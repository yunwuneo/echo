import type pg from 'pg';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';

/** Local transactional commands only. External calls must use durable intents. */
export async function command<T>(
  db: pg.Pool,
  owner: string,
  kind: string,
  operation: string,
  payload: unknown,
  apply: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return transaction(db, async (tx) => {
    const account = await tx.query(
      'SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE',
      [owner],
    );
    if (!account.rowCount)
      throw new AppError(404, 'not_found', 'Owner not found');
    const digest = hash(canonical(payload));
    const previous = (
      await tx.query(
        'SELECT payload_hash,result FROM operation_receipts WHERE owner_id=$1 AND command_type=$2 AND operation_id=$3',
        [owner, kind, operation],
      )
    ).rows[0];
    if (previous) {
      if (previous.payload_hash !== digest)
        throw new AppError(
          409,
          'idempotency_conflict',
          'Operation ID already used with different input',
        );
      return previous.result as T;
    }
    const result = await apply(tx);
    await tx.query(
      'INSERT INTO operation_receipts(owner_id,command_type,operation_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)',
      [owner, kind, operation, digest, JSON.stringify(result)],
    );
    return result;
  });
}
