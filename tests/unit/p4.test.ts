import { it, expect } from 'vitest';
import {
  dayAt,
  quietAt,
} from '../../packages/server/src/modules/autonomy/policy.js';
import {
  canonical,
  fingerprint,
  supported,
  validateArguments,
  boundedResult,
} from '../../packages/server/src/modules/mcp/schema.js';
import { resolveMcp } from '../../packages/server/src/modules/mcp/transport.js';
it('uses IANA local dates and quiet hours through DST folds, gaps and midnight', () => {
  expect(dayAt(new Date('2026-10-11T16:00:00Z'), 'Asia/Shanghai')).toBe(
    '2026-10-12',
  );
  expect(dayAt(new Date('2026-10-11T16:00:00Z'), 'America/New_York')).toBe(
    '2026-10-11',
  );
  for (const utc of [
    '2026-11-01T05:30:00Z',
    '2026-11-01T06:30:00Z',
    '2026-03-08T07:30:00Z',
  ])
    expect(quietAt(new Date(utc), 'America/New_York', '22:30', '08:00')).toBe(
      true,
    );
  expect(
    quietAt(
      new Date('2026-03-08T12:00:00Z'),
      'America/New_York',
      '22:30',
      '08:00',
    ),
  ).toBe(false);
  expect(quietAt(new Date(), 'Asia/Shanghai', '00:00', '00:00')).toBe(false);
});
it('binds semantic schema and exact nested resource arguments, rejects unsupported validation rather than ignoring it', () => {
  const schema = {
    type: 'object',
    properties: {
      calendar: { type: 'string' },
      count: { type: 'integer', minimum: 1, maximum: 3 },
    },
    required: ['calendar'],
    additionalProperties: false,
  };
  expect(supported(schema)).toBe(true);
  expect(() =>
    validateArguments(
      schema,
      { calendar: '合成', count: 2 },
      { calendar: '合成' },
    ),
  ).not.toThrow();
  expect(() =>
    validateArguments(schema, { calendar: '别处' }, { calendar: '合成' }),
  ).toThrow();
  expect(() =>
    validateArguments(schema, { calendar: '合成', extra: '注入' }, {}),
  ).toThrow();
  expect(() =>
    validateArguments(schema, { calendar: '合成', count: 4 }, {}),
  ).toThrow();
  expect(supported({ type: 'string', pattern: '(a+)+$' })).toBe(false);
  expect(supported({ type: 'object', $ref: 'https://evil.test/schema' })).toBe(
    false,
  );
  expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
  expect(fingerprint({ name: 'x', inputSchema: schema })).not.toBe(
    fingerprint({ name: 'x', inputSchema: schema, description: 'changed' }),
  );
});
it('bounds hostile results and never fetches embedded resources or media', () => {
  const r = boundedResult({
    content: [
      { type: 'text', text: '字'.repeat(12000) },
      { type: 'image', data: 'SECRET_BINARY' },
      { type: 'resource_link', uri: 'http://169.254.169.254' },
    ],
  });
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(r.text)).toBeLessThan(4050);
  expect(r.text).not.toContain('SECRET_BINARY');
  expect(r.text).not.toContain('169.254');
});
it('blocks unlisted, mixed and rebound destinations, including explicitly listed metadata IPs', async () => {
  for (const address of [
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    'fe80::1',
    'fe90::1',
    '::ffff:127.0.0.1',
  ])
    await expect(
      resolveMcp(
        `http://${address.includes(':') ? '[' + address + ']' : address}/mcp`,
        [address],
      ),
    ).rejects.toBeInstanceOf(Error);
  const resolver = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await expect(
    resolveMcp('https://synthetic.invalid/mcp', [], resolver),
  ).rejects.toMatchObject({ code: 'blocked_destination' });
  const allowed = await resolveMcp(
    'https://synthetic.invalid/mcp',
    [],
    async () => [{ address: '8.8.8.8', family: 4 }],
  );
  expect(allowed.addresses[0]!.address).toBe('8.8.8.8');
  await expect(
    resolveMcp('https://synthetic.invalid/mcp', [], async () => [
      { address: '10.0.0.1', family: 4 },
    ]),
  ).rejects.toMatchObject({ code: 'blocked_destination' });
});
