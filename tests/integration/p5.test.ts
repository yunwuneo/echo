import { canonical } from '../../packages/server/src/modules/mcp/schema.js';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool, transaction } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
  pair,
  authenticate,
  verifyKey,
  revoke,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import { buildApp } from '../../packages/server/src/app.js';
import { enqueue } from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import { mockModel } from '../fixtures/mock-model.js';
import {
  buildRelay,
  initializeRelay,
  invite,
  type RelayConfig,
} from '../../packages/push-relay/src/app.js';
import { payload, type Push } from '../../packages/push-relay/src/apns.js';
import {
  beginBinding,
  enableBinding,
  dispatchNotifications,
  resolveNotification,
  queueRevocation,
  enqueueNotification,
} from '../../packages/server/src/modules/notifications/index.js';
import {
  setMaintenance,
  rotateKey,
  prepareRestored,
  runtimeLease,
  diagnostics,
  deletionLedger,
  applyDeletionLedger,
} from '../../packages/server/src/modules/operations/index.js';
import { exportOwner } from '../../packages/server/src/modules/exports/index.js';
import { deleteMessage } from '../../packages/server/src/modules/memory/repository.js';
import { hash, decrypt } from '../../packages/server/src/security.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
  });
const rc: RelayConfig = {
  crypto: { ...config, masterKey: Buffer.alloc(32, 42) },
  topic: 'dev.echo2.synthetic',
  topics: ['dev.echo2.synthetic', 'dev.echo2.synthetic.mac'],
  environment: 'sandbox',
};
let owner: string,
  session: any,
  identity: any,
  world: string,
  room: string,
  relay: ReturnType<typeof buildRelay>,
  app: Awaited<ReturnType<typeof buildApp>>,
  mock: Awaited<ReturnType<typeof mockModel>>,
  sent: Push[],
  invalid = false,
  ticket: string;
