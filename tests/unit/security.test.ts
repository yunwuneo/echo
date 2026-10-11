import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../packages/server/src/config.js';
import {
  encrypt,
  decrypt,
  validateEndpoint,
} from '../../packages/server/src/security.js';
const base = {
  DATABASE_URL: 'postgresql://synthetic/echo2_test',
  MASTER_KEY: 'ab'.repeat(32),
  PUBLIC_URL: 'https://example.com',
};
describe('configuration and secrets', () => {
  it('requires an authenticated master key and HTTPS', () => {
    expect(() => loadConfig({ ...base, MASTER_KEY: '' })).toThrow();
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_URL: 'http://example.com',
        ALLOW_INSECURE_LOCAL: 'true',
      }),
    ).toThrow();
    expect(
      loadConfig({
        ...base,
        PUBLIC_URL: 'http://localhost:3000',
        ALLOW_INSECURE_LOCAL: 'true',
      }).port,
    ).toBe(3000);
  });
  it('binds ciphertext to owner, connection and key version', () => {
    const config = loadConfig(base),
      value = encrypt('synthetic-model-key', config, 'owner:connection');
    expect(JSON.stringify(value)).not.toContain('synthetic-model-key');
    expect(decrypt(value, config, 'owner:connection')).toBe(
      'synthetic-model-key',
    );
    expect(() => decrypt(value, config, 'other:connection')).toThrow();
    expect(() =>
      decrypt(
        value,
        { ...config, masterKey: Buffer.alloc(32) },
        'owner:connection',
      ),
    ).toThrow();
    expect(() =>
      decrypt({ ...value, version: 2 }, config, 'owner:connection'),
    ).toThrow();
    expect(() =>
      decrypt({ ...value, data: 'AAAA' }, config, 'owner:connection'),
    ).toThrow();
  });
  it('blocks local metadata and embedded credentials', async () => {
    const config = loadConfig(base);
    await expect(
      validateEndpoint('https://169.254.169.254/v1', config),
    ).rejects.toThrow();
    await expect(
      validateEndpoint('https://127.0.0.1/v1', config),
    ).rejects.toThrow();
    await expect(
      validateEndpoint('https://user:pass@example.com/v1', config),
    ).rejects.toThrow();
    await expect(
      validateEndpoint('http://example.com/v1', config),
    ).rejects.toThrow();
  });
});
