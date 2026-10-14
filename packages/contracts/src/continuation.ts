import { Type } from '@sinclair/typebox';
const ID = Type.String({ format: 'uuid' }),
  S = (n = 200) => Type.String({ maxLength: n }),
  B = Type.Boolean(),
  J = Type.Record(Type.String(), Type.Unknown());
const E = (xs: string[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const c = (name: string, p: Record<string, any>) =>
  Type.Object(
    {
      action: Type.Literal('feature'),
      command: Type.Literal(name),
      operation_id: ID,
      expected_revision: Type.Integer({ minimum: 0 }),
      payload: Type.Object(p, { additionalProperties: false }),
    },
    { additionalProperties: false },
  );
const actor = { actor_id: ID };
const selections = Type.Array(
  Type.Object(
    { kind: E(['provider', 'mcp']), id: ID },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 100, uniqueItems: true },
);
export const storageActions = [
  c('exportSelectedCredentials', {
    selections,
    password: Type.String({ minLength: 12, maxLength: 256 }),
  }),
  c('previewSelectedCredentials', {
    archive: J,
    password: Type.String({ minLength: 12, maxLength: 256 }),
  }),
  c('importSelectedCredentials', { id: ID, preview_token: S(64), selections }),
  c('externalStorageLibrary', {}),
  c('saveBackupPlan', {
    keep_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    id: Type.Optional(ID),
    link_id: ID,
    root: S(80),
    cadence: E(['daily', 'weekly']),
    enabled: B,
    password: Type.String({ minLength: 12, maxLength: 256 }),
  }),
  c('runRemoteBackup', { id: ID }),
  c('pauseBackupPlan', { id: ID }),
  c('bindExternalDocument', {
    document_id: ID,
    link_id: ID,
    root: S(80),
    path: S(500),
  }),
  c('refreshExternalDocument', { id: ID }),
  c('writeExternalDocument', { id: ID }),
  c('reconcileExternalDocument', { id: ID }),
];
export const continuationActions = [
  ...storageActions,
  c('storageDiagnostics', {}),
  c('previewDiagnosticCleanup', {
    retention_days: Type.Integer({ minimum: 1, maximum: 3650 }),
  }),
  c('applyDiagnosticCleanup', {
    retention_days: Type.Integer({ minimum: 1, maximum: 3650 }),
    preview_token: S(64),
  }),
  c('receiveHostConversation', {
    room_id: ID,
    content: S(16000),
    budget: Type.Object(
      {
        max_output_tokens: Type.Integer({ minimum: 1, maximum: 8192 }),
        tool_limit: Type.Integer({ minimum: 0, maximum: 5 }),
      },
      { additionalProperties: false },
    ),
  }),
  c('hostConversationResult', { operation_id: ID }),
  c('triggerSecret', { id: ID }),
  c('platformLibrary', {}),
  c('todaySummary', {}),
  c('collaboratorContent', actor),
  c('reportCapability', {
    capability: S(40),
    state: E([
      'authorized',
      'limited',
      'denied',
      'not_determined',
      'unavailable',
    ]),
    detail: J,
  }),
  c('reportTodaySource', {
    source: E([
      'date',
      'calendar',
      'reminders',
      'health',
      'weather',
      'location',
      'battery',
    ]),
    state: E(['loading', 'available', 'empty', 'denied', 'stale', 'failed']),
    data: Type.Unknown(),
    detail: S(200),
  }),
  c('setSystemPolicy', { ...actor, device_id: ID, action: S(80), enabled: B }),
  c('createSystemAction', {
    ...actor,
    device_id: ID,
    action: S(80),
    arguments: J,
  }),
  c('decideSystemAction', { id: ID, approve: B }),
  c('claimSystemAction', { id: ID }),
  c('reconcileSystemAction', {
    id: ID,
    state: E(['completed', 'failed']),
    external_id: Type.Optional(S(500)),
    evidence: Type.String({ minLength: 1, maxLength: 4000 }),
    confirmed: Type.Literal(true),
  }),
  c('completeSystemAction', {
    id: ID,
    state: E(['completed', 'denied', 'unknown', 'failed']),
    external_id: Type.Optional(S(500)),
    result: Type.Unknown(),
  }),
  c('receiveShareDraft', {
    ...actor,
    room_id: ID,
    content: S(16000),
    asset_ids: Type.Array(ID, { maxItems: 8, uniqueItems: true }),
  }),
  c('sendShareDraft', { id: ID }),
  c('scheduleLibrary', {}),
  c('saveSchedule', {
    id: Type.Optional(ID),
    ...actor,
    room_id: Type.Optional(ID),
    name: S(200),
    prompt: S(16000),
    rule: E(['once', 'daily', 'interval']),
    timezone: S(80),
    at: S(40),
    interval_seconds: Type.Integer({ minimum: 60, maximum: 31536000 }),
    enabled: B,
    catch_up: E(['latest', 'skip']),
    executor: E(['cloud', 'device', 'host']),
    device_id: Type.Optional(ID),
    host_id: Type.Optional(ID),
    tool_limit: Type.Integer({ minimum: 0, maximum: 5 }),
  }),
  c('reportScheduleNotification', {
    id: ID,
    state: E(['scheduled', 'denied', 'failed', 'removed']),
    notification_id: Type.Optional(S(100)),
  }),
  c('pauseSchedule', { id: ID }),
  c('runOccurrence', { id: ID, slot: S(80), allow_missed: B }),
  c('registerTrigger', {
    ...actor,
    room_id: ID,
    name: S(200),
    mode: E(['background', 'user', 'trusted_assistant']),
    service: S(200),
    node_id: S(100),
    enabled: B,
  }),
  c('revokeTrigger', { id: ID }),
  c('registrationReceipt', {
    id: ID,
    state: E(['active', 'failed', 'revoked', 'revoke_pending']),
    external_id: Type.Optional(S(300)),
  }),
];
export const hostActions = [
  c('hostLibrary', {}),
  c('createHostPairing', {}),
  c('setHostGrants', {
    id: ID,
    grants: Type.Object(
      {
        actions: Type.Array(
          E([
            'chat',
            'file_read',
            'file_write',
            'file_list',
            'plugin',
            'backup_put',
            'backup_list',
            'backup_delete',
            'mcp',
          ]),
          { maxItems: 9, uniqueItems: true },
        ),
        roots: Type.Array(S(80), { maxItems: 20, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
  }),
  c('revokeHost', { id: ID }),
  c('linkHostIdentity', {
    host_id: ID,
    ...actor,
    remote_identity: S(200),
    enabled: B,
  }),
  c('publishHostSnapshot', {
    link_id: ID,
    material_ids: Type.Array(ID, { maxItems: 100, uniqueItems: true }),
  }),
  c('setReplyRelay', { link_id: Type.Optional(ID), enabled: B }),
  c('submitHostJob', {
    link_id: ID,
    kind: E([
      'chat',
      'file_read',
      'file_write',
      'file_list',
      'plugin',
      'backup_put',
      'backup_list',
      'backup_delete',
      'mcp',
    ]),
    scope: J,
    payload: J,
    budget: Type.Object(
      {
        max_output_tokens: Type.Integer({ minimum: 1, maximum: 8192 }),
        tool_limit: Type.Integer({ minimum: 0, maximum: 5 }),
      },
      { additionalProperties: false },
    ),
  }),
  c('cancelHostJob', { id: ID }),
  c('reconcileHostJob', {
    id: ID,
    state: E(['completed', 'failed']),
    result: J,
    evidence: Type.String({ minLength: 1, maxLength: 4000 }),
    confirmed: Type.Literal(true),
  }),
  c('configureHostPlugin', {
    id: Type.Optional(ID),
    host_id: ID,
    install_id: ID,
    network: Type.Array(S(300), { maxItems: 20, uniqueItems: true }),
    directories: Type.Array(S(80), { maxItems: 20, uniqueItems: true }),
    budget: J,
    enabled: B,
  }),
  c('beginHandoff', {
    schedule_id: ID,
    executor: E(['cloud', 'host']),
    host_id: Type.Optional(ID),
  }),
  c('confirmHandoff', { schedule_id: ID, enabled: B }),
];
export const HostPairBody = Type.Object(
  {
    protocolVersion: Type.Optional(Type.Literal(1)),
    pairing_id: ID,
    code: S(128),
    name: S(100),
    public_key: S(1000),
    proof: S(200),
  },
  { additionalProperties: false },
);
export const HostRPCBody = Type.Object(
  {
    protocolVersion: Type.Literal(1),
    host_id: ID,
    timestamp: Type.Number(),
    action: E([
      'poll',
      'accept',
      'begin',
      'query',
      'receipt',
      'lease',
      'ackRevoke',
    ]),
    payload: J,
  },
  { additionalProperties: false },
);
export const EventBody = Type.Object(
  {
    event_id: S(200),
    timestamp: Type.Number(),
    service: S(200),
    node_id: S(100),
    content: S(16000),
  },
  { additionalProperties: false },
);
