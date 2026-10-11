import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pool } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
  pair,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import { buildApp } from '../../packages/server/src/app.js';
import {
  claim,
  finish,
  enqueue,
  getRun,
  recover,
  regenerate,
  cancel,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import {
  snapshot,
  sync,
  beginSnapshot,
  snapshotPage,
  pruneSync,
} from '../../packages/server/src/modules/sync/index.js';
import { mockModel } from '../fixtures/mock-model.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated echo2_test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    LEASE_MS: '1200',
    MODEL_TIMEOUT_MS: '3000',
  });
let owner: string,
  token: string,
  provider: string,
  world: any,
  actors: any[],
  room: any,
  template: any,
  app: Awaited<ReturnType<typeof buildApp>>,
  mock: Awaited<ReturnType<typeof mockModel>>;
const character = (name: string) => ({
  name,
  description: '星港领航员',
  personality: '谨慎',
  voice: '简短',
  scenario: '空间站',
  example: '准备出发。',
  greeting: '欢迎登舰。',
});
async function request(
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  path: string,
  body?: any,
  revision?: number,
) {
  return app.inject({
    method,
    url: `/v1/${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(revision ? { 'if-match': String(revision) } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}
async function create(path: string, body: any) {
  const r = await request('POST', path, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function send(
  content = '从星港出发',
  addressed?: string[],
  roomId = room.id,
) {
  return enqueue(db, owner, roomId, {
    client_command_id: randomUUID(),
    content,
    addressed_actor_ids: addressed,
  });
}
async function drain(id: string) {
  for (let n = 0; n < 3; n++) {
    await execute(db, config, id);
    if ((await getRun(db, owner, id)).state !== 'queued') break;
  }
}
const lore = (content: string, audience: string[]) => ({
  world_id: world.id,
  name: '航线',
  content,
  enabled: true,
  constant: true,
  keys: [],
  case_sensitive: false,
  scan_depth: 8,
  priority: 10,
  insertion_slot: 'before_history',
  injection_depth: 0,
  audience_actor_ids: audience,
});
beforeAll(() => migrate(db));
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  token = (
    await pair(
      db,
      (await createPairingCode(db, owner)).code,
      'P2 合成设备',
      randomUUID(),
    )
  ).access_token;
  mock = await mockModel();
  provider = (
    await createProvider(db, config, owner, {
      name: '模拟',
      base_url: mock.url,
      api_key: 'synthetic-key',
      model: 'mock',
      context_window: 32768,
      max_output_tokens: 1024,
    })
  ).id;
  app = await buildApp(db, config);
  await app.ready();
  world = await create('worlds', {
    name: '星港',
    description: '星际港口',
    persona: { name: '船长', description: '虚构玩家' },
  });
  template = await create('characters', character('阿岚'));
  actors = [];
  for (const name of ['阿岚', '北辰', '初夏', '冬青'])
    actors.push(
      await create('actors', {
        world_id: world.id,
        template_id: template.id,
        template_revision: 1,
        name,
        participation: 50,
      }),
    );
  room = await create('rooms', {
    world_id: world.id,
    name: '舰桥',
    kind: 'group',
    provider_id: provider,
    actor_ids: actors.map((a) => a.id),
    max_replies: 3,
  });
});
afterEach(async () => {
  await app.close();
  await mock.close();
});
afterAll(() => db.end());
describe('P2 world and role boundaries', () => {
  it('pins immutable character versions and separates world instances', async () => {
    const updated = await request(
      'PUT',
      `characters/${template.id}`,
      character('新版本'),
      1,
    );
    expect(updated.statusCode).toBe(200);
    expect(
      (
        await request(
          'PUT',
          `characters/${template.id}`,
          character('旧编辑'),
          1,
        )
      ).statusCode,
    ).toBe(409);
    const second = await create('worlds', {
      name: '平行世界',
      description: '',
      persona: { name: '访客', description: '' },
    });
    const copy = await create('actors', {
      world_id: second.id,
      template_id: template.id,
      template_revision: 2,
      name: '同模板',
      participation: 50,
    });
    expect(copy.id).not.toBe(actors[0].id);
    const ack = await send('你好', [actors[0].id]);
    await drain(ack.run_id);
    expect(JSON.stringify(mock.requests[0])).toContain('阿岚');
    expect(JSON.stringify(mock.requests[0])).not.toContain('新版本');
    expect(
      (
        await request(
          'PUT',
          `rooms/${room.id}`,
          { ...omitRoom(room), actor_ids: [copy.id] },
          room.revision,
        )
      ).statusCode,
    ).toBe(400);
  });
  it('archives revisions used by a manifest and stops a relay at its total deadline', async () => {
    const entry = await create('lore', lore('初版航线', []));
    const ack = await send('航线', [actors[0].id, actors[1].id]);
    const c = await claim(db, ack.run_id, 1200, 100, 1000);
    expect(c).not.toBeNull();
    const archived = (
      await db.query(
        "SELECT data FROM configuration_revisions WHERE kind='lore' AND entity_id=$1 AND revision=1",
        [entry.id],
      )
    ).rows[0].data;
    expect(archived.content).toBe('初版航线');
    await finish(db, c!, '第一位完成', 'completed', null, {
      input: 1,
      output: 1,
    });
    await db.query(
      "UPDATE runs SET deadline_at=now()-interval '1 second' WHERE id=$1",
      [ack.run_id],
    );
    expect(await claim(db, ack.run_id, 1200, 100)).toBeNull();
    expect((await getRun(db, owner, ack.run_id)).error_code).toBe(
      'run_deadline_exceeded',
    );
  });
  it('upgrades a populated P1 schema without losing command or message identities', async () => {
    const tx = await db.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('CREATE SCHEMA p2_upgrade_fixture');
      await tx.query('SET LOCAL search_path=p2_upgrade_fixture');
      await tx.query(await readFile('migrations/001_foundation.sql', 'utf8'));
      const ids = Array.from({ length: 6 }, () => randomUUID());
      await tx.query('INSERT INTO owners(id) VALUES($1)', [ids[0]]);
      await tx.query(
        "INSERT INTO provider_connections(id,owner_id,name,base_url,model,context_window,max_output_tokens,credential) VALUES($1,$2,'test','https://example.invalid','synthetic',2048,128,'{}')",
        [ids[1], ids[0]],
      );
      await tx.query(
        "INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,'P1 世界')",
        [ids[2], ids[0]],
      );
      await tx.query(
        "INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,'旧房间',$4)",
        [ids[3], ids[0], ids[2], ids[1]],
      );
      await tx.query(
        "INSERT INTO runs(id,owner_id,world_id,room_id,client_command_id,request_hash,user_message_id,reply_message_id,command_order,state) VALUES($1,$2,$3,$4,$1,'test',$5,$6,1,'completed')",
        [ids[4], ids[0], ids[2], ids[3], ids[5], randomUUID()],
      );
      await tx.query(
        "INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,content,status) VALUES($1,$2,$3,$4,1,'user','合成历史','completed')",
        [ids[5], ids[0], ids[3], ids[4]],
      );
      await tx.query(
        await readFile('migrations/002_worlds_and_cast.sql', 'utf8'),
      );
      expect((await tx.query('SELECT content,id FROM messages')).rows).toEqual([
        { content: '合成历史', id: ids[5] },
      ]);
      expect((await tx.query('SELECT kind FROM rooms')).rows[0].kind).toBe(
        'legacy',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
  it('paginates one immutable snapshot while edits continue and expires old sync cursors', async () => {
    const head = await beginSnapshot(db, owner);
    await create('worlds', {
      name: '快照之后新增',
      description: '',
      persona: { name: '玩家', description: '' },
    });
    const records: any[] = [];
    let cursor = '0';
    for (let i = 0; i < 50; i++) {
      const page = await snapshotPage(db, owner, head.snapshot_id, cursor, 2);
      records.push(...page.items);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    expect(
      records.filter((r) => r.kind === 'world').map((r) => r.data.name),
    ).toEqual(['星港']);
    expect(
      (await sync(db, owner, head.high_water_cursor, 100)).items.some(
        (e) => e.kind === 'world' && e.data.name === '快照之后新增',
      ),
    ).toBe(true);
    await expect(
      snapshotPage(db, randomUUID(), head.snapshot_id, '0'),
    ).rejects.toMatchObject({ status: 410 });
    await db.query("UPDATE sync_events SET created_at=now()-interval '8 days'");
    await pruneSync(db);
    await expect(sync(db, owner, '0')).rejects.toMatchObject({ status: 410 });
    await db.query(
      "UPDATE sync_snapshots SET expires_at=now()-interval '1 second'",
    );
    await expect(
      snapshotPage(db, owner, head.snapshot_id, '0'),
    ).rejects.toMatchObject({ status: 410 });
  });
  it('P6 pages cross chunk boundaries, retain P5 sessions, and cascade erasure', async () => {
    await db.query(
      'INSERT INTO lore_entries(id,owner_id,world_id,data) SELECT gen_random_uuid(),$1,$2,$3 FROM generate_series(1,1100)',
      [owner, world.id, lore('分页测试', [actors[0].id])],
    );
    const head = await beginSnapshot(db, owner);
    const legacy = (
      await db.query('SELECT records FROM sync_snapshots WHERE id=$1', [
        head.snapshot_id,
      ])
    ).rows[0].records;
    expect(
      (
        await db.query(
          'SELECT count(*)::int n FROM sync_snapshot_pages WHERE snapshot_id=$1',
          [head.snapshot_id],
        )
      ).rows[0].n,
    ).toBe(3);
    for (const [after, limit] of [
      [0, 1],
      [499, 2],
      [498, 500],
      [999, 200],
      [legacy.length, 100],
    ]) {
      const page = await snapshotPage(
        db,
        owner,
        head.snapshot_id,
        String(after),
        limit,
      );
      expect(page.items).toEqual(legacy.slice(after, after + limit));
      expect(page.has_more).toBe(after + limit < legacy.length);
    }
    await expect(
      snapshotPage(db, owner, head.snapshot_id, String(legacy.length + 1)),
    ).rejects.toMatchObject({ status: 400 });
    const oldID = randomUUID();
    await db.query(
      'INSERT INTO sync_snapshots(id,owner_id,metadata,records) SELECT $2,owner_id,metadata,records FROM sync_snapshots WHERE id=$1',
      [head.snapshot_id, oldID],
    );
    expect((await snapshotPage(db, owner, oldID, '499', 2)).items).toEqual(
      legacy.slice(499, 501),
    );
    await db.query('DELETE FROM sync_snapshots WHERE owner_id=$1', [owner]);
    expect((await db.query('SELECT 1 FROM sync_snapshot_pages')).rowCount).toBe(
      0,
    );
    await expect(
      snapshotPage(db, owner, head.snapshot_id, '0'),
    ).rejects.toMatchObject({ status: 410 });
  });
  it('does not lose a sync page when retention runs immediately after its first read', async () => {
    expect(
      (await request('GET', 'sync?cursor=99999999999999999999')).statusCode,
    ).toBe(410);
    const expected = await sync(db, owner, '0', 100);
    expect(expected.items.length).toBeGreaterThan(0);
    await db.query("UPDATE sync_events SET created_at=now()-interval '8 days'");
    let pruned = false;
    const racingDB = new Proxy(db, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key);
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (!pruned) {
            pruned = true;
            await pruneSync(db);
          }
          return result;
        };
      },
    });
    expect(await sync(racingDB, owner, '0', 100)).toEqual(expected);
    await expect(sync(db, owner, '0')).rejects.toMatchObject({ status: 410 });
  });
  it('rejects wrong owner, unknown fields, absent revision, more than eight members and foreign addressees', async () => {
    expect(
      (
        await request('PUT', `worlds/${world.id}`, {
          name: 'wrong',
          description: '',
          persona: { name: 'a', description: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', 'worlds', {
          name: 'x',
          description: '',
          persona: { name: 'x', description: '' },
          system_prompt: 'escape',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', 'rooms', {
          ...omitRoom(room),
          actor_ids: Array.from({ length: 9 }, () => randomUUID()),
        })
      ).statusCode,
    ).toBe(400);
    await expect(
      enqueue(db, randomUUID(), room.id, {
        client_command_id: randomUUID(),
        content: 'x',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(send('x', [randomUUID()])).rejects.toMatchObject({
      status: 400,
    });
  });
  it('keeps private room secrets and actor-only lore and state out of other prompts', async () => {
    const direct = await create('rooms', {
      world_id: world.id,
      name: '私聊',
      kind: 'direct',
      provider_id: provider,
      actor_ids: [actors[0].id],
      max_replies: 1,
    });
    await drain(
      (await send('秘密口令：合成红月', undefined, direct.id)).run_id,
    );
    await create('lore', lore('A 独占的隐秘航道', [actors[0].id]));
    await request(
      'PUT',
      `worlds/${world.id}/state`,
      {
        data: {
          location: 'A 的秘密坐标',
          time: '夜',
          present_actor_ids: [actors[0].id],
          open_topics: [],
        },
        audience_actor_ids: [actors[0].id],
      },
      1,
    );
    await drain((await send('大家好', [actors[1].id, actors[0].id])).run_id);
    expect(JSON.stringify(mock.requests[1])).not.toMatch(
      /合成红月|隐秘航道|秘密坐标/,
    );
    expect(JSON.stringify(mock.requests[2])).toContain('隐秘航道');
    expect(JSON.stringify(mock.requests[2])).toContain('秘密坐标');
    expect(JSON.stringify(mock.requests[2])).not.toContain('合成红月');
  });
  it('does not grant new members earlier messages or queued input', async () => {
    const privateGroup = await create('rooms', {
      world_id: world.id,
      name: '旧成员群',
      kind: 'group',
      provider_id: provider,
      actor_ids: [actors[0].id],
      max_replies: 1,
    });
    await drain(
      (await send('加入前的合成秘密', undefined, privateGroup.id)).run_id,
    );
    const oldQueued = await send(
      '尚未处理的秘密',
      [actors[0].id],
      privateGroup.id,
    );
    await request(
      'PUT',
      `rooms/${privateGroup.id}`,
      { ...omitRoom(privateGroup), actor_ids: [actors[0].id, actors[1].id] },
      1,
    );
    await drain(oldQueued.run_id);
    await drain(
      (await send('加入后的公开消息', [actors[1].id], privateGroup.id)).run_id,
    );
    expect(JSON.stringify(mock.requests.at(-1))).not.toMatch(
      /加入前的合成秘密|尚未处理的秘密/,
    );
    expect(JSON.stringify(mock.requests.at(-1))).toContain('加入后的公开消息');
  });
  it('limits explicit relay to three, records each author and bills each step', async () => {
    const ack = await send(
      '逐个回应',
      actors.map((a) => a.id),
    );
    await drain(ack.run_id);
    const messages = (
      await db.query(
        "SELECT * FROM messages WHERE run_id=$1 AND role='assistant' ORDER BY step_index",
        [ack.run_id],
      )
    ).rows;
    expect(messages.map((m) => m.actor_id)).toEqual(
      actors.slice(0, 3).map((a) => a.id),
    );
    expect(mock.calls).toBe(3);
    expect(JSON.stringify(mock.requests[1])).toContain('阿岚：星港已收到。');
    expect(
      (
        await db.query('SELECT * FROM usage_ledger WHERE run_id=$1', [
          ack.run_id,
        ])
      ).rowCount,
    ).toBe(3);
    expect(
      (
        await db.query('SELECT * FROM world_state WHERE world_id=$1', [
          world.id,
        ])
      ).rows[0].data.location,
    ).toBe('');
    expect(
      (
        await db.query(
          "SELECT * FROM world_events WHERE run_id=$1 AND kind='character_claim'",
          [ack.run_id],
        )
      ).rowCount,
    ).toBe(3);
  });
  it('keeps completed earlier speakers when a later step loses its worker', async () => {
    const ack = await send('接力', [actors[0].id, actors[1].id]);
    await execute(db, config, ack.run_id);
    const c = await claim(db, ack.run_id, 1200, 100);
    expect(c).not.toBeNull();
    await db.query('UPDATE messages SET content=$2 WHERE id=$1', [
      c!.run.reply_message_id,
      '半句话',
    ]);
    await db.query(
      "UPDATE world_leases SET expires_at=now()-interval '1 second'",
    );
    await recover(db);
    const rows = (
      await db.query(
        "SELECT status FROM messages WHERE run_id=$1 AND role='assistant' ORDER BY step_index",
        [ack.run_id],
      )
    ).rows;
    expect(rows.map((r) => r.status)).toEqual(['completed', 'interrupted']);
    expect((await getRun(db, owner, ack.run_id)).state).toBe('interrupted');
  });
  it('rejects stale model output after settings or membership change', async () => {
    const ack = await send('看世界', [actors[0].id]);
    const c = await claim(db, ack.run_id, 1200, 100);
    await create('lore', lore('新设定', []));
    await finish(db, c!, '旧上下文迟到回复', 'completed', null, {
      input: 5,
      output: 5,
    });
    expect((await getRun(db, owner, ack.run_id)).error_code).toBe(
      'context_changed',
    );
    expect(
      (
        await db.query('SELECT 1 FROM world_events WHERE run_id=$1', [
          ack.run_id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('caps retries per speaker and refuses more model calls when budget runs out', async () => {
    const ack = await send('继续', [actors[0].id, actors[1].id]);
    const c = await claim(db, ack.run_id, 1200, 1);
    await finish(db, c!, '完成', 'completed', null, { input: 5, output: 5 });
    expect(await claim(db, ack.run_id, 1200, 1)).toBeNull();
    expect((await getRun(db, owner, ack.run_id)).error_code).toBe(
      'request_budget_exceeded',
    );
  });
  it('regenerates only last safe turn, is idempotent, and invalidates claims', async () => {
    const ack = await send('最后一轮', [actors[0].id]);
    await drain(ack.run_id);
    const command = randomUUID(),
      next = await regenerate(db, owner, ack.run_id, command);
    expect(await regenerate(db, owner, ack.run_id, command)).toEqual(next);
    expect(
      (
        await db.query('SELECT status FROM messages WHERE run_id=$1', [
          ack.run_id,
        ])
      ).rows.every((m) => m.status === 'invalidated'),
    ).toBe(true);
    await drain(next.run_id);
    await db.query('UPDATE runs SET has_external_effects=true WHERE id=$1', [
      next.run_id,
    ]);
    await expect(
      regenerate(db, owner, next.run_id, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
    await db.query('UPDATE runs SET has_external_effects=false WHERE id=$1', [
      next.run_id,
    ]);
    await send('后续依赖');
    await expect(
      regenerate(db, owner, next.run_id, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('synchronizes edits, corrections, author identity and tombstones to another device', async () => {
    const initial = await snapshot(db, owner);
    const ack = await send('你好', [actors[0].id]);
    await drain(ack.run_id);
    const secondToken = (
      await pair(
        db,
        (await createPairingCode(db, owner)).code,
        'Mac 合成设备',
        randomUUID(),
      )
    ).access_token;
    const response = await app.inject({
      url: '/v1/sync/snapshot',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages.at(-1).actor_id).toBe(actors[0].id);
    const delta = await sync(db, owner, initial.high_water_cursor, 100);
    expect(delta.items.some((e) => e.kind === 'world_event')).toBe(true);
    expect(
      (await request('DELETE', `rooms/${room.id}`, undefined, room.revision))
        .statusCode,
    ).toBe(204);
    expect((await snapshot(db, owner)).rooms).toHaveLength(0);
    expect(
      (await sync(db, owner, delta.next_cursor)).items.some(
        (e) => e.kind === 'room_deleted',
      ),
    ).toBe(true);
  });
  it('cancels remaining relay without erasing committed speakers', async () => {
    const ack = await send('继续', [actors[0].id, actors[1].id]);
    await execute(db, config, ack.run_id);
    await cancel(db, owner, ack.run_id);
    await execute(db, config, ack.run_id);
    expect(mock.calls).toBe(1);
    expect(
      (
        await db.query(
          "SELECT status FROM messages WHERE run_id=$1 AND role='assistant'",
          [ack.run_id],
        )
      ).rows[0].status,
    ).toBe('completed');
  });
});
function omitRoom(r: any) {
  const { id: _, revision: __, ...body } = r;
  return body;
}
