import { hash } from '../../packages/server/src/security.js';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { initializeOwner } from '../../packages/server/src/modules/pairing/auth.js';
import { editEntity } from '../../packages/server/src/modules/worlds/index.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import {
  memoryCommand,
  recallMaterials,
} from '../../packages/server/src/modules/memory/materials.js';
import { mockModel } from '../fixtures/mock-model.js';
import {
  exportBackup,
  previewRestore,
  restoreBackup,
} from '../../packages/server/src/modules/backups/index.js';
const url = process.env.TEST_DATABASE_URL!;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    ALLOW_INSECURE_LOCAL: 'true',
    MODEL_TIMEOUT_MS: '3000',
  });
let owner: string,
  world: any,
  actors: any[],
  room: any,
  mock: Awaited<ReturnType<typeof mockModel>>;
const call = (command: string, payload: any, revision = 0) =>
  memoryCommand(db, config, owner, {
    command,
    payload,
    operation_id: randomUUID(),
    expected_revision: revision,
  });
beforeAll(() => migrate(db));
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  mock = await mockModel();
  const provider = await createProvider(db, config, owner, {
    name: 'fixture',
    model: 'fixture',
    base_url: mock.url,
    api_key: 'synthetic',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  world = await editEntity(db, owner, 'worlds', 'POST', {
    name: '测试',
    description: '',
    persona: { name: '用户', description: '' },
  });
  actors = [];
  for (const name of ['甲', '乙']) {
    const t = await editEntity(db, owner, 'characters', 'POST', {
      name,
      description: '',
      personality: '',
      voice: '',
      scenario: '',
      example: '',
      greeting: '',
    });
    actors.push(
      await editEntity(db, owner, 'actors', 'POST', {
        world_id: world.id,
        template_id: t.id,
        template_revision: 1,
        name,
        participation: 50,
      }),
    );
  }
  room = await editEntity(db, owner, 'rooms', 'POST', {
    world_id: world.id,
    name: '甲私聊',
    kind: 'direct',
    max_replies: 1,
    actor_ids: [actors[0].id],
    provider_id: provider.id,
  });
});
afterEach(() => mock.close());
afterAll(() => db.end());
const material = (kind: string, content: string) =>
  call('saveMaterial', {
    actor_id: actors[0].id,
    kind,
    title: kind,
    content,
    summary: '摘要',
  });
