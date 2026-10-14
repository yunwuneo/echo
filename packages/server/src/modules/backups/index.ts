import { validateGraph } from './integrity.js';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, hash, encrypt, decrypt } from '../../security.js';
import { canonical } from '../mcp/schema.js';

const scrypt = promisify(scryptCallback);
const limit = 16 * 1024 * 1024;
// Exact format-v1 business tables. Execution queues, device/session secrets,
// transient indexes and encrypted request diagnostics are deliberately excluded.
export const continuationTables = [
  'devices',
  'external_documents',
  'remote_backup_plans',
  'remote_backups',
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
] as const;
export const tables = [
  ...continuationTables,
  'miniapps',
  'runtime_conflicts',
  'group_policies',
  'group_member_policies',
  'media_jobs',
  'media_job_assets',
  'voice_sessions',
  'voice_turns',
  'voice_invites',
  'extension_installs',
  'extension_install_jobs',
  'skill_bindings',
  'worldbooks',
  'worldbook_bindings',
  'memory_policies',
  'memory_materials',
  'memory_corrections',
  'memory_organizations',
  'provider_connections',
  'character_templates',
  'character_versions',
  'worlds',
  'world_characters',
  'rooms',
  'room_memberships',
  'lore_entries',
  'world_state',
  'background_usage',
  'runs',
  'messages',
  'message_versions',
  'message_audiences',
  'world_events',
  'configuration_revisions',
  'memories',
  'memory_evidence',
  'memory_revisions',
  'memory_tombstones',
  'message_dependencies',
  'memory_settings',
  'lore_activations',
  'lore_commits',
  'import_jobs',
  'mcp_connections',
  'tool_grants',
  'tool_calls',
  'autonomy_settings',
  'autonomy_policies',
  'assets',
  'asset_references',
  'model_routes',
  'conversation_defaults',
  'conversation_inputs',
  'conversation_branches',
  'prompt_presets',
  'prompt_profiles',
  'projects',
  'documents',
  'document_versions',
  'document_assets',
  'document_version_assets',
  'privacy_deletions',
  'usage_ledger',
  'usage_daily',
  'background_daily',
  'background_scopes',
  'autonomy_daily',
] as const;
type Table = (typeof tables)[number];
type Package = {
  format: string;
  version: number;
  schema_version: { name: string; checksum: string }[];
  source_instance: string;
  owner: string;
  tables: Record<Table, any[]>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const json = (v: any) => JSON.parse(JSON.stringify(v));
const digest = (v: any) => hash(canonical(json(v)));
const fail = (code: string, message: string): never => {
  throw new AppError(409, code, message);
};
async function catalog(db: DB) {
  const columns = (
    await db.query(
      'SELECT table_name,column_name,udt_name,is_generated FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY ordinal_position',
      [tables],
    )
  ).rows;
  const keys = (
    await db.query(
      'SELECT c.relname AS table_name,a.attname AS column_name,u.ord FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY u(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum WHERE i.indisprimary AND c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname,u.ord',
      [tables],
    )
  ).rows;
  return Object.fromEntries(
    tables.map((t) => [
      t,
      {
        columns: columns.filter((c) => c.table_name === t),
        keys: keys
          .filter((k) => k.table_name === t)
          .map((k) => k.column_name as string),
      },
    ]),
  );
}
function portable(t: Table, r: any, pause = true) {
  const v = json(r);
  if (r.day instanceof Date)
    v.day = [
      r.day.getFullYear(),
      String(r.day.getMonth() + 1).padStart(2, '0'),
      String(r.day.getDate()).padStart(2, '0'),
    ].join('-');
  if (t === 'provider_connections') v.credential = {};
  if (t === 'host_nodes') v.token_hash = '';
  if (t === 'event_triggers') v.secret = {};
  if (t === 'remote_backup_plans') v.password = {};
  if (t === 'remote_backups') v.archive = null;
  if (t === 'host_jobs' && v.kind === 'backup_put') {
    delete v.payload.content_base64;
    v.payload_hash = hash(
      canonical({ scope: v.scope, payload: v.payload, budget: v.budget }),
    );
  }
  if (t === 'mcp_connections') v.credential = null;
  if (!pause) return v;
  if (t === 'remote_backup_plans') v.enabled = false;
  if (t === 'remote_backups' && v.state !== 'completed') v.state = 'paused';
  if (t === 'external_documents') {
    v.state = 'unread';
    v.job_id = null;
  }
  if (t === 'devices') v.revoked_at = '1970-01-01T00:00:00.000Z';
  if (t === 'host_nodes') {
    v.revoked_at = '1970-01-01T00:00:00.000Z';
    v.grants = {};
    v.capabilities = [];
    v.last_seen_at = null;
  }
  if (
    [
      'system_policies',
      'schedules',
      'event_triggers',
      'host_identity_links',
      'reply_relays',
      'host_plugins',
    ].includes(t)
  )
    v.enabled = false;
  if (t === 'device_capabilities') v.state = 'unavailable';
  if (t === 'today_sources') v.state = 'stale';
  if (t === 'event_triggers') {
    v.state = 'revoked';
    v.external_id = null;
  }
  if (t === 'execution_delegations') {
    v.state = 'pending';
    v.lease_until = null;
    v.revocation_ack = false;
  }
  if (
    t === 'host_jobs' &&
    ['pending', 'accepted', 'executing'].includes(v.state)
  )
    v.state = v.state === 'pending' ? 'cancelled' : 'unknown';
  if (
    t === 'system_actions' &&
    ['pending', 'approved', 'executing'].includes(v.state)
  )
    v.state = v.state === 'executing' ? 'unknown' : 'denied';
  if (t === 'schedule_occurrences' && ['pending', 'started'].includes(v.state))
    v.state = 'paused';
  if (t === 'miniapps') v.run_enabled = false;
  if (t === 'mcp_connections') v.enabled = false;
  if (
    t === 'extension_install_jobs' &&
    ['prepared', 'submitted'].includes(v.state)
  )
    v.state = 'unknown';
  if (t === 'skill_bindings') v.mode = 'off';
  if (
    t === 'media_jobs' &&
    ['queued', 'submitting', 'polling', 'accepted', 'processing'].includes(
      v.state,
    )
  )
    v.state = 'unknown';
  if (t === 'group_member_policies') v.tools_enabled = false;
  if (t === 'voice_sessions') v.state = 'closed';
  if (t === 'voice_invites') v.state = 'expired';
  if (t === 'tool_grants') v.enabled = false;
  if (t === 'autonomy_settings' || t === 'autonomy_policies') {
    v.enabled = false;
    v.tools_read = false;
    v.tools_write = false;
  }
  if (t === 'memory_organizations' && ['running', 'queued'].includes(v.state))
    v.state = 'unknown';
  if (t === 'runs') {
    if (
      ['queued', 'running', 'awaiting_approval', 'remote_pending'].includes(
        v.state,
      )
    ) {
      v.state = 'interrupted';
      v.error_code = 'restored_paused';
    }
    v.lease_holder = null;
    v.fence = null;
  }
  if (t === 'messages' && ['streaming', 'accepted'].includes(v.status))
    v.status = 'interrupted';
  if (t === 'tool_calls') {
    if (v.state === 'executing') v.state = 'outcome_unknown';
    if (['approved', 'pending'].includes(v.state)) v.state = 'denied';
  }
  return v;
}
async function readRows(db: DB, owner: string) {
  const meta = await catalog(db),
    data = {} as Package['tables'];
  let bytes = 0;
  for (const t of tables) {
    // One owner per instance, enforced in schema. Child tables inherit that scope.
    // Explicitly verify the sole owner before reading tables without owner_id.
    const scoped = meta[t]!.columns.some((c) => c.column_name === 'owner_id');
    const rows = (
      await db.query(
        'SELECT * FROM ' +
          quote(t) +
          (scoped ? ' WHERE owner_id=$1' : '') +
          ' LIMIT 10001',
        scoped ? [owner] : [],
      )
    ).rows;
    if (rows.length > 10000)
      fail('backup_size', 'Format v1 permits at most 10000 rows per table');
    data[t] = rows.map((r) => portable(t, r));
    bytes += Buffer.byteLength(JSON.stringify(data[t]));
    if (bytes > limit)
      fail(
        'backup_size',
        'Format v1 is limited to 16 MiB; use maintenance backup for larger instances',
      );
  }
  return data;
}
async function soleOwner(db: DB, owner: string) {
  const rows = (await db.query('SELECT id FROM owners')).rows;
  if (rows.length !== 1 || rows[0].id !== owner)
    throw new AppError(404, 'not_found', 'Owner not found');
}
export async function exportBackup(db: pg.Pool, password: string) {
  if (password.length < 12 || password.length > 256)
    throw new AppError(
      400,
      'backup_password',
      'Use a password of 12–256 characters',
    );
  const pack = await transaction(
    db,
    async (tx) => {
      const owners = (await tx.query('SELECT id FROM owners')).rows;
      if (owners.length !== 1)
        fail('backup_owner', 'Exactly one owner required');
      const source = (
        await tx.query('SELECT server_instance_id FROM instance_metadata')
      ).rows[0].server_instance_id;
      return {
        format: 'echo-business',
        version: 1,
        schema_version: (
          await tx.query(
            'SELECT name,checksum FROM schema_migrations ORDER BY name',
          )
        ).rows,
        source_instance: source,
        owner: owners[0].id,
        tables: await readRows(tx, owners[0].id),
      } satisfies Package;
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  await validate(db, pack);
  if (Buffer.byteLength(JSON.stringify(pack)) > limit)
    fail('backup_size', 'Backup exceeds format v1 size limit');
  const salt = randomBytes(16).toString('base64');
  const key = (await scrypt(
    password,
    Buffer.from(salt, 'base64'),
    32,
  )) as Buffer;
  const envelope = {
    format: 'echo-encrypted',
    version: 1,
    salt,
    payload: encrypt(
      JSON.stringify(pack),
      { masterKey: key, keyVersion: 1 } as Config,
      'echo-business-v1',
    ),
  };
  key.fill(0);
  return {
    archive: envelope,
    includes: tables,
    excludes: [
      'credentials',
      'session secrets and device authorization',
      'Host tokens and event signing secrets',
      'execution queues',
      'push delivery',
      'derived vectors',
      'request diagnostics',
    ],
    max_plaintext_bytes: limit,
  };
}
async function openBackup(
  db: DB,
  envelope: any,
  password: string,
): Promise<Package> {
  let pack: Package;
  try {
    if (
      envelope?.format !== 'echo-encrypted' ||
      envelope.version !== 1 ||
      typeof envelope.salt !== 'string' ||
      Buffer.from(envelope.salt, 'base64').length !== 16 ||
      typeof envelope.payload?.data !== 'string' ||
      envelope.payload.data.length > Math.ceil((limit * 4) / 3) + 1024
    )
      throw new Error();
    const key = (await scrypt(
      password,
      Buffer.from(envelope.salt, 'base64'),
      32,
    )) as Buffer;
    let plain: string;
    try {
      plain = decrypt(
        envelope.payload,
        { masterKey: key, keyVersion: 1 } as Config,
        'echo-business-v1',
      );
    } finally {
      key.fill(0);
    }
    if (Buffer.byteLength(plain) > limit) throw new Error();
    pack = JSON.parse(plain);
  } catch (e) {
    throw new AppError(
      400,
      'backup_authentication',
      'Wrong password or invalid encrypted backup',
    );
  }
  await upgradeMilestoneBackup(db, pack);
  await validate(db, pack);
  return pack;
}
// Explicit, lossless upgrade from the delivered 020 milestone format. The encrypted
// input is never rewritten; new tables start empty and only known defaults are added.
export async function upgradeMilestoneBackup(db: DB, p: any) {
  const schema = (
    await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')
  ).rows;
  // 039 changes only validation/defaults, never the portable columns or existing retention choices.
  if (
    Array.isArray(p?.schema_version) &&
    p.schema_version.at(-1)?.name === '038_delivery_status.sql'
  ) {
    const prior = schema.filter(
      (m: any) => m.name <= '038_delivery_status.sql',
    );
    if (canonical(prior) !== canonical(p.schema_version))
      fail('backup_schema', 'Historical migration checksum mismatch');
    p.schema_version = schema;
    return;
  }
  if (
    !Array.isArray(p?.schema_version) ||
    !['020_tool_call_identity.sql', '030_runtime_input_identity.sql'].includes(
      p.schema_version.at(-1)?.name,
    )
  )
    return;
  const legacy = p.schema_version.at(-1).name;
  const prefix = schema.filter((m: any) => m.name <= legacy);
  if (canonical(prefix) !== canonical(p.schema_version))
    fail('backup_schema', 'Historical migration checksum mismatch');
  const added = [
    ...continuationTables,
    ...(legacy === '020_tool_call_identity.sql'
      ? [
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
        ]
      : []),
  ];
  if (
    !p.tables ||
    Object.keys(p.tables).some((t) => !tables.includes(t as Table)) ||
    tables.some((t) => !added.includes(t) && !Array.isArray(p.tables[t]))
  )
    fail('backup_integrity', 'Historical table inventory mismatch');
  for (const t of added) {
    if (t in p.tables) fail('backup_integrity', 'Unexpected future table');
    p.tables[t] = [];
  }
  const defaults: any = {
    ...(legacy === '020_tool_call_identity.sql'
      ? {
          rooms: {
            memory_participation: true,
            parent_group_id: null,
            lane_actor_id: null,
          },
          provider_connections: { media_options: {} },
          assets: { input_mode: 'original', extracted_text: '' },
          asset_references: { input_mode: 'original', extracted_text: '' },
          background_usage: { manual: false },
          runs: { group_snapshot: null },
        }
      : {}),
  };
  defaults.provider_connections = {
    ...(defaults.provider_connections ?? {}),
    protocol: 'openai',
  };
  defaults.runs = {
    ...(defaults.runs ?? {}),
    tool_limit: 4,
    schedule_id: null,
    schedule_revision: null,
    schedule_epoch: null,
  };
  defaults.messages = { external_origin: null };
  for (const [t, fields] of Object.entries(defaults))
    for (const row of p.tables[t])
      for (const [key, value] of Object.entries(fields as any)) {
        if (key in row) fail('backup_integrity', 'Unexpected future field');
        row[key] = value;
      }
  for (const r of p.tables.memory_settings)
    r.active_index_version = r.index_version;
  for (const r of p.tables.mcp_connections) r.handle = r.id;
  p.schema_version = schema;
}
async function validate(db: DB, p: any) {
  if (
    p?.format !== 'echo-business' ||
    p.version !== 1 ||
    !uuid.test(p.source_instance) ||
    !uuid.test(p.owner) ||
    !p.tables ||
    Object.keys(p.tables).length !== tables.length
  )
    fail('backup_integrity', 'Unsupported manifest');
  const schema = (
    await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')
  ).rows;
  if (
    !Array.isArray(p.schema_version) ||
    canonical(p.schema_version) !== canonical(schema)
  )
    fail(
      'backup_schema',
      'Backup schema differs; use a matching server version or an explicit migration',
    );
  const meta = await catalog(db);
  for (const t of tables) {
    if (!Array.isArray(p.tables[t]) || p.tables[t].length > 10000)
      fail('backup_integrity', 'Invalid table ' + t);
    const columns = meta[t]!.columns.map((c) => c.column_name);
    const seen = new Set<string>();
    for (const row of p.tables[t]) {
      if (
        !row ||
        Object.keys(row).some((k) => !columns.includes(k)) ||
        columns.some((k) => !(k in row))
      )
        fail('backup_integrity', 'Invalid columns in ' + t);
      if ('owner_id' in row && row.owner_id !== p.owner)
        fail('backup_integrity', 'Mixed owners');
      const key = canonical(meta[t]!.keys.map((k) => row[k]));
      if (seen.has(key)) fail('backup_integrity', 'Duplicate key in ' + t);
      seen.add(key);
      if (t === 'assets') {
        const b = Buffer.from(row.content?.data ?? []);
        if (
          row.content?.type !== 'Buffer' ||
          b.length !== row.size ||
          hash(b) !== row.content_hash
        )
          fail('backup_integrity', 'Asset hash mismatch: ' + row.id);
      }
      if (
        (t === 'documents' ||
          t === 'document_versions' ||
          t === 'memory_materials') &&
        hash(row.content) !== row.content_hash
      )
        fail(
          'backup_integrity',
          'Document hash mismatch: ' + (row.id ?? row.document_id),
        );
      if (
        (t === 'host_nodes' && row.token_hash !== '') ||
        (t === 'event_triggers' && canonical(row.secret) !== '{}') ||
        (t === 'remote_backup_plans' && canonical(row.password) !== '{}')
      )
        fail('backup_integrity', 'Secrets forbidden in business backup');
      if (t === 'provider_connections' && canonical(row.credential) !== '{}')
        fail('backup_integrity', 'Credentials forbidden in format v1');
      if (t === 'mcp_connections' && row.credential !== null)
        fail('backup_integrity', 'Credentials forbidden in format v1');
    }
  }
  await validateGraph(db, p);
  const assets = new Set(p.tables.assets.map((a: any) => a.id));
  for (const v of p.tables.document_versions) {
    const links = p.tables.document_version_assets
      .filter(
        (r: any) =>
          r.document_id === v.document_id && r.revision === v.revision,
      )
      .map((r: any) => r.asset_id);
    if (
      !Array.isArray(v.asset_ids) ||
      v.asset_ids.some((id: string) => !assets.has(id)) ||
      canonical([...v.asset_ids].sort()) !== canonical(links.sort())
    )
      fail(
        'backup_integrity',
        'Document version references mismatch: ' + v.document_id,
      );
  }
  for (const doc of p.tables.documents) {
    const version = p.tables.document_versions.find(
      (v: any) => v.document_id === doc.id && v.revision === doc.revision,
    );
    if (
      !version ||
      version.content_hash !== doc.content_hash ||
      version.title !== doc.title
    )
      fail('backup_integrity', 'Document current version mismatch: ' + doc.id);
  }
  const msgs = new Map<string, any>(
    p.tables.messages.map((m: any) => [m.id, m]),
  );
  const versions = new Map<string, any>(
    p.tables.message_versions.map((v: any) => [v.id, v]),
  );
  for (const m of msgs.values())
    if (m.selected_version_id) {
      const v = versions.get(m.selected_version_id);
      if (!v || v.message_id !== m.id || v.content !== m.content)
        fail('backup_integrity', 'Selected message version mismatch: ' + m.id);
    }
  // Restore must preserve the same scope checks as ordinary write APIs;
  // owner-only foreign keys do not express actor-private asset visibility.
  const assetRows = new Map<string, any>(
    p.tables.assets.map((a: any) => [a.id, a]),
  );
  const rooms = new Map<string, any>(p.tables.rooms.map((r: any) => [r.id, r]));
  for (const ref of p.tables.asset_references) {
    const asset = assetRows.get(ref.asset_id);
    const message = msgs.get(ref.message_id);
    const room = rooms.get(message?.room_id);
    if (
      !asset ||
      !room ||
      asset.world_id !== room.world_id ||
      (asset.actor_id &&
        p.tables.message_audiences.some(
          (a: any) =>
            a.message_id === ref.message_id && a.actor_id !== asset.actor_id,
        ))
    )
      fail('backup_integrity', 'Asset audience mismatch: ' + ref.asset_id);
  }
  const projects = new Map<string, any>(
    p.tables.projects.map((r: any) => [r.id, r]),
  );
  const documents = new Map<string, any>(
    p.tables.documents.map((r: any) => [r.id, r]),
  );
  for (const ref of [
    ...p.tables.document_assets,
    ...p.tables.document_version_assets,
  ]) {
    const asset = assetRows.get(ref.asset_id);
    const project = projects.get(documents.get(ref.document_id)?.project_id);
    if (
      !asset ||
      !project ||
      asset.world_id !== project.world_id ||
      (asset.actor_id && asset.actor_id !== project.actor_id)
    )
      fail(
        'backup_integrity',
        'Document asset scope mismatch: ' + ref.asset_id,
      );
  }
}
function translate(p: Package, owner: string, instance: string) {
  const ids = new Map<string, string>([[p.owner, owner]]);
  const map = (id: string) => {
    if (!ids.has(id)) {
      const h = hash(owner + ':' + p.source_instance + ':' + id);
      ids.set(
        id,
        p.source_instance === instance
          ? id
          : h.slice(0, 8) +
              '-' +
              h.slice(8, 12) +
              '-5' +
              h.slice(13, 16) +
              '-a' +
              h.slice(17, 20) +
              '-' +
              h.slice(20, 32),
      );
    }
    return ids.get(id)!;
  };
  // Only structural identity fields are translated; arbitrary source text is not rewritten.
  const value = (v: any, key = '', internal = false): any => {
    if (
      [
        'client_command_id',
        'model_call_id',
        'operation_id',
        'external_id',
        'execution_id',
        'receipt_id',
        'notification_id',
        'remote_identity',
        'local_run_id',
        'node_id',
      ].includes(key)
    )
      return v;
    if (
      !internal &&
      ['arguments', 'argument_scope', 'authorization_snapshot'].includes(key)
    )
      return v;
    if (
      typeof v === 'string' &&
      uuid.test(v) &&
      (/(^id$|_id$|_ids$|actor_key$)/.test(key) ||
        key === 'members' ||
        key === 'credential_ref')
    )
      return map(v);
    if (Array.isArray(v)) return v.map((x) => value(x, key, internal));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, value(x, k, internal)]),
      );
    return v;
  };
  return Object.fromEntries(
    tables.map((t) => [
      t,
      p.tables[t].map((r) => {
        const connection =
          t === 'tool_grants'
            ? r.connection_id
            : t === 'tool_calls'
              ? p.tables.tool_grants.find((g) => g.id === r.grant_id)
                  ?.connection_id
              : null;
        const internal = p.tables.mcp_connections.some(
          (c) => c.id === connection && c.runtime === 'internal',
        );
        const source = portable(t, r);
        const mapped = value(source, '', internal);
        // External payloads and receipts are immutable evidence, not local object graphs.
        if (t === 'system_actions') {
          mapped.payload = source.payload;
          mapped.result = source.result;
        }
        if (t === 'host_jobs') {
          mapped.payload = { ...source.payload };
          if (source.payload.plugin_id)
            mapped.payload.plugin_id = map(source.payload.plugin_id);
          mapped.result = source.result;
          mapped.payload_hash = hash(
            canonical({
              scope: mapped.scope,
              payload: mapped.payload,
              budget: mapped.budget,
            }),
          );
        }
        if (t === 'host_receipts') mapped.body = source.body;
        if (t === 'host_snapshots')
          mapped.source_hash = hash(canonical(mapped.materials));
        if (t === 'today_sources') mapped.data = source.data;
        // User documents/state and provider-owned parameters are opaque JSON, not references.
        const opaque: Partial<Record<Table, string[]>> = {
          miniapps: ['state', 'resources'],
          runtime_conflicts: ['state'],
          character_versions: ['data'],
          provider_connections: ['parameters', 'media_options'],
          mcp_connections: ['tools'],
          extension_installs: ['manifest', 'resources'],
        };
        for (const field of opaque[t] ?? [])
          if (field in source) mapped[field] = source[field];
        if (t === 'tool_calls' && !internal) mapped.result = source.result;
        return mapped;
      }),
    ]),
  ) as Package['tables'];
}
async function plan(tx: DB, owner: string, p: Package) {
  await soleOwner(tx, owner);
  const instance = (
    await tx.query('SELECT server_instance_id FROM instance_metadata')
  ).rows[0].server_instance_id;
  const meta = await catalog(tx),
    mapped = translate(p, owner, instance),
    items: any[] = [];
  const origins = (
    await tx.query(
      'SELECT * FROM backup_origins WHERE owner_id=$1 AND source_instance=$2',
      [owner, p.source_instance],
    )
  ).rows;
  for (const t of tables)
    for (let i = 0; i < mapped[t].length; i++) {
      const row = mapped[t][i],
        source = p.tables[t][i],
        keys = meta[t]!.keys;
      const key = Object.fromEntries(keys.map((k) => [k, row[k]])),
        sourceKey = canonical(keys.map((k) => source[k]));
      const current = (
        await tx.query(
          'SELECT * FROM ' +
            quote(t) +
            ' WHERE ' +
            keys.map((k, n) => quote(k) + '=$' + (n + 1)).join(' AND '),
          keys.map((k) => row[k]),
        )
      ).rows[0];
      const currentHash = current ? digest(portable(t, current, false)) : null,
        wantedHash = digest(row);
      const origin = origins.find(
        (o) => o.table_name === t && o.source_key === sourceKey,
      );
      // Existing unowned identities cannot be overwritten, even when IDs collide.
      const state = !current
        ? 'insert'
        : currentHash === wantedHash
          ? 'unchanged'
          : origin && origin.baseline_hash === currentHash
            ? 'update'
            : 'conflict';
      items.push({
        table: t,
        key,
        source_key: sourceKey,
        state,
        current_hash: currentHash,
        wanted_hash: wantedHash,
        row,
      });
    }

  const deleted = (
    await tx.query(
      'SELECT entity_id,kind FROM privacy_deletions WHERE owner_id=$1',
      [owner],
    )
  ).rows;
  const erasedRuns = new Set<string>([
    ...(
      await tx.query(
        'SELECT DISTINCT run_id FROM messages WHERE id=ANY($1::uuid[])',
        [deleted.map((d) => d.entity_id)],
      )
    ).rows.map((r) => r.run_id),
    ...items
      .filter(
        (i) =>
          i.table === 'messages' &&
          deleted.some((d) => d.entity_id === i.row.id),
      )
      .map((i) => i.row.run_id),
  ]);
  for (const item of items) {
    if (
      (item.table === 'share_drafts' &&
        erasedRuns.has(item.row.run_id) &&
        (item.row.content || item.row.asset_ids.length)) ||
      (item.table === 'host_jobs' &&
        erasedRuns.has(item.row.relay_run_id) &&
        (Object.keys(item.row.payload).length || item.row.result))
    )
      fail(
        'backup_privacy_conflict',
        'Backup contains erased execution source copies',
      );
    if (
      item.table === 'host_snapshots' &&
      item.row.materials.some((m: any) =>
        deleted.some((d) => d.entity_id === m.id),
      )
    )
      fail('backup_privacy_conflict', 'Backup contains erased Host snapshot');
    if (
      item.table === 'memory_corrections' &&
      item.row.changes?.some((c: any) =>
        deleted.some((d) => d.entity_id === c.id),
      )
    )
      fail(
        'backup_privacy_conflict',
        'Backup contains erased correction content',
      );
    if (
      item.table === 'memory_materials' &&
      item.row.content &&
      item.row.source_snapshot?.some((s: any) =>
        deleted.some((d) => d.entity_id === s.id),
      )
    )
      fail('backup_privacy_conflict', 'Backup contains erased source material');
    if (
      item.table === 'voice_turns' &&
      item.row.transcript &&
      items.some(
        (m) =>
          m.table === 'messages' &&
          m.row.run_id === item.row.run_id &&
          deleted.some((d) => d.entity_id === m.row.id),
      )
    )
      fail(
        'backup_privacy_conflict',
        'Backup contains erased voice transcript',
      );
    const sourceId =
      item.table === 'message_versions' ? item.row.message_id : item.row.id;
    if (
      ['messages', 'message_versions', 'memories', 'memory_materials'].includes(
        item.table,
      ) &&
      item.row.content &&
      deleted.some((d) => d.entity_id === sourceId)
    )
      fail(
        'backup_privacy_conflict',
        'Backup contains previously erased content: ' + sourceId,
      );
  }
  const summary = items.map(({ row, ...item }) => item);
  return { items, summary, token: digest(summary) };
}
export async function previewRestore(
  db: pg.Pool,
  config: Config,
  owner: string,
  envelope: any,
  password: string,
) {
  const pack = await openBackup(db, envelope, password),
    fingerprint = digest(pack);
  return transaction(
    db,
    async (tx) => {
      await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
        owner,
      ]);
      await tx.query(
        "DELETE FROM restore_sessions WHERE owner_id=$1 AND created_at<now()-interval '24 hours'",
        [owner],
      );
      if (
        (
          await tx.query(
            'SELECT count(*)::int n FROM restore_sessions WHERE owner_id=$1 AND fingerprint<>$2',
            [owner, fingerprint],
          )
        ).rows[0].n >= 2
      )
        fail(
          'restore_session_limit',
          'Finish or wait for existing restore previews to expire (24 hours)',
        );
      await tx.query(
        'SELECT id FROM worlds WHERE owner_id=$1 ORDER BY id FOR UPDATE',
        [owner],
      );
      const p = await plan(tx, owner, pack);
      const stored = encrypt(
        JSON.stringify(pack),
        config,
        owner + ':backup:' + fingerprint,
      );
      const session = (
        await tx.query(
          'INSERT INTO restore_sessions(owner_id,fingerprint,package,preview) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,fingerprint) DO UPDATE SET preview=$4 RETURNING id,state,report',
          [
            owner,
            fingerprint,
            stored,
            JSON.stringify({ token: p.token, items: p.summary }),
          ],
        )
      ).rows[0];
      return {
        id: session.id,
        state: session.state,
        preview_token: p.token,
        items: p.summary,
        counts: Object.fromEntries(
          ['insert', 'update', 'unchanged', 'conflict'].map((s) => [
            s,
            p.items.filter((i) => i.state === s).length,
          ]),
        ),
        paused_on_restore: true,
        credential_policy: 'excluded',
        atomic_scope: 'complete_owner_graph',
      };
    },
    'ISOLATION LEVEL REPEATABLE READ',
  );
}
export async function restoreBackup(
  db: pg.Pool,
  config: Config,
  owner: string,
  id: string,
  token: string,
  skipConflicts = false,
) {
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      owner,
    ]);
    await tx.query(
      'LOCK TABLE ' +
        tables.map(quote).join(',') +
        ' IN SHARE ROW EXCLUSIVE MODE',
    );
    const session = (
      await tx.query(
        'SELECT * FROM restore_sessions WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [owner, id],
      )
    ).rows[0];
    if (!session)
      throw new AppError(404, 'not_found', 'Restore session not found');
    const pack = JSON.parse(
      decrypt(
        session.package,
        config,
        owner + ':backup:' + session.fingerprint,
      ),
    ) as Package;
    await validate(tx, pack);
    const p = await plan(tx, owner, pack);
    // Lost success responses return the durable receipt only if the graph is still unchanged.
    if (
      session.state === 'completed' &&
      p.items.every((i) => i.state === 'unchanged')
    )
      return session.report;
    // The complete relational graph is one bounded object. Any crash rolls it all back.
    if (
      (
        await tx.query(
          "SELECT 1 FROM runs WHERE owner_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending') UNION ALL SELECT 1 FROM tool_calls WHERE owner_id=$1 AND state IN ('executing','outcome_unknown') UNION ALL SELECT 1 FROM extension_install_jobs WHERE owner_id=$1 AND state IN ('prepared','submitted','unknown') UNION ALL SELECT 1 FROM host_jobs WHERE owner_id=$1 AND state IN ('accepted','executing','unknown') UNION ALL SELECT 1 FROM system_actions WHERE owner_id=$1 AND state IN ('executing','unknown') UNION ALL SELECT 1 FROM runtime_sessions WHERE owner_id=$1 AND status IN ('open','executing') AND expires_at>now() UNION ALL SELECT 1 FROM media_jobs WHERE owner_id=$1 AND state IN ('queued','submitting','polling','unknown','accepted','processing') LIMIT 1",
          [owner],
        )
      ).rowCount
    )
      fail(
        'restore_busy',
        'Finish or close active conversations, media submissions and app runtimes before restoring',
      );
    if (p.token !== token)
      fail('revision_conflict', 'Restore preview is stale');
    if (!skipConflicts && p.items.some((i) => i.state === 'conflict'))
      fail(
        'restore_conflict',
        'Local edits conflict; choose keep-local or cancel',
      );
    const meta = await catalog(tx);
    await tx.query('SET CONSTRAINTS ALL DEFERRED');
    await tx.query("SELECT set_config('echo.restore','on',true)");
    for (const item of p.items) {
      if (item.state === 'conflict') continue;
      const t = item.table as Table,
        row = item.row;
      if (['insert', 'update'].includes(item.state)) {
        // Device and Host identity records are restored revoked; no session credentials are included.
        // Preserve any current live credentials, never import or overwrite secrets.
        if (t === 'provider_connections' && item.state === 'update')
          row.credential = (
            await tx.query(
              'SELECT credential FROM provider_connections WHERE id=$1',
              [row.id],
            )
          ).rows[0].credential;
        if (t === 'mcp_connections' && item.state === 'update')
          row.credential = (
            await tx.query(
              'SELECT credential FROM mcp_connections WHERE id=$1',
              [row.id],
            )
          ).rows[0].credential;
        const cols = meta[t]!.columns,
          keys = meta[t]!.keys;
        const updates = cols.filter((c) => !keys.includes(c.column_name));
        const vals = cols.map((c) => {
          const v = row[c.column_name];
          return c.udt_name === 'bytea'
            ? Buffer.from(v.data)
            : ['json', 'jsonb'].includes(c.udt_name)
              ? JSON.stringify(v)
              : v;
        });
        await tx.query(
          'INSERT INTO ' +
            quote(t) +
            ' (' +
            cols.map((c) => quote(c.column_name)).join(',') +
            ') VALUES(' +
            vals.map((_, i) => '$' + (i + 1)).join(',') +
            ') ON CONFLICT(' +
            keys.map(quote).join(',') +
            ') ' +
            (updates.length
              ? 'DO UPDATE SET ' +
                updates
                  .map(
                    (c) =>
                      quote(c.column_name) +
                      '=EXCLUDED.' +
                      quote(c.column_name),
                  )
                  .join(',')
              : 'DO NOTHING'),
          vals,
        );
      }
      await tx.query(
        'INSERT INTO backup_origins(owner_id,source_instance,table_name,source_key,target_key,baseline_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,source_instance,table_name,source_key) DO UPDATE SET target_key=$5,baseline_hash=$6',
        [
          owner,
          pack.source_instance,
          t,
          item.source_key,
          JSON.stringify(item.key),
          item.wanted_hash,
        ],
      );
    }
    // Missing or malicious references fail before publishing the report.
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.query(
      'INSERT INTO world_leases(world_id) SELECT id FROM worlds WHERE owner_id=$1 ON CONFLICT DO NOTHING',
      [owner],
    );
    await tx.query(
      'DELETE FROM sync_snapshot_pages WHERE snapshot_id IN (SELECT id FROM sync_snapshots WHERE owner_id=$1)',
      [owner],
    );
    await tx.query('DELETE FROM sync_snapshots WHERE owner_id=$1', [owner]);
    await tx.query('DELETE FROM sync_events WHERE owner_id=$1', [owner]);
    await tx.query(
      'UPDATE sync_heads SET cursor=cursor+1,min_cursor=cursor+1 WHERE owner_id=$1',
      [owner],
    );
    const report = {
      id,
      completed: true,
      inserted: p.items.filter((i) => i.state === 'insert').length,
      updated: p.items.filter((i) => i.state === 'update').length,
      skipped: p.items
        .filter((i) => i.state === 'conflict')
        .map((i) => ({ table: i.table, key: i.key })),
      paused: true,
    };
    await tx.query(
      "UPDATE restore_sessions SET state='completed',report=$2 WHERE id=$1",
      [id, report],
    );
    return report;
  });
}
export async function dataHealth(db: pg.Pool, owner: string) {
  return transaction(
    db,
    async (tx) => {
      await soleOwner(tx, owner);
      const issues: any[] = [];
      for (const a of (
        await tx.query(
          'SELECT id,content,content_hash,size FROM assets WHERE owner_id=$1',
          [owner],
        )
      ).rows)
        if (a.content.length !== a.size || hash(a.content) !== a.content_hash)
          issues.push({ kind: 'asset_hash', id: a.id });
      for (const d of (
        await tx.query(
          'SELECT id,content,content_hash FROM documents WHERE owner_id=$1',
          [owner],
        )
      ).rows)
        if (hash(d.content) !== d.content_hash)
          issues.push({ kind: 'document_hash', id: d.id });
      for (const v of (
        await tx.query(
          'SELECT document_id,revision,content,content_hash FROM document_versions WHERE owner_id=$1',
          [owner],
        )
      ).rows)
        if (hash(v.content) !== v.content_hash)
          issues.push({
            kind: 'document_version_hash',
            id: v.document_id,
            revision: v.revision,
          });
      for (const m of (
        await tx.query(
          'SELECT id,content,content_hash FROM memory_materials WHERE owner_id=$1',
          [owner],
        )
      ).rows)
        if (hash(m.content) !== m.content_hash)
          issues.push({ kind: 'memory_material_hash', id: m.id });
      const size = (
        await tx.query(
          'SELECT COALESCE(sum(size),0)::text AS asset_bytes FROM assets WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
      return {
        healthy: !issues.length,
        issues,
        ...size,
        backup_limit_bytes: limit,
        automatic_cleanup: false,
      };
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
