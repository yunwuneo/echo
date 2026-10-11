import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
const value = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (
  value.format !== 'echo-owner-export' ||
  value.format_version !== 1 ||
  value.checksum_algorithm !== 'sha256-canonical-json-v1' ||
  createHash('sha256').update(canonical(value.data)).digest('hex') !==
    value.checksum
)
  throw new Error('Unsupported or corrupt Echo owner export');
process.stdout.write('export_verified\n');
