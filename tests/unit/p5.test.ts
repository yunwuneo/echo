import { it, expect } from 'vitest';
import { createServer, connect } from 'node:http2';
import { generateKeyPairSync, verify, randomUUID } from 'node:crypto';
import { apnsSender } from '../../packages/push-relay/src/apns.js';
import { loadConfig } from '../../packages/server/src/config.js';
it('sends a signed HTTP/2 APNs alert with exact generic payload, selected environment and invalid-token handling', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const server = createServer();
  let status = 200,
    reason = '',
    requests: any[] = [];
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (b) => (body += b));
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(body) });
      stream.respond({ ':status': status });
      stream.end(status === 200 ? '' : JSON.stringify({ reason }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origins: string[] = [];
  const sender = apnsSender(
    'SYNTH12345',
    'SYNTH67890',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    (origin) => {
      origins.push(origin);
      return connect(`http://127.0.0.1:${(server.address() as any).port}`);
    },
  );
  const p = {
    token: 'ab'.repeat(32),
    topic: 'dev.echo2.synthetic',
    environment: 'sandbox',
    event: randomUUID(),
    delivery: randomUUID(),
    instance: randomUUID(),
    epoch: randomUUID(),
  };
  try {
    expect(await sender(p)).toMatchObject({ state: 'accepted' });
    const r = requests[0],
      jwt = r.headers.authorization.slice(7).split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(jwt.slice(0, 2).join('.')),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(jwt[2], 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(jwt[0], 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'SYNTH67890',
    });
    expect(r.headers['apns-push-type']).toBe('alert');
    expect(r.headers['apns-collapse-id']).toBe(p.event);
    expect(r.body).toEqual({
      aps: {
        alert: { title: 'Echo', body: '你的世界有新动态，打开 Echo 查看。' },
        sound: 'default',
      },
      event_id: p.event,
      server_instance_id: p.instance,
      data_epoch: p.epoch,
    });
    status = 410;
    reason = 'Unregistered';
    expect(await sender({ ...p, environment: 'production' })).toEqual({
      state: 'failed',
      invalid_token: true,
    });
    expect(origins).toEqual([
      'https://api.sandbox.push.apple.com',
      'https://api.push.apple.com',
    ]);
    status = 429;
    reason = 'TooManyRequests';
    expect(await sender(p)).toEqual({ state: 'failed', invalid_token: false });
    status = 400;
    reason = 'DeviceTokenNotForTopic';
    expect((await sender(p)).invalid_token).toBe(true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it('rejects relay URL credentials, path, query and nonlocal HTTP configuration', () => {
  const env = {
    DATABASE_URL: 'postgresql://unused',
    MASTER_KEY: 'ab'.repeat(32),
  };
  for (const u of [
    'http://example.com',
    'https://secret@example.com',
    'https://example.com/path',
    'https://example.com?key=secret',
  ])
    expect(() => loadConfig({ ...env, PUSH_RELAY_URL: u })).toThrow();
  expect(
    loadConfig({ ...env, PUSH_RELAY_URL: 'https://push.example.com' })
      .pushRelayURL,
  ).toBe('https://push.example.com');
});
