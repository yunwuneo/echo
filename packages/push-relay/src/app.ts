import Fastify from 'fastify';
import { Type } from '@sinclair/typebox';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { transaction, type DB } from '../../server/src/db/index.js';
import {
  AppError,
  token,
  hash,
  encrypt,
  decrypt,
} from '../../server/src/security.js';
import type { Config } from '../../server/src/config.js';
import { RelayEnrollment, RelayDelivery } from '../../contracts/src/p5.js';
import type { Push, PushResult } from './apns.js';
export interface RelayConfig {
  crypto: Config;
  topic: string;
  topics?: string[];
  environment: 'sandbox' | 'production';
}
export async function initializeRelay(db: pg.Pool, config: RelayConfig) {
  await transaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(77210005)');
    await tx.query(
      await readFile(
        new URL(
          '../../../../packages/push-relay/src/schema.sql',
          import.meta.url,
        ),
        'utf8',
      ).catch(() => readFile(new URL('./schema.sql', import.meta.url), 'utf8')),
    );
    await tx.query(
      'INSERT INTO push_relay.metadata(key_check) VALUES($1) ON CONFLICT DO NOTHING',
      [encrypt('echo-relay', config.crypto, 'relay')],
    );
    const v = (await tx.query('SELECT key_check FROM push_relay.metadata'))
      .rows[0].key_check;
    if (decrypt(v, config.crypto, 'relay') !== 'echo-relay')
      throw new Error('Relay key mismatch');
  });
}
export async function invite(db: DB, config: RelayConfig) {
  const invitation = token();
  await db.query(
    "INSERT INTO push_relay.invitations(hash,topic,environment,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [hash(invitation), config.topic, config.environment],
  );
  return invitation;
}
async function limit(tx: DB, key: string, max: number, seconds: number) {
  const r = (
    await tx.query(
      `INSERT INTO push_relay.limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN push_relay.limits.window_start<now()-$2*interval '1 second' THEN 1 ELSE push_relay.limits.count+1 END,window_start=CASE WHEN push_relay.limits.window_start<now()-$2*interval '1 second' THEN now() ELSE push_relay.limits.window_start END RETURNING count`,
      [key, seconds],
    )
  ).rows[0];
  if (r.count > max)
    throw new AppError(429, 'rate_limited', 'Relay rate limit');
}
export function buildRelay(
  db: pg.Pool,
  config: RelayConfig,
  send: (push: Push) => Promise<PushResult>,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 4096,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler((e, r, reply) => {
    const status =
      e instanceof AppError ? e.status : (e as any).validation ? 400 : 500;
    void reply.code(status).send({
      error: { code: e instanceof AppError ? e.code : 'relay_error' },
    });
  });
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });
  app.post('/v1/tickets', { schema: { body: RelayEnrollment } }, async (r) => {
    const b = r.body as any;
    // Persist failed-enrollment counts too; rolled-back authorization is not a limiter.
    await limit(db, `enroll:${hash(r.ip)}`, 10, 60);
    if (
      !(config.topics ?? [config.topic]).includes(b.topic) ||
      b.environment !== config.environment
    )
      throw new AppError(
        400,
        'app_environment_mismatch',
        'Topic or environment mismatch',
      );
    return transaction(db, async (tx) => {
      const i = await tx.query(
        'UPDATE push_relay.invitations SET consumed_at=now() WHERE hash=$1 AND consumed_at IS NULL AND expires_at>now() AND topic=$2 AND environment=$3 RETURNING hash',
        [hash(b.invitation), b.topic, b.environment],
      );
      if (!i.rowCount)
        throw new AppError(401, 'invalid_invitation', 'Invalid invitation');
      const ticket = token(),
        h = hash(ticket);
      // Re-registration replaces the prior route for exactly this instance/epoch/device.
      await tx.query(
        "UPDATE push_relay.tickets SET revoked_at=now() WHERE binding->>'server_instance_id'=$1 AND binding->>'data_epoch'=$2 AND binding->>'device_id'=$3",
        [
          b.binding.server_instance_id,
          b.binding.data_epoch,
          b.binding.device_id,
        ],
      );
      const row = (
        await tx.query(
          'INSERT INTO push_relay.tickets(hash,binding,topic,environment,apns_token) VALUES($1,$2,$3,$4,$5) RETURNING expires_at',
          [
            h,
            b.binding,
            b.topic,
            b.environment,
            encrypt(b.apns_token, config.crypto, `relay:${h}`),
          ],
        )
      ).rows[0];
      return { ticket, expires_at: row.expires_at };
    });
  });
  async function auth(header?: string, revoked = false) {
    if (
      !header?.startsWith('Bearer ') ||
      !/^[A-Za-z0-9_-]{43}$/.test(header.slice(7))
    )
      throw new AppError(401, 'invalid_ticket', 'Invalid ticket');
    const h = hash(header.slice(7));
    const b = (
      await db.query(
        'SELECT * FROM push_relay.tickets WHERE hash=$1 AND expires_at>now()',
        [h],
      )
    ).rows[0];
    if (
      !b ||
      (!revoked && b.revoked_at) ||
      !(config.topics ?? [config.topic]).includes(b.topic) ||
      b.environment !== config.environment
    )
      throw new AppError(401, 'invalid_ticket', 'Invalid ticket');
    return b;
  }
  const empty = {
    schema: { body: Type.Object({}, { additionalProperties: false }) },
  };
  app.post(
    '/v1/tickets/token',
    {
      schema: {
        body: Type.Object(
          { apns_token: Type.String({ pattern: '^[0-9a-f]{64,200}$' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (r) => {
      const b = await auth(r.headers.authorization);
      await limit(db, `token:${b.hash}`, 10, 3600);
      await db.query(
        'UPDATE push_relay.tickets SET apns_token=$2 WHERE hash=$1 AND revoked_at IS NULL',
        [
          b.hash,
          encrypt((r.body as any).apns_token, config.crypto, `relay:${b.hash}`),
        ],
      );
      return { updated: true };
    },
  );
  app.post('/v1/tickets/verify', empty, async (r) => {
    const b = await auth(r.headers.authorization);
    return {
      binding: b.binding,
      topic: b.topic,
      environment: b.environment,
      expires_at: b.expires_at,
    };
  });
  app.post('/v1/tickets/revoke', empty, async (r) => {
    const b = await auth(r.headers.authorization, true);
    await db.query(
      'UPDATE push_relay.tickets SET revoked_at=COALESCE(revoked_at,now()) WHERE hash=$1',
      [b.hash],
    );
    return { revoked: true };
  });
  app.post('/v1/deliveries', { schema: { body: RelayDelivery } }, async (r) => {
    const b = await auth(r.headers.authorization),
      input = r.body as any;
    const result = await transaction(db, async (tx) => {
      await tx.query(
        'SELECT hash FROM push_relay.tickets WHERE hash=$1 FOR UPDATE',
        [b.hash],
      );
      const current = (
        await tx.query(
          'SELECT revoked_at FROM push_relay.tickets WHERE hash=$1',
          [b.hash],
        )
      ).rows[0];
      if (current.revoked_at)
        throw new AppError(401, 'invalid_ticket', 'Revoked ticket');
      const previous = (
        await tx.query('SELECT * FROM push_relay.deliveries WHERE id=$1', [
          input.delivery_id,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.ticket_hash !== b.hash ||
          previous.event_id !== input.event_id
        )
          throw new AppError(
            409,
            'delivery_conflict',
            'Delivery identifier already used',
          );
        return {
          state: previous.state === 'sending' ? 'unknown' : previous.state,
          invalid_token: previous.invalid_token,
        };
      }
      await limit(tx, `ticket:${b.hash}`, 60, 3600);
      await limit(tx, `instance:${b.binding.server_instance_id}`, 600, 3600);
      await tx.query(
        'INSERT INTO push_relay.deliveries(id,ticket_hash,event_id) VALUES($1,$2,$3)',
        [input.delivery_id, b.hash, input.event_id],
      );
      return null;
    });
    if (result) return result;
    // Commit before APNs. Crash/response loss stays unknown and is never transparently replayed.
    let delivered: PushResult;
    try {
      delivered = await send({
        token: decrypt(b.apns_token, config.crypto, `relay:${b.hash}`),
        topic: b.topic,
        environment: b.environment,
        event: input.event_id,
        delivery: input.delivery_id,
        instance: b.binding.server_instance_id,
        epoch: b.binding.data_epoch,
      });
    } catch {
      delivered = { state: 'unknown' };
    }
    await transaction(db, async (tx) => {
      await tx.query(
        'UPDATE push_relay.deliveries SET state=$2,invalid_token=$3 WHERE id=$1',
        [input.delivery_id, delivered.state, delivered.invalid_token ?? false],
      );
      if (delivered.invalid_token)
        await tx.query(
          'UPDATE push_relay.tickets SET revoked_at=now() WHERE hash=$1',
          [b.hash],
        );
    });
    return delivered;
  });
  return app;
}
