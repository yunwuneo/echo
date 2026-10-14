import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dailyInstant,
  dueSlot,
} from '../../packages/server/src/modules/schedules/time.js';
import {
  writeScoped,
  readScoped,
} from '../../packages/server/src/modules/hosts/files.js';
import { restorePointOperation } from '../../packages/server/src/modules/storage/restore-points.js';
import { encrypt, hash } from '../../packages/server/src/security.js';
it('T15 DST missing time moves forward and repeated time selects only first occurrence', () => {
  expect(
    new Date(
      dailyInstant('2026-03-08', '02:30', 'America/New_York'),
    ).toISOString(),
  ).toBe('2026-03-08T07:00:00.000Z');
  expect(
    new Date(
      dailyInstant('2026-11-01', '01:30', 'America/New_York'),
    ).toISOString(),
  ).toBe('2026-11-01T05:30:00.000Z');
  const s = {
    rule: 'interval',
    interval_seconds: 60,
    next_at: new Date(0),
    catch_up: 'latest',
  };
  expect(dueSlot(s, 610123)).toMatchObject({
    at: 600000,
    next: 660000,
    missed: false,
  });
  expect(dueSlot({ rule: 'once', next_at: new Date(0) }, 610123)?.missed).toBe(
    true,
  );
});
it('T18 file baseline, two-content conflict and symlink/path scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-continuation-files-'));
  try {
    const first = await writeScoped(root, 'a.txt', Buffer.from('first'), null);
    expect(first.conflict).toBe(false);
    const conflict = await writeScoped(
      root,
      'a.txt',
      Buffer.from('draft'),
      null,
    );
    expect(conflict).toMatchObject({
      conflict: true,
      current_content_base64: Buffer.from('first').toString('base64'),
      draft_content_base64: Buffer.from('draft').toString('base64'),
    });
    expect((await readScoped(root, 'a.txt')).content_hash).toBe(hash('first'));
    await symlink('/etc/passwd', join(root, 'escape'));
    await expect(readScoped(root, 'escape')).rejects.toMatchObject({
      code: 'symlink_denied',
    });
    await expect(readScoped(root, '../escape')).rejects.toMatchObject({
      code: 'path_scope',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('T18 verified encrypted restore points protect last copy and stale retention preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-continuation-backup-'));
  try {
    const archive = (s: string) =>
      Buffer.from(
        JSON.stringify({
          format: 'echo-encrypted',
          version: 1,
          payload: encrypt(
            s,
            { masterKey: Buffer.alloc(32), keyVersion: 1 } as any,
            'test',
          ),
        }),
      );
    const a = archive('first'),
      b = archive('second');
    const put = (bytes: Buffer, revision: number) =>
      restorePointOperation(root, 'backup_put', {
        content_hash: hash(bytes),
        content_base64: bytes.toString('base64'),
        expected_revision: revision,
      });
    expect((await put(a, 0)).revision).toBe(1);
    expect((await put(a, 0)).revision).toBe(1);
    await expect(
      restorePointOperation(root, 'backup_delete', {
        content_hash: hash(a),
        expected_revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'last_restore_point' });
    await put(b, 1);
    await expect(
      restorePointOperation(root, 'backup_delete', {
        content_hash: hash(a),
        expected_revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await writeFile(
      join(root, 'echo-restore-points', hash(b) + '.json'),
      'corrupt',
    );
    await expect(
      restorePointOperation(root, 'backup_delete', {
        content_hash: hash(a),
        expected_revision: 2,
      }),
    ).rejects.toMatchObject({ code: 'backup_hash' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('T18 chunked backup resumes duplicate chunks and only publishes a verified complete point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-chunked-backup-'));
  try {
    const { canonical } =
      await import('../../packages/server/src/modules/mcp/schema.js');
    const bytes = Buffer.from(
      canonical({
        format: 'echo-encrypted',
        version: 1,
        payload: encrypt(
          'x'.repeat(1100000),
          { masterKey: Buffer.alloc(32), keyVersion: 1 } as any,
          'test',
        ),
      }),
    );
    const count = Math.ceil(bytes.length / 262144);
    let result: any;
    for (let i = 0; i < count; i++) {
      const part = bytes.subarray(i * 262144, (i + 1) * 262144),
        payload = {
          content_hash: hash(bytes),
          content_base64: part.toString('base64'),
          chunk_hash: hash(part),
          chunk_index: i,
          chunk_count: count,
          expected_revision: 0,
        };
      result = await restorePointOperation(root, 'backup_put', payload);
      if (i === 0) {
        expect(result.verified).toBe(false);
        expect(
          (await restorePointOperation(root, 'backup_put', payload)).verified,
        ).toBe(false);
        expect(
          (await restorePointOperation(root, 'backup_list', {})).points,
        ).toEqual([]);
      }
    }
    expect(result.verified).toBe(true);
    expect(result.points).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('T18 concurrent Host writes cannot both replace the same external baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-file-race-'));
  try {
    await writeScoped(root, 'a', Buffer.from('base'), null);
    const results = await Promise.allSettled([
      writeScoped(root, 'a', Buffer.from('one'), hash('base')),
      writeScoped(root, 'a', Buffer.from('two'), hash('base')),
    ]);
    expect(
      results.filter((r) => r.status === 'fulfilled' && !r.value.conflict),
    ).toHaveLength(1);
    const value = await readScoped(root, 'a');
    expect([hash('one'), hash('two')]).toContain(value.content_hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
