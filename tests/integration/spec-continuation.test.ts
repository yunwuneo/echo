import { hash } from '../../packages/server/src/security.js';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, createHmac } from 'node:crypto';
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

import { platformCommand } from '../../packages/server/src/modules/platform/index.js';
import {
  scheduleCommand,
  tickSchedules,
  receiveEvent,
  revealTriggerSecret,
} from '../../packages/server/src/modules/schedules/index.js';
import {
  hostCommand,
  pairHost,
  hostRPC,
} from '../../packages/server/src/modules/hosts/index.js';
import { canonical } from '../../packages/server/src/modules/mcp/schema.js';
import { enqueue } from '../../packages/server/src/modules/runs/repository.js';
const input = (command: string, payload: any = {}, revision = 0) => ({
  command,
  payload,
  operation_id: randomUUID(),
  expected_revision: revision,
});
const hc = (name: string, p: any = {}, rev = 0) =>
  hostCommand(db, owner, input(name, p, rev));
const sc = (name: string, p: any = {}, rev = 0) =>
  scheduleCommand(db, config, owner, input(name, p, rev));
async function device() {
  return (
    await db.query(
      "INSERT INTO devices(id,owner_id,name) VALUES(gen_random_uuid(),$1,'fixture') RETURNING id",
      [owner],
    )
  ).rows[0].id;
}
async function allowScheduledContact() {
  await db.query(
    'INSERT INTO autonomy_settings(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO UPDATE SET enabled=true',
    [owner],
  );
  await db.query(
    'INSERT INTO autonomy_policies(owner_id,world_id,enabled,contact) VALUES($1,$2,true,true) ON CONFLICT(world_id) DO UPDATE SET enabled=true,contact=true',
    [owner, world.id],
  );
}
async function paired() {
  const pair = await hc('createHostPairing'),
    keys = generateKeyPairSync('ed25519');
  const body = {
    pairing_id: pair.pairing_id,
    code: pair.code,
    name: 'synthetic Host',
  };
  const host = await pairHost(db, {
    ...body,
    public_key: keys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString(),
    proof: sign(null, Buffer.from(canonical(body)), keys.privateKey).toString(
      'base64',
    ),
  });
  const rpc = (action: string, payload: any) => {
    const b = {
      protocolVersion: 1,
      host_id: host.host_id,
      timestamp: Date.now(),
      action,
      payload,
    };
    return hostRPC(
      db,
      'Bearer ' + host.token,
      b,
      sign(null, Buffer.from(canonical(b)), keys.privateKey).toString('base64'),
    );
  };
  await rpc('poll', { capabilities: ['chat', 'file_write'] });
  await hc(
    'setHostGrants',
    {
      id: host.host_id,
      grants: { actions: ['chat', 'file_write'], roots: ['docs'] },
    },
    1,
  );
  const link = await hc('linkHostIdentity', {
    host_id: host.host_id,
    actor_id: actors[0].id,
    remote_identity: 'independent',
    enabled: true,
  });
  return { host, rpc, link };
}
it('T14 revoked permission and wrong device cannot claim; duplicate share remains a draft', async () => {
  const d = await device(),
    other = await device();
  const pc = (n: string, p: any, rev = 0, dev = d) =>
    platformCommand(db, owner, input(n, p, rev), dev);
  await pc('reportCapability', {
    capability: 'calendar',
    state: 'authorized',
    detail: {},
  });
  const policy = await pc('setSystemPolicy', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    enabled: true,
  });
  const a = await pc('createSystemAction', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    arguments: { title: 'synthetic' },
  });
  await pc('decideSystemAction', { id: a.id, approve: true }, 1);
  await expect(
    pc('claimSystemAction', { id: a.id }, 2, other),
  ).rejects.toMatchObject({ code: 'device_scope' });
  await pc(
    'setSystemPolicy',
    {
      actor_id: actors[0].id,
      device_id: d,
      action: 'calendar.create',
      enabled: false,
    },
    policy.revision,
  );
  await expect(pc('claimSystemAction', { id: a.id }, 2)).rejects.toMatchObject({
    code: 'system_permission',
  });
  const share = input('receiveShareDraft', {
    actor_id: actors[0].id,
    room_id: room.id,
    content: 'shared text',
    asset_ids: [],
  });
  const one = await platformCommand(db, owner, share, d);
  expect((await platformCommand(db, owner, share, d)).id).toBe(one.id);
  expect((await db.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(
    0,
  );
});
it('T15 missed single occurrence requires explicit catch-up and recurring slots deduplicate', async () => {
  const s = await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'one',
    prompt: 'hello',
    rule: 'once',
    timezone: 'Asia/Shanghai',
    at: new Date(Date.now() - 120000).toISOString(),
    interval_seconds: 60,
    enabled: true,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
  await tickSchedules(db);
  await tickSchedules(db);
  const rows = (
    await db.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1', [
      s.id,
    ])
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe('missed');
  expect(rows[0].run_id).toBeNull();
  await expect(
    sc('runOccurrence', { id: s.id, slot: rows[0].slot, allow_missed: false }),
  ).rejects.toMatchObject({ code: 'occurrence_missing' });
});
it('T15 signed external assistant event is durable, distinct, deduplicated and revoked immediately', async () => {
  const t = await sc('registerTrigger', {
    actor_id: actors[0].id,
    room_id: room.id,
    name: 'fixture',
    mode: 'trusted_assistant',
    service: 'fixture',
    node_id: 'node-a',
    enabled: true,
  });
  const secret = await revealTriggerSecret(db, config, owner, t.id);
  await sc(
    'registrationReceipt',
    { id: t.id, state: 'active', external_id: 'registration-a' },
    1,
  );
  const body = {
    event_id: 'one',
    timestamp: Date.now(),
    service: 'fixture',
    node_id: 'node-a',
    content: 'external content',
  };
  const signature = createHmac('sha256', secret.secret)
    .update(canonical(body))
    .digest('hex');
  const first = await receiveEvent(db, config, t.id, body, signature);
  expect(
    (await receiveEvent(db, config, t.id, body, signature)).message_id,
  ).toBe(first.message_id);
  const messages = (await db.query('SELECT * FROM messages')).rows;
  expect(messages).toHaveLength(1);
  expect(messages[0].role).toBe('assistant');
  expect(messages[0].external_origin.node_id).toBe('node-a');
  expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(0);
  const events = (
    await db.query("SELECT data FROM sync_events WHERE kind='message'")
  ).rows;
  expect(events.every((x) => x.data.role === 'assistant')).toBe(true);
  await sc('revokeTrigger', { id: t.id }, 2);
  await expect(
    receiveEvent(db, config, t.id, body, signature),
  ).rejects.toMatchObject({ code: 'event_identity' });
});
it('T16 accepted job begins once, survives lost begin response and rejects permission changes', async () => {
  const { host, rpc, link } = await paired();
  const cmd = input('submitHostJob', {
    link_id: link.id,
    kind: 'file_write',
    scope: { root: 'docs' },
    payload: { path: 'a.txt', content_base64: 'eA==' },
    budget: { max_output_tokens: 100, tool_limit: 0 },
  });
  const j = await hostCommand(db, owner, cmd);
  expect((await hostCommand(db, owner, cmd)).id).toBe(j.id);
  const e = { job_id: j.id, execution_id: randomUUID() };
  await rpc('accept', e);
  expect((await rpc('begin', e)).started_now).toBe(true);
  expect((await rpc('begin', e)).started_now).toBe(false);
  await expect(
    rpc('begin', { ...e, execution_id: randomUUID() }),
  ).rejects.toMatchObject({ code: 'execution_identity' });
  const receipt = {
    ...e,
    receipt_id: randomUUID(),
    state: 'unknown',
    result: { reason: 'lost' },
    error_code: 'unknown',
  };
  await rpc('receipt', receipt);
  await rpc('receipt', receipt);
  await expect(
    rpc('receipt', { ...receipt, result: { changed: true } }),
  ).rejects.toMatchObject({ code: 'receipt_conflict' });
  await hc(
    'setHostGrants',
    { id: host.host_id, grants: { actions: [], roots: [] } },
    2,
  );
  await expect(hc('submitHostJob', cmd.payload)).rejects.toMatchObject({
    code: 'host_capability',
  });
});
it('T17 relay freezes local execution and only explicit unaccepted unsupported result permits fallback', async () => {
  const { rpc, link } = await paired();
  await hc('setReplyRelay', { link_id: link.id, enabled: true });
  const ack = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: 'hello',
  });
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE relay_run_id=$1', [
      ack.run_id,
    ])
  ).rows[0];
  expect(
    (await db.query('SELECT * FROM outbox WHERE run_id=$1', [ack.run_id]))
      .rowCount,
  ).toBe(0);
  const e = { job_id: j.id, execution_id: randomUUID() };
  await rpc('receipt', {
    ...e,
    receipt_id: randomUUID(),
    state: 'rejected',
    result: {},
    error_code: 'unsupported_route',
    not_accepted: true,
  });
  expect(
    (await db.query('SELECT state FROM runs WHERE id=$1', [ack.run_id])).rows[0]
      .state,
  ).toBe('queued');
  expect(
    (await db.query('SELECT * FROM outbox WHERE run_id=$1', [ack.run_id]))
      .rowCount,
  ).toBe(1);
  const second = await enqueue(db, owner, room.id, {
    client_command_id: randomUUID(),
    content: 'second',
  });
  const j2 = (
    await db.query('SELECT * FROM host_jobs WHERE relay_run_id=$1', [
      second.run_id,
    ])
  ).rows[0];
  const e2 = { job_id: j2.id, execution_id: randomUUID() };
  await rpc('accept', e2);
  await expect(
    rpc('receipt', {
      ...e2,
      receipt_id: randomUUID(),
      state: 'rejected',
      result: {},
      error_code: 'unsupported_route',
      not_accepted: true,
    }),
  ).rejects.toMatchObject({ code: 'fallback_unsafe' });
  await rpc('receipt', {
    ...e2,
    receipt_id: randomUUID(),
    state: 'unknown',
    result: {},
  });
  expect(
    (await db.query('SELECT * FROM outbox WHERE run_id=$1', [second.run_id]))
      .rowCount,
  ).toBe(0);
});
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRunner } from '../../packages/server/src/modules/hosts/runner.js';
import {
  storageCommand,
  tickRemoteBackups,
} from '../../packages/server/src/modules/storage/index.js';
import { diagnosticsCommand } from '../../packages/server/src/modules/storage/diagnostics.js';
import {
  createProject,
  saveDocument,
} from '../../packages/server/src/modules/documents/index.js';
const storage = (n: string, p: any = {}, rev = 0) =>
  storageCommand(db, config, owner, input(n, p, rev));
