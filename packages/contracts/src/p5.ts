import { Type } from '@sinclair/typebox';
const strict = { additionalProperties: false };
const uuid = Type.String({ format: 'uuid' });
export const PushBinding = Type.Object(
  {
    server_instance_id: uuid,
    data_epoch: uuid,
    device_id: uuid,
    challenge: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
  },
  strict,
);
export const RelayEnrollment = Type.Object(
  {
    invitation: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
    binding: PushBinding,
    topic: Type.String({
      minLength: 3,
      maxLength: 200,
      pattern: '^[A-Za-z0-9.-]+$',
    }),
    environment: Type.Union([
      Type.Literal('sandbox'),
      Type.Literal('production'),
    ]),
    apns_token: Type.String({ pattern: '^[0-9a-f]{64,200}$' }),
  },
  strict,
);
export const PushTicket = Type.Object(
  { ticket: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) },
  strict,
);
export const RelayDelivery = Type.Object(
  { event_id: uuid, delivery_id: uuid },
  strict,
);