it('T07 modes retain old material, directories hide long bodies and actor recall is isolated', async () => {
  await material('diary', '日记私有暗号');
  await material('structured', '结构私有暗号');
  await material('profile', '长资料正文不自动发送');
  await material('info', '共享卡片');
  let rows = await recallMaterials(db, owner, actors[0].id, '暗号');
  expect(JSON.stringify(rows)).toContain('结构私有暗号');
  expect(JSON.stringify(rows)).not.toContain('日记私有暗号');
  expect(rows.find((r) => r.kind === 'profile')?.content).not.toContain(
    '长资料正文',
  );
  await call('setMemoryPolicy', {
    actor_id: actors[0].id,
    mode: 'diary',
    recall: 'light',
    vector_scope: 'user',
    interval_seconds: 300,
  });
  rows = await recallMaterials(db, owner, actors[0].id, '暗号');
  expect(JSON.stringify(rows)).toContain('日记私有暗号');
  expect(JSON.stringify(rows)).not.toContain('结构私有暗号');
  expect(rows.some((r) => r.kind === 'info')).toBe(true);
  expect(await recallMaterials(db, owner, actors[1].id, '暗号')).toEqual([]);
  expect(
    (await call('memoryLibrary', { actor_id: actors[0].id })).materials,
  ).toHaveLength(4);
});
it('T07 correction is atomic, revision protected and cannot undo subsequent manual edits', async () => {
  const m = await material('fact', '原始资料');
  const preview = await call('previewMemoryCorrection', {
    actor_id: actors[0].id,
    changes: [{ id: m.id, content: '纠正资料' }],
  });
  await call('applyMemoryCorrection', {
    actor_id: actors[0].id,
    id: preview.id,
  });
  await call(
    'saveMaterial',
    {
      actor_id: actors[0].id,
      id: m.id,
      kind: 'fact',
      title: '人工',
      content: '之后人工修改',
      summary: '',
    },
    2,
  );
  await expect(
    call('undoMemoryCorrection', { actor_id: actors[0].id, id: preview.id }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(
    (await call('memoryLibrary', { actor_id: actors[0].id })).materials[0]
      .content,
  ).toBe('之后人工修改');
  const stale = await call('previewMemoryCorrection', {
    actor_id: actors[0].id,
    changes: [{ id: m.id, content: '预览后的修改' }],
  });
  await call(
    'memoryFeedback',
    { actor_id: actors[0].id, id: m.id, feedback: 'outdated' },
    3,
  );
  await expect(
    call('applyMemoryCorrection', { actor_id: actors[0].id, id: stale.id }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await recallMaterials(db, owner, actors[0].id, '资料')).toEqual([]);
});
it('T07 participation forbids manual organization and excludes existing derived material without deleting it', async () => {
  const m = await material('diary', '历史资料');
  await db.query(
    'UPDATE memory_materials SET room_id=$2,independent=false WHERE id=$1',
    [m.id, room.id],
  );
  await call(
    'setMemoryParticipation',
    { actor_id: actors[0].id, room_id: room.id, enabled: false },
    room.revision,
  );
  await expect(
    call('organizeMemory', { actor_id: actors[0].id, room_id: room.id }),
  ).rejects.toMatchObject({ code: 'memory_participation' });
  expect(mock.calls).toBe(0);
  expect(await recallMaterials(db, owner, actors[0].id, '历史')).toEqual([]);
  expect(
    (await call('memoryLibrary', { actor_id: actors[0].id })).materials,
  ).toHaveLength(1);
});
it('T07 portable backup preserves modes, feedback and material ownership', async () => {
  const m = await material('fact', '测试资料');
  await call(
    'memoryFeedback',
    { actor_id: actors[0].id, id: m.id, feedback: 'less' },
    1,
  );
  const pack = await exportBackup(db, 'synthetic-password');
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  const preview = await previewRestore(
    db,
    config,
    owner,
    pack.archive,
    'synthetic-password',
  );
  await restoreBackup(db, config, owner, preview.id, preview.preview_token);
  expect(
    (await db.query('SELECT content,feedback FROM memory_materials')).rows,
  ).toEqual([{ content: '测试资料', feedback: 'less' }]);
});
it('T08 importing a book does not bind it; disabling one binding preserves another and group ignores global', async () => {
  const { bookCommand, allowedBookEntries } =
    await import('../../packages/server/src/modules/lorebooks/library.js');
  const bookCall = (command: string, payload: any, revision = 0) =>
    bookCommand(db, owner, {
      command,
      payload: { world_id: world.id, ...payload },
      operation_id: randomUUID(),
      expected_revision: revision,
    });
  const book = await bookCall('createBook', { name: '共享设定' });
  const data = {
    name: '设定',
    content: '石桥',
    enabled: true,
    constant: true,
    keys: [],
    case_sensitive: false,
    scan_depth: 0,
    priority: 0,
    insertion_slot: 'before_history',
    injection_depth: 0,
    audience_actor_ids: [],
  };
  const entry = await bookCall('saveBookEntry', { book_id: book.id, data });
  expect(
    await allowedBookEntries(db, owner, world.id, room.id, actors[0].id),
  ).toEqual([]);
  await bookCall('bindBook', {
    book_id: book.id,
    scope: 'global',
    target_id: owner,
    enabled: true,
  });
  await bookCall('bindBook', {
    book_id: book.id,
    scope: 'room',
    target_id: room.id,
    enabled: true,
  });
  await bookCall(
    'bindBook',
    { book_id: book.id, scope: 'room', target_id: room.id, enabled: false },
    1,
  );
  expect(
    (await allowedBookEntries(db, owner, world.id, room.id, actors[0].id)).map(
      (e) => e.id,
    ),
  ).toEqual([entry.id]);
  const group = await editEntity(db, owner, 'rooms', 'POST', {
    world_id: world.id,
    name: '群',
    kind: 'group',
    max_replies: 2,
    actor_ids: actors.map((a) => a.id),
    provider_id: room.provider_id,
  });
  expect(
    await allowedBookEntries(db, owner, world.id, group.id, actors[0].id),
  ).toEqual([]);
  await bookCall('bindBook', {
    book_id: book.id,
    scope: 'group_member',
    target_id: group.id,
    actor_id: actors[0].id,
    enabled: true,
  });
  expect(
    await allowedBookEntries(db, owner, world.id, group.id, actors[0].id),
  ).toHaveLength(1);
  expect(
    await allowedBookEntries(db, owner, world.id, group.id, actors[1].id),
  ).toEqual([]);
});
it('T08 exclusion overrides constants and recursive probability choices remain bounded and deterministic', async () => {
  const { selectLore } =
    await import('../../packages/server/src/modules/lorebooks/selection.js');
  const data = {
    content: '甲',
    enabled: true,
    constant: false,
    keys: ['乙'],
    case_sensitive: false,
    scan_depth: 3,
    priority: 0,
    insertion_slot: 'before_history',
    injection_depth: 0,
    recursion: 'allow',
    probability: 100,
  };
  const entries = [
    { id: 'a', revision: 1, data },
    { id: 'b', revision: 1, data: { ...data, keys: ['甲'], content: '乙' } },
    {
      id: 'excluded',
      revision: 1,
      data: { ...data, constant: true, exclude_keys: ['乙'] },
    },
    {
      id: 'zero',
      revision: 1,
      data: { ...data, scan_depth: 0, recursion: 'direct' },
    },
  ];
  const first = selectLore(entries, [], { content: '乙' }, 'fixed', 1000, 1000);
  expect(first.selected.map((e) => e.id)).toEqual(['a', 'b']);
  expect(first.decisions.find((e) => e.id === 'excluded')?.reason).toBe(
    'excluded',
  );
  expect(
    selectLore(entries, [], { content: '乙' }, 'fixed', 1000, 1000),
  ).toEqual(first);
  const weighted = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    revision: 1,
    data: {
      ...data,
      constant: true,
      probability: 70,
      exclusion_group: 'one',
      weight: i + 1,
    },
  }));
  const chosen = selectLore(
    weighted,
    [],
    { content: '' },
    'request-id',
    1000,
    1000,
  );
  expect(chosen.selected).toHaveLength(1);
  expect(
    selectLore(weighted, [], { content: '' }, 'request-id', 1000, 1000),
  ).toEqual(chosen);
});
it('T09 invalid library import is atomic, stable handles preserve identities and adopted connections survive uninstall', async () => {
  const { extensionCommand, validateManifest } =
    await import('../../packages/server/src/modules/extensions/index.js');
  const { hash } = await import('../../packages/server/src/security.js');
  const ext = (command: string, payload: any, revision = 0) =>
    extensionCommand(db, owner, {
      command,
      payload,
      operation_id: randomUUID(),
      expected_revision: revision,
    });
  const connections = [
    {
      handle: 'fixture',
      name: '工具',
      url: mock.url,
      transport: 'streamable_http',
      private_addresses: ['127.0.0.1'],
      enabled: true,
    },
  ];
  const preview = await ext('previewConnectionImport', { connections });
  const first = await ext('applyConnectionImport', {
    connections,
    preview_token: preview.preview_token,
  });
  await expect(
    ext('previewConnectionImport', {
      connections: [...connections, { bad: true }],
    }),
  ).rejects.toMatchObject({ code: 'invalid_manifest' });
  const again = await ext('previewConnectionImport', { connections });
  const second = await ext('applyConnectionImport', {
    connections,
    preview_token: again.preview_token,
  });
  expect(second.connections[0].id).toBe(first.connections[0].id);
  const resources = { 'SKILL.md': '测试说明，不授予权限' };
  const manifest = {
    schemaVersion: 1,
    id: 'test',
    version: '1',
    name: '合成说明',
    description: '测试',
    entrypoint: 'SKILL.md',
    runtime: 'instructions',
    resourceHashes: { 'SKILL.md': hash(resources['SKILL.md']) },
    requiredCapabilities: ['external_write'],
  };
  expect(() =>
    validateManifest(
      {
        ...manifest,
        entrypoint: '../outside',
        resourceHashes: { '../outside': hash('bad') },
      },
      { '../outside': 'bad' },
    ),
  ).toThrow();
  const pack = {
    manifest,
    resources,
    connection_ids: [first.connections[0].id],
  };
  const installPreview = await ext('previewExtension', pack);
  const install = await ext('installExtension', {
    ...pack,
    preview_token: installPreview.preview_token,
  });
  const { executeInternal } =
    await import('../../packages/server/src/modules/documents/tools.js');
  await ext('setSkillMode', {
    id: install.id,
    actor_id: actors[0].id,
    mode: 'manual',
  });
  const run = { id: randomUUID(), owner_id: owner };
  const read = {
    tool_name: 'read_skill',
    actor_id: actors[0].id,
    arguments: { id: install.id },
  };
  await expect(executeInternal(db as any, run, read)).rejects.toMatchObject({
    code: 'not_found',
  });
  await ext(
    'setSkillMode',
    { id: install.id, actor_id: actors[0].id, mode: 'candidate' },
    1,
  );
  expect((await executeInternal(db as any, run, read)).content).toBe(
    resources['SKILL.md'],
  );
  await expect(
    executeInternal(db as any, run, {
      ...read,
      arguments: { id: install.id, path: '../outside' },
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(
    (await db.query('SELECT count(*)::int n FROM tool_grants')).rows[0].n,
  ).toBe(0);
  const removal = await ext('previewUninstall', { id: install.id });
  await ext(
    'uninstallExtension',
    { id: install.id, preview_token: removal.preview_token },
    install.revision,
  );
  expect(
    (
      await db.query('SELECT enabled FROM mcp_connections WHERE id=$1', [
        first.connections[0].id,
      ])
    ).rows[0].enabled,
  ).toBe(true);
  expect(
    (
      await db.query('SELECT resources FROM extension_installs WHERE id=$1', [
        install.id,
      ])
    ).rows[0].resources,
  ).toEqual(resources);
});

import { miniappCommand } from '../../packages/server/src/modules/miniapps/index.js';
import { groupCommand } from '../../packages/server/src/modules/groups/index.js';
import {
  voiceCommand,
  playedWav,
} from '../../packages/server/src/modules/media/voice.js';
import { enqueue } from '../../packages/server/src/modules/runs/repository.js';
const feature = (
  command: string,
  payload: any,
  expected_revision = 0,
  operation_id = randomUUID(),
) => ({ command, payload, expected_revision, operation_id });
it('T12 disabled execution, read-only AI, persistence off and concurrent state conflicts preserve data', async () => {
  const app = await miniappCommand(
    db,
    config,
    owner,
    feature('saveMiniApp', {
      actor_id: actors[0].id,
      title: '计数卡',
      language: 'html',
      source: '<input id="count">',
      resources: {},
    }),
  );
  await expect(
    miniappCommand(
      db,
      config,
      owner,
      feature('openRuntime', { id: app.id, principal: 'owner' }),
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await miniappCommand(
    db,
    config,
    owner,
    feature(
      'setAppPermissions',
      { id: app.id, run_enabled: true, persistence: true, ai_state: 'read' },
      1,
    ),
  );
  const a = await miniappCommand(
    db,
    config,
    owner,
    feature('openRuntime', { id: app.id, principal: 'owner' }),
  );
  const b = await miniappCommand(
    db,
    config,
    owner,
    feature('openRuntime', { id: app.id, principal: 'owner' }),
  );
  const ai = await miniappCommand(
    db,
    config,
    owner,
    feature('openRuntime', { id: app.id, principal: 'ai' }),
  );
  expect(
    (
      await miniappCommand(
        db,
        config,
        owner,
        feature('commitRuntimeState', {
          session_id: ai.id,
          state: { count: 99 },
        }),
      )
    ).saved,
  ).toBe(false);
  expect(
    (
      await miniappCommand(
        db,
        config,
        owner,
        feature('commitRuntimeState', {
          session_id: a.id,
          state: { count: 1 },
        }),
      )
    ).saved,
  ).toBe(true);
  const conflict = await miniappCommand(
    db,
    config,
    owner,
    feature('commitRuntimeState', { session_id: b.id, state: { count: 2 } }),
  );
  expect(conflict.conflict_id).toBeTruthy();
  expect(
    (
      await db.query('SELECT state FROM runtime_conflicts WHERE id=$1', [
        conflict.conflict_id,
      ])
    ).rows[0].state,
  ).toEqual({ count: 2 });
  await miniappCommand(
    db,
    config,
    owner,
    feature(
      'setAppPermissions',
      { id: app.id, run_enabled: true, persistence: false, ai_state: 'write' },
      2,
    ),
  );
  const off = await miniappCommand(
    db,
    config,
    owner,
    feature('openRuntime', { id: app.id, principal: 'owner' }),
  );
  expect(off.state).toEqual({});
  expect(
    (
      await miniappCommand(
        db,
        config,
        owner,
        feature(
          'commitRuntimeState',
          { session_id: off.id, state: { count: 3 } },
          1,
        ),
      )
    ).saved,
  ).toBe(false);
  expect(
    (await db.query('SELECT state FROM miniapps WHERE id=$1', [app.id])).rows[0]
      .state,
  ).toEqual({ count: 1 });
  const exported = await miniappCommand(
    db,
    config,
    owner,
    feature('exportMiniApp', { id: app.id }),
  );
  expect(exported.state).toBeUndefined();
  expect(exported.run_enabled).toBeUndefined();
  expect(exported.id).toBeUndefined();
  await expect(
    miniappCommand(
      db,
      config,
      owner,
      feature('runtimeRequest', {
        session_id: off.id,
        url: 'https://example.org/',
      }),
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});
it('T13 private lanes share group restrictions and silence creates no execution', async () => {
  const g = await editEntity(db, owner, 'rooms', 'POST', {
    world_id: world.id,
    name: '群',
    kind: 'group',
    actor_ids: actors.map((a) => a.id),
    provider_id: room.provider_id,
    max_replies: 2,
  });
  const policy = await groupCommand(
    db,
    owner,
    feature('saveGroupPolicy', {
      room_id: g.id,
      instruction: '群范围',
      mcp_ids: [],
      memory_enabled: false,
      reply_policy: 'silence',
    }),
  );
  const ack = await enqueue(db, owner, g.id, {
    client_command_id: randomUUID(),
    content: '静默',
  });
  expect(
    (await db.query('SELECT state FROM runs WHERE id=$1', [ack.run_id])).rows[0]
      .state,
  ).toBe('completed');
  expect(
    (await db.query('SELECT 1 FROM outbox WHERE run_id=$1', [ack.run_id]))
      .rowCount,
  ).toBe(0);
  const lane = await groupCommand(
    db,
    owner,
    feature('sendPrivateLane', {
      room_id: g.id,
      actor_id: actors[0].id,
      content: '甲机密',
    }),
  );
  expect(
    (
      await db.query(
        'SELECT actor_id FROM message_audiences WHERE message_id=$1',
        [lane.message_id],
      )
    ).rows.map((r) => r.actor_id),
  ).toEqual([actors[0].id]);
  expect(
    (
      await db.query('SELECT group_snapshot FROM runs WHERE id=$1', [
        lane.run_id,
      ])
    ).rows[0].group_snapshot.mcp_ids,
  ).toEqual([]);
  expect(policy.memory_enabled).toBe(false);
});
it('T11 late STT cannot overwrite a finalized turn and expired invite cannot be accepted', async () => {
  const settings = {
    greeting: false,
    muted: false,
    quiet_ms: 1200,
    custom_stt: false,
    fallback: true,
  };
  const s = await voiceCommand(
    db,
    owner,
    feature('startVoice', {
      room_id: room.id,
      actor_id: actors[0].id,
      settings,
    }),
  );
  const turn = await voiceCommand(
    db,
    owner,
    feature('voiceDraft', {
      session_id: s.id,
      turn_id: randomUUID(),
      text: '手动确认文本',
    }),
  );
  const send = feature(
    'finalizeVoice',
    { session_id: s.id, turn_id: turn.id },
    1,
  );
  const first = await voiceCommand(db, owner, send);
  expect(await voiceCommand(db, owner, send)).toEqual(first);
  await expect(
    voiceCommand(
      db,
      owner,
      feature(
        'acceptTranscription',
        { session_id: s.id, turn_id: turn.id, job_id: randomUUID() },
        2,
      ),
    ),
  ).rejects.toMatchObject({ code: 'voice_state' });
  const invite = (
    await db.query(
      "INSERT INTO voice_invites(owner_id,room_id,actor_id,expires_at) VALUES($1,$2,$3,now()-interval '1 second') RETURNING id",
      [owner, room.id, actors[0].id],
    )
  ).rows[0];
  await expect(
    voiceCommand(
      db,
      owner,
      feature('startVoice', {
        room_id: room.id,
        actor_id: actors[0].id,
        invite_id: invite.id,
        settings,
      }),
    ),
  ).rejects.toMatchObject({ code: 'voice_state' });
});
it('T11 played audio export excludes unplayed PCM samples and acknowledges its new revision', async () => {
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(32000, 40);
  expect(playedWav(wav, 250).length).toBe(8044);
  expect(() => playedWav(wav, 0)).toThrow();
  const { storeMedia } =
    await import('../../packages/server/src/modules/media/index.js');
  const s = await voiceCommand(
    db,
    owner,
    feature('startVoice', {
      room_id: room.id,
      actor_id: actors[0].id,
      settings: {
        greeting: false,
        muted: false,
        quiet_ms: 1200,
        custom_stt: false,
        fallback: true,
      },
    }),
  );
  const turn = await voiceCommand(
    db,
    owner,
    feature('voiceDraft', {
      session_id: s.id,
      turn_id: randomUUID(),
      text: '合成语音',
    }),
  );
  const id = await storeMedia(
    db,
    owner,
    world.id,
    actors[0].id,
    wav,
    'audio/wav',
  );
  const job = (
    await db.query(
      "INSERT INTO media_jobs(owner_id,world_id,actor_id,operation_id,input_hash,kind,input,provider,state,result) VALUES($1,$2,$3,$4,'synthetic','tts','{}','{}','completed',$5) RETURNING id",
      [
        owner,
        world.id,
        actors[0].id,
        randomUUID(),
        JSON.stringify({ asset_id: id }),
      ],
    )
  ).rows[0];
  const played = await voiceCommand(
    db,
    owner,
    feature(
      'voicePlayback',
      { session_id: s.id, turn_id: turn.id, job_id: job.id, played_ms: 250 },
      turn.revision,
    ),
  );
  const save = feature(
    'savePlayedAudio',
    { session_id: s.id, turn_id: turn.id },
    played.revision,
  );
  const saved = await voiceCommand(db, owner, save);
  expect(await voiceCommand(db, owner, save)).toEqual(saved);
  expect(saved.revision).toBe(played.revision + 1);
  expect(
    (await db.query('SELECT size FROM assets WHERE id=$1', [saved.asset_id]))
      .rows[0].size,
  ).toBe(8044);
  expect(
    (
      await voiceCommand(
        db,
        owner,
        feature(
          'voicePlayback',
          {
            session_id: s.id,
            turn_id: turn.id,
            job_id: job.id,
            played_ms: 500,
          },
          saved.revision,
        ),
      )
    ).played_ms,
  ).toBe(500);
});

import { createServer } from 'node:http';
import {
  createMediaJob,
  processMedia,
  mediaCommand,
} from '../../packages/server/src/modules/media/index.js';
import { saveModelRoute } from '../../packages/server/src/modules/providers/routes.js';
import {
  createAsset,
  previewAssetDeletion,
} from '../../packages/server/src/modules/assets/index.js';
import {
  claim,
  getRun,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
async function mediaFixture() {
  let posts = 0,
    gets = 0,
    lose = false;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const b of req) body += b;
    requests.push({ url: req.url, body });
    if (req.method === 'POST') posts++;
    else gets++;
    if (lose && req.method === 'POST') {
      res.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/embeddings') {
      res.end(
        JSON.stringify({
          data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }],
          usage: { total_tokens: 3 },
        }),
      );
      return;
    }
    if (req.url === '/videos' && req.method === 'POST')
      res.end(JSON.stringify({ id: 'video_fixture', status: 'queued' }));
    else if (req.url === '/videos/video_fixture/content') {
      res.setHeader('Content-Type', 'video/mp4');
      res.end('synthetic-mp4');
    } else if (req.url === '/videos/video_fixture')
      res.end(JSON.stringify({ id: 'video_fixture', status: 'completed' }));
    else if (req.url === '/images/generations' || req.url === '/images/edits')
      res.end(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('synthetic-png').toString('base64') }],
        }),
      );
    else if (req.url === '/chat/completions')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '识别文字' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
      );
    else if (req.url === '/audio/transcriptions')
      res.end(JSON.stringify({ text: '转写文本' }));
    else {
      res.statusCode = 429;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as any;
  const provider = await createProvider(db, config, owner, {
    name: '媒体假服务',
    model: 'fixture',
    base_url: `http://127.0.0.1:${address.port}`,
    api_key: 'synthetic',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  for (const capability of ['image', 'video', 'vision', 'stt', 'tts'] as const)
    await saveModelRoute(db, owner, {
      operation_id: randomUUID(),
      subject_id: actors[0].id,
      subject_kind: 'actor',
      capability,
      expected_revision: 0,
      route: { state: 'override', provider_id: provider.id },
    });
  return {
    provider,
    requests,
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
    lose() {
      lose = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
it('T10 video configuration does not request, duplicate command submits once and accepted job remains queryable with disabled route', async () => {
  const media = await mediaFixture();
  try {
    await mediaCommand(
      db,
      config,
      owner,
      feature(
        'mediaConfig',
        {
          id: media.provider.id,
          options: { video: { seconds: '4', size: '720x1280' } },
        },
        1,
      ),
    );
    expect(media.posts).toBe(0);
    const input = feature('createMediaJob', {
      actor_id: actors[0].id,
      kind: 'video',
      prompt: '合成视频',
    });
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () => createMediaJob(db, config, owner, input)),
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
    await Promise.all(jobs.map((j) => processMedia(db, config, j.id)));
    expect(media.posts).toBe(1);
    expect(
      (await db.query('SELECT state FROM media_jobs WHERE id=$1', [jobs[0].id]))
        .rows[0].state,
    ).toBe('accepted');
    await saveModelRoute(db, owner, {
      operation_id: randomUUID(),
      subject_id: actors[0].id,
      subject_kind: 'actor',
      capability: 'video',
      expected_revision: 1,
      route: { state: 'disabled' },
    });
    await processMedia(db, config, jobs[0].id, true);
    expect(media.posts).toBe(1);
    expect(media.gets).toBe(2);
    const done = (
      await db.query('SELECT * FROM media_jobs WHERE id=$1', [jobs[0].id])
    ).rows[0];
    expect(done.state).toBe('completed');
    expect(
      (await previewAssetDeletion(db, owner, done.result.asset_id)).can_delete,
    ).toBe(false);
  } finally {
    await media.close();
  }
});
it('T10 accepted-then-disconnected submission becomes unknown and never auto-replays', async () => {
  const media = await mediaFixture();
  try {
    media.lose();
    const job = await createMediaJob(
      db,
      config,
      owner,
      feature('createMediaJob', {
        actor_id: actors[0].id,
        kind: 'video',
        prompt: '合成',
      }),
    );
    await processMedia(db, config, job.id);
    expect(
      (await db.query('SELECT state FROM media_jobs WHERE id=$1', [job.id]))
        .rows[0].state,
    ).toBe('unknown');
    await processMedia(db, config, job.id);
    await mediaCommand(
      db,
      config,
      owner,
      feature('refreshMediaJob', { id: job.id }),
    );
    expect(media.posts).toBe(1);
  } finally {
    await media.close();
  }
});
it('T10 all four image input modes are reflected in actual outgoing model bodies', async () => {
  const media = await mediaFixture();
  try {
    await db.query(
      'UPDATE provider_connections SET vision_enabled=true WHERE id=$1',
      [room.provider_id],
    );
    for (const mode of ['original', 'text', 'both', 'metadata']) {
      const a = await createAsset(db, owner, {
        operation_id: randomUUID(),
        world_id: world.id,
        actor_id: actors[0].id,
        mime: 'image/png',
        content_base64: Buffer.from('pixels-' + mode).toString('base64'),
      });
      let vision: any;
      if (['text', 'both'].includes(mode)) {
        vision = await createMediaJob(
          db,
          config,
          owner,
          feature('createMediaJob', {
            actor_id: actors[0].id,
            kind: 'vision',
            prompt: '识别',
            asset_id: a.id,
          }),
        );
        await processMedia(db, config, vision.id);
        expect(
          (
            await db.query('SELECT state FROM media_jobs WHERE id=$1', [
              vision.id,
            ])
          ).rows[0].state,
        ).toBe('completed');
      }
      await mediaCommand(
        db,
        config,
        owner,
        feature(
          'prepareImage',
          {
            id: a.id,
            actor_id: actors[0].id,
            mode,
            ...(vision ? { vision_job_id: vision.id } : {}),
          },
          a.revision,
        ),
      );
      const ack = await enqueue(db, owner, room.id, {
        client_command_id: randomUUID(),
        content: '输入方式 ' + mode,
        asset_ids: [a.id],
      });
      await execute(db, config, ack.run_id);
      const last = mock.requests.at(-1).messages.at(-1);
      const payload = JSON.stringify(last);
      expect(payload.includes('data:image/png')).toBe(
        ['original', 'both'].includes(mode),
      );
      expect(payload.includes('识别文字')).toBe(
        ['text', 'both'].includes(mode),
      );
      if (mode === 'metadata') {
        expect(payload).not.toContain('base64');
        expect(payload).not.toContain('http');
      }
    }
  } finally {
    await media.close();
  }
});
it('T13 actual private-lane requests exclude other member inputs, public replies and manifests contain neither private marker', async () => {
  const group = await editEntity(db, owner, 'rooms', 'POST', {
    world_id: world.id,
    name: '隔离群',
    kind: 'group',
    actor_ids: actors.map((a) => a.id),
    provider_id: room.provider_id,
    max_replies: 1,
  });
  for (let i = 0; i < 2; i++) {
    const ack = await groupCommand(
      db,
      owner,
      feature('sendPrivateLane', {
        room_id: group.id,
        actor_id: actors[i].id,
        content: i === 0 ? '甲独有_marker_A' : '乙独有_marker_B',
      }),
    );
    await execute(db, config, ack.run_id);
    const body = JSON.stringify(mock.requests.at(-1));
    expect(body).toContain(i === 0 ? '甲独有_marker_A' : '乙独有_marker_B');
    expect(body).not.toContain(i === 0 ? '乙独有_marker_B' : '甲独有_marker_A');
  }
  const ack = await enqueue(db, owner, group.id, {
    client_command_id: randomUUID(),
    content: '公开发言',
    addressed_actor_ids: [actors[0].id],
  });
  await execute(db, config, ack.run_id);
  expect(JSON.stringify(mock.requests.at(-1))).not.toMatch(/marker_A|marker_B/);
  const manifest = (
    await db.query('SELECT data FROM prompt_manifests WHERE run_id=$1', [
      ack.run_id,
    ])
  ).rows;
  expect(JSON.stringify(manifest)).not.toMatch(/marker_A|marker_B/);
});

import { organizeMemory } from '../../packages/server/src/modules/memory/materials.js';
it('T07 complete but invalid JSON and explicit truncation retain sources and allow deliberate retry', async () => {
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: '只供故障测试的来源',
  });
  await execute(db, config, ack.run_id);
  for (const mode of ['memory-invalid-json', 'length'] as const) {
    mock.setMode(mode);
    await expect(
      organizeMemory(db, config, owner, actors[0].id, room.id, true),
    ).rejects.toMatchObject({
      code:
        mode === 'length' ? 'model_output_incomplete' : 'invalid_extraction',
    });
    expect(
      (await db.query('SELECT state FROM memory_organizations')).rows,
    ).toEqual([{ state: 'failed' }]);
    expect((await db.query('SELECT 1 FROM memory_materials')).rowCount).toBe(0);
  }
  mock.setMode('success');
  expect(
    (await organizeMemory(db, config, owner, actors[0].id, room.id, true))
      .content,
  ).toBe('合成整理正文');
  expect(
    (
      await db.query('SELECT content FROM messages WHERE id=$1', [
        ack.message_id,
      ])
    ).rows[0].content,
  ).toBe('只供故障测试的来源');
});
import { reconcileInstallReceipt } from '../../packages/server/src/modules/extensions/index.js';
import { deleteMessage } from '../../packages/server/src/modules/memory/repository.js';
it('T07 source revision changes reject in-flight organization; retry is possible and old backups cannot resurrect erased derived material', async () => {
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: '原始资料',
  });
  await execute(db, config, ack.run_id);
  const before = mock.calls;
  const pending = organizeMemory(
    db,
    config,
    owner,
    actors[0].id,
    room.id,
    true,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'source_invalidated',
  });
  for (let i = 0; i < 100 && mock.calls === before; i++)
    await new Promise((r) => setTimeout(r, 5));
  await db.query(
    "UPDATE messages SET content='变更后的资料',revision=revision+1 WHERE id=$1",
    [ack.message_id],
  );
  await rejected;
  expect((await db.query('SELECT 1 FROM memory_materials')).rowCount).toBe(0);
  const m = await organizeMemory(
    db,
    config,
    owner,
    actors[0].id,
    room.id,
    true,
  );
  expect(m.content).toBe('合成整理正文');
  const unrelated = await material('fact', '不关联被删来源');
  const correction = await call('previewMemoryCorrection', {
    actor_id: actors[0].id,
    changes: [{ id: unrelated.id, content: '仍可应用的修正' }],
  });
  await call('previewMemoryCorrection', {
    actor_id: actors[0].id,
    changes: [{ id: m.id, content: '关联来源的修正' }],
  });
  const pack = await exportBackup(db, 'synthetic-password');
  await deleteMessage(db, owner, ack.message_id);
  expect((await db.query('SELECT id FROM memory_corrections')).rows).toEqual([
    { id: correction.id },
  ]);
  expect(
    (await db.query('SELECT content FROM memory_materials WHERE id=$1', [m.id]))
      .rows[0].content,
  ).toBe('');
  await expect(
    previewRestore(db, config, owner, pack.archive, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_privacy_conflict' });
});
it('T09 cancelled remote install accepts only matching late receipt without deleting an adopted connection', async () => {
  const { extensionCommand } =
    await import('../../packages/server/src/modules/extensions/index.js');
  const resources = { 'SKILL.md': '仅合成说明' };
  const manifest = {
    schemaVersion: 1,
    id: 'test.late',
    version: '1',
    name: '合成扩展',
    description: '测试',
    runtime: 'instructions',
    entrypoint: 'SKILL.md',
    resourceHashes: { 'SKILL.md': hash(resources['SKILL.md']) },
    requiredCapabilities: [],
  };
  const p = { manifest, resources, connection_ids: [] };
  const preview = await extensionCommand(
    db,
    owner,
    feature('previewExtension', p),
  );
  const install = await extensionCommand(
    db,
    owner,
    feature('installExtension', { ...p, preview_token: preview.preview_token }),
  );
  const job = await extensionCommand(
    db,
    owner,
    feature('prepareRemoteInstall', {
      id: install.id,
      target: 'synthetic-host',
    }),
  );
  await extensionCommand(
    db,
    owner,
    feature('cancelRemoteInstall', { id: job.id }),
  );
  const receipt = {
    job_id: job.id,
    state: 'completed' as const,
    data: { plugin_id: 'synthetic-plugin' },
  };
  await expect(
    reconcileInstallReceipt(db, owner, job.id, 'wrong-host', receipt),
  ).rejects.toMatchObject({ code: 'receipt_scope' });
  const result = await reconcileInstallReceipt(
    db,
    owner,
    job.id,
    'synthetic-host',
    receipt,
  );
  expect(result.state).toBe('cancelled');
  expect(result.late).toBe(true);
  expect(
    (
      await reconcileInstallReceipt(
        db,
        owner,
        job.id,
        'synthetic-host',
        receipt,
      )
    ).id,
  ).toBe(job.id);
  expect(
    (
      await db.query(
        'SELECT late_receipts FROM extension_installs WHERE id=$1',
        [install.id],
      )
    ).rows[0].late_receipts,
  ).toHaveLength(1);
});
import {
  rebuildSourceVectors,
  recallSourceVectors,
} from '../../packages/server/src/modules/memory/source-vectors.js';
import {
  policies,
  savePolicy,
} from '../../packages/server/src/modules/autonomy/policy.js';
it('T07 source vector scope rebuilds in a new namespace and atomically switches without changing originals or feedback', async () => {
  const media = await mediaFixture();
  try {
    const { g, p } = await policies(db, owner, world.id);
    await savePolicy(db, owner, null, g.revision, { ...g, enabled: true });
    await savePolicy(db, owner, world.id, p.revision, {
      ...p,
      enabled: true,
      memory: true,
      quiet_start: '00:00',
      quiet_end: '00:00',
    });
    await db.query(
      'INSERT INTO memory_settings(owner_id,world_id,embedding_provider_id,embedding_dimensions) VALUES($1,$2,$3,8) ON CONFLICT(world_id) DO UPDATE SET embedding_provider_id=$3,embedding_dimensions=8',
      [owner, world.id, media.provider.id],
    );
    const ack = await enqueue(db, owner, room.id, {
      client_command_id: randomUUID(),
      content: '向量源',
    });
    await execute(db, config, ack.run_id);
    const m = await material('fact', '不改变的事实');
    await db.query(
      "INSERT INTO memory_source_shards(actor_id,message_id,index_version,scope,state,error_code) SELECT $1,$2,index_version,'both','failed','synthetic_fault' FROM memory_settings WHERE world_id=$3",
      [actors[0].id, ack.message_id, world.id],
    );
    expect(
      (await call('memoryLibrary', { actor_id: actors[0].id })).source_shards,
    ).toHaveLength(1);
    await call('sourceIndexShard', {
      actor_id: actors[0].id,
      id: ack.message_id,
      skip: true,
    });
    expect(
      (await call('memoryLibrary', { actor_id: actors[0].id })).source_shards[0]
        .state,
    ).toBe('skipped');
    await call('sourceIndexShard', {
      actor_id: actors[0].id,
      id: ack.message_id,
      skip: false,
    });
    expect(
      (await call('memoryLibrary', { actor_id: actors[0].id })).source_shards,
    ).toEqual([]);
    await call(
      'memoryFeedback',
      { actor_id: actors[0].id, id: m.id, feedback: 'less' },
      1,
    );
    for (let i = 0; i < 3; i++)
      await rebuildSourceVectors(db, config, world.id);
    const initial = (
      await db.query('SELECT * FROM memory_source_indexes WHERE actor_id=$1', [
        actors[0].id,
      ])
    ).rows[0];
    expect(initial.active_scope).toBe('both');
    expect(
      (
        await db.query(
          'SELECT * FROM memory_source_vectors WHERE actor_id=$1',
          [actors[0].id],
        )
      ).rowCount,
    ).toBe(2);
    await call('setMemoryPolicy', {
      actor_id: actors[0].id,
      mode: 'structured',
      recall: 'standard',
      vector_scope: 'user',
      interval_seconds: 300,
    });
    await rebuildSourceVectors(db, config, world.id);
    expect(
      (
        await db.query(
          'SELECT active_scope FROM memory_source_indexes WHERE actor_id=$1',
          [actors[0].id],
        )
      ).rows[0].active_scope,
    ).toBe('both');
    await rebuildSourceVectors(db, config, world.id);
    const selected = await recallSourceVectors(db, owner, actors[0].id, {
      version: initial.active_version,
      dimensions: 8,
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(selected.map((x) => x.role)).toEqual(['user']);
    expect(
      await recallSourceVectors(db, owner, actors[1].id, {
        version: initial.active_version,
        dimensions: 8,
        vector: [1, 0, 0, 0, 0, 0, 0, 0],
      }),
    ).toEqual([]);
    expect(
      (
        await db.query(
          'SELECT content,feedback FROM memory_materials WHERE id=$1',
          [m.id],
        )
      ).rows[0],
    ).toEqual({ content: '不改变的事实', feedback: 'less' });
    expect(
      (
        await db.query('SELECT content FROM messages WHERE id=$1', [
          ack.message_id,
        ])
      ).rows[0].content,
    ).toBe('向量源');
  } finally {
    await media.close();
  }
});
import { scryptSync } from 'node:crypto';
import { encrypt, decrypt } from '../../packages/server/src/security.js';
it('T06/T07 upgrades authenticated 020 milestone backup explicitly without mutating the original archive', async () => {
  const backup = await exportBackup(db, 'synthetic-password');
  const key = scryptSync(
    'synthetic-password',
    Buffer.from(backup.archive.salt, 'base64'),
    32,
  );
  const cipher = { masterKey: key, keyVersion: 1 } as any;
  const pack = JSON.parse(
    decrypt(backup.archive.payload, cipher, 'echo-business-v1'),
  );
  const added = [
    'external_documents',
    'remote_backup_plans',
    'remote_backups',
    'devices',
    'device_capabilities',
    'system_policies',
    'system_actions',
    'today_sources',
    'share_drafts',
    'share_draft_assets',
    'schedules',
    'schedule_occurrences',
    'event_triggers',
    'received_events',
    'host_nodes',
    'host_identity_links',
    'host_jobs',
    'host_receipts',
    'host_snapshots',
    'execution_delegations',
    'reply_relays',
    'host_plugins',
    'memory_policies',
    'memory_materials',
    'memory_corrections',
    'memory_organizations',
    'worldbooks',
    'worldbook_bindings',
    'extension_installs',
    'skill_bindings',
    'media_jobs',
    'media_job_assets',
    'voice_sessions',
    'voice_turns',
    'voice_invites',
    'group_policies',
    'group_member_policies',
    'miniapps',
    'runtime_conflicts',
    'extension_install_jobs',
  ];
  for (const t of added) delete pack.tables[t];
  const fields: any = {
    rooms: ['memory_participation', 'parent_group_id', 'lane_actor_id'],
    provider_connections: ['media_options', 'protocol'],
    assets: ['input_mode', 'extracted_text'],
    asset_references: ['input_mode', 'extracted_text'],
    background_usage: ['manual'],
    runs: [
      'group_snapshot',
      'tool_limit',
      'schedule_id',
      'schedule_revision',
      'schedule_epoch',
    ],
    messages: ['external_origin'],
    memory_settings: ['active_index_version'],
    mcp_connections: ['handle'],
  };
  for (const [t, columns] of Object.entries(fields))
    for (const row of pack.tables[t])
      for (const key of columns as string[]) delete row[key];
  pack.schema_version = pack.schema_version.filter(
    (m: any) => m.name <= '020_tool_call_identity.sql',
  );
  const archive = {
    ...backup.archive,
    payload: encrypt(JSON.stringify(pack), cipher, 'echo-business-v1'),
  };
  const before = JSON.stringify(archive);
  const preview = await previewRestore(
    db,
    config,
    owner,
    archive,
    'synthetic-password',
  );
  expect(preview.id).toBeTruthy();
  expect(JSON.stringify(archive)).toBe(before);
  key.fill(0);
});
it('T06 expanded backup round trip restores assets, voice, app source/state and pauses all restored execution', async () => {
  const media = await mediaFixture();
  try {
    const job = await createMediaJob(
      db,
      config,
      owner,
      feature('createMediaJob', {
        actor_id: actors[0].id,
        kind: 'image',
        prompt: '合成图',
      }),
    );
    await processMedia(db, config, job.id);
    const app = await miniappCommand(
      db,
      config,
      owner,
      feature('saveMiniApp', {
        actor_id: actors[0].id,
        title: '可恢复作品',
        language: 'html',
        source: '<p>合成内容</p>',
        resources: {},
      }),
    );
    await miniappCommand(
      db,
      config,
      owner,
      feature(
        'setAppPermissions',
        { id: app.id, run_enabled: true, persistence: true, ai_state: 'write' },
        1,
      ),
    );
    const session = await miniappCommand(
      db,
      config,
      owner,
      feature('openRuntime', { id: app.id, principal: 'owner' }),
    );
    await miniappCommand(
      db,
      config,
      owner,
      feature('commitRuntimeState', {
        session_id: session.id,
        state: { count: 7 },
      }),
    );
    await voiceCommand(
      db,
      owner,
      feature('startVoice', {
        room_id: room.id,
        actor_id: actors[0].id,
        settings: {
          greeting: false,
          muted: false,
          quiet_ms: 1000,
          custom_stt: false,
          fallback: true,
        },
      }),
    );
    const backup = await exportBackup(db, 'synthetic-password');
    await db.query('TRUNCATE owners CASCADE');
    owner = await initializeOwner(db, config);
    const preview = await previewRestore(
      db,
      config,
      owner,
      backup.archive,
      'synthetic-password',
    );
    await restoreBackup(
      db,
      config,
      owner,
      preview.id,
      preview.preview_token,
      false,
    );
    expect(
      (await db.query('SELECT source,state,run_enabled FROM miniapps')).rows,
    ).toEqual([
      { source: '<p>合成内容</p>', state: { count: 7 }, run_enabled: false },
    ]);
    expect(
      (await db.query('SELECT state FROM voice_sessions')).rows[0].state,
    ).toBe('closed');
    expect((await db.query('SELECT * FROM runtime_sessions')).rowCount).toBe(0);
    expect((await db.query('SELECT state FROM media_jobs')).rows[0].state).toBe(
      'completed',
    );
    expect((await db.query('SELECT 1 FROM media_job_assets')).rowCount).toBe(1);
    expect((await db.query('SELECT 1 FROM assets')).rowCount).toBe(1);
  } finally {
    await media.close();
  }
});
it('T13 private lane membership cannot be broadened and removing its group member prevents further sends', async () => {
  const g = await editEntity(db, owner, 'rooms', 'POST', {
    world_id: world.id,
    name: '权限群',
    kind: 'group',
    actor_ids: actors.map((a) => a.id),
    provider_id: room.provider_id,
    max_replies: 1,
  });
  const ack = await groupCommand(
    db,
    owner,
    feature('sendPrivateLane', {
      room_id: g.id,
      actor_id: actors[0].id,
      content: '独占输入',
    }),
  );
  await execute(db, config, ack.run_id);
  await expect(
    editEntity(
      db,
      owner,
      'rooms',
      'PUT',
      {
        name: '扩大支线',
        kind: 'group',
        actor_ids: actors.map((a) => a.id),
        provider_id: room.provider_id,
        max_replies: 1,
      },
      ack.room_id,
      1,
    ),
  ).rejects.toMatchObject({ code: 'private_lane_membership' });
  await db.query(
    'UPDATE room_memberships SET left_at=now() WHERE room_id=$1 AND actor_id=$2',
    [g.id, actors[0].id],
  );
  await expect(
    enqueue(db, owner, ack.room_id, {
      client_command_id: randomUUID(),
      content: '不应再发出',
    }),
  ).rejects.toMatchObject({ code: 'private_lane_membership' });
});

it('audit T02/T10 route revocation blocks queued media before HTTP but does not replay it on re-enable', async () => {
  const media = await mediaFixture();
  try {
    const job = await createMediaJob(
      db,
      config,
      owner,
      feature('createMediaJob', {
        actor_id: actors[0].id,
        kind: 'image',
        prompt: 'queued',
      }),
    );
    await saveModelRoute(db, owner, {
      operation_id: randomUUID(),
      subject_id: actors[0].id,
      subject_kind: 'actor',
      capability: 'image',
      expected_revision: 1,
      route: { state: 'disabled' },
    });
    await processMedia(db, config, job.id);
    expect(media.posts).toBe(0);
    expect(
      (
        await db.query('SELECT state,error_code FROM media_jobs WHERE id=$1', [
          job.id,
        ])
      ).rows[0],
    ).toMatchObject({ state: 'failed', error_code: 'capability_disabled' });
    await saveModelRoute(db, owner, {
      operation_id: randomUUID(),
      subject_id: actors[0].id,
      subject_kind: 'actor',
      capability: 'image',
      expected_revision: 2,
      route: { state: 'override', provider_id: media.provider.id },
    });
    await processMedia(db, config, job.id);
    expect(media.posts).toBe(0);
  } finally {
    await media.close();
  }
});
it('audit T10/T20 unknown media protects deletion and restore until explicit reconciliation', async () => {
  const media = await mediaFixture();
  try {
    const backup = await exportBackup(db, 'synthetic-password');
    const preview = await previewRestore(
      db,
      config,
      owner,
      backup.archive,
      'synthetic-password',
    );
    const job = await createMediaJob(
      db,
      config,
      owner,
      feature('createMediaJob', {
        actor_id: actors[0].id,
        kind: 'video',
        prompt: 'uncertain',
      }),
    );
    media.lose();
    await processMedia(db, config, job.id);
    const { deletionPreview } =
      await import('../../packages/server/src/modules/identities/index.js');
    const impact = await deletionPreview(db, owner, 'worlds', world.id);
    expect(impact.can_delete).toBe(false);
    expect(impact.unresolved_effects).toContainEqual({
      kind: 'media',
      id: job.id,
      state: 'unknown',
    });
    await expect(
      editEntity(
        db,
        owner,
        'worlds',
        'DELETE',
        null,
        world.id,
        impact.revision,
      ),
    ).rejects.toMatchObject({ code: 'reconciliation_required' });
    await expect(
      restoreBackup(db, config, owner, preview.id, preview.preview_token),
    ).rejects.toMatchObject({ code: 'restore_busy' });
    expect(media.posts).toBe(1);
  } finally {
    await media.close();
  }
});

it('audit T06/T10/T12 cross-instance restore translates media references but preserves arbitrary app-state IDs', async () => {
  const media = await mediaFixture();
  try {
    const job = await createMediaJob(
      db,
      config,
      owner,
      feature('createMediaJob', {
        actor_id: actors[0].id,
        kind: 'image',
        prompt: 'portable',
      }),
    );
    await processMedia(db, config, job.id);
    const app = await miniappCommand(
      db,
      config,
      owner,
      feature('saveMiniApp', {
        actor_id: actors[0].id,
        title: 'state',
        language: 'html',
        source: '<p>fixture</p>',
        resources: {},
      }),
    );
    const opaque = {
      id: randomUUID(),
      remote_id: randomUUID(),
      nested: { actor_id: randomUUID() },
    };
    await db.query(
      'UPDATE miniapps SET state=$2,state_revision=1 WHERE id=$1',
      [app.id, JSON.stringify(opaque)],
    );
    const before = (
      await db.query('SELECT result FROM media_jobs WHERE id=$1', [job.id])
    ).rows[0];
    const backup = await exportBackup(db, 'synthetic-password');
    await db.query('TRUNCATE owners CASCADE');
    owner = await initializeOwner(db, config);
    await db.query('UPDATE instance_metadata SET server_instance_id=$1', [
      randomUUID(),
    ]);
    const p = await previewRestore(
      db,
      config,
      owner,
      backup.archive,
      'synthetic-password',
    );
    await restoreBackup(db, config, owner, p.id, p.preview_token);
    const restored = (await db.query('SELECT result FROM media_jobs')).rows[0];
    expect(restored.result.asset_id).not.toBe(before.result.asset_id);
    expect(
      (
        await db.query('SELECT 1 FROM assets WHERE id=$1', [
          restored.result.asset_id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await db.query('SELECT state,run_enabled FROM miniapps')).rows[0],
    ).toEqual({ state: opaque, run_enabled: false });
    expect((await exportBackup(db, 'synthetic-password')).archive.format).toBe(
      'echo-encrypted',
    );
  } finally {
    await media.close();
  }
});

it('audit T02/T19 unsupported media protocol fails before reservation or HTTP rather than becoming unknown', async () => {
  const media = await mediaFixture();
  try {
    await db.query(
      "UPDATE provider_connections SET protocol='claude',revision=revision+1 WHERE id=$1",
      [media.provider.id],
    );
    await expect(
      createMediaJob(
        db,
        config,
        owner,
        feature('createMediaJob', {
          actor_id: actors[0].id,
          kind: 'image',
          prompt: 'unsupported',
        }),
      ),
    ).rejects.toMatchObject({ code: 'media_protocol_unsupported' });
    expect(media.posts).toBe(0);
    expect(
      (await db.query('SELECT count(*)::int n FROM media_jobs')).rows[0].n,
    ).toBe(0);
    expect(
      (await db.query('SELECT count(*)::int n FROM background_usage')).rows[0]
        .n,
    ).toBe(0);
  } finally {
    await media.close();
  }
});