it('T16 Host restart reconciles lost receipt without writing the file again', async () => {
  const { host, rpc, link } = await paired(),
    dir = await mkdtemp(join(tmpdir(), 'echo-host-recovery-'));
  try {
    const make = () => {
      const runner = new HostRunner(config, {
        cloud_url: 'https://unused.invalid',
        host_id: host.host_id,
        token: 'unused',
        private_key: 'unused',
        journal: join(dir, 'journal'),
        roots: { docs: dir },
        identities: {},
      });
      runner.rpc = rpc;
      return runner;
    };
    const j = await hc('submitHostJob', {
      link_id: link.id,
      kind: 'file_write',
      scope: { root: 'docs' },
      payload: {
        path: 'created.txt',
        content_base64: Buffer.from('once').toString('base64'),
        base_hash: null,
      },
      budget: { max_output_tokens: 1, tool_limit: 0 },
    });
    const runner = make();
    let lost = true;
    runner.rpc = async (a, p) => {
      if (a === 'receipt' && lost) {
        lost = false;
        throw Error('lost receipt');
      }
      return rpc(a, p);
    };
    await runner.tick();
    const before = await stat(join(dir, 'created.txt'));
    expect(
      (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id]))
        .rows[0].state,
    ).toBe('executing');
    await make().tick();
    expect((await stat(join(dir, 'created.txt'))).mtimeMs).toBe(before.mtimeMs);
    expect(
      (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id]))
        .rows[0].state,
    ).toBe('completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('T16 lost begin response becomes unknown without replay or file mutation', async () => {
  const { host, rpc, link } = await paired(),
    dir = await mkdtemp(join(tmpdir(), 'echo-host-begin-'));
  try {
    const make = () => {
      const r = new HostRunner(config, {
        cloud_url: 'https://unused.invalid',
        host_id: host.host_id,
        token: 'unused',
        private_key: 'unused',
        journal: join(dir, 'journal'),
        roots: { docs: dir },
        identities: {},
      });
      r.rpc = rpc;
      return r;
    };
    const j = await hc('submitHostJob', {
      link_id: link.id,
      kind: 'file_write',
      scope: { root: 'docs' },
      payload: { path: 'must-not-exist', content_base64: 'eA==' },
      budget: { max_output_tokens: 1, tool_limit: 0 },
    });
    const r = make();
    r.rpc = async (a, p) => {
      const response = await rpc(a, p);
      if (a === 'begin') throw Error('response lost');
      return response;
    };
    await r.tick();
    await make().tick();
    await expect(stat(join(dir, 'must-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id]))
        .rows[0].state,
    ).toBe('unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('T18 remote encrypted backup uploads through durable Host and verifies full archive hash', async () => {
  const { host, rpc, link } = await paired(),
    dir = await mkdtemp(join(tmpdir(), 'echo-remote-backup-'));
  try {
    const r = new HostRunner(config, {
      cloud_url: 'https://unused.invalid',
      host_id: host.host_id,
      token: 'unused',
      private_key: 'unused',
      journal: join(dir, 'journal'),
      roots: { docs: dir },
      identities: {},
    });
    r.rpc = rpc;
    await r.tick();
    await hc(
      'setHostGrants',
      {
        id: host.host_id,
        grants: {
          actions: ['backup_list', 'backup_put', 'backup_delete'],
          roots: ['docs'],
        },
      },
      2,
    );
    const p = await storage('saveBackupPlan', {
      link_id: link.id,
      root: 'docs',
      cadence: 'daily',
      enabled: false,
      password: 'synthetic-password',
    });
    const b = await storage('runRemoteBackup', { id: p.id }, p.revision);
    for (let i = 0; i < 6; i++) {
      await tickRemoteBackups(db, config);
      await r.tick();
    }
    const row = (
      await db.query('SELECT * FROM remote_backups WHERE id=$1', [b.id])
    ).rows[0];
    expect(row.state).toBe('completed');
    expect(row.archive).toBeNull();
    const bytes = await readFile(
      join(dir, 'echo-restore-points', row.content_hash + '.json'),
    );
    expect(hash(bytes)).toBe(row.content_hash);
    expect(bytes.toString()).not.toContain('synthetic-password');
    const preview = await previewRestore(
      db,
      config,
      owner,
      JSON.parse(bytes.toString()),
      'synthetic-password',
    );
    expect(preview.paused_on_restore).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('T18 selected credential import is encrypted, bound to endpoint revision and never automatically probes', async () => {
  const provider = (await db.query('SELECT * FROM provider_connections'))
      .rows[0],
    selections = [{ kind: 'provider', id: provider.id }];
  const archive = await storage('exportSelectedCredentials', {
    selections,
    password: 'synthetic-password',
  });
  expect(JSON.stringify(archive)).not.toContain('synthetic-secret');
  const preview = await storage('previewSelectedCredentials', {
    archive,
    password: 'synthetic-password',
  });
  expect(JSON.stringify(preview)).not.toContain('secret');
  await db.query(
    'UPDATE provider_connections SET revision=revision+1 WHERE id=$1',
    [provider.id],
  );
  await expect(
    storage('importSelectedCredentials', {
      id: preview.id,
      preview_token: preview.preview_token,
      selections,
    }),
  ).rejects.toMatchObject({ code: 'credential_import_conflict' });
  const p2 = await storage('previewSelectedCredentials', {
    archive,
    password: 'synthetic-password',
  });
  expect(
    await storage('importSelectedCredentials', {
      id: p2.id,
      preview_token: p2.preview_token,
      selections,
    }),
  ).toMatchObject({ imported: 1, connections_tested: false });
});
it('T20 expanded restore preserves scheduling and Host graph but keeps execution revoked', async () => {
  const { host, link } = await paired();
  const d = await device();
  await platformCommand(
    db,
    owner,
    input('receiveShareDraft', {
      actor_id: actors[0].id,
      room_id: room.id,
      content: 'draft',
      asset_ids: [],
    }),
    d,
  );
  await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'schedule',
    prompt: 'hello',
    rule: 'interval',
    timezone: 'UTC',
    at: new Date().toISOString(),
    interval_seconds: 60,
    enabled: true,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
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
  await restoreBackup(db, config, owner, preview.id, preview.preview_token);
  expect(
    (await db.query('SELECT enabled FROM schedules')).rows[0].enabled,
  ).toBe(false);
  expect(
    (await db.query('SELECT token_hash,revoked_at FROM host_nodes')).rows[0],
  ).toMatchObject({ token_hash: '' });
  expect(
    (await db.query('SELECT revoked_at FROM devices')).rows[0].revoked_at,
  ).not.toBeNull();
  expect((await db.query('SELECT state FROM share_drafts')).rows[0].state).toBe(
    'draft',
  );
});
it('T17 handoff keeps unknown work on the old executor until reconciliation and signed revocation', async () => {
  await allowScheduledContact();
  const { rpc, host, link } = await paired();
  const s = await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'schedule',
    prompt: 'hello',
    rule: 'interval',
    timezone: 'UTC',
    at: new Date().toISOString(),
    interval_seconds: 60,
    enabled: false,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
  await hc(
    'beginHandoff',
    { schedule_id: s.id, executor: 'host', host_id: host.host_id },
    1,
  );
  await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 2);
  await tickSchedules(db);
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE schedule_id=$1', [s.id])
  ).rows[0];
  expect(j).toBeTruthy();
  const e = { job_id: j.id, execution_id: randomUUID() };
  await rpc('accept', e);
  await rpc('begin', e);
  await rpc('receipt', {
    ...e,
    receipt_id: randomUUID(),
    state: 'unknown',
    result: {},
  });
  await hc('beginHandoff', { schedule_id: s.id, executor: 'cloud' }, 3);
  await expect(
    hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 4),
  ).rejects.toMatchObject({ code: 'reconciliation_required' });
  await rpc('receipt', {
    ...e,
    receipt_id: randomUUID(),
    state: 'failed',
    result: {},
    error_code: 'verified_no_effect',
  });
  await expect(
    hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 4),
  ).rejects.toMatchObject({ code: 'revocation_unconfirmed' });
  const delegation = (
    await db.query('SELECT * FROM execution_delegations WHERE schedule_id=$1', [
      s.id,
    ])
  ).rows[0];
  await rpc('ackRevoke', { schedule_id: s.id, epoch: delegation.epoch });
  expect(
    (await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 4))
      .executor,
  ).toBe('cloud');
});
import { encrypt } from '../../packages/server/src/security.js';
it('T20 diagnostic cleanup previews protect latest complete request, active work and stale revisions', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const ack = await enqueue(db, owner, room.id, {
      client_command_id: randomUUID(),
      content: 'synthetic',
    });
    ids.push(ack.run_id);
    await db.query(
      "UPDATE runs SET state=$2,created_at=now()-$3*interval '1 day' WHERE id=$1",
      [ack.run_id, i === 3 ? 'remote_pending' : 'completed', 40 - i],
    );
    const value = {
      model: 'synthetic',
      messages: [{ role: 'user', content: 'test' }],
    };
    await db.query(
      'INSERT INTO request_snapshots(run_id,attempt,owner_id,payload,payload_hash) VALUES($1,1,$2,$3,$4)',
      [
        ack.run_id,
        owner,
        JSON.stringify(
          encrypt(
            JSON.stringify(value),
            config,
            `${owner}:request:${ack.run_id}:1`,
          ),
        ),
        hash(canonical(value)),
      ],
    );
  }
  const diag = (n: string, p: any) =>
    diagnosticsCommand(db, config, owner, input(n, p));
  const health = await diag('storageDiagnostics', {});
  expect(health.healthy).toBe(true);
  expect(health.read_only).toBe(true);
  const preview = await diag('previewDiagnosticCleanup', { retention_days: 1 });
  expect(preview.items.map((x: any) => x.run_id).sort()).toEqual(
    ids.slice(0, 2).sort(),
  );
  await db.query(
    "UPDATE request_snapshots SET payload_hash='changed' WHERE run_id=$1",
    [ids[0]],
  );
  await expect(
    diag('applyDiagnosticCleanup', {
      retention_days: 1,
      preview_token: preview.preview_token,
    }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect((await diag('storageDiagnostics', {})).healthy).toBe(false);
  const current = await diag('previewDiagnosticCleanup', { retention_days: 1 });
  expect(
    (
      await diag('applyDiagnosticCleanup', {
        retention_days: 1,
        preview_token: current.preview_token,
      })
    ).deleted,
  ).toBe(2);
  expect(
    (await db.query('SELECT run_id FROM request_snapshots')).rows
      .map((x) => x.run_id)
      .sort(),
  ).toEqual(ids.slice(2).sort());
});
it('T17 snapshots exclude diary and invalidate edited fact versions before Host retrieval', async () => {
  const { rpc, link } = await paired();
  const m = await call('saveMaterial', {
    actor_id: actors[0].id,
    kind: 'fact',
    title: 'fact',
    content: 'safe fact',
    summary: '',
  });
  const diary = await call('saveMaterial', {
    actor_id: actors[0].id,
    kind: 'diary',
    title: 'private',
    content: 'private diary',
    summary: '',
  });
  await expect(
    hc('publishHostSnapshot', { link_id: link.id, material_ids: [diary.id] }),
  ).rejects.toMatchObject({ code: 'snapshot_scope' });
  await hc('publishHostSnapshot', { link_id: link.id, material_ids: [m.id] });
  const first = await rpc('poll', { capabilities: ['chat'] });
  expect(first.snapshots[0].valid).toBe(true);
  expect(JSON.stringify(first)).not.toContain('private diary');
  await call(
    'saveMaterial',
    {
      actor_id: actors[0].id,
      id: m.id,
      kind: 'fact',
      title: 'fact',
      content: 'edited fact',
      summary: '',
    },
    m.revision,
  );
  const second = await rpc('poll', { capabilities: ['chat'] });
  expect(second.snapshots[0].materials).toEqual([]);
  expect(second.snapshots[0].valid).toBe(false);
});
it('T15/T17 pausing a delegated schedule invalidates already queued Host work', async () => {
  await allowScheduledContact();
  const { rpc, host } = await paired();
  const s = await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'pause',
    prompt: 'hello',
    rule: 'interval',
    timezone: 'UTC',
    at: new Date().toISOString(),
    interval_seconds: 60,
    enabled: false,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
  await hc(
    'beginHandoff',
    { schedule_id: s.id, executor: 'host', host_id: host.host_id },
    1,
  );
  await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 2);
  await tickSchedules(db);
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE schedule_id=$1', [s.id])
  ).rows[0];
  await sc('pauseSchedule', { id: s.id }, 3);
  await expect(
    rpc('accept', { job_id: j.id, execution_id: randomUUID() }),
  ).rejects.toMatchObject({ code: 'epoch_invalid' });
  await expect(
    rpc('lease', { schedule_id: s.id, epoch: j.epoch }),
  ).rejects.toMatchObject({ code: 'epoch_invalid' });
});
it('T16 explicit Host reconciliation stores supplied evidence without rerunning a job', async () => {
  const { host, rpc, link } = await paired(),
    dir = await mkdtemp(join(tmpdir(), 'echo-host-resolve-'));
  try {
    const r = new HostRunner(config, {
      cloud_url: 'https://unused.invalid',
      host_id: host.host_id,
      token: 'unused',
      private_key: 'unused',
      journal: join(dir, 'journal'),
      roots: { docs: dir },
      identities: {},
    });
    let lost = true;
    r.rpc = async (a, p) => {
      const response = await rpc(a, p);
      if (a === 'begin' && lost) {
        lost = false;
        throw Error('lost');
      }
      return response;
    };
    const j = await hc('submitHostJob', {
      link_id: link.id,
      kind: 'file_write',
      scope: { root: 'docs' },
      payload: { path: 'absent', content_base64: 'eA==' },
      budget: { max_output_tokens: 1, tool_limit: 0 },
    });
    await r.tick();
    await r.tick();
    r.rpc = rpc;
    await r.resolve(j.id, {
      state: 'failed',
      result: { verified_by: 'synthetic operator', external_effect: false },
      error_code: 'verified_no_effect',
    });
    expect(
      (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id]))
        .rows[0].state,
    ).toBe('failed');
    await expect(stat(join(dir, 'absent'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
import { invalidateSources } from '../../packages/server/src/modules/memory/repository.js';
it('T20 source erasure redacts shared and Host copies without deleting deduplication identity', async () => {
  const d = await device();
  const draftInput = input('receiveShareDraft', {
    actor_id: actors[0].id,
    room_id: room.id,
    content: 'private source marker',
    asset_ids: [],
  });
  const draft = await platformCommand(db, owner, draftInput, d);
  const { rpc, link } = await paired();
  await hc('setReplyRelay', { link_id: link.id, enabled: true });
  const sent = await platformCommand(
    db,
    owner,
    input('sendShareDraft', { id: draft.id }),
    d,
  );
  const job = (
    await db.query('SELECT * FROM host_jobs WHERE relay_run_id=$1', [
      sent.run_id,
    ])
  ).rows[0];
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await invalidateSources(c, owner, world.id, [sent.message_id], true);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  expect(
    (await db.query('SELECT content FROM share_drafts WHERE id=$1', [draft.id]))
      .rows[0].content,
  ).toBe('');
  expect(
    (
      await db.query('SELECT state,payload FROM host_jobs WHERE id=$1', [
        job.id,
      ])
    ).rows[0],
  ).toMatchObject({ state: 'cancelled', payload: {} });
  const replay = await platformCommand(db, owner, draftInput, d);
  expect(replay.id).toBe(draft.id);
  expect(replay.redacted).toBe(true);
  expect(
    (await db.query('SELECT count(*)::int n FROM share_drafts')).rows[0].n,
  ).toBe(1);
  expect(
    JSON.stringify(
      (
        await db.query(
          "SELECT result FROM operation_receipts WHERE command_type LIKE 'platform.%' OR command_type LIKE 'host.%'",
        )
      ).rows,
    ),
  ).not.toContain('private source marker');
});
it('T14 explicit owner evidence can reconcile an unavailable original device without repeating execution', async () => {
  const d = await device(),
    other = await device();
  const pc = (n: string, p: any, revision = 0, dev = d) =>
    platformCommand(db, owner, input(n, p, revision), dev);
  await pc('reportCapability', {
    capability: 'calendar',
    state: 'authorized',
    detail: {},
  });
  await pc('setSystemPolicy', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    enabled: true,
  });
  const a = await pc('createSystemAction', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    arguments: { title: 'synthetic' },
  });
  await pc('decideSystemAction', { id: a.id, approve: true }, 1);
  await pc('claimSystemAction', { id: a.id }, 2);
  await expect(
    pc(
      'completeSystemAction',
      { id: a.id, state: 'completed', external_id: 'event-1', result: {} },
      3,
      other,
    ),
  ).rejects.toMatchObject({ code: 'device_scope' });
  await expect(
    pc(
      'reconcileSystemAction',
      {
        id: a.id,
        state: 'completed',
        external_id: 'event-1',
        evidence: '',
        confirmed: true,
      },
      3,
      other,
    ),
  ).rejects.toMatchObject({ code: 'reconciliation_required' });
  const resolved = await pc(
    'reconcileSystemAction',
    {
      id: a.id,
      state: 'completed',
      external_id: 'event-1',
      evidence: 'synthetic operator verified source event',
      confirmed: true,
    },
    3,
    other,
  );
  expect(resolved.result.execution_repeated).toBe(false);
  expect(resolved.external_id).toBe('event-1');
});
it('T17 revoked Host token stays invalid; owner evidence is required before taking reconciled work back', async () => {
  await allowScheduledContact();
  const { rpc, host } = await paired();
  const s = await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'revoke',
    prompt: 'hello',
    rule: 'interval',
    timezone: 'UTC',
    at: new Date().toISOString(),
    interval_seconds: 60,
    enabled: false,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
  await hc(
    'beginHandoff',
    { schedule_id: s.id, executor: 'host', host_id: host.host_id },
    1,
  );
  await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 2);
  await tickSchedules(db);
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE schedule_id=$1', [s.id])
  ).rows[0];
  await rpc('accept', { job_id: j.id, execution_id: randomUUID() });
  await hc('revokeHost', { id: host.host_id }, 2);
  await expect(rpc('poll', { capabilities: ['chat'] })).rejects.toMatchObject({
    code: 'host_auth',
  });
  await expect(
    hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 4),
  ).rejects.toMatchObject({ code: 'reconciliation_required' });
  const unknown = (
    await db.query('SELECT * FROM host_jobs WHERE id=$1', [j.id])
  ).rows[0];
  await hc(
    'reconcileHostJob',
    {
      id: j.id,
      state: 'failed',
      result: { external_effect: false },
      evidence: 'synthetic operator verified no effect',
      confirmed: true,
    },
    unknown.revision,
  );
  expect(
    (await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 4))
      .executor,
  ).toBe('cloud');
});

