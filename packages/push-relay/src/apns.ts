import { connect, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
export interface Push {
  token: string;
  topic: string;
  environment: string;
  event: string;
  delivery: string;
  instance: string;
  epoch: string;
}
export interface PushResult {
  state: 'accepted' | 'failed' | 'unknown';
  invalid_token?: boolean;
}
export const payload = (p: Push) => ({
  aps: {
    alert: { title: 'Echo', body: '你的世界有新动态，打开 Echo 查看。' },
    sound: 'default',
  },
  event_id: p.event,
  server_instance_id: p.instance,
  data_epoch: p.epoch,
});
export function apnsSender(
  team: string,
  keyID: string,
  pem: string,
  transport: (origin: string) => ClientHttp2Session = connect,
) {
  if (!/^[A-Z0-9]{10}$/.test(team) || !/^[A-Z0-9]{10}$/.test(keyID))
    throw new Error('Invalid APNs identifiers');
  const key = createPrivateKey(pem);
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('APNs requires P-256 key');
  let jwt = '',
    signedAt = 0;
  return async (p: Push): Promise<PushResult> => {
    const now = Math.floor(Date.now() / 1000);
    if (now - signedAt > 3000) {
      const encoded = `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyID })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: team, iat: now })).toString('base64url')}`;
      jwt = `${encoded}.${sign('sha256', Buffer.from(encoded), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      signedAt = now;
    }
    return new Promise((resolve) => {
      const session = transport(
        p.environment === 'sandbox'
          ? 'https://api.sandbox.push.apple.com'
          : 'https://api.push.apple.com',
      );
      let done = false;
      const finish = (r: PushResult) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          session.destroy();
          resolve(r);
        }
      };
      const timer = setTimeout(() => finish({ state: 'unknown' }), 10000);
      session.on('error', () => finish({ state: 'unknown' }));
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${p.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': p.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(now + 3600),
        'apns-id': p.delivery,
        'apns-collapse-id': p.event,
      });
      let status = 0,
        body = '';
      req.on('response', (h) => {
        status = Number(h[':status']);
      });
      req.on('data', (b) => {
        body += b;
        if (body.length > 4096) finish({ state: 'unknown' });
      });
      req.on('error', () => finish({ state: 'unknown' }));
      req.on('end', () => {
        let reason = '';
        try {
          reason = JSON.parse(body).reason;
        } catch {
          /* APNs 200 has empty body. */
        }
        finish({
          state: status === 200 ? 'accepted' : 'failed',
          invalid_token:
            status === 410 ||
            [
              'BadDeviceToken',
              'DeviceTokenNotForTopic',
              'Unregistered',
            ].includes(reason),
        });
      });
      req.end(JSON.stringify(payload(p)));
    });
  };
}
