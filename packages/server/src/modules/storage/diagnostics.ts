import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, hash, decrypt } from '../../security.js';
import { canonical } from '../mcp/schema.js';
import { command } from '../commands/index.js';
async function preview(tx: DB, owner: string, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new AppError(400, 'retention_range', 'Choose 1–3650 days');
  // Always keep the latest complete ledger per room and every active/uncertain operation.
  const items = (
    await tx.query(
      `WITH latest AS (SELECT DISTINCT ON(r.room_id) s.run_id,s.attempt FROM request_snapshots s JOIN runs r ON r.id=s.run_id WHERE s.owner_id=$1 AND r.state='completed' ORDER BY r.room_id,r.created_at DESC,s.attempt DESC)
 SELECT s.run_id,s.attempt,s.payload_hash,pg_column_size(s.payload)::int bytes FROM request_snapshots s JOIN runs r ON r.id=s.run_id WHERE s.owner_id=$1 AND r.created_at<now()-$2*interval '1 day' AND r.state IN ('completed','failed','cancelled','interrupted') AND NOT EXISTS(SELECT 1 FROM latest l WHERE l.run_id=s.run_id AND l.attempt=s.attempt) AND NOT EXISTS(SELECT 1 FROM tool_calls t WHERE t.run_id=r.id AND t.state IN ('executing','outcome_unknown')) AND NOT EXISTS(SELECT 1 FROM host_jobs h WHERE h.relay_run_id=r.id AND h.state IN ('accepted','executing','unknown')) ORDER BY s.run_id,s.attempt`,
      [owner, days],
    )
  ).rows;
  return {
    items,
    preview_token: hash(canonical(items)),
    logical_bytes: items.reduce((n, r) => n + r.bytes, 0),
    retention_days: days,
  };
}
export async function diagnosticsCommand(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
) {
  const p = input.payload;
  if (input.command === 'storageDiagnostics')
    return transaction(
      db,
      async (tx) => {
        const issues: any[] = [];
        const snapshots = (
          await tx.query('SELECT * FROM request_snapshots WHERE owner_id=$1', [
            owner,
          ])
        ).rows;
        for (const r of snapshots)
          try {
            const value = JSON.parse(
              decrypt(
                r.payload,
                config,
                `${owner}:request:${r.run_id}:${r.attempt}`,
              ),
            );
            if (hash(canonical(value)) !== r.payload_hash)
              issues.push({
                kind: 'request_hash',
                run_id: r.run_id,
                attempt: r.attempt,
              });
          } catch {
            issues.push({
              kind: 'request_authentication',
              run_id: r.run_id,
              attempt: r.attempt,
            });
          }
        for (const table of ['system_actions', 'host_jobs']) {
          const rows = (
            await tx.query('SELECT * FROM ' + table + ' WHERE owner_id=$1', [
              owner,
            ])
          ).rows;
          for (const row of rows) {
            const value =
              table === 'system_actions'
                ? row.payload
                : {
                    scope: row.scope,
                    payload: row.payload,
                    budget: row.budget,
                  };
            if (hash(canonical(value)) !== row.payload_hash)
              issues.push({ kind: table + '_hash', id: row.id });
          }
        }
        const relations = (
          await tx.query(
            "SELECT c.relname AS relation,pg_total_relation_size(c.oid)::text allocated_bytes FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind='r' ORDER BY c.relname",
          )
        ).rows;
        const logical = (
          await tx.query(
            'SELECT COALESCE(sum(pg_column_size(payload)),0)::text AS request_logical_bytes FROM request_snapshots WHERE owner_id=$1',
            [owner],
          )
        ).rows[0];
        const constraints = (
          await tx.query(
            "SELECT conrelid::regclass::text relation,conname name,convalidated validated FROM pg_constraint WHERE contype='f' AND connamespace=current_schema()::regnamespace AND NOT convalidated",
          )
        ).rows;
        return {
          healthy: !issues.length && !constraints.length,
          issues,
          unvalidated_constraints: constraints,
          relations,
          ...logical,
          read_only: true,
          space_note:
            'Logical deletion does not immediately shrink PostgreSQL allocated files; no VACUUM FULL is performed automatically.',
        };
      },
      'ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
  if (input.command === 'previewDiagnosticCleanup')
    return transaction(
      db,
      (tx) => preview(tx, owner, p.retention_days),
      'ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
  return command(
    db,
    owner,
    'diagnostics.cleanup',
    input.operation_id,
    input,
    async (tx) => {
      const plan = await preview(tx, owner, p.retention_days);
      if (plan.preview_token !== p.preview_token)
        throw new AppError(409, 'revision_conflict', 'Cleanup preview changed');
      for (const row of plan.items)
        await tx.query(
          'DELETE FROM request_snapshots WHERE owner_id=$1 AND run_id=$2 AND attempt=$3',
          [owner, row.run_id, row.attempt],
        );
      return {
        deleted: plan.items.length,
        logical_bytes: plan.logical_bytes,
        physical_bytes_reclaimed: null,
      };
    },
  );
}
