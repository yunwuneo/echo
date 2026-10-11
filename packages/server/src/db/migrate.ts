import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type pg from 'pg';
export async function migrate(
  db: pg.Pool,
  directory = pathToFileURL(resolve('migrations') + '/'),
) {
  const tx = await db.connect();
  try {
    await tx.query('SELECT pg_advisory_lock(77210001)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await tx.query(
        'SELECT checksum FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await tx.query('BEGIN');
      try {
        await tx.query(sql);
        await tx.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, checksum],
        );
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await tx.query('SELECT pg_advisory_unlock(77210001)');
    tx.release();
  }
}
