import {
  savePolicy,
  globalDefaults,
  policyDefaults,
} from '../../packages/server/src/modules/autonomy/policy.js';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pool, transaction } from '../../packages/server/src/db/index.js';
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
  enqueue,
  claim,
  finish,
  regenerate,
} from '../../packages/server/src/modules/runs/repository.js';
import {
  claimMemory,
  finishMemory,
  executeMemory,
} from '../../packages/server/src/modules/memory/worker.js';
import { retrieve } from '../../packages/server/src/modules/memory/retrieval.js';
import {
  editMemory,
  deleteMessage,
  listMemories,
  saveSettings,
} from '../../packages/server/src/modules/memory/repository.js';
import { reserveBackground } from '../../packages/server/src/modules/memory/usage.js';
import {
  rebuildEmbedding,
  queryEmbedding,
} from '../../packages/server/src/modules/memory/embeddings.js';
import {
  beginSnapshot,
  snapshotPage,
  sync,
} from '../../packages/server/src/modules/sync/index.js';
import { startWorker } from '../../packages/server/src/queue.js';
import { readFile } from 'node:fs/promises';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    MODEL_TIMEOUT_MS: '1500',
    BACKGROUND_DAILY_REQUEST_LIMIT: '100',
    BACKGROUND_DAILY_OUTPUT_LIMIT: '100000',
  });
let owner: string,
  token: string,
  world: any,
  actors: any[],
  room: any,
  provider: any,
  app: Awaited<ReturnType<typeof buildApp>>,
  server: ReturnType<typeof createServer>,
  mode = 'valid',
  calls = 0;
