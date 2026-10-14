import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  HostRunner,
  type HostConfiguration,
} from '../packages/server/src/modules/hosts/runner.js';
import { hostHTTP } from '../packages/server/src/modules/hosts/client.js';
import { journalWrite } from '../packages/server/src/modules/hosts/files.js';
import { canonical } from '../packages/server/src/modules/mcp/schema.js';
import { loadConfig } from '../packages/server/src/config.js';
// This standalone runner has no database and never uses a cloud model key.
const config = loadConfig({
  DATABASE_URL: 'unused-host-runner',
  MASTER_KEY: '00'.repeat(32),
  ALLOW_INSECURE_LOCAL: process.env.ALLOW_INSECURE_LOCAL,
});
const [action, path, evidencePath] = process.argv.slice(2);
if (!path || !['pair', 'run', 'once', 'resolve'].includes(action ?? ''))
  throw Error(
    'Usage: npm run host -- pair|run|once|resolve /absolute/private/config.json [evidence.json]',
  );
const file = resolve(path);
const info = await stat(file);
if ((info.mode & 0o077) !== 0)
  throw Error('Host configuration must be private (chmod 600)');
let host = JSON.parse(await readFile(file, 'utf8')) as HostConfiguration & {
  pairing_id?: string;
  code?: string;
  name?: string;
};
if (action === 'pair') {
  if (!host.pairing_id || !host.code || !host.name)
    throw Error(
      'Set cloud_url, pairing_id, code and name in the private configuration',
    );
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const proof = sign(
    null,
    Buffer.from(
      canonical({
        pairing_id: host.pairing_id,
        code: host.code,
        name: host.name,
      }),
    ),
    keys.privateKey,
  ).toString('base64');
  const result = await hostHTTP(config, host.cloud_url, '/v1/hosts/pair', {
    protocolVersion: 1,
    pairing_id: host.pairing_id,
    code: host.code,
    name: host.name,
    public_key: publicKey,
    proof,
  });
  host = {
    ...host,
    host_id: result.host_id,
    token: result.token,
    private_key: keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    roots: host.roots ?? {},
    identities: host.identities ?? {},
  };
  delete host.code;
  delete host.pairing_id;
  await journalWrite(file, host);
  process.stdout.write(
    'Host paired; configure independent identities and authorized roots before running.\n',
  );
} else {
  if (!host.journal || !host.host_id || !host.private_key || !host.token)
    throw Error('Incomplete Host configuration');
  const runner = new HostRunner(config, host, async (value) => {
    await journalWrite(file, value);
  });
  if (action === 'resolve') {
    if (!evidencePath) throw Error('An explicit evidence file is required');
    const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
    await runner.resolve(evidence.job_id, evidence);
    process.stdout.write(
      'Reconciliation receipt stored. No external action was repeated.\n',
    );
    process.exit(0);
  }
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });
  do {
    try {
      await runner.tick();
    } catch {
      process.stderr.write(
        'Host connection unavailable; durable jobs will be reconciled on reconnect.\n',
      );
    }
    if (action === 'once' || stopping) break;
    await new Promise((r) => setTimeout(r, 5000));
  } while (!stopping);
}
