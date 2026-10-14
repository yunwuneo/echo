import { constants } from 'node:fs';
import {
  realpath,
  lstat,
  readFile,
  open,
  rename,
  unlink,
  readdir,
  opendir,
  mkdir,
  statfs,
  rmdir,
} from 'node:fs/promises';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, hash } from '../../security.js';
const fail = (code: string) =>
  new AppError(409, code, 'Authorized file unavailable or changed');
export async function scopedPath(
  root: string,
  path: string,
  allowMissing = false,
) {
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split(/[\\/]/).some((p) => p === '..' || p === '.')
  )
    throw fail('path_scope');
  const base = await realpath(root).catch(() => {
    throw fail('directory_authorization_lost');
  });
  const destination = resolve(base, path);
  if (
    relative(base, destination).startsWith('..' + sep) ||
    destination === base
  )
    throw fail('path_scope');
  let cursor = base;
  const parts = relative(base, destination).split(sep);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    const info = await lstat(cursor).catch((e) => {
      if (e.code === 'ENOENT' && allowMissing && i === parts.length - 1)
        return null;
      throw fail('external_missing');
    });
    if (info?.isSymbolicLink()) throw fail('symlink_denied');
  }
  return destination;
}
export async function readScoped(
  root: string,
  path: string,
  maxBytes = 1048576,
) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 24 * 1024 * 1024
  )
    throw fail('file_limit');
  const full = await scopedPath(root, path);
  const h = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.size > maxBytes) throw fail('file_limit');
    const data = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < data.length) {
      const r = await h.read(data, offset, data.length - offset, null);
      if (!r.bytesRead) break;
      offset += r.bytesRead;
    }
    if (offset > maxBytes) throw fail('file_limit');
    const result = data.subarray(0, offset);
    return {
      content_base64: result.toString('base64'),
      content_hash: hash(result),
      size: result.length,
    };
  } finally {
    await h.close();
  }
}
export async function writeScoped(
  root: string,
  path: string,
  data: Buffer,
  baseHash: string | null,
) {
  const full = await scopedPath(root, path, true),
    lock = full + '.echo-lock';
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e: any) {
    if (e.code === 'EEXIST') throw fail('external_write_busy');
    throw e;
  }
  try {
    return await writeUnlocked(root, path, data, baseHash);
  } finally {
    await rmdir(lock);
  }
}
async function writeUnlocked(
  root: string,
  path: string,
  data: Buffer,
  baseHash: string | null,
) {
  if (data.length > 1048576) throw fail('file_limit');
  const full = await scopedPath(root, path, true);
  const current = await readScoped(root, path)
    .then((r) => Buffer.from(r.content_base64, 'base64'))
    .catch((e) => {
      if (e.code === 'ENOENT' || e.code === 'external_missing') return null;
      throw e;
    });
  if ((current ? hash(current) : null) !== baseHash)
    return {
      conflict: true,
      current_hash: current ? hash(current) : null,
      current_content_base64: current?.toString('base64') ?? null,
      draft_content_base64: data.toString('base64'),
    };
  const space = await statfs(dirname(full));
  if (space.bavail * space.bsize < data.length * 2 + 1048576)
    throw fail('storage_full');
  const temp = join(dirname(full), '.echo-write-' + randomUUID());
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Recheck immediately before replacement, and refuse changed or symlink targets.
    await scopedPath(root, path, true);
    const latest = await readScoped(root, path)
      .then((r) => Buffer.from(r.content_base64, 'base64'))
      .catch((e) => {
        if (e.code === 'ENOENT' || e.code === 'external_missing') return null;
        throw e;
      });
    if ((latest ? hash(latest) : null) !== baseHash)
      throw fail('external_conflict');
    await rename(temp, full);
    const dir = await open(dirname(full), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return { conflict: false, content_hash: hash(data), size: data.length };
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => {});
  }
}
export async function listScoped(root: string, path: string) {
  const directory = path
    ? await scopedPath(root, path)
    : await realpath(root).catch(() => {
        throw fail('directory_authorization_lost');
      });
  const entries = [];
  const iterator = await opendir(directory);
  for await (const entry of iterator) {
    if (!entry.isSymbolicLink())
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
      });
    if (entries.length === 500) break;
  }
  return entries;
}
export async function journalWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.' + randomUUID() + '.tmp';
  const h = await open(tmp, 'wx', 0o600);
  try {
    await h.writeFile(JSON.stringify(value));
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(tmp, path);
    const d = await open(dirname(path), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
