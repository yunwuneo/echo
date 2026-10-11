#!/usr/bin/env node
// Host-side Compose operator. All child processes use argument arrays; secrets
// remain in the private env file and never appear in command arguments or output.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const [command, envFile, project, directory, ledgerFile] =
  process.argv.slice(2);
if (
  !['backup', 'restore', 'verify', 'privacy-export'].includes(command) ||
  !envFile ||
  !project ||
  !directory ||
  !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)
)
  throw new Error(
    'Usage: node scripts/ops.mjs backup|restore|verify|privacy-export <private.env> <compose-project> <new-directory-or-ledger-file> [latest-privacy-ledger.json]',
  );
const base = [
  'compose',
  '--env-file',
  resolve(envFile),
  '-f',
  resolve('deploy/compose.yaml'),
  '-p',
  project,
];
async function run(args, { input, output } = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn('docker', [...base, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    let ioError;
    const source = input ? createReadStream(input) : null,
      dest = output
        ? createWriteStream(output, { flags: 'wx', mode: 0o600 })
        : null;
    source?.on('error', (e) => {
      ioError = e;
      p.kill();
    });
    dest?.on('error', (e) => {
      ioError = e;
      p.kill();
    });
    if (source) source.pipe(p.stdin);
    else p.stdin.end();
    p.stdin.on('error', () => {});
    if (dest) p.stdout.pipe(dest);
    else
      p.stdout.on('data', (b) => {
        stdout += b;
        if (stdout.length > 128 * 1024 * 1024) p.kill();
      });
    p.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    p.on('error', reject);
    p.on('close', async (code) => {
      if (dest && !dest.writableFinished && !dest.destroyed)
        await new Promise((r) => {
          dest.once('finish', r);
          dest.once('error', r);
        });
      if (code !== 0 || ioError)
        reject(
          new Error(
            `Operation failed (exit ${code}); services remain stopped. ${ioError?.code ?? ''}`,
          ),
        );
      else resolvePromise(stdout);
    });
  });
}
const cli = (args, opts) =>
  run(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'api',
      'node',
      'dist/packages/server/src/cli.js',
      ...args,
    ],
    opts,
  );
async function sha(file) {
  const h = createHash('sha256');
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest('hex');
}
async function verify(dir) {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (
    m.format !== 'echo-backup' ||
    m.format_version !== 1 ||
    m.postgres_major !== 17 ||
    !m.maintenance ||
    !m.master_key_required
  )
    throw new Error('Unsupported or unsafe backup format');
  for (const name of ['database.dump', 'privacy-ledger.json'])
    if (
      (await sha(join(dir, name))) !== m.files[name]?.sha256 ||
      (await stat(join(dir, name))).size !== m.files[name]?.bytes
    )
      throw new Error(`Backup checksum mismatch: ${name}`);
  return m;
}
try {
  if (command === 'verify') {
    const m = await verify(directory);
    process.stdout.write(
      JSON.stringify({
        valid: true,
        created_at: m.created_at,
        inventory: m.inventory,
      }) + '\n',
    );
  } else if (command === 'privacy-export') {
    await cli(['privacy-export'], { output: directory });
    process.stdout.write('privacy_ledger_saved\n');
  } else if (command === 'backup') {
    await mkdir(directory, { mode: 0o700 });
    await run(['stop', 'proxy', 'api', 'worker']);
    await cli(['maintenance', 'on']);
    const check = JSON.parse(await cli(['backup-check']));
    const part = join(directory, 'database.dump.partial');
    await run(
      [
        'exec',
        '-T',
        'database',
        'pg_dump',
        '-U',
        'echo2',
        '-d',
        'echo2',
        '-Fc',
        '--no-owner',
        '--no-acl',
        '--exclude-schema=pgboss',
        '--exclude-schema=push_relay',
      ],
      { output: part },
    );
    await rename(part, join(directory, 'database.dump'));
    await cli(['privacy-export'], {
      output: join(directory, 'privacy-ledger.json'),
    });
    const files = {};
    for (const name of ['database.dump', 'privacy-ledger.json'])
      files[name] = {
        sha256: await sha(join(directory, name)),
        bytes: (await stat(join(directory, name))).size,
      };
    const manifest = {
      format: 'echo-backup',
      format_version: 1,
      created_at: new Date().toISOString(),
      postgres_major: 17,
      app_version: '0.5.0',
      maintenance: true,
      master_key_required: true,
      resources:
        'Import originals and avatars are bytea/jsonb in PostgreSQL; no external resource volume in P5.',
      ...check,
      files,
    };
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(
      'backup_verified; source remains in maintenance with API/Worker/proxy stopped\n',
    );
    await verify(directory);
  } else {
    const m = await verify(directory);
    await run(['up', '-d', '--wait', 'database']);
    const existing = await run([
      'exec',
      '-T',
      'database',
      'psql',
      '-U',
      'echo2',
      '-d',
      'echo2',
      '-Atc',
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    ]);
    if (Number(existing.trim()) !== 0)
      throw new Error(
        'Restore target must be an empty dedicated database; existing data is never overwritten',
      );
    await run(['stop', 'proxy', 'api', 'worker']);
    await run(
      [
        'exec',
        '-T',
        'database',
        'pg_restore',
        '-U',
        'echo2',
        '-d',
        'echo2',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
      ],
      { input: join(directory, 'database.dump') },
    );
    await cli(['migrate']);
    const check = JSON.parse(await cli(['backup-check']));
    if (JSON.stringify(check.inventory) !== JSON.stringify(m.inventory))
      throw new Error(
        'Restored data inventory differs; target remains quarantined',
      );
    await cli(['restore-prepare']);
    await cli(['privacy-apply'], {
      input: join(directory, 'privacy-ledger.json'),
    });
    if (ledgerFile)
      await cli(['privacy-apply'], { input: resolve(ledgerFile) });
    process.stdout.write(
      'restore_verified; target remains in maintenance, autonomy/tools/push disabled, devices revoked. Keep the source stopped before cutover.\n',
    );
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}
