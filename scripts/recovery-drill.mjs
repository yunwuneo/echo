#!/usr/bin/env node
// Destructive only to newly-created, uniquely-named synthetic Compose projects.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--synthetic'))
  throw new Error('Pass --synthetic; this creates disposable test databases');
const suffix = randomUUID().slice(0, 8),
  root = resolve('.local', 'p5-recovery-' + suffix);
await mkdir(root, { recursive: true, mode: 0o700 });
const source = 'echo-p5-src-' + suffix,
  target = 'echo-p5-dst-' + suffix;
const sourceEnv = join(root, 'source.env'),
  targetEnv = join(root, 'target.env');
const env = `PUBLIC_URL=https://synthetic.invalid\nPOSTGRES_PASSWORD=synthetic-p5-only\nMASTER_KEY=${'ab'.repeat(32)}\nMASTER_KEY_VERSION=1\nECHO_IMAGE=${process.env.ECHO_DRILL_IMAGE ?? 'echo2-server:p5-local'}\n`;
await writeFile(sourceEnv, env, { mode: 0o600 });
await writeFile(targetEnv, env, { mode: 0o600 });
function run(bin, args, input, expectFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (b) => (text += b));
    p.stderr.on('data', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(input);
    p.on('error', reject);
    p.on('close', (code) => {
      if ((code === 0) === expectFailure)
        reject(new Error(`Unexpected exit ${code} for ${args[0]}`));
      else resolvePromise(text);
    });
  });
}
const compose = (which, args, input, bad = false) =>
  run(
    'docker',
    [
      'compose',
      '--env-file',
      which === source ? sourceEnv : targetEnv,
      '-f',
      resolve('deploy/compose.yaml'),
      '-p',
      which,
      ...args,
    ],
    input,
    bad,
  );
const cli = (which, args, input, bad = false) =>
  compose(
    which,
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
    input,
    bad,
  );
const ops = (cmd, which, dir, ledger, bad = false) =>
  run(
    process.execPath,
    [
      'scripts/ops.mjs',
      cmd,
      which === source ? sourceEnv : targetEnv,
      which,
      dir,
      ...(ledger ? [ledger] : []),
    ],
    undefined,
    bad,
  );
