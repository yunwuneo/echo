import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, decrypt, encrypt } from '../../security.js';
import { verifyKey } from '../pairing/auth.js';
const runtimeLock = 77210012;
export async function assertAvailable(db: DB) {
  const m = (await db.query('SELECT maintenance FROM instance_metadata'))
    .rows[0];
  if (m?.maintenance)
    throw new AppError(503, 'maintenance', 'Server is in maintenance mode');
}
// Live processes hold a shared session lock. Offline operations require exclusive
// ownership, preventing rotation/restore under any still-running API or worker.
export async function runtimeLease(db: pg.Pool, config: Config) {
  const session = await db.connect();
  try {
    await session.query('SELECT pg_advisory_lock_shared($1)', [runtimeLock]);
    await assertAvailable(session);
    await verifyKey(db, config);
    return async () => {
      await session.query('SELECT pg_advisory_unlock_shared($1)', [
        runtimeLock,
      ]);
      session.release();
    };
  } catch (e) {
    await session.query('SELECT pg_advisory_unlock_shared($1)', [runtimeLock]);
    session.release();
    throw e;
  }
}
export async function offline<T>(
  db: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
) {
  return transaction(db, async (tx) => {
    const lock = (
      await tx.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
        runtimeLock,
      ])
    ).rows[0].acquired;
    if (!lock)
      throw new AppError(
        409,
        'processes_running',
        'Stop API and Worker before this operation',
      );
    const m = (
      await tx.query('SELECT maintenance FROM instance_metadata FOR UPDATE')
    ).rows[0];
    if (!m?.maintenance)
      throw new AppError(
        409,
        'maintenance_required',
        'Enable maintenance first',
      );
    return fn(tx);
  });
}
export async function setMaintenance(db: pg.Pool, enabled: boolean) {
  // Turning off maintenance is an explicit local operator action after cutover.
  await db.query('UPDATE instance_metadata SET maintenance=$1', [enabled]);
}
export async function rotateKey(db: pg.Pool, old: Config, next: Config) {
  if (
    next.keyVersion !== old.keyVersion + 1 ||
    next.masterKey.equals(old.masterKey)
  )
    throw new AppError(
      400,
      'invalid_rotation',
      'Use a new key and the next key version',
    );
  return offline(db, async (tx) => {
    const metadata = (await tx.query('SELECT key_check FROM instance_metadata'))
      .rows[0];
    if (decrypt(metadata.key_check, old, 'instance') !== 'echo2-key-check')
      throw new Error('Key mismatch');
    let count = 0;
    for (const table of [
      'provider_connections',
      'mcp_connections',
      'notification_bindings',
      'notification_revocations',
    ]) {
      const key = table.startsWith('notification') ? 'ticket' : 'credential';
      const id = table === 'notification_bindings' ? 'device_id' : 'id';
      const rows = (
        await tx.query(
          `SELECT * FROM ${table} WHERE ${key} IS NOT NULL FOR UPDATE`,
        )
      ).rows;
      for (const row of rows) {
        const context =
          table === 'provider_connections'
            ? `${row.owner_id}:${row.id}`
            : table === 'mcp_connections'
              ? `${row.owner_id}:mcp:${row.id}`
              : `${row.owner_id}:push:${row.device_id}`;
        const value = encrypt(decrypt(row[key], old, context), next, context);
        await tx.query(`UPDATE ${table} SET ${key}=$2 WHERE ${id}=$1`, [
          row[id],
          value,
        ]);
        count++;
      }
    }
    await tx.query('UPDATE instance_metadata SET key_check=$1', [
      encrypt('echo2-key-check', next, 'instance'),
    ]);
    return { rotated_credentials: count, key_version: next.keyVersion };
  });
}
export async function prepareRestored(db: pg.Pool, config: Config) {
  await verifyKey(db, config);
  return offline(db, async (tx) => {
    // A restored database is quarantined. Never replay unresolved external actions.
    await tx.query(
      'UPDATE autonomy_settings SET enabled=false,tools_read=false,tools_write=false,revision=revision+1',
    );
    await tx.query(
      'UPDATE autonomy_policies SET enabled=false,tools_read=false,tools_write=false,revision=revision+1,next_contact_at=now(),next_interaction_at=now()',
    );
    await tx.query('UPDATE tool_grants SET enabled=false,revision=revision+1');
    await tx.query(
      'UPDATE mcp_connections SET enabled=false,revision=revision+1',
    );
    await tx.query(
      "UPDATE tool_calls SET state=CASE WHEN state='executing' THEN 'outcome_unknown' ELSE 'expired' END,error_code='database_restored' WHERE state IN ('pending','approved','executing')",
    );
    await tx.query(
      "UPDATE runs SET state='interrupted',error_code='database_restored',lease_holder=NULL WHERE state IN ('queued','running','awaiting_approval')",
    );
    await tx.query(
      "UPDATE messages SET status='interrupted' WHERE status IN ('streaming','accepted') AND run_id IN (SELECT id FROM runs WHERE error_code='database_restored')",
    );
    await tx.query(
      'UPDATE world_leases SET holder=NULL,run_id=NULL,fencing_token=fencing_token+1,expires_at=now()',
    );
    await tx.query(
      'UPDATE outbox SET dispatched_at=now() WHERE dispatched_at IS NULL',
    );
    await tx.query(
      "UPDATE usage_ledger SET state='unknown',error_code='database_restored' WHERE state='reserved'",
    );
    await tx.query(
      "UPDATE background_usage SET state='unknown',error_code='database_restored' WHERE state='reserved'",
    );
    await tx.query('UPDATE memory_jobs SET lease_until=NULL');
    await tx.query('UPDATE devices SET revoked_at=COALESCE(revoked_at,now())');
    await tx.query(
      'UPDATE device_sessions SET revoked_at=COALESCE(revoked_at,now())',
    );
    await tx.query('DELETE FROM pairing_codes');
    await tx.query('DELETE FROM sync_snapshots');
    await tx.query(
      'UPDATE notification_bindings SET enabled=false,ticket=NULL,challenge_hash=NULL,revision=revision+1',
    );
    await tx.query('DELETE FROM notification_revocations');
    await tx.query(
      "UPDATE notification_deliveries SET state='suppressed',error_code='database_restored' WHERE state IN ('pending','sending')",
    );
    await tx.query('DELETE FROM worker_health');
    const m = (
      await tx.query(
        'UPDATE instance_metadata SET data_epoch=gen_random_uuid() RETURNING server_instance_id,data_epoch,maintenance',
      )
    ).rows[0];
    return m;
  });
}
export async function diagnostics(db: DB) {
  const m = (
    await db.query(
      'SELECT server_instance_id,data_epoch,maintenance FROM instance_metadata',
    )
  ).rows[0];
  const migrations = (
    await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')
  ).rows;
  const runs = (
    await db.query(
      'SELECT state,count(*)::int AS count FROM runs GROUP BY state ORDER BY state',
    )
  ).rows;
  const notifications = (
    await db.query(
      'SELECT state,count(*)::int AS count FROM notification_deliveries GROUP BY state ORDER BY state',
    )
  ).rows;
  const worker = (
    await db.query(
      "SELECT seen_at,seen_at>now()-interval '30 seconds' AS healthy FROM worker_health",
    )
  ).rows[0] ?? { healthy: false };
  return { version: '0.6.0', ...m, migrations, runs, notifications, worker };
}
export async function inventory(db: DB) {
  const tables = [
    'messages',
    'memories',
    'worlds',
    'rooms',
    'world_characters',
    'character_versions',
    'lore_entries',
    'import_jobs',
  ];
  const data: Record<string, unknown> = {};
  for (const table of tables)
    data[table] = (
      await db.query(
        `SELECT count(*)::int AS count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS digest FROM (SELECT md5(row_to_json(t)::text) AS h FROM ${table} t) s`,
      )
    ).rows[0];
  return data;
}
export async function deletionLedger(db: DB) {
  return {
    format: 'echo-privacy-ledger',
    format_version: 1,
    server_instance_id: (
      await db.query('SELECT server_instance_id FROM instance_metadata')
    ).rows[0].server_instance_id,
    items: (
      await db.query(
        'SELECT owner_id,entity_id,kind FROM privacy_deletions ORDER BY owner_id,kind,entity_id',
      )
    ).rows,
  };
}
export async function applyDeletionLedger(db: pg.Pool, value: any) {
  const { deleteMessage, editMemory } = await import('../memory/repository.js');
  const instance = (
    await db.query(
      'SELECT server_instance_id,maintenance FROM instance_metadata',
    )
  ).rows[0];
  if (
    !instance?.maintenance ||
    value.format !== 'echo-privacy-ledger' ||
    value.format_version !== 1 ||
    value.server_instance_id !== instance.server_instance_id ||
    !Array.isArray(value.items) ||
    value.items.length > 1000000
  )
    throw new AppError(
      400,
      'invalid_privacy_ledger',
      'Ledger is not for this instance',
    );
  // Validate the whole input before applying any deletion; execution is idempotent.
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const row of value.items)
    if (
      !uuid.test(row.owner_id) ||
      !uuid.test(row.entity_id) ||
      !['message', 'memory'].includes(row.kind)
    )
      throw new AppError(400, 'invalid_privacy_ledger', 'Malformed deletion');
  for (const row of value.items) {
    if (row.kind === 'message') {
      if (
        (
          await db.query('SELECT 1 FROM messages WHERE id=$1 AND owner_id=$2', [
            row.entity_id,
            row.owner_id,
          ])
        ).rowCount
      )
        await deleteMessage(db, row.owner_id, row.entity_id);
    } else {
      const m = (
        await db.query(
          'SELECT revision,status FROM memories WHERE id=$1 AND owner_id=$2',
          [row.entity_id, row.owner_id],
        )
      ).rows[0];
      if (m && !['deleted', 'invalidated'].includes(m.status))
        await editMemory(db, row.owner_id, row.entity_id, m.revision, null);
    }
  }
  return { applied: value.items.length };
}
