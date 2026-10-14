import { statfs } from 'node:fs/promises';
export function requiredSpace(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('Invalid storage estimate');
  return Math.max(64 * 1024 * 1024, bytes * 2);
}
export function assertSpace(available, bytes) {
  const required = requiredSpace(bytes);
  if (!Number.isFinite(available) || available < required)
    throw new Error(
      'Insufficient verified storage; no maintenance or restore may begin',
    );
  return { available_bytes: available, required_bytes: required };
}
export async function localSpace(path, bytes, inspect = statfs) {
  const fs = await inspect(path);
  return assertSpace(Number(fs.bavail) * Number(fs.bsize), bytes);
}
export function databaseSpace(df, bytes) {
  const line = df.trim().split('\n').at(-1)?.trim().split(/\s+/);
  return assertSpace(Number(line?.[3]) * 1024, bytes);
}
