import pg from 'pg';
export type DB = pg.Pool | pg.PoolClient;
export function pool(databaseURL: string) {
  return new pg.Pool({
    connectionString: databaseURL,
    options: '-c timezone=UTC',
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
}
export async function transaction<T>(
  db: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
  isolation = '',
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query(`BEGIN ${isolation}`);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    tx.release();
  }
}
