import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Config } from './config.js';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export interface Ciphertext {
  version: number;
  iv: string;
  tag: string;
  data: string;
}
export function encrypt(
  plaintext: string,
  config: Config,
  context: string,
): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, iv);
  cipher.setAAD(Buffer.from(`${config.keyVersion}:${context}`));
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    version: config.keyVersion,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
export function decrypt(
  value: Ciphertext,
  config: Config,
  context: string,
): string {
  try {
    if (value.version !== config.keyVersion) throw new Error();
    const cipher = createDecipheriv(
      'aes-256-gcm',
      config.masterKey,
      Buffer.from(value.iv, 'base64'),
    );
    cipher.setAAD(Buffer.from(`${value.version}:${context}`));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(value.data, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(
      503,
      'credential_unavailable',
      'Credential authentication failed; check master key and version',
    );
  }
}
export function blockedIP(address: string): boolean {
  if (address.includes(':')) {
    const a = address.toLowerCase();
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      a.startsWith('fe') ||
      a.startsWith('ff') ||
      a.startsWith('::ffff:') ||
      (!a.startsWith('2') && !a.startsWith('3'))
    );
  }
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a! >= 224
  );
}
export async function validateEndpoint(value: string, config: Config) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'invalid_endpoint', 'Invalid model endpoint');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new AppError(
      400,
      'invalid_endpoint',
      'Endpoint must not contain credentials, query or fragment',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    config.allowInsecureLocal &&
    ['localhost', '127.0.0.1', '::1'].includes(host) &&
    ['http:', 'https:'].includes(url.protocol)
  )
    return url.toString().replace(/\/$/, '');
  if (url.protocol !== 'https:')
    throw new AppError(
      400,
      'invalid_endpoint',
      'Model endpoint must use HTTPS',
    );
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new AppError(
          400,
          'invalid_endpoint',
          'Model endpoint DNS unavailable',
        );
      });
  if (!addresses.length || addresses.some((a) => blockedIP(a.address)))
    throw new AppError(
      400,
      'invalid_endpoint',
      'Private and special network destinations are disabled',
    );
  return url.toString().replace(/\/$/, '');
}
export async function resolveEndpoint(value: string, config: Config) {
  const base = await validateEndpoint(value, config);
  const host = new URL(base).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  const local =
    config.allowInsecureLocal &&
    ['localhost', '127.0.0.1', '::1'].includes(host);
  if (
    !addresses.length ||
    (!local && addresses.some((a) => blockedIP(a.address)))
  )
    throw new AppError(
      400,
      'invalid_endpoint',
      'Model endpoint changed to a blocked destination',
    );
  return { base, addresses };
}
