import { mkdir, readFile, unlink, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, AppError } from '../../security.js';
import {
  scopedPath,
  journalWrite,
  writeScoped,
  readScoped,
} from '../hosts/files.js';
const fail = (code: string) =>
  new AppError(409, code, 'Restore point verification or revision failed');
const locks = new Map<string, Promise<unknown>>();
// Per-root serialization supplements immutable content-addressed blobs and CAS manifests.
export async function restorePointOperation(
  root: string,
  kind: string,
  p: any,
): Promise<any> {
  const prior = locks.get(root) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const folder = await scopedPath(root, 'echo-restore-points', true);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await scopedPath(root, 'echo-restore-points');
      const lock = join(folder, '.manifest.echo-lock');
      try {
        await mkdir(lock, { mode: 0o700 });
      } catch (e: any) {
        if (e.code === 'EEXIST') throw fail('backup_manifest_busy');
        throw e;
      }
      try {
        return await operate(root, kind, p);
      } finally {
        await rmdir(lock);
      }
    });
  locks.set(root, next);
  try {
    return await next;
  } finally {
    if (locks.get(root) === next) locks.delete(root);
  }
}
async function operate(root: string, kind: string, p: any) {
  const folder = await scopedPath(root, 'echo-restore-points', true);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await scopedPath(root, 'echo-restore-points');
  const manifestPath = join(folder, 'manifest.json');
  let manifest: any = { revision: 0, points: [] };
  try {
    await scopedPath(folder, 'manifest.json');
    manifest = JSON.parse(
      Buffer.from(
        (await readScoped(folder, 'manifest.json')).content_base64,
        'base64',
      ).toString(),
    );
  } catch (e: any) {
    if (e.code !== 'ENOENT' && e.code !== 'external_missing') throw e;
  }
  if (kind === 'backup_list') return manifest;
  if (!/^[a-f0-9]{64}$/.test(p.content_hash ?? '')) throw fail('backup_hash');
  const filename = p.content_hash + '.json';
  if (kind === 'backup_put') {
    let bytes = Buffer.from(p.content_base64 ?? '', 'base64');
    if (p.chunk_count !== undefined) {
      if (
        !Number.isInteger(p.chunk_count) ||
        p.chunk_count < 1 ||
        p.chunk_count > 96 ||
        !Number.isInteger(p.chunk_index) ||
        p.chunk_index < 0 ||
        p.chunk_index >= p.chunk_count ||
        bytes.length > 262144 ||
        hash(bytes) !== p.chunk_hash
      )
        throw fail('backup_chunk');
      if (manifest.points.some((x: any) => x.content_hash === p.content_hash))
        return { ...manifest, verified: true };
      const name = p.content_hash + '.' + p.chunk_index + '.part';
      const written = await writeScoped(folder, name, bytes, null);
      if (
        written.conflict &&
        (await readScoped(folder, name)).content_hash !== p.chunk_hash
      )
        throw fail('backup_chunk');
      const chunks: Buffer[] = [];
      let size = 0;
      for (let i = 0; i < p.chunk_count; i++) {
        try {
          const chunk = await readScoped(
            folder,
            p.content_hash + '.' + i + '.part',
          );
          const b = Buffer.from(chunk.content_base64, 'base64');
          size += b.length;
          if (size > 24 * 1024 * 1024) throw fail('backup_limit');
          chunks.push(b);
        } catch (e: any) {
          if (e.code === 'external_missing')
            return {
              verified: false,
              chunk_received: p.chunk_index,
              content_hash: p.content_hash,
            };
          throw e;
        }
      }
      bytes = Buffer.concat(chunks);
    }
    if (bytes.length > 24 * 1024 * 1024 || hash(bytes) !== p.content_hash)
      throw fail('backup_hash');
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString());
    } catch {
      throw fail('backup_format');
    }
    if (
      envelope.format !== 'echo-encrypted' ||
      envelope.version !== 1 ||
      !envelope.payload?.data ||
      !envelope.payload?.tag
    )
      throw fail('backup_encryption_required');
    if (manifest.points.some((x: any) => x.content_hash === p.content_hash))
      return { ...manifest, verified: true };
    if (manifest.revision !== p.expected_revision)
      throw fail('revision_conflict');
    // The final envelope is immutable and bounded. Persist atomically only after all chunks authenticate.
    let written: any;
    if (bytes.length <= 1048576)
      written = await writeScoped(folder, filename, bytes, null);
    else {
      await journalWrite(await scopedPath(folder, filename, true), envelope);
      written = { conflict: false };
    }
    if (written.conflict) {
      const prior = await readScoped(folder, filename);
      if (prior.content_hash !== p.content_hash) throw fail('backup_hash');
    }
    const checked = Buffer.from(
      (await readScoped(folder, filename, 24 * 1024 * 1024)).content_base64,
      'base64',
    );
    if (hash(checked) !== p.content_hash) throw fail('backup_hash');
    manifest.points.push({
      plan_id: p.plan_id ?? null,
      content_hash: p.content_hash,
      size: bytes.length,
      created_at: new Date().toISOString(),
      verified: true,
    });
    manifest.revision++;
    await journalWrite(manifestPath, manifest);
    if (p.chunk_count)
      for (let i = 0; i < p.chunk_count; i++)
        await unlink(
          await scopedPath(folder, p.content_hash + '.' + i + '.part'),
        ).catch(() => {});
    return { ...manifest, verified: true };
  }
  if (kind === 'backup_delete') {
    if (manifest.revision !== p.expected_revision)
      throw fail('revision_conflict');
    const target = manifest.points.find(
      (x: any) => x.content_hash === p.content_hash,
    );
    if (!target) return manifest;
    const survivors = manifest.points.filter(
      (x: any) => x.content_hash !== p.content_hash && x.verified,
    );
    if (!survivors.length) throw fail('last_restore_point');
    // Verify a surviving point before pruning. Lost deletion response is reconciled by the manifest.
    for (const point of survivors) {
      const check = Buffer.from(
        (
          await readScoped(
            folder,
            point.content_hash + '.json',
            24 * 1024 * 1024,
          )
        ).content_base64,
        'base64',
      );
      if (hash(check) !== point.content_hash) throw fail('backup_hash');
    }
    manifest = { revision: manifest.revision + 1, points: survivors };
    await journalWrite(manifestPath, manifest);
    await unlink(await scopedPath(folder, filename)).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    return manifest;
  }
  throw fail('backup_operation');
}
