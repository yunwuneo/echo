import { PushTicket } from './p5.js';
import {
  AutonomySettingsInput,
  AutonomyPolicyInput,
  McpConnectionInput,
  ToolGrantInput,
  ToolDecisionInput,
} from './p4.js';
import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false };
export const ID = Type.String({ format: 'uuid' });
export const Cursor = Type.String({
  pattern: '^(0|[1-9][0-9]*)$',
  maxLength: 20,
});
export const ErrorSchema = Type.Object(
  {
    error: Type.Object({ code: Type.String(), message: Type.String() }, strict),
  },
  strict,
);
export const Device = Type.Object(
  {
    id: ID,
    name: Type.String(),
    created_at: Type.String(),
    revoked_at: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export const Session = Type.Object(
  {
    access_token: Type.String(),
    refresh_token: Type.String(),
    expires_in: Type.Integer(),
    device_id: ID,
    owner_id: ID,
  },
  strict,
);
export const PairRequest = Type.Object(
  {
    code: Type.String({ minLength: 16, maxLength: 128 }),
    device_name: Type.String({ minLength: 1, maxLength: 80 }),
  },
  strict,
);
export const RefreshRequest = Type.Object(
  { refresh_token: Type.String({ minLength: 32, maxLength: 128 }) },
  strict,
);
export const ProviderRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    base_url: Type.String({ minLength: 8, maxLength: 2048 }),
    tools_enabled: Type.Optional(Type.Boolean()),
    api_key: Type.String({ minLength: 1, maxLength: 4096 }),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    context_window: Type.Integer({
      minimum: 2048,
      maximum: 1000000,
      default: 32768,
    }),
    max_output_tokens: Type.Integer({
      minimum: 1,
      maximum: 8192,
      default: 1024,
    }),
  },
  strict,
);
export const Provider = Type.Object(
  {
    id: ID,
    name: Type.String(),
    base_url: Type.String(),
    model: Type.String(),
    context_window: Type.Integer(),
    max_output_tokens: Type.Integer(),
    credential_present: Type.Boolean(),
    capabilities: Type.Object(
      {
        text: Type.Literal(true),
        streaming: Type.Literal(true),
        tools: Type.Boolean(),
        verification: Type.Literal('declared'),
      },
      strict,
    ),
  },
  strict,
);
export const MessageRequest = Type.Object(
  {
    client_command_id: ID,
    content: Type.String({ minLength: 1, maxLength: 16000 }),
    addressed_actor_ids: Type.Optional(
      Type.Array(ID, { maxItems: 8, uniqueItems: true }),
    ),
  },
  strict,
);
export type MessageInput = Static<typeof MessageRequest>;
export type ProviderInput = Static<typeof ProviderRequest>;
export const RunState = Type.Union(
  [
    'queued',
    'running',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ].map((s) => Type.Literal(s)),
);
export const Ack = Type.Object({ message_id: ID, run_id: ID }, strict);
export const Message = Type.Object(
  {
    id: ID,
    room_id: ID,
    run_id: ID,
    sequence: Cursor,
    actor_id: Type.Union([ID, Type.Null()]),
    actor_name: Type.Union([Type.String(), Type.Null()]),
    step_index: Type.Integer(),
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    content: Type.String(),
    status: Type.String(),
    created_at: Type.String(),
  },
  strict,
);
export const Run = Type.Object(
  {
    id: ID,
    world_id: ID,
    room_id: ID,
    state: RunState,
    attempts: Type.Integer(),
    error_code: Type.Union([Type.String(), Type.Null()]),
    created_at: Type.String(),
  },
  strict,
);
export const SyncEvent = Type.Object(
  { cursor: Cursor, kind: Type.String(), entity_id: ID, data: Type.Unknown() },
  strict,
);
const text = (maxLength = 16000) => Type.String({ maxLength });
const name = Type.String({ minLength: 1, maxLength: 80 });
export const Persona = Type.Object({ name, description: text() }, strict);
export const WorldInput = Type.Object(
  { name, description: text(), persona: Persona },
  strict,
);
export const World = Type.Composite(
  [WorldInput, Type.Object({ id: ID, revision: Type.Integer() })],
  strict,
);
export const CharacterData = Type.Object(
  {
    name,
    description: text(),
    personality: text(),
    voice: text(),
    scenario: text(),
    example: text(),
    greeting: text(),
    prompt_suggestions: Type.Optional(
      Type.Object(
        {
          system_prompt: text(),
          post_history_instructions: text(),
          enabled: Type.Boolean(),
        },
        strict,
      ),
    ),
    alternate_greetings: Type.Optional(Type.Array(text(), { maxItems: 50 })),
  },
  strict,
);
export const Character = Type.Composite(
  [CharacterData, Type.Object({ id: ID, revision: Type.Integer() })],
  strict,
);
export const ActorInput = Type.Object(
  {
    template_id: ID,
    template_revision: Type.Integer({ minimum: 1 }),
    name,
    participation: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  strict,
);
export const Actor = Type.Composite(
  [ActorInput, Type.Object({ id: ID, world_id: ID, revision: Type.Integer() })],
  strict,
);
export const RoomInput = Type.Object(
  {
    name,
    provider_id: ID,
    kind: Type.Union([Type.Literal('direct'), Type.Literal('group')]),
    actor_ids: Type.Array(ID, { minItems: 1, maxItems: 8, uniqueItems: true }),
    max_replies: Type.Integer({ minimum: 1, maximum: 3 }),
  },
  strict,
);
export const Room = Type.Object(
  {
    id: ID,
    world_id: ID,
    name,
    provider_id: ID,
    kind: Type.String(),
    actor_ids: Type.Array(ID),
    max_replies: Type.Integer(),
    revision: Type.Integer(),
  },
  strict,
);
export const LoreInput = Type.Object(
  {
    match_mode: Type.Optional(
      Type.Union([Type.Literal('keywords'), Type.Literal('regex')]),
    ),
    sticky_turns: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    cooldown_turns: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    delay_turns: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    name,
    content: text(),
    enabled: Type.Boolean(),
    constant: Type.Boolean(),
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
      maxItems: 32,
    }),
    case_sensitive: Type.Boolean(),
    scan_depth: Type.Integer({ minimum: 1, maximum: 50 }),
    priority: Type.Integer({ minimum: -1000, maximum: 1000 }),
    insertion_slot: Type.Union(
      [
        'before_character',
        'after_character',
        'before_history',
        'history_depth',
      ].map((x) => Type.Literal(x)),
    ),
    injection_depth: Type.Integer({ minimum: 0, maximum: 50 }),
    audience_actor_ids: Type.Array(ID, { maxItems: 8, uniqueItems: true }),
  },
  strict,
);
export const Lore = Type.Composite(
  [LoreInput, Type.Object({ id: ID, world_id: ID, revision: Type.Integer() })],
  strict,
);
export const StateData = Type.Object(
  {
    location: text(500),
    time: text(500),
    present_actor_ids: Type.Array(ID, { maxItems: 8, uniqueItems: true }),
    open_topics: Type.Array(text(500), { maxItems: 20 }),
  },
  strict,
);
export const StateInput = Type.Object(
  {
    data: StateData,
    audience_actor_ids: Type.Array(ID, { maxItems: 8, uniqueItems: true }),
  },
  strict,
);
export const WorldState = Type.Composite(
  [StateInput, Type.Object({ world_id: ID, revision: Type.Integer() })],
  strict,
);
export const WorldEvent = Type.Object(
  {
    id: ID,
    world_id: ID,
    run_id: Type.Union([ID, Type.Null()]),
    message_id: Type.Union([ID, Type.Null()]),
    kind: Type.String(),
    revision: Type.Integer(),
    data: Type.Unknown(),
    audience_actor_ids: Type.Array(ID),
    invalidated: Type.Boolean(),
    created_at: Type.String(),
  },
  strict,
);
export type WorldBody = Static<typeof WorldInput>;
export type CharacterBody = Static<typeof CharacterData>;
export type ActorBody = Static<typeof ActorInput>;
export type RoomBody = Static<typeof RoomInput>;
export type LoreBody = Static<typeof LoreInput>;
export type StateBody = Static<typeof StateInput>;
export const UsageEntry = Type.Object(
  {
    id: ID,
    run_id: ID,
    attempt: Type.Integer(),
    state: Type.Union([
      Type.Literal('reserved'),
      Type.Literal('known'),
      Type.Literal('unknown'),
    ]),
    input_tokens: Type.Union([Type.Integer(), Type.Null()]),
    output_tokens: Type.Union([Type.Integer(), Type.Null()]),
    estimated_input_tokens: Type.Integer(),
    reserved_output_tokens: Type.Integer(),
    error_code: Type.Union([Type.String(), Type.Null()]),
    created_at: Type.String(),
  },
  strict,
);
const pagination = Type.Object(
  {
    after: Type.Optional(Cursor),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
    ),
  },
  strict,
);
const errors = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  410: ErrorSchema,
  413: ErrorSchema,
  415: ErrorSchema,
  429: ErrorSchema,
  500: ErrorSchema,
  503: ErrorSchema,
};
const idParams = Type.Object({ id: ID }, strict);
const route = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  operationId: string,
  response: object,
  extras: object = {},
  auth = true,
) => ({
  method,
  url,
  schema: {
    operationId,
    security: auth ? [{ deviceBearer: [] }] : [],
    response: { ...errors, ...response },
    ...extras,
  },
});
const revisionHeader = Type.Object({
  'if-match': Type.String({ pattern: '^[1-9][0-9]{0,8}$' }),
});
const entityRoutes = <N extends string>(
  resource: N,
  schema: object,
  body: object,
) => ({
  [`create${resource}`]: route(
    'POST',
    `/v1/${resource}`,
    `create${resource}`,
    { 201: schema },
    { body },
  ),
  [`update${resource}`]: route(
    'PUT',
    `/v1/${resource}/:id`,
    `update${resource}`,
    { 200: schema },
    { params: idParams, headers: revisionHeader, body },
  ),
  [`delete${resource}`]: route(
    'DELETE',
    `/v1/${resource}/:id`,
    `delete${resource}`,
    { 204: Type.Null() },
    { params: idParams, headers: revisionHeader },
  ),
});
export const Memory = Type.Object(
  {
    id: ID,
    world_id: ID,
    revision: Type.Integer(),
    content: text(),
    topic: text(100),
    kind: Type.String(),
    status: Type.String(),
    manual: Type.Boolean(),
    pinned: Type.Boolean(),
    audience_actor_ids: Type.Array(ID),
    source_ids: Type.Array(ID),
    valid_from: Type.String(),
    valid_to: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export const MemoryEdit = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 2000 }),
    topic: Type.String({ minLength: 1, maxLength: 100 }),
    pinned: Type.Boolean(),
    audience_actor_ids: Type.Array(ID, { uniqueItems: true }),
    valid_to: Type.Optional(
      Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    ),
    supersedes_id: Type.Optional(ID),
  },
  strict,
);
export const MemorySettingsInput = Type.Object(
  {
    enabled: Type.Boolean(),
    embedding_provider_id: Type.Optional(Type.Union([ID, Type.Null()])),
    embedding_dimensions: Type.Integer({ minimum: 0, maximum: 4096 }),
  },
  strict,
);
export const MemorySettings = Type.Composite(
  [
    MemorySettingsInput,
    Type.Object({
      world_id: ID,
      revision: Type.Integer(),
      index_version: Type.Integer(),
    }),
  ],
  strict,
);
const ImportInput = Type.Object(
  {
    format: Type.Union([Type.Literal('json'), Type.Literal('png')]),
    data_base64: Type.String({ maxLength: 13981016 }),
    audience_actor_ids: Type.Array(ID, { maxItems: 8, uniqueItems: true }),
  },
  strict,
);
export const routes = {
  notificationStatus: route('GET', '/v1/notifications', 'notificationStatus', {
    200: Type.Unknown(),
  }),
  beginPushBinding: route(
    'POST',
    '/v1/notifications/binding',
    'beginPushBinding',
    { 200: Type.Unknown() },
  ),
  enablePush: route(
    'PUT',
    '/v1/notifications/binding',
    'enablePush',
    { 200: Type.Unknown() },
    { body: PushTicket },
  ),
  disablePush: route('DELETE', '/v1/notifications/binding', 'disablePush', {
    204: Type.Null(),
  }),
  resolvePush: route(
    'GET',
    '/v1/notifications/:id',
    'resolvePush',
    { 200: Type.Object({ room_id: ID, message_id: ID }, strict) },
    { params: idParams },
  ),
  exportData: route('POST', '/v1/exports', 'exportData', {
    200: Type.Unknown(),
  }),
  diagnostics: route('GET', '/v1/diagnostics', 'diagnostics', {
    200: Type.Unknown(),
  }),
  autonomySettings: route('GET', '/v1/autonomy', 'getAutonomySettings', {
    200: Type.Unknown(),
  }),
  saveAutonomySettings: route(
    'PUT',
    '/v1/autonomy',
    'saveAutonomySettings',
    { 200: Type.Unknown() },
    { headers: revisionHeader, body: AutonomySettingsInput },
  ),
  autonomyPolicy: route(
    'GET',
    '/v1/worlds/:id/autonomy',
    'getAutonomyPolicy',
    { 200: Type.Unknown() },
    { params: idParams },
  ),
  saveAutonomyPolicy: route(
    'PUT',
    '/v1/worlds/:id/autonomy',
    'saveAutonomyPolicy',
    { 200: Type.Unknown() },
    { params: idParams, headers: revisionHeader, body: AutonomyPolicyInput },
  ),
  recaps: route(
    'GET',
    '/v1/worlds/:id/recaps',
    'getRecaps',
    { 200: Type.Unknown() },
    {
      params: idParams,
      querystring: Type.Object(
        {
          after: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 2147483647 }),
          ),
        },
        strict,
      ),
    },
  ),
  readRecaps: route(
    'POST',
    '/v1/worlds/:id/recaps/read',
    'readRecaps',
    { 204: Type.Null() },
    {
      params: idParams,
      body: Type.Object(
        { revision: Type.Integer({ minimum: 0, maximum: 2147483647 }) },
        strict,
      ),
    },
  ),
  backgroundUsage: route('GET', '/v1/background-usage', 'getBackgroundUsage', {
    200: Type.Unknown(),
  }),
  mcpConnections: route('GET', '/v1/mcp/connections', 'listMcpConnections', {
    200: Type.Unknown(),
  }),
  createMcpConnection: route(
    'POST',
    '/v1/mcp/connections',
    'createMcpConnection',
    { 201: Type.Unknown() },
    { body: McpConnectionInput },
  ),
  updateMcpConnection: route(
    'PUT',
    '/v1/mcp/connections/:id',
    'updateMcpConnection',
    { 200: Type.Unknown() },
    { params: idParams, headers: revisionHeader, body: McpConnectionInput },
  ),
  discoverMcpTools: route(
    'POST',
    '/v1/mcp/connections/:id/discover',
    'discoverMcpTools',
    { 200: Type.Unknown() },
    { params: idParams },
  ),
  toolGrants: route('GET', '/v1/tool-grants', 'listToolGrants', {
    200: Type.Unknown(),
  }),
  createToolGrant: route(
    'POST',
    '/v1/tool-grants',
    'createToolGrant',
    { 201: Type.Unknown() },
    { body: ToolGrantInput },
  ),
  updateToolGrant: route(
    'PUT',
    '/v1/tool-grants/:id',
    'updateToolGrant',
    { 200: Type.Unknown() },
    { params: idParams, headers: revisionHeader, body: ToolGrantInput },
  ),
  revokeToolGrant: route(
    'DELETE',
    '/v1/tool-grants/:id',
    'revokeToolGrant',
    { 204: Type.Null() },
    { params: idParams },
  ),
  toolCalls: route('GET', '/v1/tool-calls', 'listToolCalls', {
    200: Type.Unknown(),
  }),
  approvals: route('GET', '/v1/approvals', 'listApprovals', {
    200: Type.Unknown(),
  }),
  decideTool: route(
    'POST',
    '/v1/approvals/:id/decision',
    'decideTool',
    { 200: Type.Unknown() },
    { params: idParams, body: ToolDecisionInput },
  ),
  memorySettings: route(
    'PUT',
    '/v1/worlds/:id/memory-settings',
    'saveMemorySettings',
    { 200: MemorySettings },
    { params: idParams, headers: revisionHeader, body: MemorySettingsInput },
  ),
  memoryStatus: route(
    'GET',
    '/v1/worlds/:id/memory-status',
    'memoryStatus',
    { 200: Type.Unknown() },
    { params: idParams },
  ),
  memoryRetry: route(
    'POST',
    '/v1/worlds/:id/memory-retry',
    'retryMemory',
    { 204: Type.Null() },
    { params: idParams },
  ),
  memories: route(
    'GET',
    '/v1/worlds/:id/memories',
    'listMemories',
    { 200: Type.Object({ items: Type.Array(Memory) }, strict) },
    { params: idParams },
  ),
  memoryRevisions: route(
    'GET',
    '/v1/memories/:id/revisions',
    'memoryRevisions',
    { 200: Type.Unknown() },
    { params: idParams },
  ),
  memoryUpdate: route(
    'PUT',
    '/v1/memories/:id',
    'updateMemory',
    { 200: Memory },
    { params: idParams, headers: revisionHeader, body: MemoryEdit },
  ),
  memoryDelete: route(
    'DELETE',
    '/v1/memories/:id',
    'deleteMemory',
    { 204: Type.Null() },
    { params: idParams, headers: revisionHeader },
  ),
  messageDelete: route(
    'DELETE',
    '/v1/messages/:id',
    'deleteMessage',
    { 204: Type.Null() },
    { params: idParams },
  ),
  importPreview: route(
    'POST',
    '/v1/worlds/:id/imports/preview',
    'previewImport',
    { 200: Type.Unknown() },
    { params: idParams, body: ImportInput },
  ),
  importCommit: route(
    'POST',
    '/v1/imports/:id/commit',
    'commitImport',
    { 200: Type.Unknown() },
    {
      params: idParams,
      body: Type.Object(
        {
          strategy: Type.Union([Type.Literal('skip'), Type.Literal('copy')]),
          enable_prompt_suggestions: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    },
  ),
  importExport: route(
    'GET',
    '/v1/imports/:id/original',
    'exportImport',
    {
      200: Type.Object(
        {
          format: Type.String(),
          file_hash: Type.String(),
          data_base64: Type.String(),
        },
        strict,
      ),
    },
    { params: idParams },
  ),

  ...entityRoutes('worlds', World, WorldInput),
  ...entityRoutes('characters', Character, CharacterData),
  ...entityRoutes(
    'actors',
    Actor,
    Type.Composite([ActorInput, Type.Object({ world_id: ID })], strict),
  ),
  ...entityRoutes(
    'rooms',
    Room,
    Type.Composite([RoomInput, Type.Object({ world_id: ID })], strict),
  ),
  ...entityRoutes(
    'lore',
    Lore,
    Type.Composite([LoreInput, Type.Object({ world_id: ID })], strict),
  ),
  state: route(
    'PUT',
    '/v1/worlds/:id/state',
    'correctWorldState',
    { 200: WorldState },
    { params: idParams, headers: revisionHeader, body: StateInput },
  ),
  manifests: route(
    'GET',
    '/v1/runs/:id/manifests',
    'promptManifests',
    { 200: Type.Object({ items: Type.Array(Type.Unknown()) }, strict) },
    { params: idParams },
  ),
  regenerate: route(
    'POST',
    '/v1/runs/:id/regenerate',
    'regenerateRun',
    { 202: Ack },
    { params: idParams, body: Type.Object({ client_command_id: ID }, strict) },
  ),
  health: route(
    'GET',
    '/health',
    'health',
    { 200: Type.Object({ status: Type.Literal('ok') }, strict) },
    {},
    false,
  ),
  capabilities: route(
    'GET',
    '/v1/capabilities',
    'capabilities',
    {
      200: Type.Object(
        {
          protocol_version: Type.Literal(1),
          server_instance_id: ID,
          data_epoch: ID,
          owner_id: Type.Union([ID, Type.Null()]),
          features: Type.Array(Type.String()),
        },
        strict,
      ),
    },
    {},
    false,
  ),
  pair: route(
    'POST',
    '/v1/pairing',
    'pair',
    { 201: Session },
    { body: PairRequest },
    false,
  ),
  pairingCode: route('POST', '/v1/pairing/codes', 'createPairingCode', {
    201: Type.Object(
      { code: Type.String(), expires_in: Type.Integer() },
      strict,
    ),
  }),
  refresh: route(
    'POST',
    '/v1/sessions/refresh',
    'refreshSession',
    { 200: Session },
    { body: RefreshRequest },
    false,
  ),
  devices: route('GET', '/v1/devices', 'listDevices', {
    200: Type.Object({ items: Type.Array(Device) }, strict),
  }),
  revoke: route(
    'DELETE',
    '/v1/devices/:id',
    'revokeDevice',
    { 204: Type.Null() },
    { params: idParams },
  ),
  providers: route('GET', '/v1/providers', 'listProviders', {
    200: Type.Object({ items: Type.Array(Provider) }, strict),
  }),
  createProvider: route(
    'POST',
    '/v1/providers',
    'createProvider',
    { 201: Provider },
    { body: ProviderRequest },
  ),
  messages: route(
    'GET',
    '/v1/rooms/:id/messages',
    'listMessages',
    {
      200: Type.Object(
        { items: Type.Array(Message), next_cursor: Cursor },
        strict,
      ),
    },
    { params: idParams, querystring: pagination },
  ),
  send: route(
    'POST',
    '/v1/rooms/:id/messages',
    'sendMessage',
    { 202: Ack },
    { params: idParams, body: MessageRequest },
  ),
  run: route(
    'GET',
    '/v1/runs/:id',
    'getRun',
    { 200: Run },
    { params: idParams },
  ),
  cancel: route(
    'POST',
    '/v1/runs/:id/cancel',
    'cancelRun',
    { 200: Run },
    { params: idParams },
  ),
  sync: route(
    'GET',
    '/v1/sync',
    'sync',
    {
      200: Type.Object(
        {
          items: Type.Array(SyncEvent),
          next_cursor: Cursor,
          has_more: Type.Boolean(),
        },
        strict,
      ),
    },
    {
      querystring: Type.Object(
        {
          cursor: Cursor,
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
          ),
        },
        strict,
      ),
    },
  ),
  beginSnapshot: route('POST', '/v1/sync/snapshots', 'beginSnapshot', {
    201: Type.Object(
      {
        snapshot_id: ID,
        server_instance_id: ID,
        data_epoch: ID,
        owner_id: ID,
        high_water_cursor: Cursor,
        expires_in: Type.Integer(),
      },
      strict,
    ),
  }),
  snapshotPage: route(
    'GET',
    '/v1/sync/snapshots/:id',
    'snapshotPage',
    {
      200: Type.Object(
        {
          items: Type.Array(
            Type.Object(
              { kind: Type.String(), entity_id: ID, data: Type.Unknown() },
              strict,
            ),
          ),
          next_cursor: Cursor,
          has_more: Type.Boolean(),
        },
        strict,
      ),
    },
    {
      params: idParams,
      querystring: Type.Object(
        {
          after: Cursor,
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 500, default: 200 }),
          ),
        },
        strict,
      ),
    },
  ),
  snapshot: route('GET', '/v1/sync/snapshot', 'snapshot', {
    200: Type.Object(
      {
        server_instance_id: ID,
        data_epoch: ID,
        owner_id: ID,
        high_water_cursor: Cursor,
        worlds: Type.Array(World),
        rooms: Type.Array(Room),
        messages: Type.Array(Message),
        runs: Type.Array(Run),
        characters: Type.Array(Character),
        actors: Type.Array(Actor),
        lore: Type.Array(Lore),
        states: Type.Array(WorldState),
        world_events: Type.Array(WorldEvent),
        memories: Type.Array(Memory),
        memory_settings: Type.Array(MemorySettings),
        autonomy_settings: Type.Array(Type.Unknown()),
        autonomy_policies: Type.Array(Type.Unknown()),
        mcp_connections: Type.Array(Type.Unknown()),
        tool_grants: Type.Array(Type.Unknown()),
        tool_calls: Type.Array(Type.Unknown()),
      },
      strict,
    ),
  }),
  events: route(
    'GET',
    '/v1/events',
    'events',
    {
      200: {
        description:
          'Durable sync cursor IDs. Reconnect using cursor or Last-Event-ID.',
        content: { 'text/event-stream': { schema: Type.String() } },
      },
    },
    { querystring: Type.Object({ cursor: Type.Optional(Cursor) }, strict) },
  ),
  usage: route('GET', '/v1/usage', 'usage', {
    200: Type.Object({ items: Type.Array(UsageEntry) }, strict),
  }),
};
