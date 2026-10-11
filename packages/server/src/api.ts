import { loadConfig } from './config.js';
import { pool } from './db/index.js';
import { runtimeLease } from './modules/operations/index.js';
import { buildApp } from './app.js';
const config = loadConfig(),
  db = pool(config.databaseURL);
let releaseRuntime: (() => Promise<void>) | undefined;
try {
  releaseRuntime = await runtimeLease(db, config);
  const app = await buildApp(db, config, { logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await releaseRuntime?.();
    releaseRuntime = undefined;
    await db.end();
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch {
  await releaseRuntime?.();
  process.stderr.write(
    'api_start_failed: check configuration, migrations and master key\n',
  );
  await db.end();
  process.exitCode = 1;
}