beforeAll(async () => {
  await migrate(db);
  await initializeRelay(db, rc);
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE owners CASCADE; TRUNCATE push_relay.tickets,push_relay.invitations,push_relay.limits CASCADE',
  );
  await db.query('UPDATE instance_metadata SET maintenance=false');
  owner = await initializeOwner(db, config);
  session = await pair(
    db,
    (await createPairingCode(db, owner)).code,
    'P5 synthetic',
    randomUUID(),
  );
  identity = await authenticate(db, `Bearer ${session.access_token}`);
  sent = [];
  invalid = false;
  relay = buildRelay(db, rc, async (p) => {
    sent.push(p);
    return invalid
      ? { state: 'failed', invalid_token: true }
      : { state: 'accepted' };
  });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  config.pushRelayURL = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  mock = await mockModel();
  const provider = await createProvider(db, config, owner, {
    name: '合成模型',
    base_url: mock.url,
    api_key: 'never-export-this-model-key',
    model: 'mock-text',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  world = randomUUID();
  room = randomUUID();
  await db.query('INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)', [
    world,
    owner,
    '合成星港',
  ]);
  await db.query(
    'INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',
    [room, owner, world, '协议室', provider.id],
  );
  await db.query(
    "INSERT INTO autonomy_policies(world_id,owner_id,quiet_start,quiet_end) VALUES($1,$2,'00:00','00:00')",
    [world, owner],
  );
  app = await buildApp(db, config);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await relay.close();
  await mock.close();
  await db.query('UPDATE instance_metadata SET maintenance=false');
});
afterAll(() => db.end());
const request = (method: any, path: string, payload?: any) =>
  app.inject({
    method,
    url: '/v1/' + path,
    headers: { authorization: `Bearer ${session.access_token}` },
    payload,
  });
async function enroll(overrides: any = {}) {
  const binding = await beginBinding(db, config, identity);
  const response = await relay.inject({
    method: 'POST',
    url: '/v1/tickets',
    payload: {
      invitation: await invite(db, rc),
      binding: binding.binding,
      topic: rc.topic,
      environment: rc.environment,
      apns_token: 'ab'.repeat(32),
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  ticket = response.json().ticket;
  return enableBinding(db, config, identity, ticket);
}
async function message() {
  const ack = await enqueue(db, owner, room, {
    client_command_id: randomUUID(),
    content: '合成秘密：月港通行口令',
    addressed_actor_ids: [],
  });
  await execute(db, config, ack.run_id);
  return (
    await db.query(
      "SELECT * FROM messages WHERE run_id=$1 AND role='assistant'",
      [ack.run_id],
    )
  ).rows[0];
}
it('commits completion before push, deduplicates delivery, and authenticates click source without leaking content', async () => {
  await enroll();
  const m = await message();
  expect(m.status).toBe('completed');
  expect(sent).toHaveLength(0);
  const d = (await db.query('SELECT * FROM notification_deliveries')).rows[0];
  expect(d).toBeDefined();
  await dispatchNotifications(db, config);
  await dispatchNotifications(db, config);
  expect(sent).toHaveLength(1);
  expect(Object.keys(payload(sent[0]!)).sort()).toEqual([
    'aps',
    'data_epoch',
    'event_id',
    'server_instance_id',
  ]);
  expect(JSON.stringify(sent)).not.toContain('合成秘密');
  expect(JSON.stringify(sent)).not.toContain('never-export');
  expect((await resolveNotification(db, identity, d.event_id)).message_id).toBe(
    m.id,
  );
  await expect(
    resolveNotification(
      db,
      { ...identity, deviceId: randomUUID() },
      d.event_id,
    ),
  ).rejects.toThrow();
  const retry = await relay.inject({
    method: 'POST',
    url: '/v1/deliveries',
    headers: { authorization: `Bearer ${ticket}` },
    payload: { delivery_id: d.id, event_id: d.event_id },
  });
  expect(retry.json().state).toBe('accepted');
  expect(sent).toHaveLength(1);
  await deleteMessage(db, owner, m.id);
  await expect(resolveNotification(db, identity, d.event_id)).rejects.toThrow();
});
it('unconfigured relay keeps all business data and creates no delivery', async () => {
  config.pushRelayURL = undefined;
  const m = await message();
  await dispatchNotifications(db, config);
  expect(m.status).toBe('completed');
  expect(sent).toHaveLength(0);
  expect((await request('GET', 'notifications')).json().available).toBe(false);
});
it('invitation is one-use, topic/environment are bound, extra payload and unauthenticated sends fail', async () => {
  const binding = (await beginBinding(db, config, identity)).binding;
  const invitation = await invite(db, rc);
  const b = {
    binding,
    invitation,
    topic: rc.topic,
    environment: rc.environment,
    apns_token: 'ab'.repeat(32),
  };
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/tickets',
        payload: { ...b, environment: 'production' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/tickets',
        payload: { ...b, topic: 'other.app' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await relay.inject({ method: 'POST', url: '/v1/tickets', payload: b }))
      .statusCode,
  ).toBe(200);
  expect(
    (await relay.inject({ method: 'POST', url: '/v1/tickets', payload: b }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/deliveries',
        payload: { delivery_id: randomUUID(), event_id: randomUUID() },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await request('PUT', 'notifications/binding', {
        ticket: 'x'.repeat(43),
        body: 'secret',
      })
    ).statusCode,
  ).toBe(400);
});
it('ticket cannot bind a different device, stale challenge, or restored epoch', async () => {
  const binding = (await beginBinding(db, config, identity)).binding;
  const r = await relay.inject({
    method: 'POST',
    url: '/v1/tickets',
    payload: {
      invitation: await invite(db, rc),
      binding: { ...binding, device_id: randomUUID() },
      topic: rc.topic,
      environment: rc.environment,
      apns_token: 'ab'.repeat(32),
    },
  });
  await expect(
    enableBinding(db, config, identity, r.json().ticket),
  ).rejects.toThrow();
  await enroll();
  await expect(enableBinding(db, config, identity, ticket)).rejects.toThrow();
});
it('revocation suppresses pending deliveries and is retried durably at relay', async () => {
  await enroll();
  await message();
  await revoke(db, identity, session.device_id);
  await dispatchNotifications(db, config);
  expect(sent).toHaveLength(0);
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/tickets/verify',
        headers: { authorization: `Bearer ${ticket}` },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await db.query('SELECT * FROM notification_revocations')).rowCount,
  ).toBe(0);
});
it('one relay supports distinct iOS/macOS topics while invitations remain topic-bound', async () => {
  const mac = 'dev.echo2.synthetic.mac';
  await enroll({
    topic: mac,
    invitation: await invite(db, { ...rc, topic: mac }),
  });
  await message();
  await dispatchNotifications(db, config);
  expect(sent[0]!.topic).toBe(mac);
  const binding = (await beginBinding(db, config, identity)).binding;
  const response = await relay.inject({
    method: 'POST',
    url: '/v1/tickets',
    payload: {
      invitation: await invite(db, rc),
      binding,
      topic: mac,
      environment: 'sandbox',
      apns_token: 'ab'.repeat(32),
    },
  });
  expect(response.statusCode).toBe(401);
});
it('APNs token rotation stays bound to the authorized ticket and reaches the new address', async () => {
  await enroll();
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/tickets/token',
        headers: { authorization: `Bearer ${ticket}` },
        payload: { apns_token: 'cd'.repeat(32) },
      })
    ).statusCode,
  ).toBe(200);
  await message();
  await dispatchNotifications(db, config);
  expect(sent[0]!.token).toBe('cd'.repeat(32));
  await db.query(
    "UPDATE push_relay.tickets SET expires_at=now()-interval '1 second'",
  );
  expect(
    (
      await relay.inject({
        method: 'POST',
        url: '/v1/tickets/token',
        headers: { authorization: `Bearer ${ticket}` },
        payload: { apns_token: 'ef'.repeat(32) },
      })
    ).statusCode,
  ).toBe(401);
});
it('APNs invalid token disables binding without claiming visible delivery', async () => {
  await enroll();
  await message();
  invalid = true;
  await dispatchNotifications(db, config);
  expect((await request('GET', 'notifications')).json().enabled).toBe(false);
  expect(
    (await db.query('SELECT state FROM notification_deliveries')).rows[0].state,
  ).not.toBe('accepted');
});
it('relay outage does not affect completed messages and expired worker lease recovers same ID', async () => {
  await enroll();
  const m = await message();
  await relay.close();
  await dispatchNotifications(db, config);
  const d = (await db.query('SELECT * FROM notification_deliveries')).rows[0];
  expect(d.state).toBe('pending');
  expect(m.status).toBe('completed');
  await db.query(
    "UPDATE notification_deliveries SET state='sending',lease_until=now()-interval '1 minute',next_attempt_at=now()",
  );
  relay = buildRelay(db, rc, async (p) => {
    sent.push(p);
    return { state: 'accepted' };
  });
  await relay.listen({
    host: '127.0.0.1',
    port: Number(new URL(config.pushRelayURL!).port),
  });
  await dispatchNotifications(db, config);
  expect(
    (await db.query('SELECT id,state FROM notification_deliveries')).rows[0],
  ).toMatchObject({ id: d.id, state: 'accepted' });
  expect(sent).toHaveLength(1);
});
it('quiet period and rolled-back completion never push', async () => {
  await enroll();
  await db.query(
    "UPDATE autonomy_policies SET quiet_start='00:00',quiet_end='23:59'",
  );
  await message();
  expect(
    (await db.query('SELECT * FROM notification_deliveries')).rowCount,
  ).toBe(0);
  await db.query("UPDATE autonomy_policies SET quiet_end='00:00'");
  const m = (await db.query("SELECT * FROM messages WHERE role='assistant'"))
    .rows[0];
  await expect(
    transaction(db, async (tx) => {
      await enqueueNotification(tx, m);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(
    (await db.query('SELECT * FROM notification_deliveries')).rowCount,
  ).toBe(0);
});
it('relay rate limits, rejects conflicting IDs and never replays a dispatch with unknown outcome', async () => {
  await enroll();
  const h = hash(ticket),
    id = randomUUID(),
    event = randomUUID();
  await db.query(
    'INSERT INTO push_relay.deliveries(id,ticket_hash,event_id) VALUES($1,$2,$3)',
    [id, h, event],
  );
  const call = (delivery: string, e: string) =>
    relay.inject({
      method: 'POST',
      url: '/v1/deliveries',
      headers: { authorization: `Bearer ${ticket}` },
      payload: { delivery_id: delivery, event_id: e },
    });
  expect((await call(id, event)).json().state).toBe('unknown');
  expect(sent).toHaveLength(0);
  expect((await call(id, randomUUID())).statusCode).toBe(409);
  await db.query('INSERT INTO push_relay.limits(key,count) VALUES($1,60)', [
    `ticket:${h}`,
  ]);
  expect((await call(randomUUID(), randomUUID())).statusCode).toBe(429);
});
it('export preserves source data and unknown import extensions, excludes credentials and session secrets', async () => {
  const m = await message();
  await db.query(
    "INSERT INTO import_jobs(id,owner_id,world_id,file_hash,adapter_version,format,raw,preview) VALUES($1,$2,$3,$4,1,'json',$5,'{}')",
    [
      randomUUID(),
      owner,
      world,
      'synthetic',
      Buffer.from('{"extensions":{"unknown":"preserved"}}'),
    ],
  );
  const e = await exportOwner(db, owner);
  expect(e.checksum).toBe(hash(canonical(JSON.parse(JSON.stringify(e.data)))));
  expect(JSON.stringify(e)).not.toContain('never-export-this');
  expect(JSON.stringify(e)).not.toContain(session.access_token);
  expect(e.data.sections.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: m.id })]),
  );
  expect((e.data.sections.imports![0] as any).raw_base64).toBe(
    Buffer.from('{"extensions":{"unknown":"preserved"}}').toString('base64'),
  );
  expect((await request('POST', 'exports')).statusCode).toBe(200);
});
it('maintenance blocks API and active process locks reject rotation; bad credentials roll whole rotation back', async () => {
  await enroll();
  const next = { ...config, masterKey: Buffer.alloc(32, 99), keyVersion: 2 };
  const release = await runtimeLease(db, config);
  await setMaintenance(db, true);
  expect(
    (
      await request('POST', 'rooms/' + room + '/messages', {
        client_command_id: randomUUID(),
        content: 'blocked',
      })
    ).statusCode,
  ).toBe(503);
  await expect(rotateKey(db, config, next)).rejects.toThrow('Stop API');
  await release();
  await db.query(
    "UPDATE notification_bindings SET ticket=jsonb_set(ticket,'{tag}','\"corrupt\"')",
  );
  await expect(rotateKey(db, config, next)).rejects.toThrow();
  await verifyKey(db, config);
  const p = (await db.query('SELECT * FROM provider_connections')).rows[0];
  expect(decrypt(p.credential, config, `${owner}:${p.id}`)).toBe(
    'never-export-this-model-key',
  );
});
it('rotates all credential contexts atomically and old key fails after success', async () => {
  await enroll();
  await transaction(db, (tx) => queueRevocation(tx, owner, session.device_id));
  await setMaintenance(db, true);
  const next = { ...config, masterKey: Buffer.alloc(32, 99), keyVersion: 2 };
  await rotateKey(db, config, next);
  await expect(verifyKey(db, config)).rejects.toThrow();
  await verifyKey(db, next);
  const r = (await db.query('SELECT * FROM notification_revocations')).rows[0];
  expect(decrypt(r.ticket, next, `${owner}:push:${session.device_id}`)).toBe(
    ticket,
  );
  // Return this shared synthetic instance to the baseline key for the other suites.
  await db.query('TRUNCATE owners CASCADE; DELETE FROM instance_metadata');
  await initializeOwner(db, config);
});
it('restore changes epoch, keeps quarantine, revokes sessions and never resumes pending work', async () => {
  await enroll();
  const ack = await enqueue(db, owner, room, {
    client_command_id: randomUUID(),
    content: 'queued',
    addressed_actor_ids: [],
  });
  const prior = (await db.query('SELECT data_epoch FROM instance_metadata'))
    .rows[0].data_epoch;
  await setMaintenance(db, true);
  const m = await prepareRestored(db, config);
  expect(m.data_epoch).not.toBe(prior);
  expect(m.maintenance).toBe(true);
  await expect(
    authenticate(db, `Bearer ${session.access_token}`),
  ).rejects.toThrow();
  expect(
    (await db.query('SELECT state FROM runs WHERE id=$1', [ack.run_id])).rows[0]
      .state,
  ).toBe('interrupted');
  expect(
    (await db.query('SELECT enabled FROM notification_bindings')).rows[0]
      .enabled,
  ).toBe(false);
  expect((await diagnostics(db)).maintenance).toBe(true);
});
it('privacy ledger can reapply a newer deletion after old backup restore', async () => {
  const m = await message();
  await deleteMessage(db, owner, m.id);
  const ledger = await deletionLedger(db);
  expect(ledger.items).toContainEqual({
    owner_id: owner,
    entity_id: m.id,
    kind: 'message',
  });
  await db.query(
    "UPDATE messages SET content='old backup resurrected text',status='completed' WHERE id=$1",
    [m.id],
  );
  await setMaintenance(db, true);
  await applyDeletionLedger(db, ledger);
  expect(
    (await db.query('SELECT content FROM messages WHERE id=$1', [m.id])).rows[0]
      .content,
  ).toBe('');
  await expect(
    applyDeletionLedger(db, { ...ledger, server_instance_id: randomUUID() }),
  ).rejects.toThrow();
});
it('P4 upgrade adds disabled notification and stable maintenance defaults without altering data', async () => {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('CREATE SCHEMA p5_upgrade');
    await tx.query('SET LOCAL search_path=p5_upgrade,public');
    for (const f of [
      '001_foundation.sql',
      '002_worlds_and_cast.sql',
      '003_memory_and_imports.sql',
      '004_autonomy_and_tools.sql',
    ])
      await tx.query(await readFile('migrations/' + f, 'utf8'));
    await tx.query("INSERT INTO instance_metadata(key_check) VALUES('{}')");
    await tx.query('INSERT INTO owners DEFAULT VALUES');
    await tx.query(
      await readFile('migrations/005_notifications_and_operations.sql', 'utf8'),
    );
    expect(
      (await tx.query('SELECT maintenance FROM instance_metadata')).rows[0]
        .maintenance,
    ).toBe(false);
    expect(
      (await tx.query('SELECT * FROM notification_bindings')).rowCount,
    ).toBe(0);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  await migrate(db);
});

