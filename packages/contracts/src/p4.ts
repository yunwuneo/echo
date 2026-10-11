import { Type } from '@sinclair/typebox';
const strict = { additionalProperties: false },
  id = Type.String({ format: 'uuid' }),
  name = Type.String({ minLength: 1, maxLength: 80 });
const limit = (maximum: number) => Type.Integer({ minimum: 0, maximum });
const limits = {
  request_limit: limit(10000),
  input_limit: limit(10000000),
  output_limit: limit(1000000),
};
export const AutonomySettingsInput = Type.Object(
  {
    enabled: Type.Boolean(),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    tools_read: Type.Boolean(),
    tools_write: Type.Boolean(),
    ...limits,
  },
  strict,
);
const time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
export const AutonomyPolicyInput = Type.Object(
  {
    enabled: Type.Boolean(),
    memory: Type.Boolean(),
    contact: Type.Boolean(),
    interaction: Type.Boolean(),
    tools_read: Type.Boolean(),
    tools_write: Type.Boolean(),
    room_id: Type.Optional(Type.Union([id, Type.Null()])),
    max_turns: Type.Integer({ minimum: 1, maximum: 3 }),
    contact_daily: limit(3),
    interaction_daily: limit(4),
    interval_minutes: Type.Integer({ minimum: 120, maximum: 10080 }),
    quiet_start: time,
    quiet_end: time,
    quiet_interaction: Type.Boolean(),
    ...limits,
    category_limit: limit(10000),
  },
  strict,
);
export const McpConnectionInput = Type.Object(
  {
    name,
    url: Type.String({ minLength: 8, maxLength: 2048 }),
    transport: Type.Union([
      Type.Literal('streamable_http'),
      Type.Literal('sse'),
    ]),
    enabled: Type.Boolean(),
    auth_type: Type.Union(
      ['none', 'bearer', 'api_key'].map((s) => Type.Literal(s)),
    ),
    header_name: Type.String({ maxLength: 80 }),
    credential: Type.Optional(Type.String({ maxLength: 4096 })),
    private_addresses: Type.Array(Type.String({ maxLength: 80 }), {
      maxItems: 16,
      uniqueItems: true,
    }),
  },
  strict,
);
export const ToolGrantInput = Type.Object(
  {
    world_id: id,
    actor_id: id,
    connection_id: id,
    tool_name: Type.String({ minLength: 1, maxLength: 200 }),
    schema_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    effect: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    approval_mode: Type.Union([Type.Literal('each'), Type.Literal('scoped')]),
    argument_scope: Type.Record(Type.String(), Type.Unknown()),
    expires_at: Type.String({ format: 'date-time' }),
    enabled: Type.Boolean(),
  },
  strict,
);
export const ToolDecisionInput = Type.Object(
  {
    decision: Type.Union(
      ['approve', 'deny', 'confirmed_success', 'confirmed_failure'].map((s) =>
        Type.Literal(s),
      ),
    ),
  },
  strict,
);
