import { queueRevocation } from '../notifications/index.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import { AppError, hash, token, encrypt, decrypt } from '../../security.js';
import type { Config } from '../../config.js';
export interface Identity {
  ownerId: string;
  deviceId: string;
  sessionId: string;
}
export async function verifyKey(db: pg.Pool, config: Config) {
  const check = encrypt('echo2-key-check', config, 'instance');
  await db.query(
    'INSERT INTO instance_metadata(singleton,key_check) VALUES(true,$1) ON CONFLICT DO NOTHING',
    [check],
  );
  const value = (await db.query('SELECT key_check FROM instance_metadata'))
    .rows[0].key_check;
  if (decrypt(value, config, 'instance') !== 'echo2-key-check')
    throw new Error('Invalid instance key');
}
export async function initializeOwner(db: pg.Pool, config: Config) {
  await verifyKey(db, config);
  return transaction(db, async (tx) => {
    const owner = (
      await tx.query(
        'INSERT INTO owners(singleton) VALUES(true) ON CONFLICT(singleton) DO UPDATE SET singleton=true RETURNING id',
      )
    ).rows[0].id as string;
    await tx.query(
      'INSERT INTO sync_heads(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
      [owner],
    );
    return owner;
  });
}
export async function createPairingCode(db: DB, ownerId: string) {
  const code = token();
  await db.query(
    "INSERT INTO pairing_codes(code_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
    [hash(code), ownerId],
  );
  return { code, expires_in: 300 };
}
async function newSession(
  tx: DB,
  ownerId: string,
  deviceId: string,
  familyId = randomUUID(),
) {
  const access = token(),
    refresh = token();
  await tx.query(
    "INSERT INTO device_sessions(id,owner_id,device_id,family_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 minutes',now()+interval '30 days')",
    [randomUUID(), ownerId, deviceId, familyId, hash(access), hash(refresh)],
  );
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: 900,
    device_id: deviceId,
    owner_id: ownerId,
  };
}
export async function pair(
  db: pg.Pool,
  code: string,
  name: string,
  ip: string,
) {
  const attempts = await db.query(
    "INSERT INTO pairing_attempts(ip_hash,window_start,count) VALUES($1,now(),1) ON CONFLICT(ip_hash) DO UPDATE SET count=CASE WHEN pairing_attempts.window_start<now()-interval '1 minute' THEN 1 ELSE pairing_attempts.count+1 END, window_start=CASE WHEN pairing_attempts.window_start<now()-interval '1 minute' THEN now() ELSE pairing_attempts.window_start END RETURNING count",
    [hash(ip)],
  );
  if (attempts.rows[0].count > 5)
    throw new AppError(
      429,
      'pairing_rate_limited',
      'Try pairing again in one minute',
    );
  return transaction(db, async (tx) => {
    const result = await tx.query(
      'UPDATE pairing_codes SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING owner_id',
      [hash(code)],
    );
    if (!result.rowCount)
      throw new AppError(
        401,
        'invalid_pairing_code',
        'Pairing code is invalid or expired',
      );
    const owner = result.rows[0].owner_id as string,
      device = randomUUID();
    await tx.query('INSERT INTO devices(id,owner_id,name) VALUES($1,$2,$3)', [
      device,
      owner,
      name,
    ]);
    return newSession(tx, owner, device);
  });
}
export async function authenticate(
  db: DB,
  bearer: string | undefined,
): Promise<Identity> {
  if (!bearer?.startsWith('Bearer ') || bearer.length > 200)
    throw new AppError(
      401,
      'unauthorized',
      'Valid device authentication required',
    );
  const rows = await db.query(
    'SELECT s.id,s.owner_id,s.device_id FROM device_sessions s JOIN devices d ON d.id=s.device_id AND d.owner_id=s.owner_id WHERE s.access_hash=$1 AND s.access_expires_at>now() AND s.refresh_expires_at>now() AND s.revoked_at IS NULL AND s.rotated_at IS NULL AND d.revoked_at IS NULL',
    [hash(bearer.slice(7))],
  );
  if (!rows.rowCount)
    throw new AppError(
      401,
      'unauthorized',
      'Device session is expired or revoked',
    );
  const r = rows.rows[0];
  return { ownerId: r.owner_id, deviceId: r.device_id, sessionId: r.id };
}
export async function refresh(db: pg.Pool, value: string) {
  const session = await transaction(db, async (tx) => {
    const r = (
      await tx.query(
        'SELECT s.*,s.refresh_expires_at>clock_timestamp() AS unexpired,d.revoked_at AS device_revoked FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.refresh_hash=$1 FOR UPDATE OF s,d',
        [hash(value)],
      )
    ).rows[0];
    if (!r) return null;
    if (r.rotated_at) {
      await tx.query(
        'UPDATE device_sessions SET revoked_at=now() WHERE family_id=$1',
        [r.family_id],
      );
      return null;
    }
    if (r.revoked_at || r.device_revoked || !r.unexpired) return null;
    await tx.query('UPDATE device_sessions SET rotated_at=now() WHERE id=$1', [
      r.id,
    ]);
    return newSession(tx, r.owner_id, r.device_id, r.family_id);
  });
  if (!session)
    throw new AppError(
      401,
      'invalid_refresh',
      'Refresh token is expired, reused or revoked',
    );
  return session;
}
export async function revoke(db: pg.Pool, identity: Identity, id: string) {
  await transaction(db, async (tx) => {
    const r = await tx.query(
      'UPDATE devices SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=$1 AND id=$2 RETURNING id',
      [identity.ownerId, id],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Device not found');
    await queueRevocation(tx, identity.ownerId, id);
    await tx.query(
      'UPDATE device_sessions SET revoked_at=now() WHERE owner_id=$1 AND device_id=$2',
      [identity.ownerId, id],
    );
  });
}
