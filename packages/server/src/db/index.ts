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
  let broken: Error | undefined;
  const onError = (error: Error) => {
    broken = error;
  };
  tx.on('error', onError);
  try {
    await tx.query(`BEGIN ${isolation}`);
    const result = await fn(tx);
    if (broken) throw broken;
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await tx.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw e;
  } finally {
    // A lost session must not be returned to the pool as a healthy connection.
    tx.release(broken);
    tx.off('error', onError);
  }
}
