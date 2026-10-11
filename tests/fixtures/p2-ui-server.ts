import {
  savePolicy,
  policies,
  globalDefaults,
  policyDefaults,
} from '../../packages/server/src/modules/autonomy/policy.js';
import {
  scheduleAutonomy,
  recaps,
} from '../../packages/server/src/modules/autonomy/scheduler.js';
import {
  saveConnection,
  refreshTools,
  saveGrant,
} from '../../packages/server/src/modules/mcp/connections.js';
import { claim } from '../../packages/server/src/modules/runs/repository.js';
import { proposeTool } from '../../packages/server/src/modules/mcp/gateway.js';
import { mockMcp } from './mock-mcp.js';
import { randomUUID } from 'node:crypto';
import {
  enqueue,
  getRun,
} from '../../packages/server/src/modules/runs/repository.js';
import { execute } from '../../packages/server/src/modules/runs/engine.js';
import {
  listMemories,
  saveSettings,
} from '../../packages/server/src/modules/memory/repository.js';
import { executeMemory } from '../../packages/server/src/modules/memory/worker.js';
// Isolated synthetic UI fixture. Never included in the runtime image.
import { writeFile } from 'node:fs/promises';
import { pool } from '../../packages/server/src/db/index.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import { editEntity } from '../../packages/server/src/modules/worlds/index.js';
import { buildApp } from '../../packages/server/src/app.js';
import { startWorker } from '../../packages/server/src/queue.js';
import { mockModel } from './mock-model.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/echo2_test')
  throw new Error('Dedicated test database required');
const config = loadConfig({
    DATABASE_URL: url,
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    ALLOW_INSECURE_LOCAL: 'true',
    LEASE_MS: '1500',
    // Allow all three persisted queue steps; deadline failure is covered by the
    // backend integration suite rather than by this UI connectivity fixture.
    MODEL_TIMEOUT_MS: '30000',
  }),
  db = pool(url);
await migrate(db);
await db.query('TRUNCATE owners CASCADE');
const owner = await initializeOwner(db, config),
  mock = await mockModel();
