import { loadConfig } from './config.js';
import { pool } from './db/index.js';
import { verifyKey } from './modules/pairing/auth.js';
import { startWorker } from './queue.js';
const config = loadConfig(),
  db = pool(config.databaseURL);
try {
  await verifyKey(db, config);
  const worker = await startWorker(db, config);
  process.stdout.write('worker_ready\n');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    await db.end();
    process.stdout.write('worker_stopped\n');
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch {
  process.stderr.write(
    'worker_start_failed: check configuration, migrations and master key\n',
  );
  await db.end();
  process.exitCode = 1;
}