it('P5 to P6 migration preserves existing snapshots and rolls back interrupted DDL', async () => {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('CREATE SCHEMA p6_upgrade');
    await tx.query('SET LOCAL search_path=p6_upgrade,public');
    for (const f of [
      '001_foundation.sql',
      '002_worlds_and_cast.sql',
      '003_memory_and_imports.sql',
      '004_autonomy_and_tools.sql',
      '005_notifications_and_operations.sql',
    ])
      await tx.query(await readFile('migrations/' + f, 'utf8'));
    const owner = (
      await tx.query('INSERT INTO owners DEFAULT VALUES RETURNING id')
    ).rows[0].id;
    const id = randomUUID(),
      records = [
        { kind: 'world', entity_id: randomUUID(), data: { name: '旧快照' } },
      ];
    await tx.query(
      'INSERT INTO sync_snapshots(id,owner_id,metadata,records) VALUES($1,$2,$3,$4)',
      [id, owner, {}, JSON.stringify(records)],
    );
    const sql = await readFile('migrations/006_snapshot_pages.sql', 'utf8');
    await tx.query('SAVEPOINT interruption');
    await tx.query(sql);
    await tx.query('ROLLBACK TO SAVEPOINT interruption');
    expect(
      (
        await tx.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='p6_upgrade' AND table_name='sync_snapshots' AND column_name='record_count'",
        )
      ).rowCount,
    ).toBe(0);
    await tx.query(sql);
    const old = (
      await tx.query('SELECT * FROM sync_snapshots WHERE id=$1', [id])
    ).rows[0];
    expect(old.records).toEqual(records);
    expect(old.record_count).toBeNull();
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  await migrate(db);
});
