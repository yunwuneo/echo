import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, symlink, readdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
  pair,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import {
  claimProvider,
  saveModelRoute,
} from '../../packages/server/src/modules/providers/routes.js';
import { buildApp } from '../../packages/server/src/app.js';
import {
  enqueue,
  getRun,
  claim,
  cancel,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import { command } from '../../packages/server/src/modules/commands/index.js';
import { readAsset } from '../../packages/server/src/modules/assets/index.js';
import { mockModel } from '../fixtures/mock-model.js';
import { hash, encrypt } from '../../packages/server/src/security.js';
import { canonical } from '../../packages/server/src/modules/mcp/schema.js';
import { referenceAsset } from '../../packages/server/src/modules/assets/index.js';
import { deleteMessage } from '../../packages/server/src/modules/memory/repository.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated echo2_test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    ALLOW_INSECURE_LOCAL: 'true',
    LEASE_MS: '5000',
    MODEL_TIMEOUT_MS: '3000',
  });
let owner: string,
  token: string,
  world: any,
  actors: any[],
  rooms: any[],
  providers: any[];
let app: Awaited<ReturnType<typeof buildApp>>,
  mock: Awaited<ReturnType<typeof mockModel>>;
async function request(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: any,
) {
  return app.inject({
    method,
    url: '/v1/' + path,
    headers: { authorization: `Bearer ${token}` },
    ...(body ? { payload: body } : {}),
  });
}
async function create(path: string, body: any) {
  const r = await request('POST', path, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function send(room = rooms[0].id) {
  return enqueue(db, owner, room, {
    client_command_id: randomUUID(),
    content: '合成消息',
  });
}
async function route(
  subject: string,
  state: 'inherit' | 'disabled' | 'override',
  provider?: string,
  revision = 0,
  capability: any = 'chat',
) {
  return saveModelRoute(db, owner, {
    operation_id: randomUUID(),
    expected_revision: revision,
    subject_id: subject,
    subject_kind: subject === owner ? 'owner' : 'actor',
    capability,
    route: state === 'override' ? { state, provider_id: provider! } : { state },
  });
}
beforeAll(() => migrate(db));
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  token = (
    await pair(
      db,
      (await createPairingCode(db, owner)).code,
      '规格合成设备',
      randomUUID(),
    )
  ).access_token;
  mock = await mockModel();
  providers = [];
  for (const model of ['first', 'second'])
    providers.push(
      await createProvider(db, config, owner, {
        name: model,
        model,
        base_url: mock.url,
        api_key: 'synthetic-secret',
        context_window: 32768,
        max_output_tokens: 1024,
      }),
    );
  app = await buildApp(db, config);
  await app.ready();
  world = await create('worlds', {
    name: '合成世界',
    description: '',
    persona: { name: '测试', description: '' },
  });
  actors = [];
  for (const name of ['甲', '乙']) {
    const template = await create('characters', {
      name,
      description: '',
      personality: '',
      voice: '',
      scenario: '',
      example: '',
      greeting: '',
    });
    actors.push(
      await create('actors', {
        world_id: world.id,
        template_id: template.id,
        template_revision: 1,
        name,
        participation: 50,
      }),
    );
  }
  rooms = [];
  for (const actor of [actors[0], actors[0], actors[1]])
    rooms.push(
      await create('rooms', {
        world_id: world.id,
        name: '合成私聊',
        kind: 'direct',
        max_replies: 1,
        actor_ids: [actor.id],
        provider_id: providers[0].id,
      }),
    );
});
afterEach(async () => {
  await app?.close();
  await mock?.close();
});
afterAll(() => db.end());

it('transactional operations deduplicate concurrent calls, reject changed payload and roll back receipt with failed write', async () => {
  const op = randomUUID();
  let effects = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      command(db, owner, 'test', op, { v: 1 }, async (tx) => {
        effects++;
        await tx.query('UPDATE worlds SET revision=revision+1 WHERE id=$1', [
          world.id,
        ]);
        return { id: world.id };
      }),
    ),
  );
  expect(effects).toBe(1);
  expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  await expect(
    command(db, owner, 'test', op, { v: 2 }, async () => null),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  const bad = randomUUID();
  await expect(
    command(db, owner, 'test', bad, {}, async (tx) => {
      await tx.query('UPDATE worlds SET name=$2 WHERE id=$1', [
        world.id,
        '不能留下',
      ]);
      throw new Error('injected crash');
    }),
  ).rejects.toThrow('injected crash');
  expect(
    (await db.query('SELECT name FROM worlds WHERE id=$1', [world.id])).rows[0]
      .name,
  ).toBe('合成世界');
  expect(
    (
      await db.query('SELECT 1 FROM operation_receipts WHERE operation_id=$1', [
        bad,
      ])
    ).rowCount,
  ).toBe(0);
});