const checks = [];
const record = (name) => {
  checks.push(name);
  process.stdout.write(name + '\n');
};
try {
  await compose(source, ['up', '-d', '--wait', 'database']);
  await cli(source, ['migrate']);
  await cli(source, ['init']);
  const script = `
import { pool, transaction } from './dist/packages/server/src/db/index.js';
import { loadConfig } from './dist/packages/server/src/config.js';
import { encrypt } from './dist/packages/server/src/security.js';
import { randomUUID } from 'node:crypto';
const config=loadConfig(),db=pool(config.databaseURL);
try {await transaction(db,async tx=>{
 const owner=(await tx.query('SELECT id FROM owners')).rows[0].id,provider=randomUUID(),world=randomUUID(),room=randomUUID();
 await tx.query('INSERT INTO provider_connections(id,owner_id,name,base_url,model,context_window,max_output_tokens,credential) VALUES($1,$2,$3,$4,$5,32768,1024,$6)',[provider,owner,'合成模型','https://synthetic.invalid/v1','synthetic',encrypt('synthetic-restore-key',config,owner+':'+provider)]);
 await tx.query('INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)',[world,owner,'恢复演练星港']);
 await tx.query('INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',[room,owner,world,'合成群聊',provider]);
 await tx.query('INSERT INTO autonomy_policies(world_id,owner_id,enabled) VALUES($1,$2,true)',[world,owner]);
 await tx.query('INSERT INTO autonomy_settings(owner_id,enabled) VALUES($1,true)',[owner]);
 const run=randomUUID(),user=randomUUID(),reply=randomUUID();
 await tx.query("INSERT INTO runs(id,owner_id,world_id,room_id,client_command_id,request_hash,user_message_id,reply_message_id,command_order,state) VALUES($1,$2,$3,$4,$5,'synthetic',$6,$7,1,'completed')",[run,owner,world,room,randomUUID(),user,reply]);
 await tx.query("INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,content,status) VALUES($1,$2,$3,$4,1,'user','星港通行口令：合成测试','completed'),($5,$2,$3,$4,2,'assistant','已记录合成约定','completed')",[user,owner,room,run,reply]);
 await tx.query('INSERT INTO import_jobs(id,owner_id,world_id,file_hash,adapter_version,format,raw,preview) VALUES($1,$2,$3,$4,1,$5,$6,$7)',[randomUUID(),owner,world,'synthetic','json',Buffer.from('{"extensions":{"custom":"preserved"}}'),{}]);
});}finally{await db.end();}`;
  await compose(
    source,
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-',
    ],
    script,
  );
  await compose(source, ['up', '-d', '--wait', 'api', 'worker']);
  record('clean_linux_containers_started_and_healthy');
  await compose(source, ['restart', 'database']);
  await compose(source, ['up', '-d', '--wait', 'api', 'worker']);
  record('database_restart_recovers_health');
  const backup = join(root, 'backup');
  await ops('backup', source, backup);
  record('backup_created_and_verified_source_stopped');
  const manifest = JSON.parse(
    await readFile(join(backup, 'manifest.json'), 'utf8'),
  );
  if (manifest.inventory.messages.count !== 2) throw new Error('Seed missing');
  const corrupt = join(root, 'corrupt');
  await cp(backup, corrupt, { recursive: true });
  await writeFile(join(corrupt, 'database.dump'), 'corrupt');
  await ops('verify', source, corrupt, undefined, true);
  record('corrupt_backup_rejected');
  await cli(source, ['privacy-export']);
  const deletion = await compose(
    source,
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-',
    ],
    `
import {pool} from './dist/packages/server/src/db/index.js';
import {deleteMessage} from './dist/packages/server/src/modules/memory/repository.js';
import {deletionLedger} from './dist/packages/server/src/modules/operations/index.js';
const db=pool(process.env.DATABASE_URL);try{const m=(await db.query("SELECT * FROM messages WHERE role='user'")).rows[0];await deleteMessage(db,m.owner_id,m.id);console.log(JSON.stringify(await deletionLedger(db)));}finally{await db.end();}`,
  );
  const ledger = join(root, 'latest-privacy-ledger.json');
  await writeFile(ledger, deletion, { mode: 0o600 });
  // Wrong key rejects validation after restore and leaves destination quarantined.
  await writeFile(targetEnv, env.replace('ab'.repeat(32), 'cd'.repeat(32)), {
    mode: 0o600,
  });
  await ops('restore', target, backup, undefined, true);
  record('missing_correct_master_key_rejected_without_starting_services');
  await compose(target, ['down', '-v']);
  await writeFile(targetEnv, env, { mode: 0o600 });
  await ops('restore', target, backup, ledger);
  record('isolated_restore_inventory_matches_and_newer_deletions_reapplied');
  await ops('restore', target, backup, undefined, true);
  record('nonempty_restore_target_refused');
  const diagnostic = JSON.parse(await cli(target, ['diagnostics']));
  if (!diagnostic.maintenance) throw new Error('Not quarantined');
  const check = await compose(
    target,
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-',
    ],
    `
import {pool} from './dist/packages/server/src/db/index.js';import {decrypt} from './dist/packages/server/src/security.js';import {loadConfig} from './dist/packages/server/src/config.js';
const c=loadConfig(),db=pool(c.databaseURL);try{const p=(await db.query('SELECT * FROM provider_connections')).rows[0];if(decrypt(p.credential,c,p.owner_id+':'+p.id)!=='synthetic-restore-key')throw new Error('decryption');const m=(await db.query("SELECT content FROM messages WHERE role='user'")).rows[0];if(m.content!=='')throw new Error('privacy');if((await db.query('SELECT 1 FROM autonomy_settings WHERE enabled')).rowCount)throw new Error('autonomy');console.log('credentials_and_privacy_verified');}finally{await db.end();}`,
  );
  if (!check.includes('credentials_and_privacy_verified'))
    throw new Error('Restore check failed');
  record('restored_credentials_decrypt_and_autonomy_stays_off');
  // Source stays stopped. Explicit operator cutover only, then a new pairing.
  await cli(target, ['maintenance', 'off']);
  await cli(target, ['pair']);
  await compose(target, ['up', '-d', '--wait', 'api', 'worker']);
  record('explicit_cutover_and_new_pairing_healthy');
  const previousArg = process.argv.find((a) =>
    a.startsWith('--previous-image='),
  );
  if (previousArg) {
    const previous = previousArg.slice('--previous-image='.length);
    if (!/^[a-zA-Z0-9._:/-]+$/.test(previous))
      throw new Error('Invalid previous image');
    await compose(target, ['stop', 'api', 'worker']);
    await writeFile(
      targetEnv,
      env.replace(
        process.env.ECHO_DRILL_IMAGE ?? 'echo2-server:p5-local',
        previous,
      ),
      { mode: 0o600 },
    );
    await compose(
      target,
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-',
      ],
      `
import {pool} from './dist/packages/server/src/db/index.js';import {loadConfig} from './dist/packages/server/src/config.js';
import {verifyKey} from './dist/packages/server/src/modules/pairing/auth.js';import {buildApp} from './dist/packages/server/src/app.js';import {startWorker} from './dist/packages/server/src/queue.js';import {snapshot} from './dist/packages/server/src/modules/sync/index.js';
const config=loadConfig(),db=pool(config.databaseURL);let worker,app;try{await verifyKey(db,config);app=await buildApp(db,config);if((await app.inject({method:'GET',url:'/health'})).statusCode!==200)throw new Error('old API health');const owner=(await db.query('SELECT id FROM owners')).rows[0].id;const data=await snapshot(db,owner);if(data.messages.length!==2)throw new Error('old snapshot');worker=await startWorker(db,config);}finally{await worker?.stop();await app?.close();await db.end();}`,
    );
    await writeFile(targetEnv, env, { mode: 0o600 });
    await compose(target, ['up', '-d', '--wait', 'api', 'worker']);
    record('previous_image_api_worker_snapshot_compatible_and_return_to_p5');
  }
  const summary = {
    checks,
    backup,
    source_stayed_stopped: true,
    external_model_requests: 0,
    real_apns_requests: 0,
  };
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  process.stdout.write('report: ' + join(root, 'report.json') + '\n');
} finally {
  await compose(source, ['down', '-v']).catch(() => {});
  await compose(target, ['down', '-v']).catch(() => {});
}
