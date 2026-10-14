import { featureActions } from './features.js';
import { Type } from '@sinclair/typebox';
const strict = { additionalProperties: false };
export const MID = Type.String({ format: 'uuid' });
const op = { operation_id: MID };
const revision = { expected_revision: Type.Integer({ minimum: 0 }) };
const context = {
  ...op,
  ...revision,
  context_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
};
const resource = Type.Union(
  ['worlds', 'characters', 'actors', 'rooms', 'lore'].map((v) =>
    Type.Literal(v),
  ),
);
export const Behavior = Type.Object(
  {
    history_mode: Type.Union(
      ['all', 'recent', 'tokens', 'start'].map((v) => Type.Literal(v)),
    ),
    history_count: Type.Integer({ minimum: 1, maximum: 1000 }),
    history_tokens: Type.Integer({ minimum: 1, maximum: 100000 }),
    image_history: Type.Union(
      ['current', 'recent_two', 'all'].map((v) => Type.Literal(v)),
    ),
    start_message_id: Type.Union([MID, Type.Null()]),
  },
  strict,
);
export const action = (name: string, properties: Record<string, any>) =>
  Type.Object({ action: Type.Literal(name), ...properties }, strict);
export const Parameters = Type.Object(
  {
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    top_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    presence_penalty: Type.Optional(Type.Number({ minimum: -2, maximum: 2 })),
    frequency_penalty: Type.Optional(Type.Number({ minimum: -2, maximum: 2 })),
    seed: Type.Optional(Type.Integer()),
    stop: Type.Optional(
      Type.Array(Type.String({ maxLength: 100 }), { maxItems: 4 }),
    ),
  },
  strict,
);
const PresetData = Type.Object(
  {
    extensions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    parameters: Parameters,
    entries: Type.Array(
      Type.Object(
        {
          enabled: Type.Boolean(),
          role: Type.Union(
            ['system', 'user', 'assistant'].map((v) => Type.Literal(v)),
          ),
          content: Type.String({ maxLength: 16000 }),
          position: Type.Union(
            [
              'before_character',
              'before_history',
              'after_history',
              'history_depth',
            ].map((v) => Type.Literal(v)),
          ),
          depth: Type.Integer({ minimum: 0, maximum: 1000 }),
        },
        strict,
      ),
      { maxItems: 32 },
    ),
  },
  strict,
);
const Variable = Type.Object(
  {
    name: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }),
    url: Type.String({ maxLength: 2048 }),
    method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
    body: Type.Optional(Type.String({ maxLength: 64000 })),
    credential_ref: Type.Optional(MID),
    required: Type.Boolean(),
    json_path: Type.String({ maxLength: 200 }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 10, maximum: 10000 })),
  },
  strict,
);
const ProfileData = Type.Object(
  {
    time_recap: Type.Optional(Type.Boolean()),
    parameters: Type.Optional(Parameters),
    body: Type.Optional(Parameters),
    preset_ids: Type.Optional(
      Type.Array(MID, { maxItems: 8, uniqueItems: true }),
    ),
    variables: Type.Optional(Type.Array(Variable, { maxItems: 16 })),
    instructions: Type.Optional(Type.String({ maxLength: 16000 })),
  },
  strict,
);
export const milestoneActions = [
  action('exportBackup', {
    password: Type.String({ minLength: 12, maxLength: 256 }),
  }),
  action('previewRestore', {
    password: Type.String({ maxLength: 256 }),
    archive: Type.Unknown(),
  }),
  action('restoreBackup', {
    id: MID,
    preview_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    keep_local: Type.Boolean(),
  }),
  action('dataHealth', {}),

  action('contentLibrary', {}),
  action('createProject', {
    ...op,
    world_id: MID,
    actor_id: Type.Optional(MID),
    name: Type.String({ minLength: 1, maxLength: 80 }),
  }),
  action('documentDetails', { id: MID }),
  action('saveDocument', {
    ...op,
    id: Type.Optional(MID),
    project_id: MID,
    expected_revision: Type.Integer({ minimum: 0 }),
    base_hash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Union([Type.Literal('artifact'), Type.Literal('reference')]),
    content: Type.String({ maxLength: 262144 }),
    asset_ids: Type.Optional(
      Type.Array(MID, { maxItems: 32, uniqueItems: true }),
    ),
    restore_revision: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  action('enableInternalTools', { ...op }),

  action('promptLibrary', {}),
  action('savePreset', {
    ...op,
    ...revision,
    id: Type.Optional(MID),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    data: PresetData,
  }),
  action('clonePreset', {
    ...op,
    id: MID,
    name: Type.String({ minLength: 1, maxLength: 80 }),
  }),
  action('saveProfile', {
    ...op,
    ...revision,
    subject_id: MID,
    data: ProfileData,
  }),
  action('requestSnapshots', { id: MID }),
  action('recapHistory', { id: MID }),

  action('deletionPreview', { id: MID, resource }),
  action('deleteEntity', { id: MID, resource, ...context }),
  action('probeProvider', {
    id: MID,
    ...op,
    ...revision,
    confirm_billable: Type.Boolean(),
  }),
  action('providerProbes', { id: MID }),
  action('saveBehavior', {
    id: Type.Union([MID, Type.Null()]),
    ...op,
    ...revision,
    behavior: Behavior,
  }),
  action('behaviorDefaults', {}),
  action('regenerateMessage', {
    id: MID,
    ...context,
    mode: Type.Union([Type.Literal('keep'), Type.Literal('truncate')]),
  }),
  action('deleteVersion', { id: MID, ...op, ...revision, version_id: MID }),
];
export const MilestoneInput = Type.Union([
  ...milestoneActions,
  ...featureActions,
]);
