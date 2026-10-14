import { Type, type Static } from '@sinclair/typebox';
const strict = { additionalProperties: false };
const ID = Type.String({ format: 'uuid' });
const operation_id = ID;
const expected_revision = Type.Integer({ minimum: 0 });
export const BranchInput = Type.Object(
  {
    operation_id,
    expected_revision,
    context_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
  },
  strict,
);
export const AssetInput = Type.Object(
  {
    operation_id,
    world_id: ID,
    actor_id: Type.Optional(ID),
    mime: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$',
    }),
    content_base64: Type.String({ minLength: 4, maxLength: 1398104 }),
  },
  strict,
);
export const AssetReferenceInput = Type.Object(
  {
    operation_id,
    expected_revision,
    message_id: ID,
    purpose: Type.Union([
      Type.Literal('attachment'),
      Type.Literal('reference'),
    ]),
    enabled: Type.Boolean(),
  },
  strict,
);
export const AssetDeleteInput = Type.Object(
  {
    operation_id,
    expected_revision,
    preview_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  strict,
);
export const RouteInput = Type.Object(
  {
    operation_id,
    expected_revision,
    subject_kind: Type.Union([Type.Literal('owner'), Type.Literal('actor')]),
    subject_id: ID,
    capability: Type.Union(
      ['chat', 'image', 'video', 'stt', 'tts', 'vision', 'embedding'].map((v) =>
        Type.Literal(v),
      ),
    ),
    route: Type.Union([
      Type.Object({ state: Type.Literal('inherit') }, strict),
      Type.Object({ state: Type.Literal('disabled') }, strict),
      Type.Object({ state: Type.Literal('override'), provider_id: ID }, strict),
    ]),
  },
  strict,
);
export type RouteCommand = Static<typeof RouteInput>;
export const QueueInput = Type.Object(
  { operation_id, content: Type.String({ minLength: 1, maxLength: 16000 }) },
  strict,
);
export const QueueEditInput = Type.Object(
  {
    operation_id,
    expected_revision,
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
    remove: Type.Optional(Type.Boolean()),
  },
  strict,
);
export const StartTurnInput = Type.Object(
  {
    operation_id,
    items: Type.Array(
      Type.Object({ id: ID, revision: Type.Integer({ minimum: 1 }) }, strict),
      { minItems: 1, maxItems: 32 },
    ),
    addressed_actor_ids: Type.Optional(
      Type.Array(ID, { maxItems: 8, uniqueItems: true }),
    ),
  },
  strict,
);
export const MessageEditInput = Type.Object(
  {
    operation_id,
    expected_revision,
    context_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    mode: Type.Union([Type.Literal('keep'), Type.Literal('truncate')]),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
    version_id: Type.Optional(ID),
  },
  strict,
);
