import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pool, transaction } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
  pair,
  refresh,
  authenticate,
  verifyKey,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import {
  enqueue,
  claim,
  savePartial,
  recover,
  getRun,
  heartbeat,
  finish,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import {
  emit,
  snapshot,
  sync,
} from '../../packages/server/src/modules/sync/index.js';
import { startWorker } from '../../packages/server/src/queue.js';
import { buildApp } from '../../packages/server/src/app.js';
import { mockModel } from '../fixtures/mock-model.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('/echo2_test'))
  throw new Error(
    'TEST_DATABASE_URL must point to the dedicated echo2_test database. Tests reset its data.',
  );
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    LEASE_MS: '1200',
    MODEL_TIMEOUT_MS: '3000',
  });
let owner: string,
  room: string,
  world: string,
  session: Awaited<ReturnType<typeof pair>>,
  app: Awaited<ReturnType<typeof buildApp>>,
  mock: Awaited<ReturnType<typeof mockModel>>;
const children = new Set<ChildProcess>();
async function until<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  ms = 12000,
): Promise<T> {
  const end = Date.now() + ms;
  let value: T;
  do {
    value = await fn();
    if (predicate(value)) return value;
    await delay(100);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${JSON.stringify(value!)}`);
}
async function send(content = '你好') {
  return enqueue(db, owner, room, { client_command_id: randomUUID(), content });
}
async function workerProcess() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/server/src/worker.ts'],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        MASTER_KEY: 'ab'.repeat(32),
        PUBLIC_URL: 'http://localhost:3000',
        ALLOW_INSECURE_LOCAL: 'true',
        LEASE_MS: '1200',
        MODEL_TIMEOUT_MS: '10000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  await until(
    async () => output,
    (s) => s.includes('worker_ready'),
  );
  return child;
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  child.kill(signal);
  await until(
    async () => child.exitCode !== null || child.signalCode !== null,
    Boolean,
  );
  children.delete(child);
}
beforeAll(async () => {
  await migrate(db);
}, 30000);
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  const code = await createPairingCode(db, owner);
  session = await pair(db, code.code, '合成测试设备', randomUUID());
  mock = await mockModel();
  const provider = await createProvider(db, config, owner, {
    name: '合成模型',
    base_url: mock.url,
    api_key: 'synthetic-secret-key',
    model: 'mock-text',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  world = randomUUID();
  room = randomUUID();
  await db.query('INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)', [
    world,
    owner,
    '星港',
  ]);
  await db.query(
    'INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',
    [room, owner, world, '协议室', provider.id],
  );
  app = await buildApp(db, config);
  await app.ready();
});
afterEach(async () => {
  for (const child of children) await kill(child);
  await app?.close();
  await mock?.close();
});
afterAll(async () => {
  await db.end();
});
const headers = () => ({ authorization: `Bearer ${session.access_token}` });
describe('P1 auth and contracts', () => {
  it('replays and expired pairing fail, brute force is persisted and limited', async () => {
    const code = await createPairingCode(db, owner);
    await pair(db, code.code, '第二设备', 'one');
    await expect(pair(db, code.code, '重放', 'two')).rejects.toThrow();
    const expired = await createPairingCode(db, owner);
    await db.query(
      "UPDATE pairing_codes SET expires_at=now()-interval '1 second' WHERE consumed_at IS NULL",
    );
    await expect(pair(db, expired.code, '过期', 'three')).rejects.toThrow();
    for (let n = 0; n < 5; n++)
      await expect(
        pair(db, 'bad-code', '暴力', 'limited'),
      ).rejects.toMatchObject({ status: 401 });
    await expect(pair(db, 'bad-code', '暴力', 'limited')).rejects.toMatchObject(
      { status: 429 },
    );
    expect(
      (await app.inject({ method: 'POST', url: '/v1/owners', payload: {} }))
        .statusCode,
    ).toBe(404);
  });
  it('refresh rotation rejects replay and revokes the new session family', async () => {
    const next = await refresh(db, session.refresh_token);
    await expect(
      authenticate(db, `Bearer ${session.access_token}`),
    ).rejects.toThrow();
    await authenticate(db, `Bearer ${next.access_token}`);
    await expect(refresh(db, session.refresh_token)).rejects.toThrow();
    await expect(
      authenticate(db, `Bearer ${next.access_token}`),
    ).rejects.toThrow();
  });
  it('revokes REST and refresh, and isolates another owner ID', async () => {
    const result = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${session.device_id}`,
      headers: headers(),
    });
    expect(result.statusCode).toBe(204);
    expect(
      (await app.inject({ url: '/v1/devices', headers: headers() })).statusCode,
    ).toBe(401);
    await expect(refresh(db, session.refresh_token)).rejects.toThrow();
    await expect(
      enqueue(db, randomUUID(), room, {
        client_command_id: randomUUID(),
        content: '越权',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('does not expose keys; wrong master key refuses startup verification', async () => {
    const result = await app.inject({
      url: '/v1/providers',
      headers: headers(),
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('synthetic-secret-key');
    expect(result.json().items[0].credential_present).toBe(true);
    expect(
      JSON.stringify(
        (await db.query('SELECT credential FROM provider_connections')).rows,
      ),
    ).not.toContain('synthetic-secret-key');
    await expect(
      verifyKey(db, { ...config, masterKey: Buffer.alloc(32) }),
    ).rejects.toThrow();
  });
  it('validates inputs, emits a stable 202 ACK and detects conflicting retries', async () => {
    const body = { client_command_id: randomUUID(), content: '你好' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: `/v1/rooms/${room}/messages`,
          headers: headers(),
          payload: body,
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect((await db.query('SELECT count(*) FROM runs')).rows[0].count).toBe(
      '1',
    );
    expect((await db.query('SELECT count(*) FROM outbox')).rows[0].count).toBe(
      '1',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/rooms/${room}/messages`,
          headers: headers(),
          payload: { ...body, content: '改变正文' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: '/v1/sync?cursor=-1', headers: headers() }))
        .statusCode,
    ).toBe(400);
  });
});
describe('P1 logging and request limits', () => {
  it('redacts injected database failures and never logs request secrets', async () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const secured = await buildApp(db, config, {
      logger: true,
      logStream: stream,
    });
    await secured.ready();
    const spy = vi
      .spyOn(db, 'query')
      .mockRejectedValueOnce(
        new Error('synthetic-secret-key and private dialogue'),
      );
    try {
      const result = await secured.inject({
        url: '/health',
        headers: headers(),
      });
      expect(result.statusCode).toBe(500);
      expect(output).toContain('internal_error');
      expect(output + result.body).not.toContain('synthetic-secret-key');
      expect(output).not.toContain('private dialogue');
      expect(output).not.toContain(session.access_token);
    } finally {
      spy.mockRestore();
      await secured.close();
    }
  });
  it('rejects unknown write fields and context overflow before a model request', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${room}/messages`,
      headers: headers(),
      payload: {
        client_command_id: randomUUID(),
        content: '你好',
        grant_admin: true,
      },
    });
    expect(invalid.statusCode).toBe(400);
    const malformed = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${room}/messages`,
      headers: { ...headers(), 'Content-Type': 'application/json' },
      payload: '{bad',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('invalid_request');
    const oversized = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${room}/messages`,
      headers: headers(),
      payload: {
        client_command_id: randomUUID(),
        content: '太长'.repeat(10000),
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(
      (
        await app.inject({
          url: `/v1/rooms/${room}/messages?after=99999999999999999999`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
    await db.query(
      'UPDATE provider_connections SET context_window=2048,max_output_tokens=1024',
    );
    const ack = await send('合成超长输入'.repeat(300));
    await execute(db, config, ack.run_id);
    expect((await getRun(db, owner, ack.run_id)).error_code).toBe(
      'context_budget_exceeded',
    );
    expect(mock.calls).toBe(0);
  });
});
describe('P1 durable text execution', () => {
  it('finishes after the HTTP client disconnects and exposes the same final result', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No API port');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/v1/rooms/${room}/messages`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Content-Type': 'application/json',
        Connection: 'close',
      },
      body: JSON.stringify({
        client_command_id: randomUUID(),
        content: '关闭客户端后的合成消息',
      }),
    });
    expect(response.status).toBe(202);
    const ack = (await response.json()) as { run_id: string };
    const worker = await workerProcess();
    await until(
      () => getRun(db, owner, ack.run_id),
      (r) => r.state === 'completed',
    );
    const result = await app.inject({
      url: `/v1/rooms/${room}/messages`,
      headers: headers(),
    });
    expect(
      result.json().items.find((m: { role: string }) => m.role === 'assistant')
        .content,
    ).toBe('星港已收到。');
    await kill(worker, 'SIGTERM');
  }, 20000);

  it('outbox survives no worker and duplicate delivery has one authoritative result', async () => {
    const ack = await send();
    await delay(100);
    expect((await getRun(db, owner, ack.run_id)).state).toBe('queued');
    const w = await startWorker(db, config);
    try {
      await w.boss.send('text-run', { runId: ack.run_id });
      await until(
        () => getRun(db, owner, ack.run_id),
        (r) => r.state === 'completed',
      );
      await execute(db, config, ack.run_id);
      const messages = (
        await db.query(
          'SELECT * FROM messages WHERE run_id=$1 ORDER BY sequence',
          [ack.run_id],
        )
      ).rows;
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe('星港已收到。');
      expect(mock.calls).toBe(1);
      expect(
        (
          await db.query(
            'SELECT state,input_tokens,output_tokens FROM usage_ledger',
          )
        ).rows,
      ).toEqual([{ state: 'known', input_tokens: 24, output_tokens: 8 }]);
    } finally {
      await w.stop();
    }
  }, 20000);
  it('serializes a world and excludes future queued messages from the first prompt', async () => {
    const first = await send('第一条'),
      second = await send('未来秘密');
    await Promise.all([
      execute(db, config, second.run_id),
      execute(db, config, first.run_id),
    ]);
    expect((await getRun(db, owner, second.run_id)).state).toBe('queued');
    expect(JSON.stringify(mock.requests[0])).not.toContain('未来秘密');
    await execute(db, config, second.run_id);
    expect((await getRun(db, owner, second.run_id)).state).toBe('completed');
    expect(JSON.stringify(mock.requests[1])).toContain('星港已收到。');
  });
  it('interrupts partial streams and never transparently appends a retry', async () => {
    mock.setMode('partial');
    const ack = await send();
    await execute(db, config, ack.run_id);
    expect((await getRun(db, owner, ack.run_id)).state).toBe('interrupted');
    expect(
      (
        await db.query(
          "SELECT content,status FROM messages WHERE run_id=$1 AND role='assistant'",
          [ack.run_id],
        )
      ).rows[0],
    ).toEqual({ content: '星港', status: 'interrupted' });
    await execute(db, config, ack.run_id);
    expect(mock.calls).toBe(1);
  });
  it('fails malformed streams and refuses tool or truncated completions', async () => {
    for (const mode of ['malformed', 'tool', 'length'] as const) {
      mock.setMode(mode);
      const ack = await send(mode);
      await execute(db, config, ack.run_id);
      const run = await getRun(db, owner, ack.run_id);
      expect(['failed', 'interrupted']).toContain(run.state);
      expect(run.state).not.toBe('completed');
    }
  });
  it('bounds transient retry and reserves budget for each charged attempt', async () => {
    mock.setMode('rate-limit');
    const ack = await send();
    for (let n = 0; n < 3; n++) {
      await db.query('UPDATE runs SET next_attempt_at=now() WHERE id=$1', [
        ack.run_id,
      ]);
      await execute(db, config, ack.run_id);
    }
    expect((await getRun(db, owner, ack.run_id)).state).toBe('failed');
    expect(mock.calls).toBe(3);
    expect(
      (await db.query('SELECT count(*) FROM usage_ledger')).rows[0].count,
    ).toBe('3');
    expect(
      (await db.query('SELECT requests FROM usage_daily')).rows[0].requests,
    ).toBe(3);
  });
  it('missing usage is unknown, not zero', async () => {
    mock.setMode('no-usage');
    const ack = await send();
    await execute(db, config, ack.run_id);
    expect((await getRun(db, owner, ack.run_id)).state).toBe('completed');
    expect(
      (await db.query('SELECT state,input_tokens FROM usage_ledger')).rows[0],
    ).toEqual({ state: 'unknown', input_tokens: null });
  });
  it('cancel blocks late writes and leaves external consumption unknown', async () => {
    mock.setMode('hold');
    const ack = await send();
    const execution = execute(db, config, ack.run_id);
    await until(
      async () => mock.calls,
      (n) => n > 0,
    );
    expect(
      (
        await db.query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname='echo2_test' AND state='idle in transaction'",
        )
      ).rows[0].count,
    ).toBe('0');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/runs/${ack.run_id}/cancel`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    await execution;
    expect((await getRun(db, owner, ack.run_id)).state).toBe('cancelled');
    expect(
      (await db.query('SELECT state FROM usage_ledger')).rows[0].state,
    ).toBe('unknown');
  }, 10000);
  it('times out without output with only a bounded retry', async () => {
    mock.setMode('hold');
    const ack = await send();
    await execute(db, { ...config, modelTimeoutMs: 300 }, ack.run_id);
    const run = await getRun(db, owner, ack.run_id);
    expect(run.state).toBe('queued');
    expect(run.error_code).toBe('model_timeout');
  });
  it('rejects expired fencing and marks crashed partial output interrupted', async () => {
    const ack = await send(),
      c = await claim(db, ack.run_id, config.leaseMs, 100);
    expect(c).not.toBeNull();
    await savePartial(db, c!, '保留部分');
    await db.query(
      "UPDATE world_leases SET expires_at=now()-interval '1 second'",
    );
    await recover(db);
    expect(await heartbeat(db, c!, config.leaseMs)).toBeNull();
    expect(await finish(db, c!, '旧结果', 'completed', null, null)).toBeNull();
    expect((await getRun(db, owner, ack.run_id)).state).toBe('interrupted');
    expect(
      (await db.query("SELECT content FROM messages WHERE role='assistant'"))
        .rows[0].content,
    ).toBe('保留部分');
  });
  it('prevents parallel worlds from overspending the final request', async () => {
    const secondRoom = randomUUID(),
      secondWorld = randomUUID(),
      provider = (await db.query('SELECT id FROM provider_connections')).rows[0]
        .id;
    await db.query('INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)', [
      secondWorld,
      owner,
      '山城',
    ]);
    await db.query(
      'INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',
      [secondRoom, owner, secondWorld, '另一室', provider],
    );
    const first = await send(),
      second = await enqueue(db, owner, secondRoom, {
        client_command_id: randomUUID(),
        content: '预算竞争',
      });
    await Promise.all([
      execute(db, { ...config, dailyRequestLimit: 1 }, first.run_id),
      execute(db, { ...config, dailyRequestLimit: 1 }, second.run_id),
    ]);
    expect(mock.calls).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM runs WHERE error_code='request_budget_exceeded'",
        )
      ).rows[0].count,
    ).toBe('1');
  });
  it('SIGKILL before output recovers after restart without duplicate messages', async () => {
    mock.setMode('hold');
    const ack = await send();
    const first = await workerProcess();
    await until(
      async () => mock.calls,
      (n) => n === 1,
    );
    await kill(first);
    mock.setMode('success');
    const second = await workerProcess();
    await until(
      () => getRun(db, owner, ack.run_id),
      (r) => r.state === 'completed',
      20000,
    );
    expect(
      (
        await db.query('SELECT count(*) FROM messages WHERE run_id=$1', [
          ack.run_id,
        ])
      ).rows[0].count,
    ).toBe('2');
    expect((await getRun(db, owner, ack.run_id)).attempts).toBe(2);
    await kill(second, 'SIGTERM');
  }, 30000);
  it('SIGKILL after a durable partial preserves it and does not rerun generation', async () => {
    mock.setMode('partial');
    const ack = await send(),
      first = await workerProcess();
    await until(
      async () =>
        (
          await db.query(
            "SELECT content FROM messages WHERE run_id=$1 AND role='assistant'",
            [ack.run_id],
          )
        ).rows[0]?.content,
      (s) => s === '星港',
    );
    await kill(first);
    mock.setMode('success');
    const second = await workerProcess();
    await until(
      () => getRun(db, owner, ack.run_id),
      (r) => r.state === 'interrupted',
    );
    expect(mock.calls).toBe(1);
    await kill(second, 'SIGTERM');
  }, 30000);
});
describe('P1 sync and migrations', () => {
  it('migrations repeat with no changes and vector is installed', async () => {
    const before = (await db.query('SELECT * FROM schema_migrations')).rows;
    await Promise.all([migrate(db), migrate(db)]);
    expect((await db.query('SELECT * FROM schema_migrations')).rows).toEqual(
      before,
    );
    expect(
      (
        await db.query(
          "SELECT extversion FROM pg_extension WHERE extname='vector'",
        )
      ).rows[0].extversion,
    ).toBe('0.8.2');
  });
  it('snapshot and delta return the persisted final result; expired cursors fail', async () => {
    const ack = await send();
    const initial = await snapshot(db, owner);
    await execute(db, config, ack.run_id);
    const delta = await sync(db, owner, initial.high_water_cursor);
    expect(
      delta.items.some((e) => e.kind === 'run' && e.data.state === 'completed'),
    ).toBe(true);
    expect(
      (await snapshot(db, owner)).messages.filter(
        (m: { run_id: string }) => m.run_id === ack.run_id,
      ),
    ).toHaveLength(2);
    await db.query(
      'UPDATE sync_heads SET min_cursor=cursor WHERE owner_id=$1',
      [owner],
    );
    await expect(sync(db, owner, '0')).rejects.toMatchObject({ status: 410 });
  });
  it('allocates cursors in commit order across concurrent transactions', async () => {
    await Promise.all([
      transaction(db, async (tx) => {
        await emit(tx, owner, 'test', randomUUID(), { order: 1 });
        await delay(200);
      }),
      transaction(db, async (tx) => {
        await delay(50);
        await emit(tx, owner, 'test', randomUUID(), { order: 2 });
      }),
    ]);
    const events = await sync(db, owner, '0');
    expect(events.items.map((e) => e.cursor)).toEqual(['1', '2']);
    expect(events.items.map((e) => e.data.order)).toEqual([1, 2]);
  });
  it('revocation terminates an established SSE stream', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No API port');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/events?cursor=0`,
      { headers: headers() },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${session.device_id}`,
      headers: headers(),
    });
    let done = false;
    const deadline = Date.now() + 3000;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
    reader.releaseLock();
  });
});
