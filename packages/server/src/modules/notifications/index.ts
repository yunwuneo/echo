import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, token, hash, encrypt, decrypt } from '../../security.js';
import type { Identity } from '../pairing/auth.js';
import { relayRequest } from './http.js';
const context = (owner: string, device: string) => `${owner}:push:${device}`;
export async function notificationStatus(
  db: DB,
  config: Config,
  identity: Identity,
) {
  const b = (
    await db.query(
      'SELECT enabled,expires_at,topic,environment,relay_url FROM notification_bindings WHERE device_id=$1 AND owner_id=$2',
      [identity.deviceId, identity.ownerId],
    )
  ).rows[0];
  const deliveries = (
    await db.query(
      'SELECT d.state,d.error_code,d.updated_at FROM notification_deliveries d WHERE device_id=$1 ORDER BY updated_at DESC LIMIT 20',
      [identity.deviceId],
    )
  ).rows;
  return {
    available: !!config.pushRelayURL,
    relay_url: config.pushRelayURL ?? null,
    enabled: !!(
      config.pushRelayURL &&
      b?.enabled &&
      b.relay_url === config.pushRelayURL &&
      +b.expires_at > Date.now()
    ),
    expires_at: b?.expires_at ?? null,
    topic: b?.topic ?? null,
    environment: b?.environment ?? null,
    deliveries,
  };
}
export async function beginBinding(db: DB, config: Config, identity: Identity) {
  if (!config.pushRelayURL)
    throw new AppError(
      409,
      'push_disabled',
      'The server has no push relay configured',
    );
  const challenge = token();
  await db.query(
    `INSERT INTO notification_bindings(device_id,owner_id,challenge_hash,challenge_expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') ON CONFLICT(device_id) DO UPDATE SET challenge_hash=$3,challenge_expires_at=now()+interval '10 minutes'`,
    [identity.deviceId, identity.ownerId, hash(challenge)],
  );
  const m = (
    await db.query(
      'SELECT server_instance_id,data_epoch FROM instance_metadata',
    )
  ).rows[0];
  return {
    relay_url: config.pushRelayURL,
    binding: { ...m, device_id: identity.deviceId, challenge },
  };
}
export async function queueRevocation(tx: DB, owner: string, device: string) {
  await tx.query(
    `INSERT INTO notification_revocations(device_id,owner_id,ticket,relay_url,expires_at) SELECT device_id,owner_id,ticket,relay_url,expires_at FROM notification_bindings WHERE owner_id=$1 AND device_id=$2 AND ticket IS NOT NULL`,
    [owner, device],
  );
  await tx.query(
    'UPDATE notification_bindings SET enabled=false,ticket=NULL,challenge_hash=NULL,revision=revision+1 WHERE owner_id=$1 AND device_id=$2',
    [owner, device],
  );
  await tx.query(
    "UPDATE notification_deliveries SET state='suppressed',error_code='binding_revoked' WHERE device_id=$1 AND state IN ('pending','sending')",
    [device],
  );
}
export async function enableBinding(
  db: pg.Pool,
  config: Config,
  identity: Identity,
  ticket: string,
) {
  if (!config.pushRelayURL)
    throw new AppError(409, 'push_disabled', 'Relay disabled');
  const verified = await relayRequest(
    config,
    config.pushRelayURL,
    '/v1/tickets/verify',
    ticket,
  );
  await transaction(db, async (tx) => {
    const m = (
      await tx.query(
        'SELECT server_instance_id,data_epoch FROM instance_metadata',
      )
    ).rows[0];
    const d = (
      await tx.query('SELECT revoked_at FROM devices WHERE id=$1 FOR UPDATE', [
        identity.deviceId,
      ])
    ).rows[0];
    const b = (
      await tx.query(
        'SELECT *,challenge_expires_at>now() AS valid FROM notification_bindings WHERE device_id=$1 AND owner_id=$2 FOR UPDATE',
        [identity.deviceId, identity.ownerId],
      )
    ).rows[0];
    const v = verified.binding;
    if (
      !b?.valid ||
      d?.revoked_at ||
      !v ||
      v.server_instance_id !== m.server_instance_id ||
      v.data_epoch !== m.data_epoch ||
      v.device_id !== identity.deviceId ||
      typeof v.challenge !== 'string' ||
      hash(v.challenge) !== b.challenge_hash ||
      !['sandbox', 'production'].includes(verified.environment) ||
      typeof verified.topic !== 'string' ||
      !(Date.parse(verified.expires_at) > Date.now())
    )
      throw new AppError(
        403,
        'push_binding_mismatch',
        'Ticket does not match this device challenge',
      );
    await queueRevocation(tx, identity.ownerId, identity.deviceId);
    await tx.query(
      'UPDATE notification_bindings SET ticket=$2,enabled=true,relay_url=$3,expires_at=$4,topic=$5,environment=$6 WHERE device_id=$1',
      [
        identity.deviceId,
        encrypt(ticket, config, context(identity.ownerId, identity.deviceId)),
        config.pushRelayURL,
        verified.expires_at,
        verified.topic,
        verified.environment,
      ],
    );
  });
  return notificationStatus(db, config, identity);
}
export async function enqueueNotification(tx: DB, message: any) {
  if (
    message.role !== 'assistant' ||
    message.status !== 'completed' ||
    message.internal ||
    !message.content
  )
    return;
  // Quiet periods suppress all pushes, including quiet_interaction story progression.
  const quiet = (
    await tx.query(
      `SELECT COALESCE(p.quiet_start,'22:30') AS quiet_start,COALESCE(p.quiet_end,'08:00') AS quiet_end,to_char(now() AT TIME ZONE COALESCE(g.timezone,'Asia/Shanghai'),'HH24:MI') AS local_time FROM rooms r LEFT JOIN autonomy_policies p ON p.world_id=r.world_id LEFT JOIN autonomy_settings g ON g.owner_id=r.owner_id WHERE r.id=$1`,
      [message.room_id],
    )
  ).rows[0];
  if (
    quiet &&
    (quiet.quiet_start < quiet.quiet_end
      ? quiet.local_time >= quiet.quiet_start &&
        quiet.local_time < quiet.quiet_end
      : quiet.quiet_start !== quiet.quiet_end &&
        (quiet.local_time >= quiet.quiet_start ||
          quiet.local_time < quiet.quiet_end))
  )
    return;
  const event = (
    await tx.query(
      'INSERT INTO notification_events(owner_id,message_id) VALUES($1,$2) ON CONFLICT(message_id) DO UPDATE SET message_id=$2 RETURNING id',
      [message.owner_id, message.id],
    )
  ).rows[0].id;
  await tx.query(
    `INSERT INTO notification_deliveries(event_id,device_id,binding_revision) SELECT $1,b.device_id,b.revision FROM notification_bindings b JOIN devices d ON d.id=b.device_id WHERE b.owner_id=$2 AND b.enabled AND b.expires_at>now() AND d.revoked_at IS NULL ON CONFLICT DO NOTHING`,
    [event, message.owner_id],
  );
}
export async function resolveNotification(
  db: DB,
  identity: Identity,
  event: string,
) {
  const row = (
    await db.query(
      `SELECT m.id AS message_id,m.room_id FROM notification_events e JOIN notification_deliveries d ON d.event_id=e.id JOIN messages m ON m.id=e.message_id JOIN rooms r ON r.id=m.room_id JOIN worlds w ON w.id=r.world_id WHERE e.id=$1 AND e.owner_id=$2 AND d.device_id=$3 AND m.status='completed' AND NOT m.internal AND NOT r.deleted AND NOT w.deleted`,
      [event, identity.ownerId, identity.deviceId],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      404,
      'notification_unavailable',
      'Notification source is unavailable',
    );
  return row;
}
export async function dispatchNotifications(
  db: pg.Pool,
  config: Config,
  signal?: AbortSignal,
) {
  if (!config.pushRelayURL) return;
  const revocations = (
    await db.query(
      'SELECT * FROM notification_revocations WHERE next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10',
    )
  ).rows;
  for (const r of revocations) {
    if (signal?.aborted) return;
    try {
      await relayRequest(
        config,
        r.relay_url,
        '/v1/tickets/revoke',
        decrypt(r.ticket, config, context(r.owner_id, r.device_id)),
        undefined,
        signal,
      );
      await db.query('DELETE FROM notification_revocations WHERE id=$1', [
        r.id,
      ]);
    } catch {
      await db.query(
        "UPDATE notification_revocations SET attempts=attempts+1,next_attempt_at=now()+interval '5 minutes' WHERE id=$1",
        [r.id],
      );
    }
  }
  await db.query('DELETE FROM notification_revocations WHERE expires_at<now()');
  // A lost worker retries the same random delivery ID; the relay deduplicates it.
  const deliveries = await transaction(
    db,
    async (tx) =>
      (
        await tx.query(
          `UPDATE notification_deliveries SET state='sending',attempts=attempts+1,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id IN (SELECT id FROM notification_deliveries WHERE (state='pending' OR state='sending' AND lease_until<now()) AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`,
        )
      ).rows,
  );
  for (const d of deliveries) {
    if (signal?.aborted) return;
    const b = (
      await db.query(
        `SELECT b.*,e.owner_id,e.created_at,m.status,m.internal,r.deleted AS room_deleted,w.deleted AS world_deleted,d.revoked_at FROM notification_bindings b JOIN devices d ON d.id=b.device_id JOIN notification_events e ON e.id=$2 JOIN messages m ON m.id=e.message_id JOIN rooms r ON r.id=m.room_id JOIN worlds w ON w.id=r.world_id WHERE b.device_id=$1`,
        [d.device_id, d.event_id],
      )
    ).rows[0];
    let state = 'suppressed',
      code: string | null = 'binding_or_source_unavailable';
    if (
      b?.enabled &&
      b.ticket &&
      b.revision === d.binding_revision &&
      !b.revoked_at &&
      !b.room_deleted &&
      !b.world_deleted &&
      b.status === 'completed' &&
      !b.internal &&
      b.relay_url === config.pushRelayURL &&
      +b.expires_at > Date.now() &&
      Date.now() - +b.created_at < 86400000
    ) {
      try {
        const result = await relayRequest(
          config,
          b.relay_url,
          '/v1/deliveries',
          decrypt(b.ticket, config, context(b.owner_id, b.device_id)),
          { event_id: d.event_id, delivery_id: d.id },
          signal,
        );
        state = ['accepted', 'failed', 'unknown'].includes(result.state)
          ? result.state
          : 'unknown';
        code = state === 'accepted' ? null : 'relay_' + state;
        if (result.invalid_token)
          await transaction(db, (tx) =>
            queueRevocation(tx, b.owner_id, b.device_id),
          );
      } catch (e) {
        state =
          d.attempts < 5 &&
          !(e instanceof AppError && [401, 403, 410].includes(e.status))
            ? 'pending'
            : 'failed';
        code = 'relay_unavailable';
      }
    }
    await db.query(
      "UPDATE notification_deliveries SET state=$2,error_code=$3,updated_at=now(),next_attempt_at=now()+interval '1 minute',lease_until=NULL WHERE id=$1 AND state='sending'",
      [d.id, state, code],
    );
  }
}