const provider = await createProvider(db, config, owner, {
  name: '本机合成模型',
  base_url: mock.url,
  api_key: 'synthetic-only',
  model: 'mock',
  context_window: 32768,
  max_output_tokens: 1024,
});
const world = await editEntity(db, owner, 'worlds', 'POST', {
  name: '星港联调',
  description: '仅含合成数据的双端测试世界',
  persona: { name: '船长', description: '虚构身份' },
});
const actors: any[] = [];
for (const name of ['阿岚', '北辰', '初夏']) {
  const template = await editEntity(db, owner, 'characters', 'POST', {
    name,
    description: '星港测试角色',
    personality: '谨慎',
    voice: '简短',
    scenario: '舰桥',
    example: '欢迎回来',
    greeting: '你好',
  });
  actors.push(
    await editEntity(db, owner, 'actors', 'POST', {
      world_id: world.id,
      template_id: template.id,
      template_revision: 1,
      name,
      participation: 50,
    }),
  );
}
const room = await editEntity(db, owner, 'rooms', 'POST', {
  world_id: world.id,
  name: '舰桥群聊',
  kind: 'group',
  provider_id: provider.id,
  actor_ids: actors.map((a) => a.id),
  max_replies: 3,
});
const app = await buildApp(db, config);
let offline = false;
app.addHook('onRequest', async (req, reply) => {
  if (offline && !req.url.startsWith('/__test'))
    return reply.code(503).send({
      error: { code: 'fixture_offline', message: 'Synthetic network outage' },
    });
});
app.get('/__test/code', async () => createPairingCode(db, owner));
app.post('/__test/offline', async () => {
  offline = true;
  return { ok: true };
});
app.post('/__test/online', async () => {
  offline = false;
  return { ok: true };
});
app.post('/__test/p3-seed', async () => {
  const { g, p } = await policies(db, owner, world.id);
  await savePolicy(db, owner, null, g.revision, { ...g, enabled: true });
  await savePolicy(db, owner, world.id, p.revision, {
    ...p,
    enabled: true,
    memory: true,
  });
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: `蓝色风铃是暗号（合成批次 ${randomUUID().slice(0, 8)}）`,
    addressed_actor_ids: [actors[0].id],
  });
  for (let i = 0; i < 50; i++) {
    await execute(db, config, ack.run_id);
    if ((await getRun(db, owner, ack.run_id)).state === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = (
    await db.query('SELECT revision FROM memory_settings WHERE world_id=$1', [
      world.id,
    ])
  ).rows[0];
  await saveSettings(db, owner, world.id, s.revision, {
    enabled: true,
    embedding_provider_id: null,
    embedding_dimensions: 0,
  });
  await db.query(
    "UPDATE memory_sources SET committed_at=now()-interval '61 seconds'",
  );
  await executeMemory(db, config, room.id);
  return { ok: true, memories: await listMemories(db, owner, world.id) };
});
const mcp = await mockMcp();
app.post('/__test/p4-seed', async () => {
  const { g, p } = await policies(db, owner, world.id);
  await savePolicy(db, owner, null, g.revision, {
    ...globalDefaults,
    enabled: true,
    tools_read: true,
    tools_write: true,
    request_limit: 100,
    output_limit: 100000,
  });
  await savePolicy(db, owner, world.id, p.revision, {
    ...policyDefaults,
    enabled: false,
    contact: true,
    room_id: room.id,
    tools_read: true,
    tools_write: true,
    quiet_start: '00:00',
    quiet_end: '00:00',
  });
  let connection = await saveConnection(db, config, owner, {
    name: '合成提醒',
    url: mcp.url + '/mcp',
    transport: 'streamable_http',
    enabled: true,
    auth_type: 'none',
    header_name: 'X-API-Key',
    private_addresses: ['127.0.0.1'],
  });
  connection = await refreshTools(db, config, owner, connection.id);
  const grant = await saveGrant(db, owner, {
    world_id: world.id,
    actor_id: actors[0].id,
    connection_id: connection.id,
    tool_name: 'reminder',
    schema_hash: connection.tools[0].schema_hash,
    effect: 'write',
    approval_mode: 'each',
    argument_scope: { calendar: 'synthetic' },
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    enabled: true,
  });
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: '请创建一个合成提醒',
    addressed_actor_ids: [actors[0].id],
  });
  const c = await claim(db, ack.run_id, 10000, 100);
  if (c)
    await proposeTool(
      db,
      c,
      {
        id: 'ui-call',
        name: 'mcp_' + grant.id.replaceAll('-', ''),
        arguments: JSON.stringify({
          calendar: 'synthetic',
          text: '模拟器审批测试',
        }),
      },
      { input: 10, output: 10 },
    );
  return { ok: true };
});
app.post('/__test/p4-background', async () => {
  await db.query(
    "UPDATE worlds SET last_user_at=now()-interval '1 hour' WHERE id=$1",
    [world.id],
  );
  await db.query(
    'UPDATE autonomy_policies SET next_contact_at=now() WHERE world_id=$1',
    [world.id],
  );
  await scheduleAutonomy(db);
  return { ok: true };
});
app.post('/__test/p5-event', async () => {
  const device = (
    await db.query(
      'SELECT id FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    )
  ).rows[0];
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: 'P5 云端通知合成来源',
    addressed_actor_ids: [actors[0].id],
  });
  await execute(db, config, ack.run_id);
  let message: any;
  for (let attempt = 0; attempt < 40; attempt++) {
    message = (
      await db.query(
        "SELECT id FROM messages WHERE run_id=$1 AND role='assistant' AND status='completed' ORDER BY sequence LIMIT 1",
        [ack.run_id],
      )
    ).rows[0];
    if (message) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!message || !device)
    throw new Error('Synthetic notification source unavailable');
  const event = (
    await db.query(
      'INSERT INTO notification_events(owner_id,message_id) VALUES($1,$2) ON CONFLICT(message_id) DO UPDATE SET message_id=$2 RETURNING id',
      [owner, message.id],
    )
  ).rows[0];
  await db.query(
    "INSERT INTO notification_deliveries(event_id,device_id,binding_revision,state) VALUES($1,$2,1,'accepted') ON CONFLICT DO NOTHING",
    [event.id, device.id],
  );
  const meta = (
    await db.query(
      'SELECT server_instance_id,data_epoch FROM instance_metadata',
    )
  ).rows[0];
  return { event_id: event.id, ...meta, message_id: message.id };
});
app.get('/__test/state', async () => ({
  tool_calls: (
    await db.query('SELECT state FROM tool_calls ORDER BY created_at DESC')
  ).rows,
  mcp_calls: mcp.calls,
  policy: (await policies(db, owner, world.id)).p,
  recaps: await recaps(db, owner, world.id),
  memories: await listMemories(db, owner, world.id),
  import_count: (
    await db.query(
      'SELECT count(*)::int AS n FROM import_jobs WHERE result IS NOT NULL',
    )
  ).rows[0].n,
  imported_characters: (
    await db.query(
      `SELECT v.data->>'name' AS name,
              (v.data->'prompt_suggestions'->>'enabled')::boolean AS suggestions_enabled
       FROM import_jobs j JOIN character_versions v
         ON v.template_id=(j.result->>'character_id')::uuid AND v.revision=1
       WHERE j.result IS NOT NULL`,
    )
  ).rows,
  messages: (
    await db.query(
      'SELECT id,content,role,status,actor_id FROM messages ORDER BY created_at',
    )
  ).rows,
  devices: (await db.query('SELECT id,name FROM devices')).rows,
  model_calls: mock.calls,
}));
const worker = await startWorker(db, config);
await app.listen({ port: 3000, host: '0.0.0.0' });
await writeFile(
  '/tmp/p2-ui-ready.json',
  JSON.stringify({ room_id: room.id, world_id: world.id }),
);
process.stdout.write('p2_ui_fixture_ready\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    await worker.stop();
    await mock.close();
    await mcp.close();
    await db.end();
  });
