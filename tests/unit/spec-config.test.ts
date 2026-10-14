import { it, expect } from 'vitest';
import { resolveRoute } from '../../packages/server/src/modules/providers/routes.js';
it('all functional routes preserve explicit disabled, inherit, and override without conflating null', () => {
  const global = {
    state: 'override' as const,
    provider_id: 'global',
    revision: 4,
  };
  expect(
    resolveRoute({ state: 'disabled', revision: 2 }, global, 'legacy'),
  ).toMatchObject({ state: 'disabled', provider_id: null });
  expect(resolveRoute({ state: 'inherit', revision: 3 }, global)).toMatchObject(
    { provider_id: 'global', source: 'owner' },
  );
  expect(
    resolveRoute(
      { state: 'override', provider_id: 'actor', revision: 3 },
      global,
    ),
  ).toMatchObject({ provider_id: 'actor', source: 'actor' });
  expect(
    resolveRoute(undefined, { state: 'disabled', revision: 1 }, 'legacy').state,
  ).toBe('disabled');
  expect(resolveRoute(undefined, undefined).state).toBe('unconfigured');
  expect(resolveRoute(undefined, undefined, 'legacy').source).toBe(
    'legacy_room',
  );
});

it('storage preflight refuses low or unverified free space before maintenance writes', async () => {
  const { localSpace, databaseSpace } =
    await import('../../scripts/storage-preflight.mjs');
  await expect(
    localSpace('/synthetic', 1024, async () => ({ bavail: 0, bsize: 4096 })),
  ).rejects.toThrow('Insufficient verified storage');
  expect(() => databaseSpace('not a valid filesystem report', 1024)).toThrow(
    'Insufficient verified storage',
  );
  expect(
    databaseSpace(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\nsynthetic 1000000 1000 999000 1% /data',
      1024,
    ).required_bytes,
  ).toBe(64 * 1024 * 1024);
});
