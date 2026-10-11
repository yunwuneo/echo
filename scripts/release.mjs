#!/usr/bin/env node
// Local reviewable candidate only. No upload, signing, license choice or publication.
import {
  readFile,
  readdir,
  lstat,
  mkdir,
  copyFile,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const files = [];
const roots = [
  '.dockerignore',
  '.env.example',
  '.gitignore',
  '.node-version',
  '.nvmrc',
  '.prettierrc.json',
  '.prettierignore',
  'AGENTS.md',
  'Dockerfile',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'apps',
  'packages',
  'migrations',
  'scripts',
  'tests',
  'docs',
  'deploy',
  '.github',
];
const skip = new Set([
  '.build',
  '.swiftpm',
  'node_modules',
  'dist',
  'DerivedData',
  'xcuserdata',
  '.DS_Store',
]);
async function walk(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink())
    throw new Error('Refusing symlink in release inputs: ' + path);
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort())
      if (!skip.has(name)) await walk(join(path, name));
  } else {
    if (
      /\.(pem|key|p12|mobileprovision|env)$/i.test(path) ||
      (path.split('/').at(-1).startsWith('.env') && path !== '.env.example')
    )
      throw new Error('Credential-like file in release input: ' + path);
    const bytes = await readFile(path);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
}
for (const root of roots) await walk(root);
files.sort((a, b) => a.path.localeCompare(b.path));
const fingerprint = hash(JSON.stringify(files));
const name = `echo-${pkg.version}-candidate-${fingerprint.slice(0, 12)}`;
const parent = resolve('.local/releases'),
  target = join(parent, name);
await mkdir(target, { recursive: true, mode: 0o700 });
for (const f of files) {
  const dest = join(target, f.path);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(f.path, dest);
  if (hash(await readFile(dest)) !== f.sha256)
    throw new Error('Source changed while preparing candidate: ' + f.path);
}
const manifest = {
  format: 1,
  version: pkg.version,
  status: 'local_candidate_not_release_approved',
  source_sha256: fingerprint,
  protocol: 'v1',
  schema: 6,
  owner_archive_format: 1,
  node: '24.14.0',
  npm: '11.9.0',
  release_ready: false,
  remaining_gates: [
    'two_real_model_configurations_and_human_scores',
    'physical_Apple_notification_matrix',
    '24h_wall_clock_soak_result',
    'independent_Linux_HTTPS_and_disk_faults',
    'iOS_large_text_and_dark_mode_retest',
    'full_macOS_accessibility_and_UI',
    'candidate_runtime_image_build',
    'license_and_distribution_decisions',
  ],
  evidence: 'docs/p6-report.md',
  compatibility: 'docs/compatibility.md',
  privacy: 'docs/privacy-data.md',
  files,
};
await writeFile(
  join(target, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
const archive = join(parent, name + '.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', parent, name], {
  stdio: 'inherit',
  // Do not export macOS resource forks or Finder metadata as AppleDouble files.
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (result.status !== 0) throw new Error('Failed to create local archive');
await writeFile(
  archive + '.sha256',
  `${hash(await readFile(archive))}  ${name}.tar.gz\n`,
);
process.stdout.write(
  JSON.stringify({
    directory: target,
    archive,
    source_sha256: fingerprint,
    release_ready: false,
  }) + '\n',
);