const requests: any[] = [];
async function req(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  rev?: number,
) {
  return app.inject({
    method,
    url: '/v1/' + path,
    headers: {
      authorization: `Bearer ${token}`,
      ...(rev ? { 'if-match': String(rev) } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}
async function create(path: string, body: any) {
  const r = await req('POST', path, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function chat(
  content: string,
  ids = [actors[0].id],
  roomId = room.id,
  reply = '收到',
) {
  const ack = await enqueue(db, owner, roomId, {
    client_command_id: randomUUID(),
    content,
    addressed_actor_ids: ids,
  });
  const c = await claim(db, ack.run_id, 10000, 100);
  expect(c).not.toBeNull();
  await finish(db, c!, reply, 'completed', null, { input: 1, output: 1 });
  return { ...ack, c };
}
async function idle() {
  await db.query(
    "UPDATE memory_sources SET committed_at=now()-interval '61 seconds'",
  );
}
async function extract(roomId = room.id) {
  await idle();
  const c = await claimMemory(db, config, roomId);
  expect(c).not.toBeNull();
  return c!;
}
const candidate = (c: any, text: string, topic: string, ids?: string[]) => ({
  candidates: [
    {
      content: text,
      topic,
      kind: 'statement',
      source_ids: ids ?? [c.sources.find((s: any) => s.content === text).id],
    },
  ],
});
async function memory(text = '蓝色风铃是暗号', topic = '暗号') {
  await chat(text);
  const c = await extract();
  await finishMemory(db, c, candidate(c, text, topic));
  return (await listMemories(db, owner, world.id)).find(
    (m) => m.content === text,
  )!;
}
beforeAll(() => migrate(db));
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  token = (
    await pair(
      db,
      (await createPairingCode(db, owner)).code,
      'P3 synthetic',
      randomUUID(),
    )
  ).access_token;
  mode = 'valid';
  calls = 0;
  requests.length = 0;
  server = createServer(async (r, s) => {
    let raw = '';
    for await (const chunk of r) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    calls++;
    if (mode === 'fail') {
      s.writeHead(503).end();
      return;
    }
    if (r.url?.endsWith('/embeddings')) {
      s.setHeader('content-type', 'application/json');
      s.end(
        JSON.stringify({
          data: [{ embedding: mode === 'dim3' ? [1, 0, 0] : [1, 0] }],
          usage: { total_tokens: 7 },
        }),
      );
      return;
    }
    const source = JSON.parse(body.messages.at(-1).content).find(
      (m: any) => m.role === 'user',
    );
    const content =
      mode === 'invalid'
        ? 'not json'
        : JSON.stringify({
            candidates: source
              ? [
                  {
                    content: source.content,
                    topic: source.content.slice(0, 2),
                    kind: 'statement',
                    source_ids: [source.id],
                  },
                ]
              : [],
          });
    s.writeHead(200, { 'Content-Type': 'text/event-stream' });
    s.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  provider = await createProvider(db, config, owner, {
    name: '合成',
    base_url: `http://127.0.0.1:${port}/v1`,
    api_key: 'synthetic',
    model: 'mock',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  app = await buildApp(db, config);
  await app.ready();
  world = await create('worlds', {
    name: '星港',
    description: '',
    persona: { name: '船长', description: '' },
  });
  const t = await create('characters', {
    name: '领航员',
    description: '',
    personality: '',
    voice: '',
    scenario: '',
    example: '',
    greeting: '',
  });
  actors = [];
  for (const name of ['林舟', '夏棠'])
    actors.push(
      await create('actors', {
        world_id: world.id,
        template_id: t.id,
        template_revision: 1,
        name,
        participation: 50,
      }),
    );
  room = await create('rooms', {
    world_id: world.id,
    name: '私聊',
    provider_id: provider.id,
    kind: 'direct',
    actor_ids: [actors[0].id],
    max_replies: 1,
  });
  await savePolicy(db, owner, null, 1, {
    ...globalDefaults,
    enabled: true,
    request_limit: 100,
    input_limit: 1000000,
    output_limit: 100000,
  });
  await savePolicy(db, owner, world.id, 1, {
    ...policyDefaults,
    enabled: true,
    memory: true,
    request_limit: 100,
    category_limit: 100,
    input_limit: 1000000,
    output_limit: 100000,
  });
  await saveSettings(db, owner, world.id, 1, {
    enabled: true,
    embedding_provider_id: null,
    embedding_dimensions: 0,
  });
});
afterEach(async () => {
  await app.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterAll(() => db.end());
describe('P3 persistent memory, scope and imports', () => {
  it('requires explicit opt-in for imported prompt suggestions and binds it to the import decision', async () => {
    const data = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '提示建议测试',
        system_prompt: '航海术语',
        post_history_instructions: '简短收尾',
      },
    };
    const preview = (
      await req('POST', `worlds/${world.id}/imports/preview`, {
        format: 'json',
        data_base64: Buffer.from(JSON.stringify(data)).toString('base64'),
        audience_actor_ids: [],
      })
    ).json();
    expect(preview.character.prompt_suggestions.enabled).toBe(false);
    const result = await req('POST', `imports/${preview.id}/commit`, {
      strategy: 'copy',
      enable_prompt_suggestions: true,
    });
    expect(result.statusCode, result.body).toBe(200);
    const saved = (
      await db.query(
        'SELECT data FROM character_versions WHERE template_id=$1',
        [result.json().character_id],
      )
    ).rows[0].data;
    expect(saved.prompt_suggestions).toEqual({
      enabled: true,
      system_prompt: '航海术语',
      post_history_instructions: '简短收尾',
    });
    expect(
      (
        await req('POST', `imports/${preview.id}/commit`, {
          strategy: 'copy',
          enable_prompt_suggestions: false,
        })
      ).statusCode,
    ).toBe(409);
  });

  it('accepts omitted nullable fields from generated Apple clients and rejects invalid expiry', async () => {
    const m = await memory();
    const body = {
      content: '暗号已更新',
      topic: '暗号',
      pinned: false,
      audience_actor_ids: m.audience_actor_ids,
    };
    const response = await req('PUT', `memories/${m.id}`, body, m.revision);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().valid_to).toBeNull();
    expect(
      (
        await req(
          'PUT',
          `memories/${m.id}`,
          { ...body, valid_to: 'invalid' },
          response.json().revision,
        )
      ).statusCode,
    ).toBe(400);
    const settings = await req(
      'PUT',
      `worlds/${world.id}/memory-settings`,
      { enabled: false, embedding_dimensions: 0 },
      2,
    );
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().embedding_provider_id).toBeNull();
  });
  it('intersects mixed evidence audiences before persistence even after a new member joins', async () => {
    const old = await chat('暗号是蓝色风铃');
    const updated = await req(
      'PUT',
      `rooms/${room.id}`,
      {
        world_id: world.id,
        name: '扩大房间',
        provider_id: provider.id,
        kind: 'group',
        actor_ids: actors.map((a) => a.id),
        max_replies: 1,
      },
      room.revision,
    );
    expect(updated.statusCode).toBe(200);
    const latest = await chat('北塔今夜亮灯');
    const c = await extract();
    await finishMemory(
      db,
      c,
      candidate(c, '北塔今夜亮灯', '北塔', [old.message_id, latest.message_id]),
    );
    const m = (await listMemories(db, owner, world.id))[0]!;
    expect(m.audience_actor_ids).toEqual([actors[0].id]);
    expect(await retrieve(db, owner, world.id, actors[1].id, '北塔')).toEqual(
      [],
    );
  });

  it('extracts after idle or eight sources and advances only successful grounded batches', async () => {
    await chat('明晚九点去北塔');
    expect(await claimMemory(db, config, room.id)).toBeNull();
    const c = await extract();
    expect(await claimMemory(db, config, room.id)).toBeNull();
    await expect(
      finishMemory(db, c, {
        candidates: [
          {
            content: '伪造',
            topic: '伪造',
            kind: 'statement',
            source_ids: [c.sources[0].id],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ungrounded_extraction' });
    expect(
      (
        await db.query('SELECT cursor FROM memory_jobs WHERE room_id=$1', [
          room.id,
        ])
      ).rows[0].cursor,
    ).toBe('0');
    expect(
      await finishMemory(db, c, candidate(c, '明晚九点去北塔', '北塔')),
    ).toBe(true);
    expect(
      await finishMemory(db, c, candidate(c, '明晚九点去北塔', '北塔')),
    ).toBe(false);
    const rows = await listMemories(db, owner, world.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ids).toEqual([c.sources[0].id]);
    for (let i = 0; i < 4; i++) await chat(`第${i}次发言`);
    expect(await claimMemory(db, config, room.id)).not.toBeNull();
  });
  it('retrieves across rooms only for actors in the evidence intersection and never across worlds', async () => {
    const m = await memory();
    expect(await retrieve(db, owner, world.id, actors[1].id, '暗号')).toEqual(
      [],
    );
    expect(
      await retrieve(db, randomUUID(), world.id, actors[0].id, '暗号'),
    ).toEqual([]);
    expect(
      await retrieve(db, owner, randomUUID(), actors[0].id, '暗号'),
    ).toEqual([]);
    const group = await create('rooms', {
      world_id: world.id,
      name: '舰桥',
      provider_id: provider.id,
      kind: 'group',
      actor_ids: actors.map((a) => a.id),
      max_replies: 1,
    });
    const a = await chat('暗号是什么', [actors[0].id], group.id);
    expect(JSON.stringify(a.c!.messages)).toContain(m.content);
    const b = await chat('暗号是什么', [actors[1].id], group.id);
    expect(JSON.stringify(b.c!.messages)).not.toContain(m.content);
    const c = await extract(group.id);
    await finishMemory(db, c, { candidates: [] });
    expect(
      (
        await req(
          'PUT',
          `memories/${m.id}`,
          {
            content: m.content,
            topic: '暗号',
            pinned: false,
            audience_actor_ids: actors.map((a) => a.id),
            valid_to: null,
          },
          m.revision,
        )
      ).statusCode,
    ).toBe(400);
  });
  it('deduplicates equal facts, preserves claims, surfaces changed preference as conflict and prioritizes manual corrections', async () => {
    const m = await memory('我喜欢甜咖啡', '咖啡');
    await chat('我喜欢甜咖啡');
    let c = await extract();
    await finishMemory(db, c, candidate(c, '我喜欢甜咖啡', '咖啡'));
    let rows = await listMemories(db, owner, world.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ids.length).toBe(2);
    await chat('现在不喝咖啡', undefined, undefined, '北塔已经封锁');
    c = await extract();
    await finishMemory(db, c, {
      candidates: [
        ...candidate(c, '现在不喝咖啡', '咖啡').candidates,
        {
          content: '北塔已经封锁',
          topic: '北塔',
          kind: 'statement',
          source_ids: [c.sources.find((s: any) => s.role === 'assistant').id],
        },
      ],
    });
    rows = await listMemories(db, owner, world.id);
    expect(rows.find((r) => r.content === '北塔已经封锁')?.status).toBe(
      'claimed',
    );
    const changed = rows.find((r) => r.content === '现在不喝咖啡')!;
    expect(changed.status).toBe('conflict');
    await editMemory(db, owner, changed.id, changed.revision, {
      content: '现在不喝咖啡',
      topic: '咖啡',
      pinned: true,
      audience_actor_ids: changed.audience_actor_ids,
      valid_to: null,
      supersedes_id: m.id,
    });
    expect(
      (await retrieve(db, owner, world.id, actors[0].id, '咖啡')).map(
        (r) => r.content,
      ),
    ).toEqual(['现在不喝咖啡']);
  });
  it('forgetting invalidates evidence descendants, vectors, revisions, stale extraction and snapshot replays', async () => {
    const m = await memory();
    const recall = await chat(
      '说出暗号',
      undefined,
      undefined,
      '蓝色风铃是暗号',
    );
    const c = await extract();
    const snap = await beginSnapshot(db, owner);
    await db.query("INSERT INTO memory_vectors VALUES($1,$2,1,'[1,0]')", [
      m.id,
      m.revision,
    ]);
    await editMemory(db, owner, m.id, m.revision, null);
    expect(
      await finishMemory(db, c, candidate(c, '蓝色风铃是暗号', '暗号')),
    ).toBe(false);
    expect(await retrieve(db, owner, world.id, actors[0].id, '暗号')).toEqual(
      [],
    );
    expect((await db.query('SELECT * FROM memory_vectors')).rowCount).toBe(0);
    expect(
      JSON.stringify(
        (await db.query('SELECT data FROM memory_revisions')).rows,
      ),
    ).not.toContain('蓝色风铃');
    expect(
      (
        await db.query('SELECT memory_excluded FROM messages WHERE id=$1', [
          recall.c!.run.reply_message_id,
        ])
      ).rows[0].memory_excluded,
    ).toBe(true);
    await expect(
      snapshotPage(db, owner, snap.snapshot_id, '0'),
    ).rejects.toMatchObject({ status: 410 });
    await expect(sync(db, owner, snap.high_water_cursor)).rejects.toMatchObject(
      { status: 410 },
    );
    const future = await chat('暗号是什么');
    expect(JSON.stringify(future.c!.messages)).not.toContain('蓝色风铃');
  });
  it('source erasure removes dependent message content and rejects stale memory jobs', async () => {
    const m = await memory();
    const c = await extractAfterChat();
    await deleteMessage(db, owner, m.source_ids[0]);
    expect(await finishMemory(db, c, { candidates: [] })).toBe(false);
    expect(
      (
        await db.query('SELECT content,status FROM messages WHERE id=$1', [
          m.source_ids[0],
        ])
      ).rows[0],
    ).toEqual({ content: '', status: 'invalidated' });
    expect(
      JSON.stringify((await db.query('SELECT data FROM sync_events')).rows),
    ).not.toContain('蓝色风铃');
  });
  it('regeneration invalidates derived memories and restores lore state without counting retries', async () => {
    const lore = await create('lore', {
      world_id: world.id,
      name: '灯塔',
      content: '亮灯',
      enabled: true,
      constant: true,
      keys: [],
      case_sensitive: false,
      scan_depth: 8,
      priority: 1,
      insertion_slot: 'before_history',
      injection_depth: 0,
      audience_actor_ids: [],
      sticky_turns: 3,
      cooldown_turns: 2,
      delay_turns: 0,
      match_mode: 'keywords',
    });
    const first = await chat('去灯塔');
    const c = await extract();
    await finishMemory(db, c, candidate(c, '去灯塔', '灯塔'));
    expect(
      (
        await db.query('SELECT turn FROM lore_activations WHERE entry_id=$1', [
          lore.id,
        ])
      ).rows[0].turn,
    ).toBe(1);
    const ack = await regenerate(db, owner, first.run_id, randomUUID());
    expect((await listMemories(db, owner, world.id))[0]!.status).toBe(
      'invalidated',
    );
    expect((await db.query('SELECT * FROM lore_activations')).rowCount).toBe(0);
    const next = await claim(db, ack.run_id, 10000, 100);
    await finish(db, next!, '再答', 'completed', null, { input: 1, output: 1 });
    expect(
      (await db.query('SELECT turn FROM lore_activations')).rows[0].turn,
    ).toBe(1);
  });
  it('persists bounded retry failure without advancing cursor and resumes through pg-boss after restart', async () => {
    await chat('约定去北塔');
    await idle();
    mode = 'invalid';
    await executeMemory(db, config, room.id);
    let row = (await db.query('SELECT * FROM memory_jobs')).rows[0];
    expect(row.cursor).toBe('0');
    expect(row.attempts).toBe(1);
    expect(row.error_code).toBe('memory_extraction_failed');
    await req('POST', `worlds/${world.id}/memory-retry`);
    mode = 'valid';
    let worker = await startWorker(db, config);
    await worker.stop();
    worker = await startWorker(db, config);
    try {
      await expect
        .poll(async () => (await listMemories(db, owner, world.id)).length, {
          timeout: 8000,
        })
        .toBe(1);
    } finally {
      await worker.stop();
    }
    row = (await db.query('SELECT * FROM memory_jobs')).rows[0];
    expect(BigInt(row.cursor)).toBeGreaterThan(0n);
  });
  it('fences expired workers and does not allow background budgets to be oversubscribed', async () => {
    await chat('去北塔');
    const old = await extract();
    await db.query(
      "UPDATE memory_jobs SET lease_until=now()-interval '1 second'",
    );
    const next = await claimMemory(db, config, room.id);
    expect(next).not.toBeNull();
    expect(await finishMemory(db, old, { candidates: [] })).toBe(false);
    expect(await finishMemory(db, next!, { candidates: [] })).toBe(true);
    await db.query('TRUNCATE background_daily');
    const limited = { ...config, backgroundRequestLimit: 1 };
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        transaction(db, (tx) =>
          reserveBackground(
            tx,
            limited,
            owner,
            world.id,
            'memory_extract',
            10,
            10,
          ),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
  it('rebuilds versioned embeddings, filters semantic recall by scope, survives service failure and dimension changes', async () => {
    const m = await memory();
    await saveSettings(db, owner, world.id, 2, {
      enabled: true,
      embedding_provider_id: provider.id,
      embedding_dimensions: 2,
    });
    await rebuildEmbedding(db, config, world.id);
    expect((await db.query('SELECT * FROM memory_vectors')).rowCount).toBe(1);
    const vector = { version: 2, dimensions: 2, vector: [1, 0] };
    expect(
      (await retrieve(db, owner, world.id, actors[0].id, '口令', vector))[0]
        ?.id,
    ).toBe(m.id);
    expect(
      await retrieve(db, owner, world.id, actors[1].id, '口令', vector),
    ).toEqual([]);
    await saveSettings(db, owner, world.id, 3, {
      enabled: true,
      embedding_provider_id: provider.id,
      embedding_dimensions: 3,
    });
    expect((await db.query('SELECT * FROM memory_vectors')).rowCount).toBe(0);
    await rebuildEmbedding(db, config, world.id);
    expect(
      (await req('GET', `worlds/${world.id}/memory-status`)).json().index_error,
    ).toBe('embedding_dimensions');
    expect(
      (await retrieve(db, owner, world.id, actors[0].id, '暗号')).length,
    ).toBe(1);
    mode = 'dim3';
    await req('POST', `worlds/${world.id}/memory-retry`);
    await rebuildEmbedding(db, config, world.id);
    expect(
      (
        await db.query(
          'SELECT vector_dims(embedding) AS d,index_version FROM memory_vectors',
        )
      ).rows[0],
    ).toMatchObject({ d: 3, index_version: 3 });
    expect(
      await retrieve(db, owner, world.id, actors[0].id, '口令', vector),
    ).toEqual([]);
    mode = 'fail';
    const ack = await enqueue(db, owner, room.id, {
      client_command_id: randomUUID(),
      content: '口令',
    });
    expect(await queryEmbedding(db, config, ack.run_id)).toBeUndefined();
  });
  it('manual correction wins over a late extraction and expiry excludes recall', async () => {
    const m = await memory();
    const c = await extractAfterChat();
    await editMemory(db, owner, m.id, m.revision, {
      content: '红色风铃是暗号',
      topic: '暗号',
      pinned: false,
      audience_actor_ids: m.audience_actor_ids,
      valid_to: '2020-01-01T00:00:00Z',
    });
    expect(await finishMemory(db, c, { candidates: [] })).toBe(false);
    expect(await retrieve(db, owner, world.id, actors[0].id, '暗号')).toEqual(
      [],
    );
  });
  it('previews conflicts, commits atomically and idempotently, exports exact unknown data and preserves new fields from old editors', async () => {
    const raw = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '闻砚',
        description: '测试',
        alternate_greetings: ['另一句'],
        extensions: { script: 'fetch("https://evil.invalid")' },
        character_book: {
          entries: [
            {
              keys: ['北塔'],
              content: '北塔有灯',
              insertion_order: 10,
              position: 'before_char',
              extensions: { sticky: 2 },
            },
          ],
        },
      },
    };
    const bytes = Buffer.from(JSON.stringify(raw));
    const input = {
      format: 'json',
      data_base64: bytes.toString('base64'),
      audience_actor_ids: [],
    };
    const preview = (
      await req('POST', `worlds/${world.id}/imports/preview`, input)
    ).json();
    expect(preview.errors).toEqual([]);
    expect(preview.warnings.join()).toContain('extensions');
    expect(preview.result).toBeNull();
    expect(calls).toBe(0);
    const result = await req('POST', `imports/${preview.id}/commit`, {
      strategy: 'copy',
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(
      (
        await req('POST', `imports/${preview.id}/commit`, { strategy: 'copy' })
      ).json(),
    ).toEqual(result.json());
    expect(
      (await req('GET', `imports/${preview.id}/original`)).json().data_base64,
    ).toBe(bytes.toString('base64'));
    const data = (
      await db.query('SELECT data FROM lore_entries WHERE id=$1', [
        result.json().lore_ids[0],
      ])
    ).rows[0].data;
    expect(data.audience_actor_ids).toEqual([result.json().actor_id]);
    const { sticky_turns, cooldown_turns, delay_turns, match_mode, ...old } =
      data;
    const edited = await req(
      'PUT',
      `lore/${result.json().lore_ids[0]}`,
      { ...old, world_id: world.id },
      1,
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().sticky_turns).toBe(2);
    const invalid = {
      ...raw,
      data: {
        ...raw.data,
        character_book: {
          entries: [{ content: '错误', keys: [], insertion_order: 99999 }],
        },
      },
    };
    const badPreview = (
      await req('POST', `worlds/${world.id}/imports/preview`, {
        ...input,
        data_base64: Buffer.from(JSON.stringify(invalid)).toString('base64'),
      })
    ).json();
    expect(badPreview.errors.length).toBeGreaterThan(0);
    const count = (await db.query('SELECT count(*) FROM character_templates'))
      .rows[0].count;
    expect(
      (
        await req('POST', `imports/${badPreview.id}/commit`, {
          strategy: 'skip',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await db.query('SELECT count(*) FROM character_templates')).rows[0]
        .count,
    ).toBe(count);
  });
  it('detects stale previews and supports explicit skip/copy conflicts without replacing user data', async () => {
    const input = {
      format: 'json',
      data_base64: Buffer.from(
        JSON.stringify({
          entries: [
            { comment: '航线', key: ['北塔'], content: '去北塔', position: 0 },
          ],
        }),
      ).toString('base64'),
      audience_actor_ids: [],
    };
    const p = (
      await req('POST', `worlds/${world.id}/imports/preview`, input)
    ).json();
    await create('lore', {
      world_id: world.id,
      name: '航线',
      content: '原版',
      enabled: true,
      constant: true,
      keys: [],
      case_sensitive: false,
      scan_depth: 8,
      priority: 1,
      insertion_slot: 'before_history',
      injection_depth: 0,
      audience_actor_ids: [],
    });
    expect(
      (await req('POST', `imports/${p.id}/commit`, { strategy: 'skip' }))
        .statusCode,
    ).toBe(409);
    const refreshed = (
      await req('POST', `worlds/${world.id}/imports/preview`, input)
    ).json();
    expect(refreshed.conflicts).toEqual(['世界书：航线']);
    const result = (
      await req('POST', `imports/${p.id}/commit`, { strategy: 'skip' })
    ).json();
    expect(result.lore_ids).toEqual([]);
    expect(result.skipped).toEqual(['世界书：航线']);
  });
  it('upgrades populated P2 history and can repeat migration without data loss', async () => {
    const tx = await db.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('CREATE SCHEMA p3_upgrade_fixture');
      await tx.query('SET LOCAL search_path=p3_upgrade_fixture,public');
      for (const file of ['001_foundation.sql', '002_worlds_and_cast.sql'])
        await tx.query(await readFile('migrations/' + file, 'utf8'));
      const o = randomUUID(),
        w = randomUUID();
      await tx.query('INSERT INTO owners(id) VALUES($1)', [o]);
      await tx.query(
        "INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,'P2')",
        [w, o],
      );
      await tx.query(
        await readFile('migrations/003_memory_and_imports.sql', 'utf8'),
      );
      expect(
        (await tx.query('SELECT enabled,index_version FROM memory_settings'))
          .rows,
      ).toEqual([{ enabled: false, index_version: 1 }]);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    await migrate(db);
  });
});
async function extractAfterChat() {
  await chat('新约定');
  return extract();
}
