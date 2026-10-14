import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
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
import { buildApp } from '../../packages/server/src/app.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import {
  enqueue,
  claim,
  finish,
  getRun,
  recover,
  regenerate,
  cancel,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import {
  globalDefaults,
  policyDefaults,
  savePolicy,
  policies,
  dayAt,
} from '../../packages/server/src/modules/autonomy/policy.js';
import {
  scheduleAutonomy,
  recaps,
} from '../../packages/server/src/modules/autonomy/scheduler.js';
import { reserveBackground } from '../../packages/server/src/modules/memory/usage.js';
import {
  saveConnection,
  refreshTools,
  saveGrant,
  revokeGrant,
} from '../../packages/server/src/modules/mcp/connections.js';
import {
  proposeTool,
  decide,
  expireApprovals,
  availableTools,
} from '../../packages/server/src/modules/mcp/gateway.js';
import { snapshot } from '../../packages/server/src/modules/sync/index.js';
import { mockMcp } from '../fixtures/mock-mcp.js';
import { startWorker } from '../../packages/server/src/queue.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated test database required');
const db = pool(url),
  config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    MODEL_TIMEOUT_MS: '1800',
    LEASE_MS: '1000',
    BACKGROUND_DAILY_REQUEST_LIMIT: '100',
    BACKGROUND_DAILY_INPUT_LIMIT: '1000000',
    BACKGROUND_DAILY_OUTPUT_LIMIT: '100000',
  });
let owner: string,
  token: string,
  world: any,
  room: any,
  actors: any[],
  provider: any,
  connection: any,
  grant: any,
  app: Awaited<ReturnType<typeof buildApp>>,
  mcp: Awaited<ReturnType<typeof mockMcp>>,
  model: ReturnType<typeof createServer>,
  modelMode: string,
  modelRequests: any[],
  worker: Awaited<ReturnType<typeof startWorker>> | undefined;