it('Q19/Q33 protects shared originals, rejects stale deletion previews and does not multiply bytes on retry', async () => {
  const body = {
    operation_id: randomUUID(),
    world_id: world.id,
    mime: 'text/plain',
    content_base64: Buffer.from('原件').toString('base64'),
  };
  const a = await create('assets', body);
  expect(await create('assets', body)).toEqual(a);
  expect(
    (await create('assets', { ...body, operation_id: randomUUID() })).id,
  ).toBe(a.id);
  const initial = (
    await request('GET', `assets/${a.id}/deletion-preview`)
  ).json();
  const m1 = await send(),
    m2 = await send(rooms[1].id);
  const binding = {
    operation_id: randomUUID(),
    expected_revision: 1,
    message_id: m1.message_id,
    purpose: 'attachment',
    enabled: true,
  };
  expect(
    (await request('PUT', `assets/${a.id}/references`, binding)).statusCode,
  ).toBe(200);
  expect(
    (await request('PUT', `assets/${a.id}/references`, binding)).json()
      .revision,
  ).toBe(2);
  expect(
    (
      await request('POST', `assets/${a.id}/delete`, {
        operation_id: randomUUID(),
        expected_revision: 1,
        preview_token: initial.preview_token,
      })
    ).statusCode,
  ).toBe(409);
  await request('PUT', `assets/${a.id}/references`, {
    ...binding,
    operation_id: randomUUID(),
    expected_revision: 2,
    message_id: m2.message_id,
  });
  const shared = (
    await request('GET', `assets/${a.id}/deletion-preview`)
  ).json();
  expect(shared.references).toHaveLength(2);
  expect(shared.can_delete).toBe(false);
  expect(
    (
      await request('POST', `assets/${a.id}/delete`, {
        operation_id: randomUUID(),
        expected_revision: 3,
        preview_token: shared.preview_token,
      })
    ).json().error.code,
  ).toBe('resource_in_use');
  await request('PUT', `assets/${a.id}/references`, {
    ...binding,
    operation_id: randomUUID(),
    expected_revision: 3,
    enabled: false,
  });
  expect((await readAsset(db, owner, a.id)).content_base64).toBe(
    body.content_base64,
  );
  await request('PUT', `assets/${a.id}/references`, {
    ...binding,
    operation_id: randomUUID(),
    message_id: m2.message_id,
    expected_revision: 4,
    enabled: false,
  });
  const empty = (
    await request('GET', `assets/${a.id}/deletion-preview`)
  ).json();
  const deletion = {
    operation_id: randomUUID(),
    expected_revision: 5,
    preview_token: empty.preview_token,
  };
  expect(
    (await request('POST', `assets/${a.id}/delete`, deletion)).json().deleted,
  ).toBe(true);
  expect(
    (await request('POST', `assets/${a.id}/delete`, deletion)).json().deleted,
  ).toBe(true);
  expect((await db.query('SELECT count(*) FROM assets')).rows[0].count).toBe(
    '0',
  );
});

