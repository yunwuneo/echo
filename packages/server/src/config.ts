export interface Config {
  databaseURL: string;
  pushRelayURL?: string;
  publicURL: string;
  masterKey: Buffer;
  keyVersion: number;
  allowInsecureLocal: boolean;
  port: number;
  leaseMs: number;
  modelTimeoutMs: number;
  dailyRequestLimit: number;
  backgroundRequestLimit: number;
  backgroundInputLimit: number;
  backgroundOutputLimit: number;
}
export function loadConfig(env = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.MASTER_KEY || !/^[0-9a-f]{64}$/i.test(env.MASTER_KEY))
    throw new Error('MASTER_KEY must be 32 bytes encoded as 64 hex characters');
  const publicURL = new URL(env.PUBLIC_URL ?? 'https://localhost');
  const allowInsecureLocal = env.ALLOW_INSECURE_LOCAL === 'true';
  if (
    publicURL.protocol !== 'https:' &&
    !(
      allowInsecureLocal &&
      publicURL.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(publicURL.hostname)
    )
  )
    throw new Error(
      'PUBLIC_URL must use HTTPS (explicit loopback development exception only)',
    );
  if (
    publicURL.username ||
    publicURL.password ||
    publicURL.search ||
    publicURL.hash
  )
    throw new Error('Invalid PUBLIC_URL');
  const int = (name: string, fallback: number, min: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name}`);
    return n;
  };
  let pushRelayURL: string | undefined;
  if (env.PUSH_RELAY_URL) {
    const u = new URL(env.PUSH_RELAY_URL);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      (u.protocol !== 'https:' &&
        !(
          allowInsecureLocal &&
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        ))
    )
      throw new Error('Invalid PUSH_RELAY_URL');
    pushRelayURL = u.origin;
  }
  return {
    pushRelayURL,
    databaseURL: env.DATABASE_URL,
    publicURL: publicURL.origin,
    masterKey: Buffer.from(env.MASTER_KEY, 'hex'),
    keyVersion: int('MASTER_KEY_VERSION', 1, 1),
    allowInsecureLocal,
    port: int('PORT', 3000, 1),
    leaseMs: int('LEASE_MS', 15000, 1000),
    modelTimeoutMs: int('MODEL_TIMEOUT_MS', 120000, 100),
    dailyRequestLimit: int('FOREGROUND_DAILY_REQUEST_LIMIT', 100, 1),
    backgroundRequestLimit: int('BACKGROUND_DAILY_REQUEST_LIMIT', 20, 0),
    backgroundInputLimit: int('BACKGROUND_DAILY_INPUT_LIMIT', 100000, 0),
    backgroundOutputLimit: int('BACKGROUND_DAILY_OUTPUT_LIMIT', 10000, 0),
  };
}
