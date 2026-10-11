import { pool } from './db/index.js';
const db = pool(process.env.DATABASE_URL ?? '');
try {
  const result = await db.query(
    "SELECT 1 FROM worker_health h CROSS JOIN instance_metadata m WHERE h.seen_at>now()-interval '30 seconds' AND NOT m.maintenance",
  );
  if (!result.rowCount) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await db.end();
}