it('rejects cross-owner reads, cross-world references and private assets exposed to another actor', async () => {
  const a = await create('assets', {
    operation_id: randomUUID(),
    world_id: world.id,
    actor_id: actors[0].id,
    mime: 'text/plain',
    content_base64: Buffer.from('私密').toString('base64'),
  });
  await expect(readAsset(db, randomUUID(), a.id)).rejects.toMatchObject({
    status: 404,
  });
  const message = await send(rooms[2].id);
  expect(
    (
      await request('PUT', `assets/${a.id}/references`, {
        operation_id: randomUUID(),
        expected_revision: 1,
        message_id: message.message_id,
        purpose: 'attachment',
        enabled: true,
      })
    ).statusCode,
  ).toBe(403);
  const other = await create('worlds', {
    name: '其他世界',
    description: '',
    persona: { name: '测试', description: '' },
  });
  const b = await create('assets', {
    operation_id: randomUUID(),
    world_id: other.id,
    mime: 'text/plain',
    content_base64: 'eA==',
  });
  expect(
    (
      await request('PUT', `assets/${b.id}/references`, {
        operation_id: randomUUID(),
        expected_revision: 1,
        message_id: message.message_id,
        purpose: 'attachment',
        enabled: true,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await db.query('SELECT count(*) FROM asset_references')).rows[0].count,
  ).toBe('0');
});

it('Q01 changes both existing private conversations for one actor only, and records actual outbound model', async () => {
  await route(actors[0].id, 'override', providers[1].id);
  for (const room of rooms) {
    const ack = await send(room.id);
    await execute(db, config, ack.run_id);
    expect((await getRun(db, owner, ack.run_id)).state).toBe('completed');
  }
  expect(mock.requests.map((r) => r.model)).toEqual([
    'second',
    'second',
    'first',
  ]);
  const manifests = (
    await db.query('SELECT data FROM prompt_manifests ORDER BY run_id')
  ).rows;
  expect(
    manifests.every((m) => m.data.model_route.provider_revision === 1),
  ).toBe(true);
  expect(JSON.stringify(manifests)).not.toContain('synthetic-secret');
  expect(manifests.every((m) => m.data.message_versions.length > 0)).toBe(true);
  expect(new Set(manifests.map((m) => m.data.payload_sha256))).toEqual(
    new Set(mock.requests.map((r) => hash(canonical(r)))),
  );
});

it('Q01 disabled never inherits; stale config cannot overwrite; tool continuations retain frozen route after edits', async () => {
  await route(owner, 'override', providers[1].id);
  await route(actors[0].id, 'disabled');
  const disabled = await send();
  await execute(db, config, disabled.run_id);
  expect((await getRun(db, owner, disabled.run_id)).error_code).toBe(
    'capability_disabled',
  );
  expect(mock.calls).toBe(0);
  await expect(route(actors[0].id, 'inherit')).rejects.toMatchObject({
    code: 'revision_conflict',
  });
  await route(actors[0].id, 'inherit', undefined, 1);
  const ack = await send(),
    frozen = await claim(db, ack.run_id, 5000, 100);
  expect(frozen?.provider.model).toBe('second');
  await route(actors[0].id, 'override', providers[0].id, 2);
  const room = (
    await db.query('SELECT * FROM rooms WHERE id=$1', [rooms[0].id])
  ).rows[0];
  expect((await claimProvider(db, frozen!.run, room, actors[0].id)).model).toBe(
    'second',
  );
  await db.query(
    'UPDATE provider_connections SET revision=revision+1 WHERE id=$1',
    [providers[1].id],
  );
  await expect(
    claimProvider(db, frozen!.run, room, actors[0].id),
  ).rejects.toMatchObject({ code: 'provider_changed' });
  await cancel(db, owner, ack.run_id);
});

it('strict schemas reject a fake override/disabled mixture and corrupted assets fail explicitly', async () => {
  const response = await request('PUT', 'model-routes', {
    operation_id: randomUUID(),
    expected_revision: 0,
    subject_kind: 'actor',
    subject_id: actors[0].id,
    capability: 'chat',
    route: { state: 'disabled', provider_id: providers[0].id },
  });
  expect(response.statusCode).toBe(400);
  const a = await create('assets', {
    operation_id: randomUUID(),
    world_id: world.id,
    mime: 'text/plain',
    content_base64: 'eA==',
  });
  await db.query("UPDATE assets SET content='y'::bytea WHERE id=$1", [a.id]);
  expect((await request('GET', `assets/${a.id}`)).json().error.code).toBe(
    'asset_corrupt',
  );
});

it('connection editing is revisioned, idempotent and never returns or records plaintext credentials', async () => {
  const body = {
    operation_id: randomUUID(),
    name: '新连接',
    model: 'third',
    base_url: mock.url,
    api_key: 'synthetic-new-secret',
    context_window: 32768,
    max_output_tokens: 1024,
  };
  const first = await create('providers', body),
    second = await create('providers', body);
  expect(first).toEqual(second);
  expect(mock.calls).toBe(0);
  const update = { ...body, operation_id: randomUUID(), name: '修改名称' };
  const call = () =>
    app.inject({
      method: 'PUT',
      url: `/v1/providers/${first.id}`,
      headers: { authorization: `Bearer ${token}`, 'if-match': '1' },
      payload: update,
    });
  const changed = await call();
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().revision).toBe(2);
  expect((await call()).json()).toEqual(changed.json());
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/v1/providers/${first.id}`,
        headers: { authorization: `Bearer ${token}`, 'if-match': '1' },
        payload: { ...update, operation_id: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    JSON.stringify((await db.query('SELECT * FROM operation_receipts')).rows),
  ).not.toContain(body.api_key);
  expect((await request('GET', 'providers')).body).not.toContain(body.api_key);
});

it('Q03 editing retains versions and marks retained tail; selection never overwrites an old version; selected-only export excludes originals', async () => {
  const ack = await send();
  await execute(db, config, ack.run_id);
  const before = (
    await request('GET', `messages/${ack.message_id}/versions`)
  ).json();
  expect(before.items).toHaveLength(1);
  const edit = {
    operation_id: randomUUID(),
    expected_revision: before.message.revision,
    context_token: before.context_token,
    mode: 'keep',
    content: '修改后的原话',
  };
  const saved = await request('PUT', `messages/${ack.message_id}`, edit);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (await request('PUT', `messages/${ack.message_id}`, edit)).json(),
  ).toEqual(saved.json());
  const after = (
    await request('GET', `messages/${ack.message_id}/versions`)
  ).json();
  expect(after.items).toHaveLength(2);
  expect(after.items.map((v: any) => v.content)).toContain('合成消息');
  const exported = (await request('GET', `rooms/${rooms[0].id}/export`)).json();
  expect(exported.messages[0].content).toBe('修改后的原话');
  expect(exported.messages[1].context_stale).toBe(true);
  expect(JSON.stringify(exported)).not.toContain('合成消息');
  const choose = await request('PUT', `messages/${ack.message_id}`, {
    operation_id: randomUUID(),
    expected_revision: after.message.revision,
    context_token: after.context_token,
    mode: 'keep',
    version_id: before.items[0].id,
  });
  expect(choose.statusCode, choose.body).toBe(200);
  expect(
    (await request('GET', `messages/${ack.message_id}/versions`)).json().items,
  ).toHaveLength(2);
  expect(
    (await request('GET', `rooms/${rooms[0].id}/export`)).json().messages[0]
      .content,
  ).toBe('合成消息');
  expect(mock.calls).toBe(1);
});

it('Q03 refuses edits while running and stale impact previews; truncate removes later visible messages without replaying actions', async () => {
  const first = await send();
  await execute(db, config, first.run_id);
  const preview = (
    await request('GET', `messages/${first.message_id}/versions`)
  ).json();
  const second = await send();
  const input = {
    operation_id: randomUUID(),
    expected_revision: preview.message.revision,
    context_token: preview.context_token,
    mode: 'truncate',
    content: '新分界',
  };
  expect(
    (await request('PUT', `messages/${first.message_id}`, input)).statusCode,
  ).toBe(409);
  await execute(db, config, second.run_id);
  expect(
    (await request('PUT', `messages/${first.message_id}`, input)).statusCode,
  ).toBe(409);
  const fresh = (
    await request('GET', `messages/${first.message_id}/versions`)
  ).json();
  expect(
    (
      await request('PUT', `messages/${first.message_id}`, {
        ...input,
        context_token: fresh.context_token,
      })
    ).statusCode,
  ).toBe(200);
  const exported = (await request('GET', `rooms/${rooms[0].id}/export`)).json();
  expect(exported.messages).toHaveLength(1);
  expect(exported.messages[0].content).toBe('新分界');
  expect(mock.calls).toBe(2);
});

it('privacy erasure removes all message versions and references while retaining shared asset bytes', async () => {
  const ack = await send();
  await execute(db, config, ack.run_id);
  const a = await create('assets', {
    operation_id: randomUUID(),
    world_id: world.id,
    mime: 'text/plain',
    content_base64: 'eA==',
  });
  await request('PUT', `assets/${a.id}/references`, {
    operation_id: randomUUID(),
    expected_revision: 1,
    message_id: ack.message_id,
    purpose: 'attachment',
    enabled: true,
  });
  const erased = await app.inject({
    method: 'DELETE',
    url: `/v1/messages/${ack.message_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(erased.statusCode, erased.body).toBe(204);
  expect(
    (
      await db.query('SELECT * FROM message_versions WHERE message_id=$1', [
        ack.message_id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await db.query('SELECT * FROM asset_references WHERE message_id=$1', [
        ack.message_id,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await readAsset(db, owner, a.id)).content_base64).toBe('eA==');
});

it('upgrades a populated 006 schema without losing selected content and rolls back an interrupted migration atomically', async () => {
  const schema = 'spec_upgrade_' + randomUUID().replaceAll('-', '');
  const directory = await mkdtemp('/private/tmp/echo-spec-migration-');
  await db.query(`CREATE SCHEMA ${schema}`);
  const isolated = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema},public`,
  });
  try {
    await isolated.query(
      `CREATE TABLE ${schema}.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    for (const name of (await readdir('migrations')).filter((n) =>
      /^00[1-6]_/.test(n),
    ))
      await symlink(resolve('migrations', name), `${directory}/${name}`);
    await migrate(isolated, pathToFileURL(directory + '/'));
    const oldOwner = await initializeOwner(isolated, config);
    // Populate the historical schema using its own columns, before any upgrade.
    const p = { id: randomUUID() };
    await isolated.query(
      'INSERT INTO provider_connections(id,owner_id,name,model,base_url,credential,context_window,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,32768,1024)',
      [
        p.id,
        oldOwner,
        '旧模型',
        'old',
        mock.url,
        encrypt('old-synthetic-key', config, `${oldOwner}:${p.id}`),
      ],
    );
    const w = randomUUID(),
      room = randomUUID();
    await isolated.query(
      'INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)',
      [w, oldOwner, '保留世界'],
    );
    await isolated.query(
      'INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',
      [room, oldOwner, w, '保留对话', p.id],
    );
    const queued = await enqueue(isolated, oldOwner, room, {
      client_command_id: randomUUID(),
      content: '升级前原文',
    });
    const before = (
      await isolated.query('SELECT credential FROM provider_connections')
    ).rows[0].credential;
    await migrate(isolated);
    await migrate(isolated);
    const message = (
      await isolated.query(
        'SELECT m.content,v.content AS version FROM messages m JOIN message_versions v ON v.id=m.selected_version_id WHERE m.id=$1',
        [queued.message_id],
      )
    ).rows[0];
    expect(message).toEqual({ content: '升级前原文', version: '升级前原文' });
    expect(
      (await isolated.query('SELECT credential FROM provider_connections'))
        .rows[0].credential,
    ).toEqual(before);
    await writeFile(
      `${directory}/999_spec_fault.sql`,
      'CREATE TABLE interrupted_probe(id integer); SELECT spec_injected_missing_function();',
    );
    await expect(
      migrate(isolated, pathToFileURL(directory + '/')),
    ).rejects.toThrow();
    expect(
      (
        await isolated.query(
          "SELECT to_regclass('interrupted_probe') AS table_id",
        )
      ).rows[0].table_id,
    ).toBeNull();
    expect(
      (
        await isolated.query(
          "SELECT 1 FROM schema_migrations WHERE name='999_spec_fault.sql'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await isolated.query('SELECT content FROM messages WHERE id=$1', [
          queued.message_id,
        ])
      ).rows[0].content,
    ).toBe('升级前原文');
  } finally {
    await isolated.end();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

it('concurrent privacy deletion and attachment never leave a reference to erased content', async () => {
  const ack = await send();
  await execute(db, config, ack.run_id);
  const a = await create('assets', {
    operation_id: randomUUID(),
    world_id: world.id,
    mime: 'text/plain',
    content_base64: 'eA==',
  });
  const results = await Promise.allSettled([
    referenceAsset(db, owner, a.id, {
      operation_id: randomUUID(),
      expected_revision: 1,
      message_id: ack.message_id,
      purpose: 'attachment',
      enabled: true,
    }),
    deleteMessage(db, owner, ack.message_id),
  ]);
  expect(results[1].status).toBe('fulfilled');
  if (results[0].status === 'rejected')
    expect(results[0].reason).toMatchObject({ status: 404 });
  expect(
    (
      await db.query('SELECT 1 FROM asset_references WHERE message_id=$1', [
        ack.message_id,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await readAsset(db, owner, a.id)).content_base64).toBe('eA==');
});

it('freezes every group speaker route at turn start while next turns adopt the new actor route', async () => {
  const group = await create('rooms', {
    world_id: world.id,
    name: '合成群',
    kind: 'group',
    max_replies: 2,
    actor_ids: actors.map((a) => a.id),
    provider_id: providers[0].id,
  });
  const ack = await enqueue(db, owner, group.id, {
    client_command_id: randomUUID(),
    content: '群输入',
    addressed_actor_ids: actors.map((a) => a.id),
  });
  await execute(db, config, ack.run_id);
  await route(actors[1].id, 'override', providers[1].id);
  await execute(db, config, ack.run_id);
  expect(mock.requests.map((r) => r.model)).toEqual(['first', 'first']);
  const next = await send(rooms[2].id);
  await execute(db, config, next.run_id);
  expect(mock.requests.at(-1).model).toBe('second');
});

it('Q02 freezes edited queue versions once, retains new input during generation and recovers from a fresh pool without duplicate dispatch', async () => {
  const { queueInput, updateQueuedInput, startQueuedTurn, queuedInputs } =
    await import('../../packages/server/src/modules/conversations/queue.js');
  const room = rooms[0].id;
  const entries = [];
  for (const content of ['one', 'two', 'three'])
    entries.push(
      await queueInput(db, owner, room, {
        operation_id: randomUUID(),
        content,
      }),
    );
  entries[1] = await updateQueuedInput(db, owner, entries[1]!.id, {
    operation_id: randomUUID(),
    expected_revision: 1,
    content: 'two-edited',
  });
  expect(mock.requests).toHaveLength(0);
  const input = { operation_id: randomUUID(), items: entries };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => startQueuedTurn(db, owner, room, input)),
  );
  expect(new Set(results.map((r) => r.run_id)).size).toBe(1);
  const ack = results[0]!;
  const fresh = pool(url!);
  try {
    expect(
      await startQueuedTurn(fresh, owner, room, {
        ...input,
        operation_id: randomUUID(),
      }),
    ).toEqual(ack);
    await expect(
      updateQueuedInput(fresh, owner, entries[0]!.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        content: 'late edit',
      }),
    ).rejects.toMatchObject({ code: 'input_frozen' });
    const later = await queueInput(fresh, owner, room, {
      operation_id: randomUUID(),
      content: 'next turn only',
    });
    await expect(
      startQueuedTurn(fresh, owner, room, {
        operation_id: randomUUID(),
        items: [later],
      }),
    ).rejects.toMatchObject({ code: 'active_runs' });
    expect((await queuedInputs(fresh, owner, room)).map((i) => i.id)).toEqual([
      later.id,
    ]);
    await execute(db, config, ack.run_id);
    expect(mock.requests).toHaveLength(1);
    const payload = JSON.stringify(mock.requests[0]);
    expect(payload).toContain('two-edited');
    expect(payload).not.toContain('next turn only');
    expect(
      (await db.query('SELECT count(*)::int AS n FROM runs')).rows[0].n,
    ).toBe(1);
    await deleteMessage(db, owner, ack.message_id);
    expect(
      (
        await db.query(
          'SELECT content FROM conversation_inputs WHERE consumed_run_id=$1',
          [ack.run_id],
        )
      ).rows.every((r) => r.content === ''),
    ).toBe(true);
  } finally {
    await fresh.end();
  }
});

it('queue rejects stale revisions, changed membership, mixed scopes and oversized aggregate without consuming inputs', async () => {
  const { queueInput, updateQueuedInput, startQueuedTurn, queuedInputs } =
    await import('../../packages/server/src/modules/conversations/queue.js');
  const room = rooms[0].id;
  const a = await queueInput(db, owner, room, {
    operation_id: randomUUID(),
    content: 'private queue',
  });
  const b = await queueInput(db, owner, rooms[1].id, {
    operation_id: randomUUID(),
    content: 'other room',
  });
  await expect(
    startQueuedTurn(db, owner, room, {
      operation_id: randomUUID(),
      items: [a, b],
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  const revised = await updateQueuedInput(db, owner, a.id, {
    operation_id: randomUUID(),
    expected_revision: 1,
    content: 'private updated',
  });
  await expect(
    startQueuedTurn(db, owner, room, {
      operation_id: randomUUID(),
      items: [a],
    }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  await db.query(
    'INSERT INTO room_memberships(owner_id,world_id,room_id,actor_id) VALUES($1,$2,$3,$4)',
    [owner, world.id, room, actors[1].id],
  );
  await expect(
    startQueuedTurn(db, owner, room, {
      operation_id: randomUUID(),
      items: [revised],
    }),
  ).rejects.toMatchObject({ code: 'audience_changed' });
  expect(mock.requests).toHaveLength(0);
  const removed = await request('PUT', `queued-inputs/${a.id}`, {
    operation_id: randomUUID(),
    expected_revision: 2,
    remove: true,
  });
  expect(removed.statusCode).toBe(200);
  expect(await queuedInputs(db, owner, room)).toEqual([]);
  const big = [];
  for (let i = 0; i < 2; i++)
    big.push(
      await queueInput(db, owner, room, {
        operation_id: randomUUID(),
        content: 'x'.repeat(9000),
      }),
    );
  await expect(
    startQueuedTurn(db, owner, room, {
      operation_id: randomUUID(),
      items: big,
    }),
  ).rejects.toMatchObject({ code: 'input_too_large' });
  expect(await queuedInputs(db, owner, room)).toHaveLength(2);
  expect(
    (await db.query('SELECT count(*)::int AS n FROM runs')).rows[0].n,
  ).toBe(0);
});

it('Q03 branches selected complete turns independently, keeps shared asset references and never replays original work', async () => {
  const { branchConversation } =
    await import('../../packages/server/src/modules/conversations/branches.js');
  const first = await send();
  await execute(db, config, first.run_id);
  const second = await send();
  await execute(db, config, second.run_id);
  const reply = (
    await db.query(
      "SELECT * FROM messages WHERE run_id=$1 AND role='assistant'",
      [first.run_id],
    )
  ).rows[0];
  const asset = await create('assets', {
    operation_id: randomUUID(),
    world_id: world.id,
    mime: 'text/plain',
    content_base64: Buffer.from('shared').toString('base64'),
  });
  await referenceAsset(db, owner, asset.id, {
    operation_id: randomUUID(),
    expected_revision: 1,
    message_id: reply.id,
    purpose: 'reference',
    enabled: true,
  });
  const preview = (
    await request('GET', `messages/${reply.id}/versions`)
  ).json();
  const input = {
    operation_id: randomUUID(),
    expected_revision: preview.message.revision,
    context_token: preview.context_token,
    name: '合成分支',
  };
  const branch = await branchConversation(db, owner, reply.id, input);
  expect(await branchConversation(db, owner, reply.id, input)).toEqual(branch);
  expect(branch.copied_messages).toBe(2);
  expect(mock.requests).toHaveLength(2);
  expect(
    (
      await db.query(
        'SELECT 1 FROM outbox o JOIN runs r ON r.id=o.run_id WHERE r.room_id=$1',
        [branch.room_id],
      )
    ).rowCount,
  ).toBe(0);
  const copies = (
    await db.query(
      'SELECT * FROM messages WHERE room_id=$1 ORDER BY sequence',
      [branch.room_id],
    )
  ).rows;
  expect(copies.map((m) => m.id)).not.toContain(reply.id);
  expect(copies[1].content).toBe(reply.content);
  expect(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM asset_references WHERE asset_id=$1',
        [asset.id],
      )
    ).rows[0].n,
  ).toBe(2);
  const cp = (await request('GET', `messages/${copies[1].id}/versions`)).json();
  const edited = await request('PUT', `messages/${copies[1].id}`, {
    operation_id: randomUUID(),
    expected_revision: cp.message.revision,
    context_token: cp.context_token,
    mode: 'keep',
    content: 'only branch changed',
  });
  expect(edited.statusCode, edited.body).toBe(200);
  expect(
    (await db.query('SELECT content FROM messages WHERE id=$1', [reply.id]))
      .rows[0].content,
  ).toBe(reply.content);
  await deleteMessage(db, owner, reply.id);
  expect(
    (
      await db.query('SELECT content,status FROM messages WHERE id=$1', [
        copies[1].id,
      ])
    ).rows[0],
  ).toEqual({ content: '', status: 'invalidated' });
  expect(
    (
      await db.query('SELECT count(*)::int AS n FROM assets WHERE id=$1', [
        asset.id,
      ])
    ).rows[0].n,
  ).toBe(1);
  expect(mock.requests).toHaveLength(2);
});