const request = (method: any, path: string, body?: any, revision?: number) =>
  app.inject({
    method,
    url: '/v1/' + path,
    headers: {
      authorization: `Bearer ${token}`,
      ...(revision ? { 'if-match': String(revision) } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
async function create(path: string, body: any) {
  const r = await request('POST', path, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function globals(input: any = {}) {
  const { g } = await policies(db, owner, world.id);
  return savePolicy(db, owner, null, g.revision, { ...g, ...input });
}
async function policy(input: any = {}) {
  const { p } = await policies(db, owner, world.id);
  return savePolicy(db, owner, world.id, p.revision, { ...p, ...input });
}
async function enableBackground(input: any = {}) {
  await globals({ enabled: true });
  await policy({
    enabled: true,
    memory: true,
    contact: true,
    room_id: room.id,
    quiet_start: '00:00',
    quiet_end: '00:00',
    ...input,
  });
  await db.query("UPDATE worlds SET last_user_at=now()-interval '1 hour'");
}
async function setupTool(
  effect = 'write',
  mode = 'each',
  transport = 'streamable_http',
) {
  connection = await saveConnection(db, config, owner, {
    name: '合成 MCP',
    url: mcp.url + (transport === 'sse' ? '/sse' : '/mcp'),
    transport,
    enabled: true,
    auth_type: 'bearer',
    header_name: 'X-API-Key',
    credential: 'synthetic-secret',
    private_addresses: ['127.0.0.1'],
  });
  connection = await refreshTools(db, config, owner, connection.id);
  // Group tools now require an explicit group selection in addition to existing grants.
  await db.query(
    'INSERT INTO group_policies(owner_id,room_id,mcp_ids) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET mcp_ids=$3',
    [owner, room.id, [connection.id]],
  );
  await db.query(
    'INSERT INTO group_member_policies(room_id,actor_id,tools_enabled) VALUES($1,$2,true) ON CONFLICT(room_id,actor_id) DO UPDATE SET tools_enabled=true',
    [room.id, actors[0].id],
  );
  grant = await saveGrant(db, owner, {
    world_id: world.id,
    actor_id: actors[0].id,
    connection_id: connection.id,
    tool_name: 'reminder',
    schema_hash: connection.tools[0].schema_hash,
    effect,
    approval_mode: mode,
    argument_scope: { calendar: 'synthetic' },
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    enabled: true,
  });
  await globals({ tools_read: true, tools_write: true });
  await policy({ tools_read: true, tools_write: true });
}
async function send() {
  return enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: '请查询或创建合成提醒',
    addressed_actor_ids: [actors[0].id],
  });
}
async function step(id: string) {
  await db.query('UPDATE runs SET next_attempt_at=now() WHERE id=$1', [id]);
  await execute(db, config, id);
  return getRun(db, owner, id);
}
async function pending() {
  const ack = await send();
  expect((await step(ack.run_id)).state).toBe('awaiting_approval');
  return {
    ...ack,
    call: (
      await db.query('SELECT * FROM tool_calls WHERE run_id=$1', [ack.run_id])
    ).rows[0],
  };
}
beforeAll(() => migrate(db));
beforeEach(async () => {
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  token = (
    await pair(
      db,
      (await createPairingCode(db, owner)).code,
      'P4 synthetic',
      randomUUID(),
    )
  ).access_token;
  mcp = await mockMcp();
  modelMode = 'tool';
  modelRequests = [];
  model = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const b = JSON.parse(raw);
    modelRequests.push(b);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (modelMode === 'hold') return;
    const calls = b.messages.filter((m: any) => m.role === 'tool').length;
    if (
      (modelMode === 'tool' && b.tools?.length && calls === 0) ||
      (modelMode === 'loop' && b.tools?.length)
    ) {
      const name = b.tools[0].function.name;
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + calls, type: 'function', function: { name, arguments: JSON.stringify({ calendar: 'synthetic', text: '合成提醒' }) } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      const content = modelMode === 'skip' ? '<skip>' : '星港已记录本次行动。';
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  provider = await createProvider(db, config, owner, {
    name: '合成模型',
    base_url: `http://127.0.0.1:${(model.address() as any).port}/v1`,
    api_key: 'synthetic-model-key',
    model: 'mock',
    context_window: 32768,
    max_output_tokens: 1024,
    tools_enabled: true,
  });
  app = await buildApp(db, config);
  await app.ready();
  world = await create('worlds', {
    name: '星港',
    description: '',
    persona: { name: '船长', description: '' },
  });
  const template = await create('characters', {
    name: '林舟',
    description: '领航员',
    personality: '谨慎',
    voice: '简短',
    scenario: '',
    example: '',
    greeting: '',
  });
  actors = [];
  for (const name of ['林舟', '夏棠'])
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
    provider_id: provider.id,
    kind: 'group',
    actor_ids: actors.map((a) => a.id),
    max_replies: 3,
  });
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await app.close();
  await mcp.close();
  model.closeAllConnections();
  await new Promise<void>((r) => model.close(() => r()));
});
afterAll(() => db.end());
it('keeps default switches off and never offers ungranted tools or credentials', async () => {
  await scheduleAutonomy(db);
  expect((await db.query('SELECT * FROM runs')).rowCount).toBe(0);
  const ack = await send();
  await step(ack.run_id);
  expect(modelRequests[0].tools).toBeUndefined();
  expect(JSON.stringify(modelRequests)).not.toContain('synthetic-model-key');
  await expect(
    transaction(db, (tx) =>
      reserveBackground(tx, config, owner, world.id, 'memory_extract', 10, 10),
    ),
  ).rejects.toMatchObject({ code: 'autonomy_disabled' });
});
it.each(['streamable_http', 'sse'])(
  'uses official SDK %s discovery and a granted read tool, with paired untrusted context',
  async (transport) => {
    await setupTool('read', 'scoped', transport);
    const ack = await send();
    expect((await step(ack.run_id)).state).toBe('queued');
    expect(mcp.calls).toBe(0);
    await step(ack.run_id);
    expect(mcp.calls).toBe(1);
    expect((await step(ack.run_id)).state).toBe('completed');
    expect(modelRequests[1].messages.at(-1).role).toBe('tool');
    expect(modelRequests[1].messages.at(-1).content).toContain(
      'untrusted_tool_result',
    );
    expect(JSON.stringify(modelRequests)).not.toContain('synthetic-secret');
    expect((await snapshot(db, owner)).mcp_connections[0]).not.toHaveProperty(
      'credential',
    );
    expect(
      mcp.headers.some((h) => h.authorization === 'Bearer synthetic-secret'),
    ).toBe(true);
    await expect(
      regenerate(db, owner, ack.run_id, randomUUID()),
    ).rejects.toMatchObject({ code: 'regeneration_unsafe' });
  },
);
it('binds write approval, releases the world while waiting, and executes only after approval', async () => {
  await setupTool();
  const p = await pending();
  expect(mcp.calls).toBe(0);
  expect(
    (
      await db.query('SELECT holder FROM world_leases WHERE world_id=$1', [
        world.id,
      ])
    ).rows[0].holder,
  ).toBeNull();
  await decide(db, owner, p.call.id, 'approve');
  await step(p.run_id);
  await step(p.run_id);
  expect(mcp.calls).toBe(1);
  expect((await getRun(db, owner, p.run_id)).has_external_effects).toBe(true);
  expect((await getRun(db, owner, p.run_id)).state).toBe('completed');
  await step(p.run_id);
  expect(mcp.calls).toBe(1);
});
it.each(['scope', 'schema', 'revoke', 'world', 'global', 'expired'])(
  'rejects an approval after %s changes',
  async (change) => {
    await setupTool();
    const p = await pending();
    if (change === 'scope')
      await db.query("UPDATE tool_calls SET arguments='{}' WHERE id=$1", [
        p.call.id,
      ]);
    if (change === 'schema') {
      mcp.changeSchema();
      await refreshTools(db, config, owner, connection.id);
    }
    if (change === 'revoke') await revokeGrant(db, owner, grant.id);
    if (change === 'world')
      await db.query('UPDATE worlds SET revision=revision+1 WHERE id=$1', [
        world.id,
      ]);
    if (change === 'global') await globals({ tools_write: false });
    if (change === 'expired')
      await db.query(
        "UPDATE tool_calls SET expires_at=now()-interval '1 second' WHERE id=$1",
        [p.call.id],
      );
    await expect(
      decide(db, owner, p.call.id, 'approve'),
    ).rejects.toBeInstanceOf(Error);
    expect(mcp.calls).toBe(0);
  },
);
it('denial and approval expiry cancel without issuing an external write', async () => {
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'deny');
  await step(p.run_id);
  const q = await pending();
  await db.query(
    "UPDATE tool_calls SET expires_at=now()-interval '1 second' WHERE id=$1",
    [q.call.id],
  );
  await expireApprovals(db);
  expect((await getRun(db, owner, q.run_id)).state).toBe('cancelled');
  expect(mcp.calls).toBe(0);
});
it('reports unknown after a performed write loses its reply and never reissues it', async () => {
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  mcp.setMode('lost');
  expect((await step(p.run_id)).state).toBe('awaiting_approval');
  expect(mcp.calls).toBe(1);
  await recover(db);
  await step(p.run_id);
  expect(mcp.calls).toBe(1);
  expect(
    (await db.query('SELECT state FROM tool_calls WHERE id=$1', [p.call.id]))
      .rows[0].state,
  ).toBe('outcome_unknown');
  await decide(db, owner, p.call.id, 'confirmed_success');
  mcp.setMode('success');
  await step(p.run_id);
  expect(mcp.calls).toBe(1);
  expect(modelRequests.at(-1).messages.at(-1).content).toContain(
    'human_reported_outcome',
  );
});
it('Q36 preserves an unknown action receipt through source deletion and scrubs its payload after reconciliation without replay', async () => {
  const { deleteMessage } =
    await import('../../packages/server/src/modules/memory/repository.js');
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  mcp.setMode('lost');
  await step(p.run_id);
  const before = (
    await db.query('SELECT * FROM tool_calls WHERE id=$1', [p.call.id])
  ).rows[0];
  expect(before.state).toBe('outcome_unknown');
  await cancel(db, owner, p.run_id);
  await deleteMessage(db, owner, p.message_id);
  const retained = (
    await db.query('SELECT * FROM tool_calls WHERE id=$1', [p.call.id])
  ).rows[0];
  expect(retained.arguments).toEqual(before.arguments);
  expect(retained.arguments_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(retained.arguments_hash).toBe(before.arguments_hash);
  expect(retained.state).toBe('outcome_unknown');
  const { beginSnapshot } =
    await import('../../packages/server/src/modules/sync/index.js');
  const snapshot = await beginSnapshot(db, owner);
  await decide(db, owner, p.call.id, 'confirmed_success');
  expect(
    (
      await db.query('SELECT arguments FROM tool_calls WHERE id=$1', [
        p.call.id,
      ])
    ).rows[0].arguments,
  ).toEqual({});
  expect(
    (
      await db.query('SELECT id FROM sync_snapshots WHERE id=$1', [
        snapshot.snapshot_id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await db.query(
        "SELECT 1 FROM sync_events WHERE owner_id=$1 AND kind='tool_call' AND data->'arguments'=$2::jsonb",
        [owner, JSON.stringify(before.arguments)],
      )
    ).rowCount,
  ).toBe(0);
  await step(p.run_id);
  expect(mcp.calls).toBe(1);
  expect((await getRun(db, owner, p.run_id)).state).toBe('cancelled');
});
it('checks live schema again after approval and enforces scopes before dispatch', async () => {
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  mcp.changeSchema();
  await step(p.run_id);
  expect(mcp.calls).toBe(0);
  expect(
    (
      await db.query('SELECT error_code FROM tool_calls WHERE id=$1', [
        p.call.id,
      ])
    ).rows[0].error_code,
  ).toBe('tool_schema_changed');
  await cancel(db, owner, p.run_id);
  const q = await send();
  const c = await claim(db, q.run_id, 10000, 100);
  expect(c).not.toBeNull();
  await expect(
    proposeTool(
      db,
      c!,
      {
        id: 'other',
        name: 'mcp_' + grant.id.replaceAll('-', ''),
        arguments: '{"calendar":"other","text":"bad"}',
      },
      null,
    ),
  ).rejects.toMatchObject({ code: 'tool_scope_denied' });
});
it('limits output and bounds repeated tool calls at four', async () => {
  await setupTool('write', 'scoped');
  mcp.setMode('large');
  modelMode = 'loop';
  const ack = await send();
  for (let i = 0; i < 10; i++) await step(ack.run_id);
  expect(mcp.calls).toBe(4);
  expect((await getRun(db, owner, ack.run_id)).error_code).toBe(
    'tool_loop_limit',
  );
  const rows = (await db.query('SELECT result,truncated FROM tool_calls')).rows;
  expect(
    rows.every((r) => r.truncated && Buffer.byteLength(r.result) < 4050),
  ).toBe(true);
});
it('recovers a crash at dispatch as unknown and refuses a stale worker publication', async () => {
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  const c = await claim(db, p.run_id, 1000, 100);
  await db.query(
    "UPDATE tool_calls SET state='executing',dispatched_at=now() WHERE id=$1",
    [p.call.id],
  );
  await db.query(
    "UPDATE world_leases SET expires_at=now()-interval '1 second'",
  );
  await recover(db);
  expect((await getRun(db, owner, p.run_id)).state).toBe('awaiting_approval');
  expect(await finish(db, c!, '迟到', 'completed', null, null)).toBeNull();
  await step(p.run_id);
  expect(mcp.calls).toBe(0);
});
it('blocks unlisted loopback, link-local, cross-origin SSE and redirects, and safely fails 401/429', async () => {
  await expect(
    saveConnection(db, config, owner, {
      name: 'x',
      url: mcp.url + '/mcp',
      transport: 'streamable_http',
      enabled: true,
      auth_type: 'none',
      header_name: 'X-Key',
      private_addresses: [],
    }),
  ).rejects.toMatchObject({ code: 'blocked_destination' });
  await expect(
    saveConnection(db, config, owner, {
      name: 'x',
      url: 'http://169.254.169.254/meta',
      transport: 'streamable_http',
      enabled: true,
      auth_type: 'none',
      header_name: 'X-Key',
      private_addresses: ['169.254.169.254'],
    }),
  ).rejects.toMatchObject({ code: 'blocked_destination' });
  await setupTool('read');
  for (const mode of ['401', '429', 'redirect']) {
    mcp.setMode(mode);
    await expect(
      refreshTools(db, config, owner, connection.id),
    ).rejects.toMatchObject({ code: 'mcp_connect_failed' });
  }
  mcp.setMode('success');
  await setupTool('read', 'scoped', 'sse');
  mcp.setMode('origin');
  await expect(
    refreshTools(db, config, owner, connection.id),
  ).rejects.toMatchObject({ code: 'mcp_connect_failed' });
  expect(mcp.calls).toBe(0);
});
it('never exposes a grant in another actor or world context', async () => {
  await setupTool('read');
  const r = { owner_id: owner, world_id: world.id };
  expect(await availableTools(db, r, actors[1].id)).toEqual([]);
  expect(
    await availableTools(db, { ...r, world_id: randomUUID() }, actors[0].id),
  ).toEqual([]);
  expect(
    await availableTools(db, { ...r, owner_id: randomUUID() }, actors[0].id),
  ).toEqual([]);
});
it('runs with all clients closed, survives worker restart, and recaps link to actual messages', async () => {
  modelMode = 'text';
  await enableBackground({ contact: false, interaction: true, max_turns: 2 });
  await scheduleAutonomy(db);
  const run = (await db.query('SELECT * FROM runs')).rows[0];
  expect(run.trigger_kind).toBe('interaction');
  worker = await startWorker(db, { ...config, modelTimeoutMs: 10000 });
  const until = Date.now() + 12000;
  while (
    Date.now() < until &&
    (await getRun(db, owner, run.id)).state !== 'completed'
  )
    await new Promise((r) => setTimeout(r, 100));
  await worker.stop();
  worker = undefined;
  expect((await getRun(db, owner, run.id)).state).toBe('completed');
  const first = await recaps(db, owner, world.id);
  expect(first.items).toHaveLength(2);
  worker = await startWorker(db, { ...config, modelTimeoutMs: 10000 });
  expect((await recaps(db, owner, world.id)).items.map((i) => i.id)).toEqual(
    first.items.map((i) => i.id),
  );
  expect(
    (await snapshot(db, owner)).messages.every((m: any) => m.role !== 'user'),
  ).toBe(true);
  expect(modelRequests).toHaveLength(2);
}, 20000);
it('filters quiet hours and user activity, handles missed windows once and honors daily limits', async () => {
  await enableBackground();
  const now = new Date('2026-10-11T16:00:00Z');
  await db.query("UPDATE worlds SET last_user_at='2026-10-01'");
  await db.query(
    "UPDATE autonomy_policies SET next_contact_at='2026-10-01',quiet_start='22:30',quiet_end='08:00'",
  );
  await scheduleAutonomy(db, now);
  expect((await db.query('SELECT * FROM runs')).rowCount).toBe(0);
  await policy({ quiet_start: '00:00', quiet_end: '00:00', contact_daily: 1 });
  const day = new Date('2026-10-12T04:00:00Z');
  await scheduleAutonomy(db, day);
  expect((await db.query('SELECT * FROM runs')).rowCount).toBe(1);
  const run = (await db.query('SELECT id FROM runs')).rows[0];
  await cancel(db, owner, run.id);
  await scheduleAutonomy(db, new Date('2026-10-12T08:00:00Z'));
  expect((await db.query('SELECT * FROM runs')).rowCount).toBe(1);
  expect(
    (await db.query('SELECT day::text FROM autonomy_daily')).rows[0].day,
  ).toBe(dayAt(day, 'Asia/Shanghai'));
});
it('suppresses skip and late results after disabling then re-enabling autonomy', async () => {
  await enableBackground();
  await scheduleAutonomy(db);
  const run = (await db.query('SELECT id FROM runs')).rows[0];
  const c = await claim(db, run.id, 10000, 100, 120000, undefined, config);
  expect(c).not.toBeNull();
  await globals({ enabled: false });
  await globals({ enabled: true });
  await finish(db, c!, '迟到剧情', 'completed', null, {
    input: 10,
    output: 10,
  });
  expect((await recaps(db, owner, world.id)).items).toEqual([]);
  expect(
    (await db.query("SELECT content FROM messages WHERE role='assistant'"))
      .rows[0].content,
  ).toBe('');
  await db.query(
    "UPDATE autonomy_policies SET next_contact_at=now()-interval '1 second'",
  );
  await scheduleAutonomy(db);
  const next = (await db.query("SELECT id FROM runs WHERE state='queued'"))
    .rows[0];
  modelMode = 'skip';
  await step(next.id);
  expect((await recaps(db, owner, world.id)).items).toEqual([]);
  expect((await getRun(db, owner, next.id)).error_code).toBe('autonomy_skip');
});
it('checks queued policy revocations before any model request and gives a new user priority at a turn boundary', async () => {
  await enableBackground({ contact: false, interaction: true });
  await scheduleAutonomy(db);
  const run = (await db.query('SELECT id FROM runs')).rows[0];
  const c = await claim(db, run.id, 10000, 100, 120000, undefined, config);
  const front = await send();
  await finish(db, c!, '一条已完成发言', 'completed', null, null);
  expect((await getRun(db, owner, run.id)).state).toBe('completed');
  expect((await claim(db, front.run_id, 10000, 100))?.run.id).toBe(
    front.run_id,
  );
  await cancel(db, owner, front.run_id);
  await db.query("UPDATE worlds SET last_user_at=now()-interval '1 hour'");
  await db.query(
    "UPDATE autonomy_policies SET next_interaction_at=now()-interval '1 second'",
  );
  await scheduleAutonomy(db);
  const next = (await db.query("SELECT id FROM runs WHERE state='queued'"))
    .rows[0];
  await policy({ enabled: false });
  await step(next.id);
  expect(modelRequests).toHaveLength(0);
  expect((await getRun(db, owner, next.id)).error_code).toBe(
    'autonomy_disabled',
  );
});
it('serializes global/world/category budget reservations, retains unknown cost, and rejects exhausted work before model calls', async () => {
  await enableBackground();
  await globals({ request_limit: 1 });
  const values = await Promise.allSettled(
    [1, 2].map(() =>
      transaction(db, (tx) =>
        reserveBackground(
          tx,
          config,
          owner,
          world.id,
          'memory_extract',
          20,
          20,
        ),
      ),
    ),
  );
  expect(values.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  await scheduleAutonomy(db);
  const run = (await db.query('SELECT id FROM runs')).rows[0];
  await step(run.id);
  expect(modelRequests).toHaveLength(0);
  expect((await getRun(db, owner, run.id)).error_code).toBe(
    'background_budget_exceeded',
  );
  expect(
    (await db.query('SELECT requests FROM background_daily')).rows[0].requests,
  ).toBe(1);
});
it('cancels a dispatched action as unknown, and allows reconciliation without resuming the cancelled run', async () => {
  await setupTool();
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  await db.query(
    "UPDATE tool_calls SET state='executing',dispatched_at=now() WHERE id=$1",
    [p.call.id],
  );
  await cancel(db, owner, p.run_id);
  expect(
    (await db.query('SELECT state FROM tool_calls WHERE id=$1', [p.call.id]))
      .rows[0].state,
  ).toBe('outcome_unknown');
  await decide(db, owner, p.call.id, 'confirmed_success');
  expect((await getRun(db, owner, p.run_id)).state).toBe('cancelled');
  await step(p.run_id);
  expect(mcp.calls).toBe(0);
});
it('keeps a simulated 24-hour absence bounded, and never catches up missed intervals in a burst', async () => {
  await enableBackground({ contact: true, interaction: true, max_turns: 3 });
  const base = new Date();
  await db.query("UPDATE worlds SET last_user_at=now()-interval '1 day'");
  for (let hour = 0; hour < 24; hour++) {
    const now = new Date(base.getTime() + hour * 3600000);
    await scheduleAutonomy(db, now);
    const runs = (await db.query("SELECT id FROM runs WHERE state='queued'"))
      .rows;
    for (const run of runs) {
      for (let step = 0; step < 3; step++) {
        const c = await claim(
          db,
          run.id,
          10000,
          100,
          120000,
          undefined,
          config,
        );
        if (!c) break;
        await finish(db, c, '有来源的合成互动', 'completed', null, {
          input: 5,
          output: 5,
        });
      }
    }
  }
  const days = (await db.query('SELECT kind,count FROM autonomy_daily')).rows;
  expect(days.every((d) => d.count <= (d.kind === 'contact' ? 3 : 4))).toBe(
    true,
  );
  expect(
    Number((await db.query('SELECT count(*) FROM runs')).rows[0].count),
  ).toBeLessThanOrEqual(14);
  const before = (await db.query('SELECT count(*) FROM runs')).rows[0].count;
  await scheduleAutonomy(db, new Date(base.getTime() + 7 * 86400000));
  expect(
    Number((await db.query('SELECT count(*) FROM runs')).rows[0].count) -
      Number(before),
  ).toBeLessThanOrEqual(1);
});
it('upgrades a populated P3 schema with all new authority switches off and keeps migration idempotent', async () => {
  const { readFile } = await import('node:fs/promises');
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('CREATE SCHEMA p4_upgrade_fixture');
    await tx.query('SET LOCAL search_path=p4_upgrade_fixture,public');
    for (const file of [
      '001_foundation.sql',
      '002_worlds_and_cast.sql',
      '003_memory_and_imports.sql',
    ])
      await tx.query(await readFile('migrations/' + file, 'utf8'));
    const ownerId = randomUUID(),
      worldId = randomUUID();
    await tx.query('INSERT INTO owners(id) VALUES($1)', [ownerId]);
    await tx.query(
      "INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,'P3 合成世界')",
      [worldId, ownerId],
    );
    await tx.query(
      'INSERT INTO memory_settings(world_id,owner_id,enabled) VALUES($1,$2,true)',
      [worldId, ownerId],
    );
    await tx.query(
      await readFile('migrations/004_autonomy_and_tools.sql', 'utf8'),
    );
    expect(
      (
        await tx.query(
          'SELECT enabled,tools_read,tools_write FROM autonomy_settings',
        )
      ).rows,
    ).toEqual([{ enabled: false, tools_read: false, tools_write: false }]);
    expect(
      (
        await tx.query(
          'SELECT enabled,memory,contact,interaction FROM autonomy_policies',
        )
      ).rows,
    ).toEqual([
      { enabled: false, memory: false, contact: false, interaction: false },
    ]);
    expect(
      (await tx.query('SELECT enabled FROM memory_settings')).rows[0].enabled,
    ).toBe(true);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  await migrate(db);
});
it('redacts a credential echoed by the remote tool before storage, sync or model context', async () => {
  await setupTool('read', 'scoped');
  mcp.setMode('echo');
  const ack = await send();
  await step(ack.run_id);
  await step(ack.run_id);
  await step(ack.run_id);
  expect(JSON.stringify(modelRequests)).not.toContain('synthetic-secret');
  const result = (await db.query('SELECT result FROM tool_calls')).rows[0]
    .result;
  expect(result).toContain('[REDACTED]');
  expect(JSON.stringify((await snapshot(db, owner)).tool_calls)).not.toContain(
    'synthetic-secret',
  );
});
it('forgets derived tool arguments and results and prevents an old pending action from restoring sources', async () => {
  const { invalidateSources } =
    await import('../../packages/server/src/modules/memory/repository.js');
  await setupTool();
  const p = await pending();
  await transaction(db, (tx) =>
    invalidateSources(tx, owner, world.id, [p.message_id]),
  );
  const row = (
    await db.query('SELECT * FROM tool_calls WHERE id=$1', [p.call.id])
  ).rows[0];
  expect(row.arguments).toEqual({});
  expect(row.result).toBeNull();
  await expect(decide(db, owner, p.call.id, 'approve')).rejects.toMatchObject({
    code: 'approval_inactive',
  });
  await db.query("UPDATE runs SET state='queued' WHERE id=$1", [p.run_id]);
  await step(p.run_id);
  expect((await getRun(db, owner, p.run_id)).error_code).toBe(
    'source_invalidated',
  );
  expect(mcp.calls).toBe(0);
});
it('lets at most one world reserve the last shared background request', async () => {
  await enableBackground();
  await globals({ request_limit: 1 });
  const other = await create('worlds', {
    name: '山城',
    description: '',
    persona: { name: '旅人', description: '' },
  });
  await savePolicy(db, owner, other.id, 1, {
    ...policyDefaults,
    enabled: true,
    memory: true,
  });
  const attempts = await Promise.allSettled(
    [world.id, other.id].map((w) =>
      transaction(db, (tx) =>
        reserveBackground(tx, config, owner, w, 'memory_extract', 10, 10),
      ),
    ),
  );
  expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await db.query('SELECT requests FROM background_daily')).rows[0].requests,
  ).toBe(1);
});
it('T13 revoking a member group tool permission blocks an approved external write before dispatch', async () => {
  await setupTool('write', 'each');
  const p = await pending();
  await decide(db, owner, p.call.id, 'approve');
  await db.query(
    'UPDATE group_member_policies SET tools_enabled=false,revision=revision+1 WHERE room_id=$1 AND actor_id=$2',
    [room.id, actors[0].id],
  );
  await step(p.run_id);
  expect(mcp.calls).toBe(0);
  expect(
    (await db.query('SELECT state FROM tool_calls WHERE id=$1', [p.call.id]))
      .rows[0].state,
  ).not.toBe('succeeded');
});
