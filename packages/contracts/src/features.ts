import { Type } from '@sinclair/typebox';
import { continuationActions, hostActions } from './continuation.js';
const strict = { additionalProperties: false };
export const ID = Type.String({ format: 'uuid' });
export const text = (maxLength = 16000) => Type.String({ maxLength });
export const choice = (values: string[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
export const feature = (command: string, properties: Record<string, any>) =>
  Type.Object(
    {
      action: Type.Literal('feature'),
      command: Type.Literal(command),
      operation_id: ID,
      expected_revision: Type.Integer({ minimum: 0 }),
      payload: Type.Object(properties, strict),
    },
    strict,
  );
const actor = { actor_id: ID };
export const featureActions = [
  ...continuationActions,
  ...hostActions,
  feature('appLibrary', {}),
  ...['saveMiniApp', 'importMiniApp'].map((c) =>
    feature(c, {
      actor_id: ID,
      id: Type.Optional(ID),
      title: text(200),
      language: choice(['html', 'python']),
      source: text(1048576),
      resources: Type.Record(Type.String(), text(1048576)),
    }),
  ),
  feature('setAppPermissions', {
    id: ID,
    run_enabled: Type.Boolean(),
    persistence: Type.Boolean(),
    ai_state: choice(['none', 'read', 'write']),
  }),
  feature('openRuntime', { id: ID, principal: choice(['owner', 'ai']) }),
  feature('grantSessionNetwork', {
    session_id: ID,
    origins: Type.Array(text(300), { maxItems: 20 }),
  }),
  feature('runtimeRequest', { session_id: ID, url: text(2000) }),
  feature('commitRuntimeState', {
    session_id: ID,
    state: Type.Record(Type.String(), Type.Unknown()),
  }),
  feature('closeRuntime', { session_id: ID }),
  feature('runPython', { session_id: ID, input: Type.Unknown() }),
  feature('exportMiniApp', { id: ID }),
  feature('previewResetState', { id: ID }),
  feature('resetRuntimeState', { id: ID, preview_token: text(64) }),
  feature('groupPolicy', { room_id: ID }),
  feature('saveGroupPolicy', {
    room_id: ID,
    instruction: text(),
    mcp_ids: Type.Array(ID, { maxItems: 100, uniqueItems: true }),
    memory_enabled: Type.Boolean(),
    image_provider_id: Type.Optional(ID),
    reply_policy: choice(['turns', 'random', 'silence']),
  }),
  feature('setGroupMember', {
    room_id: ID,
    actor_id: ID,
    tools_enabled: Type.Boolean(),
    memory_enabled: Type.Boolean(),
    instruction: text(),
  }),
  feature('sendPrivateLane', {
    room_id: ID,
    actor_id: ID,
    content: Type.String({ minLength: 1, maxLength: 16000 }),
  }),
  feature('previewDisband', { room_id: ID }),
  feature('disbandGroup', { room_id: ID, preview_token: text(64) }),
  feature('voiceLibrary', {}),
  feature('startVoice', {
    room_id: ID,
    actor_id: ID,
    invite_id: Type.Optional(ID),
    settings: Type.Object(
      {
        greeting: Type.Boolean(),
        muted: Type.Boolean(),
        quiet_ms: Type.Integer({ minimum: 500, maximum: 10000 }),
        custom_stt: Type.Boolean(),
        fallback: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  }),
  feature('inviteVoice', { room_id: ID, actor_id: ID }),
  feature('closeVoice', { session_id: ID }),
  feature('voiceDraft', { session_id: ID, turn_id: ID, text: text() }),
  feature('acceptTranscription', { session_id: ID, turn_id: ID, job_id: ID }),
  feature('finalizeVoice', { session_id: ID, turn_id: ID }),
  feature('voicePlayback', {
    session_id: ID,
    turn_id: ID,
    job_id: ID,
    played_ms: Type.Integer({ minimum: 0, maximum: 3600000 }),
  }),
  feature('savePlayedAudio', { session_id: ID, turn_id: ID }),
  feature('mediaLibrary', {}),
  feature('mediaConfig', {
    id: ID,
    options: Type.Object(
      {
        image: Type.Optional(
          Type.Object({ size: text(30) }, { additionalProperties: false }),
        ),
        video: Type.Optional(
          Type.Object(
            {
              seconds: choice(['4', '8', '12']),
              size: choice(['720x1280', '1280x720', '1024x1792', '1792x1024']),
            },
            { additionalProperties: false },
          ),
        ),
        tts: Type.Optional(
          Type.Object({ voice: text(80) }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
  }),
  feature('createMediaJob', {
    actor_id: ID,
    kind: choice(['image', 'edit', 'video', 'vision', 'stt', 'tts']),
    room_id: Type.Optional(ID),
    prompt: text(4000),
    asset_id: Type.Optional(ID),
    voice: Type.Optional(text(80)),
  }),
  feature('refreshMediaJob', { id: ID }),
  feature('reconcileMediaJob', {
    id: ID,
    external_id: Type.String({ minLength: 1, maxLength: 200 }),
  }),
  feature('prepareImage', {
    id: ID,
    actor_id: ID,
    mode: choice(['original', 'text', 'both', 'metadata']),
    vision_job_id: Type.Optional(ID),
  }),
  feature('extensionLibrary', {}),
  feature('prepareRemoteInstall', { id: ID, target: text(200) }),
  feature('cancelRemoteInstall', { id: ID }),
  ...['previewConnectionImport', 'applyConnectionImport'].map((c) =>
    feature(c, {
      connections: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
        maxItems: 100,
      }),
      ...(c === 'applyConnectionImport' ? { preview_token: text(64) } : {}),
    }),
  ),
  ...['previewExtension', 'installExtension'].map((c) =>
    feature(c, {
      manifest: Type.Record(Type.String(), Type.Unknown()),
      resources: Type.Record(Type.String(), text(1048576)),
      connection_ids: Type.Array(ID, { maxItems: 100 }),
      new_connections: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          maxItems: 20,
        }),
      ),
      ...(c === 'installExtension' ? { preview_token: text(64) } : {}),
    }),
  ),
  feature('previewUninstall', { id: ID }),
  feature('uninstallExtension', { id: ID, preview_token: text(64) }),
  feature('setSkillMode', {
    id: ID,
    actor_id: ID,
    mode: choice(['off', 'manual', 'candidate', 'auto']),
  }),
  feature('sendWithSkill', {
    id: ID,
    actor_id: ID,
    room_id: ID,
    content: Type.String({ minLength: 1, maxLength: 16000 }),
  }),
  feature('createAppFromExtension', { id: ID, actor_id: ID }),
  feature('useSkill', { id: ID, actor_id: ID, run_id: ID }),
  feature('bookLibrary', { world_id: ID }),
  feature('createBook', { world_id: ID, name: text(200) }),
  feature('saveBookEntry', {
    world_id: ID,
    book_id: ID,
    id: Type.Optional(ID),
    data: Type.Record(Type.String(), Type.Unknown()),
  }),
  feature('bindBook', {
    world_id: ID,
    book_id: ID,
    scope: choice(['global', 'actor', 'room', 'group_member']),
    target_id: ID,
    actor_id: Type.Optional(ID),
    enabled: Type.Boolean(),
  }),
  feature('memoryLibrary', actor),
  feature('setMemoryPolicy', {
    ...actor,
    mode: choice(['diary', 'structured']),
    recall: choice(['light', 'standard', 'deep']),
    vector_scope: choice(['user', 'both']),
    interval_seconds: Type.Integer({ minimum: 60, maximum: 86400 }),
  }),
  feature('setMemoryParticipation', {
    ...actor,
    room_id: ID,
    enabled: Type.Boolean(),
  }),
  feature('saveMaterial', {
    ...actor,
    id: Type.Optional(ID),
    kind: choice(['fact', 'profile', 'diary', 'structured', 'info', 'event']),
    title: text(200),
    content: Type.String({ minLength: 1, maxLength: 16000 }),
    summary: text(1000),
  }),
  feature('organizeMemory', { ...actor, room_id: ID }),
  feature('memoryFeedback', {
    ...actor,
    id: ID,
    feedback: choice(['normal', 'less', 'outdated']),
  }),
  feature('previewMemoryCorrection', {
    ...actor,
    changes: Type.Array(
      Type.Object(
        { id: ID, content: Type.String({ minLength: 1, maxLength: 16000 }) },
        strict,
      ),
      { minItems: 1, maxItems: 50 },
    ),
  }),
  feature('applyMemoryCorrection', { ...actor, id: ID }),
  feature('undoMemoryCorrection', { ...actor, id: ID }),
  feature('sourceIndexShard', { ...actor, id: ID, skip: Type.Boolean() }),
  feature('indexShard', { ...actor, id: ID, skip: Type.Boolean() }),
];