// Full-spec audit: regressions must fail before the fixes below are applied.
async function backupVariant(archive: any, change: (pack: any) => void) {
  const { scryptSync } = await import('node:crypto');
  const { encrypt, decrypt } =
    await import('../../packages/server/src/security.js');
  const cipher = {
    ...config,
    masterKey: scryptSync(
      'synthetic-password',
      Buffer.from(archive.salt, 'base64'),
      32,
    ),
    keyVersion: 1,
  };
  const pack = JSON.parse(decrypt(archive.payload, cipher, 'echo-business-v1'));
  change(pack);
  return {
    ...archive,
    payload: encrypt(JSON.stringify(pack), cipher, 'echo-business-v1'),
  };
}
it('audit T05/T14 refuses changed approved system arguments and deleted actors before claiming', async () => {
  const d = await device();
  const pc = (n: string, p: any, rev = 0) =>
    platformCommand(db, owner, input(n, p, rev), d);
  await pc('reportCapability', {
    capability: 'calendar',
    state: 'authorized',
    detail: {},
  });
  await pc('setSystemPolicy', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    enabled: true,
  });
  const a = await pc('createSystemAction', {
    actor_id: actors[0].id,
    device_id: d,
    action: 'calendar.create',
    arguments: { title: 'approved' },
  });
  await pc('decideSystemAction', { id: a.id, approve: true }, 1);
  await db.query("UPDATE system_actions SET payload='{}' WHERE id=$1", [a.id]);
  await expect(pc('claimSystemAction', { id: a.id }, 2)).rejects.toMatchObject({
    code: 'action_integrity',
  });
  await db.query('UPDATE system_actions SET payload=$2 WHERE id=$1', [
    a.id,
    JSON.stringify(a.payload),
  ]);
  await db.query('UPDATE world_characters SET deleted=true WHERE id=$1', [
    actors[0].id,
  ]);
  await expect(pc('claimSystemAction', { id: a.id }, 2)).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(
    (await db.query('SELECT state FROM system_actions WHERE id=$1', [a.id]))
      .rows[0].state,
  ).toBe('approved');
});
it('audit T16 rejects changed Host job payload at accept and begin without starting execution', async () => {
  const { rpc, link } = await paired();
  const j = await hc('submitHostJob', {
    link_id: link.id,
    kind: 'file_write',
    scope: { root: 'docs' },
    payload: { path: 'x', content_base64: 'eA==', base_hash: null },
    budget: { max_output_tokens: 1, tool_limit: 0 },
  });
  const identity = randomUUID();
  await db.query(
    'UPDATE host_jobs SET payload=payload || \'{"path":"changed"}\' WHERE id=$1',
    [j.id],
  );
  await expect(
    rpc('accept', { job_id: j.id, execution_id: identity }),
  ).rejects.toMatchObject({ code: 'job_integrity' });
  await db.query('UPDATE host_jobs SET payload=$2 WHERE id=$1', [
    j.id,
    JSON.stringify(j.payload),
  ]);
  await rpc('accept', { job_id: j.id, execution_id: identity });
  await db.query(
    'UPDATE host_jobs SET budget=\'{"max_output_tokens":8192,"tool_limit":5}\' WHERE id=$1',
    [j.id],
  );
  await expect(
    rpc('begin', { job_id: j.id, execution_id: identity }),
  ).rejects.toMatchObject({ code: 'job_integrity' });
  expect(
    (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id])).rows[0]
      .state,
  ).toBe('accepted');
});
it('audit T06/T18 preserves remote receipt identity across instances and repeats restore receipt with imported unknown work', async () => {
  const { rpc, link } = await paired();
  const j = await hc('submitHostJob', {
    link_id: link.id,
    kind: 'chat',
    scope: {},
    payload: { content: 'synthetic' },
    budget: { max_output_tokens: 10, tool_limit: 0 },
  });
  const execution = randomUUID(),
    remoteRun = randomUUID(),
    receipt = randomUUID();
  await rpc('accept', { job_id: j.id, execution_id: execution });
  await rpc('receipt', {
    job_id: j.id,
    execution_id: execution,
    receipt_id: receipt,
    state: 'unknown',
    result: { local_run_id: remoteRun },
    error_code: 'disconnected',
  });
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
  const result = await restoreBackup(db, config, owner, p.id, p.preview_token);
  const restored = (await db.query('SELECT * FROM host_jobs')).rows[0];
  expect(restored.id).not.toBe(j.id);
  expect(restored.execution_id).toBe(execution);
  expect(restored.result.local_run_id).toBe(remoteRun);
  const r = (await db.query('SELECT * FROM host_receipts')).rows[0];
  expect(r.job_id).toBe(restored.id);
  expect(r.receipt_id).toBe(receipt);
  expect(r.body.job_id).toBe(j.id);
  expect(r.payload_hash).toBe(hash(canonical(r.body)));
  expect(await restoreBackup(db, config, owner, p.id, p.preview_token)).toEqual(
    result,
  );
  expect(
    (await db.query('SELECT count(*)::int n FROM host_jobs')).rows[0].n,
  ).toBe(1);
});
it('audit T06/T20 rejects authentic but cross-actor share references and missing graph targets before staging', async () => {
  const d = await device();
  const draft = await platformCommand(
    db,
    owner,
    input('receiveShareDraft', {
      actor_id: actors[0].id,
      room_id: room.id,
      content: 'private',
      asset_ids: [],
    }),
    d,
  );
  const backup = await exportBackup(db, 'synthetic-password');
  const wrong = await backupVariant(backup.archive, (p) => {
    p.tables.share_drafts[0].actor_id = actors[1].id;
  });
  await expect(
    previewRestore(db, config, owner, wrong, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_integrity' });
  const missing = await backupVariant(backup.archive, (p) => {
    p.tables.share_drafts[0].room_id = randomUUID();
  });
  await expect(
    previewRestore(db, config, owner, missing, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_integrity' });
  expect(
    (await db.query('SELECT count(*)::int n FROM restore_sessions')).rows[0].n,
  ).toBe(0);
  expect(draft.content).toBe('private');
});

it('audit T15/T17 Host schedule obeys global contact permission at submission and immediately before execution', async () => {
  const { host, rpc } = await paired();
  const s = await sc('saveSchedule', {
    actor_id: actors[0].id,
    name: 'permission',
    prompt: 'hello',
    rule: 'interval',
    timezone: 'UTC',
    at: new Date().toISOString(),
    interval_seconds: 60,
    enabled: false,
    catch_up: 'latest',
    executor: 'cloud',
    tool_limit: 5,
  });
  await hc(
    'beginHandoff',
    { schedule_id: s.id, executor: 'host', host_id: host.host_id },
    1,
  );
  await hc('confirmHandoff', { schedule_id: s.id, enabled: true }, 2);
  await tickSchedules(db);
  expect(
    (
      await db.query(
        'SELECT state FROM schedule_occurrences WHERE schedule_id=$1',
        [s.id],
      )
    ).rows[0].state,
  ).toBe('blocked');
  expect(
    (await db.query('SELECT count(*)::int n FROM host_jobs')).rows[0].n,
  ).toBe(0);
  await allowScheduledContact();
  await tickSchedules(db, new Date(Date.now() + 61000));
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE schedule_id=$1', [s.id])
  ).rows[0];
  const identity = randomUUID();
  await rpc('accept', { job_id: j.id, execution_id: identity });
  await db.query(
    'UPDATE autonomy_settings SET enabled=false,revision=revision+1 WHERE owner_id=$1',
    [owner],
  );
  await expect(
    rpc('begin', { job_id: j.id, execution_id: identity }),
  ).rejects.toMatchObject({ code: 'autonomy_disabled' });
  expect(
    (await db.query('SELECT state FROM host_jobs WHERE id=$1', [j.id])).rows[0]
      .state,
  ).toBe('accepted');
});
it('audit T06/T20 erased source copies cannot re-enter through share drafts or Host payloads in a valid encrypted package', async () => {
  const d = await device();
  const draft = await platformCommand(
    db,
    owner,
    input('receiveShareDraft', {
      actor_id: actors[0].id,
      room_id: room.id,
      content: 'private marker',
      asset_ids: [],
    }),
    d,
  );
  const { link } = await paired();
  await hc('setReplyRelay', { link_id: link.id, enabled: true });
  const sent = await platformCommand(
    db,
    owner,
    input('sendShareDraft', { id: draft.id }),
    d,
  );
  const backup = await exportBackup(db, 'synthetic-password');
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await invalidateSources(tx, owner, world.id, [sent.message_id], true);
    await tx.query('COMMIT');
  } finally {
    tx.release();
  }
  const withoutMessages = await backupVariant(backup.archive, (p) => {
    for (const m of p.tables.messages) m.content = '';
    for (const v of p.tables.message_versions) v.content = '';
  });
  await expect(
    previewRestore(db, config, owner, withoutMessages, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_privacy_conflict' });
  const onlyHost = await backupVariant(withoutMessages, (p) => {
    for (const d of p.tables.share_drafts) d.content = '';
  });
  await expect(
    previewRestore(db, config, owner, onlyHost, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_privacy_conflict' });
});

it('audit T18 retention defaults to keep-all; checksummed 038 packages upgrade without changing explicit choices', async () => {
  const { link } = await paired();
  const plan = await storageCommand(
    db,
    config,
    owner,
    input('saveBackupPlan', {
      link_id: link.id,
      root: 'docs',
      cadence: 'daily',
      enabled: false,
      password: 'synthetic-password',
    }),
  );
  expect(
    (
      await db.query('SELECT keep_count FROM remote_backup_plans WHERE id=$1', [
        plan.id,
      ])
    ).rows[0].keep_count,
  ).toBe(0);
  await storageCommand(
    db,
    config,
    owner,
    input(
      'saveBackupPlan',
      {
        id: plan.id,
        link_id: link.id,
        root: 'docs',
        cadence: 'daily',
        enabled: false,
        password: 'synthetic-password',
        keep_count: 3,
      },
      1,
    ),
  );
  const backup = await exportBackup(db, 'synthetic-password');
  const legacy = await backupVariant(backup.archive, (p) => {
    p.schema_version = p.schema_version.filter(
      (m: any) => m.name <= '038_delivery_status.sql',
    );
  });
  const original = JSON.stringify(legacy);
  await db.query('TRUNCATE owners CASCADE');
  owner = await initializeOwner(db, config);
  const p = await previewRestore(
    db,
    config,
    owner,
    legacy,
    'synthetic-password',
  );
  await restoreBackup(db, config, owner, p.id, p.preview_token);
  expect(
    (await db.query('SELECT keep_count,enabled FROM remote_backup_plans'))
      .rows[0],
  ).toEqual({ keep_count: 3, enabled: false });
  expect(JSON.stringify(legacy)).toBe(original);
  const corrupt = await backupVariant(legacy, (p) => {
    p.schema_version[0].checksum = 'invalid';
  });
  await expect(
    previewRestore(db, config, owner, corrupt, 'synthetic-password'),
  ).rejects.toMatchObject({ code: 'backup_schema' });
});

it('audit T18 pause needs no password and invalidates queued backup execution', async () => {
  const { host, link, rpc } = await paired();
  await rpc('poll', { capabilities: ['backup_list', 'backup_put'] });
  await hc(
    'setHostGrants',
    {
      id: host.host_id,
      grants: { actions: ['backup_list', 'backup_put'], roots: ['docs'] },
    },
    2,
  );
  const plan = await storageCommand(
    db,
    config,
    owner,
    input('saveBackupPlan', {
      link_id: link.id,
      root: 'docs',
      cadence: 'daily',
      enabled: true,
      password: 'synthetic-password',
    }),
  );
  await storageCommand(
    db,
    config,
    owner,
    input('runRemoteBackup', { id: plan.id }, 1),
  );
  await tickRemoteBackups(db, config);
  const j = (
    await db.query('SELECT * FROM host_jobs WHERE kind=$1', ['backup_list'])
  ).rows[0];
  const pause = input('pauseBackupPlan', { id: plan.id }, 1);
  expect(await storageCommand(db, config, owner, pause)).toMatchObject({
    enabled: false,
    revision: 2,
  });
  expect(await storageCommand(db, config, owner, pause)).toMatchObject({
    enabled: false,
    revision: 2,
  });
  expect(
    (await rpc('accept', { job_id: j.id, execution_id: randomUUID() })).state,
  ).toBe('cancelled');
  expect(
    (await db.query('SELECT state FROM remote_backups')).rows[0].state,
  ).toBe('paused');
});
