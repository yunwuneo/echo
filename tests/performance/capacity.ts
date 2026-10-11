import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { startWorker } from '../../packages/server/src/queue.js';
import { preparePrompt } from '../../packages/server/src/modules/context/index.js';
import {
  beginSnapshot,
  snapshotPage,
} from '../../packages/server/src/modules/sync/index.js';
import { mockModel } from '../fixtures/mock-model.js';
import { seed } from './fixture.js';

const url = process.env.BENCH_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_benchmark')
  throw new Error('Dedicated empty echo2_benchmark database required');
const mode = process.env.BENCH_MODE ?? 'capacity';
const seconds = Number(process.env.BENCH_SECONDS ?? 600);
if (
  !['baseline', 'capacity', 'soak'].includes(mode) ||
  !Number.isInteger(seconds) ||
  seconds < 1 ||
  seconds > 86400
)
  throw new Error('Invalid benchmark mode/duration');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://127.0.0.1:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    FOREGROUND_DAILY_REQUEST_LIMIT: '1000',
  });
const root = '.local/p6-benchmark';
await mkdir(root, { recursive: true });
const report: any = {
  format: 1,
  mode,
  status: 'running',
  started_at: new Date().toISOString(),
  synthetic: true,
  real_model_calls: 0,
  real_apns_calls: 0,
  duration_requested_s: seconds,
  node: process.version,
  architecture: process.arch,
  topology:
    'Docker: app+worker+two HTTP clients+mock 1 CPU/2 GiB; PostgreSQL 1 CPU/2 GiB; loopback HTTP; no TLS or physical Apple device',
  samples: [],
  metrics: {},
};
const metrics: Record<string, number[]> = {};
const record = (name: string, n: number) => (metrics[name] ??= []).push(n);
const summarize = (a: number[]) => {
  const v = [...a].sort((a, b) => a - b);
  return {
    count: v.length,
    p50_ms: v[Math.max(0, Math.ceil(v.length * 0.5) - 1)],
    p95_ms: v[Math.max(0, Math.ceil(v.length * 0.95) - 1)],
    max_ms: v.at(-1),
  };
};
async function save() {
  report.updated_at = new Date().toISOString();
  report.metrics = Object.fromEntries(
    Object.entries(metrics).map(([k, v]) => [k, summarize(v)]),
  );
  await writeFile(
    `${root}/${mode}.tmp`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await rename(`${root}/${mode}.tmp`, `${root}/${mode}.json`);
}
const mock = await mockModel();
let fixture: Awaited<ReturnType<typeof seed>> | undefined,
  worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined,
  polling: Promise<void> | undefined;
try {
  await migrate(db);
  fixture = await seed(db, config, mock.url);
  const { owner, sessions, app, worlds } = fixture;
  report.seed_counts = (
    await db.query(
      'SELECT (SELECT count(*) FROM worlds) worlds,(SELECT count(*) FROM world_characters) actors,(SELECT count(*) FROM messages) messages,(SELECT count(*) FROM memories) memories,(SELECT count(*) FROM lore_entries) lore',
    )
  ).rows[0];
  report.database_before_bytes = Number(
    (await db.query('SELECT pg_database_size(current_database()) size')).rows[0]
      .size,
  );
  const w = worlds[0]!;
  const run = (
    await db.query(
      'SELECT * FROM runs WHERE world_id=$1 ORDER BY command_order DESC LIMIT 1',
      [w.world.id],
    )
  ).rows[0];
  const provider = (
    await db.query('SELECT * FROM provider_connections LIMIT 1')
  ).rows[0];
  let queryCount = 0;
  const measured = {
    query: async (...args: any[]) => {
      queryCount++;
      return (db.query as any)(...args);
    },
  };
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await preparePrompt(
      measured as any,
      run,
      provider,
      w.actors[0].id,
      w.world,
    );
    record('retrieval_and_context', performance.now() - start);
  }
  report.context_queries_per_call = queryCount / 30;
  const start = performance.now();
  const snap = await beginSnapshot(db, owner);
  report.snapshot_begin_ms = performance.now() - start;
  let after = '0',
    count = 0;
  const snapshotStart = performance.now();
  do {
    const t = performance.now(),
      page = await snapshotPage(db, owner, snap.snapshot_id, after, 500);
    record('snapshot_page', performance.now() - t);
    count += page.items.length;
    after = page.next_cursor;
    if (!page.has_more || (mode === 'baseline' && count >= 1500)) break;
  } while (true);
  report.snapshot_records_read = count;
  report.snapshot_read_ms = performance.now() - snapshotStart;
  report.snapshot_complete = mode !== 'baseline';
  await db.query('DELETE FROM sync_snapshots WHERE id=$1', [snap.snapshot_id]);
  report.query_plan = (
    await db.query(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM messages WHERE room_id=$1 AND status='completed' AND NOT memory_excluded ORDER BY sequence DESC LIMIT 100",
      [w.room.id],
    )
  ).rows[0];
  await save();
  if (mode !== 'baseline') {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const request = async (client: number, path: string, body?: unknown) => {
      const r = await fetch(base + '/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${sessions[client]!.access_token}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
      return r.json() as Promise<any>;
    };
    worker = await startWorker(db, config);
    let cursors = [
      String(
        (
          await db.query('SELECT cursor FROM sync_heads WHERE owner_id=$1', [
            owner,
          ])
        ).rows[0].cursor,
      ),
      '',
    ];
    cursors[1] = cursors[0]!;
    const accepted = new Map<string, number>(),
      completed = new Map<string, number>(),
      seen = [new Set<string>(), new Set<string>()];
    // created_at on sync_events is transaction-start time: a conservative upper bound on commit-to-visible latency.
    const sample = async () => {
      for (let client = 0; client < 2; client++) {
        let page;
        do {
          page = await request(
            client,
            `sync?cursor=${cursors[client]}&limit=100`,
          );
          cursors[client] = page.next_cursor;
          for (const e of page.items)
            if (
              e.kind === 'message' &&
              e.data.status === 'completed' &&
              e.data.role === 'assistant' &&
              !seen[client]!.has(e.entity_id)
            ) {
              seen[client]!.add(e.entity_id);
              const row = (
                await db.query(
                  'SELECT EXTRACT(EPOCH FROM (clock_timestamp()-created_at))*1000 ms FROM sync_events WHERE owner_id=$1 AND cursor=$2',
                  [owner, e.cursor],
                )
              ).rows[0];
              record('committed_to_http_client_upper_bound', Number(row.ms));
              if (client === 0 && accepted.has(e.data.run_id))
                completed.set(
                  e.data.run_id,
                  performance.now() - accepted.get(e.data.run_id)!,
                );
            }
        } while (page.has_more);
      }
    };
    if (mode === 'capacity')
      timer = setInterval(() => {
        if (!polling)
          polling = sample()
            .catch((e) => {
              report.poll_error = String(e);
            })
            .finally(() => {
              polling = undefined;
            });
      }, 200);
    async function send(index: number) {
      const target = worlds[index % worlds.length]!;
      const t = performance.now();
      const ack = await request(0, `rooms/${target.room.id}/messages`, {
        client_command_id: randomUUID(),
        content: '北塔灯塔航线合成测试',
        addressed_actor_ids: [target.actors[0].id],
      });
      record('durable_ack', performance.now() - t);
      accepted.set(ack.run_id, t);
    }
    const started = performance.now(),
      cpu = process.cpuUsage();
    let nextInput = started,
      nextSample = started,
      sent = 0,
      restarted = false;
    if (mode === 'capacity')
      await Promise.all(Array.from({ length: 10 }, (_, i) => send(i)));
    while (performance.now() - started < seconds * 1000) {
      if (mode === 'capacity' && performance.now() >= nextInput) {
        await send(sent++);
        nextInput += 10000;
      }
      if (
        mode === 'soak' &&
        !restarted &&
        performance.now() - started > seconds * 500
      ) {
        await worker.stop();
        worker = await startWorker(db, config);
        restarted = true;
        report.worker_restarted_at = new Date().toISOString();
      }
      if (performance.now() >= nextSample) {
        const counts = (
          await db.query(
            `SELECT (SELECT count(*) FROM runs WHERE state IN ('queued','running')) backlog,(SELECT count(*) FROM sync_events) sync_events,(SELECT count(*) FROM background_usage) background_requests,(SELECT count(*) FROM memories) memories,(SELECT count(*) FROM pgboss.job WHERE state IN ('created','active','retry')) queue_jobs`,
          )
        ).rows[0];
        report.samples.push({
          elapsed_s: (performance.now() - started) / 1000,
          rss: process.memoryUsage().rss,
          cpu: process.cpuUsage(cpu),
          database_bytes: Number(
            (await db.query('SELECT pg_database_size(current_database()) size'))
              .rows[0].size,
          ),
          ...counts,
        });
        await save();
        process.stdout.write(
          `sample ${Math.round((performance.now() - started) / 1000)}s backlog=${counts.backlog}\n`,
        );
        nextSample += 10000;
      }
      await delay(100);
    }
    report.wall_elapsed_s = (performance.now() - started) / 1000;
    // Drain bounded work before judging completion.
    const drain = performance.now();
    while (
      performance.now() - drain < 30000 &&
      (
        await db.query(
          "SELECT 1 FROM runs WHERE state IN ('queued','running') LIMIT 1",
        )
      ).rowCount
    )
      await delay(250);
    await polling;
    if (mode === 'capacity') await sample();
    report.foreground_commands = accepted.size;
    report.completed_foreground_runs = completed.size;
    for (const n of completed.values()) record('ack_to_model_complete', n);
    report.model_calls = mock.calls;
    report.final_states = (
      await db.query(
        'SELECT state,count(*) FROM runs WHERE command_order>5000 GROUP BY state',
      )
    ).rows;
    report.background_daily = (
      await db.query(
        'SELECT day,requests,input_tokens,output_tokens FROM background_daily ORDER BY day',
      )
    ).rows;
    report.errors = (
      await db.query(
        'SELECT error_code,count(*) FROM runs WHERE error_code IS NOT NULL GROUP BY error_code',
      )
    ).rows;
    report.checks = {
      background_exercised: report.background_daily.some(
        (r: any) => r.requests > 0,
      ),
      all_foreground_completed: accepted.size === completed.size,
      no_poll_failure: !report.poll_error,
      bounded_background: report.background_daily.every(
        (r: any) =>
          r.requests <= 20 &&
          r.input_tokens <= 100000 &&
          r.output_tokens <= 10000,
      ),
      ack_p95: (summarize(metrics.durable_ack ?? []).p95_ms ?? Infinity) <= 500,
      sync_p95:
        (summarize(metrics.committed_to_http_client_upper_bound ?? []).p95_ms ??
          Infinity) <= 2000,
      context_p95: summarize(metrics.retrieval_and_context!).p95_ms! <= 300,
    };
    if (mode === 'soak') {
      delete report.checks.ack_p95;
      delete report.checks.sync_p95;
      report.checks.full_24h = seconds === 86400;
    }
    if (Object.values(report.checks).some((v) => v === false))
      process.exitCode = 1;
  }
  report.status = process.exitCode ? 'failed' : 'completed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  await polling;
  await worker?.stop();
  await fixture?.app.close();
  await mock.close();
  await db.end();
  report.finished_at = new Date().toISOString();
  try {
    report.cgroup = {
      cpu: await readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
      memory: await readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    };
  } catch {
    report.cgroup = null;
  }
  await save();
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      metrics: report.metrics,
      error: report.error,
    }) + '\n',
  );
}
