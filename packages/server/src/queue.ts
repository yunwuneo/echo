import { assertAvailable, runtimeLease } from './modules/operations/index.js';
import { dispatchNotifications } from './modules/notifications/index.js';
import { scheduleAutonomy } from './modules/autonomy/scheduler.js';
import { expireApprovals } from './modules/mcp/gateway.js';
import { executeMemory } from './modules/memory/worker.js';
import { rebuildEmbedding } from './modules/memory/embeddings.js';
import { PgBoss } from 'pg-boss';
import type pg from 'pg';
import type { Config } from './config.js';
import { execute } from './modules/runs/engine.js';
import { pruneSync } from './modules/sync/index.js';
import { recover } from './modules/runs/repository.js';
export async function startWorker(db: pg.Pool, config: Config) {
  const releaseRuntime = await runtimeLease(db, config);
  const boss = new PgBoss({ connectionString: config.databaseURL });
  boss.on('error', () => {
    process.stderr.write('queue_error\n');
  });
  const controller = new AbortController();
  try {
    await boss.start();
    await boss.createQueue('text-run', {
      retryLimit: 2,
      retryDelay: 1,
      expireInSeconds: 180,
    });
    await boss.work<{ runId: string }>(
      'text-run',
      { localConcurrency: 2, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        await assertAvailable(db);
        for (const job of jobs)
          await execute(db, config, job.data.runId, controller.signal);
      },
    );
    await boss.createQueue('memory', { retryLimit: 0, expireInSeconds: 180 });
    await boss.createQueue('embedding', {
      retryLimit: 0,
      expireInSeconds: 180,
    });
    await boss.work<{ room: string }>(
      'memory',
      { localConcurrency: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        await assertAvailable(db);
        for (const job of jobs)
          await executeMemory(db, config, job.data.room, controller.signal);
      },
    );
    await boss.work<{ world: string }>(
      'embedding',
      { localConcurrency: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        await assertAvailable(db);
        for (const job of jobs)
          await rebuildEmbedding(db, config, job.data.world, controller.signal);
      },
    );
    let lastMemory = 0;
    let notifications: Promise<void> | null = null;
    let busy = false,
      lastPrune = 0;
    const dispatch = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        await assertAvailable(db);
        await db.query(
          'INSERT INTO worker_health(singleton,seen_at) VALUES(true,now()) ON CONFLICT(singleton) DO UPDATE SET seen_at=now()',
        );
        await recover(db);
        await expireApprovals(db);
        await db.query(
          "UPDATE background_usage SET state='unknown',error_code='worker_lost' WHERE state='reserved' AND created_at<clock_timestamp()-(GREATEST($1::integer,30000)+15000)*interval '1 millisecond'",
          [config.modelTimeoutMs],
        );
        if (Date.now() - lastPrune > 60000) {
          await pruneSync(db);
          await scheduleAutonomy(db);
          lastPrune = Date.now();
        }
        if (Date.now() - lastMemory >= 5000) {
          const rooms = (
            await db.query(
              `SELECT j.room_id FROM memory_jobs j JOIN rooms r ON r.id=j.room_id JOIN worlds w ON w.id=r.world_id JOIN memory_settings s ON s.world_id=r.world_id WHERE s.enabled AND NOT w.deleted AND NOT r.deleted AND j.attempts<3 AND j.next_attempt_at<=now() AND (j.lease_until IS NULL OR j.lease_until<=now()) AND EXISTS(SELECT 1 FROM memory_sources src WHERE src.room_id=j.room_id AND src.cursor>j.cursor) ORDER BY j.next_attempt_at LIMIT 20`,
            )
          ).rows;
          for (const r of rooms)
            await boss.send(
              'memory',
              { room: r.room_id },
              { singletonKey: r.room_id, singletonSeconds: 2 },
            );
          const worlds = (
            await db.query(
              `SELECT s.world_id FROM memory_settings s JOIN worlds w ON w.id=s.world_id WHERE NOT w.deleted AND s.embedding_provider_id IS NOT NULL AND s.index_next_at<=now() ORDER BY s.index_next_at LIMIT 20`,
            )
          ).rows;
          for (const w of worlds)
            await boss.send(
              'embedding',
              { world: w.world_id },
              { singletonKey: w.world_id, singletonSeconds: 2 },
            );
          lastMemory = Date.now();
        }
        const rows = (
          await db.query(
            'SELECT id,run_id FROM outbox WHERE dispatched_at IS NULL AND available_at<=clock_timestamp() ORDER BY available_at LIMIT 20',
          )
        ).rows;
        for (const row of rows) {
          await boss.send('text-run', { runId: row.run_id });
          await db.query('UPDATE outbox SET dispatched_at=now() WHERE id=$1', [
            row.id,
          ]);
        }
      } finally {
        busy = false;
      }
    };
    await dispatch();
    let inFlight: Promise<void> | null = null;
    const interval = setInterval(() => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = dispatch()
        .catch(() => {
          process.stderr.write('dispatcher_error\n');
        })
        .finally(() => {
          inFlight = null;
        });
    }, 500);
    const notificationTimer = setInterval(() => {
      if (notifications || controller.signal.aborted) return;
      notifications = assertAvailable(db)
        .then(() => dispatchNotifications(db, config, controller.signal))
        .catch(() => {
          process.stderr.write('notification_dispatch_failed\n');
        })
        .finally(() => {
          notifications = null;
        });
    }, 5000);
    return {
      boss,
      stop: async () => {
        clearInterval(interval);
        clearInterval(notificationTimer);
        controller.abort();
        await inFlight;
        await notifications;
        await boss.stop({ graceful: true, timeout: 10000 });
        await releaseRuntime();
      },
    };
  } catch (error) {
    controller.abort();
    await boss.stop({ graceful: false, timeout: 1000 }).catch(() => {});
    await releaseRuntime().catch(() => {});
    throw error;
  }
}
