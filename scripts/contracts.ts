import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../packages/server/src/app.js';
import { pool } from '../packages/server/src/db/index.js';
import type { Config } from '../packages/server/src/config.js';
const db = pool('postgresql://unused:unused@127.0.0.1/unused');
const config = {
  databaseURL: '',
  publicURL: 'https://localhost',
  masterKey: Buffer.alloc(32),
  keyVersion: 1,
  allowInsecureLocal: false,
  port: 3000,
  leaseMs: 15000,
  modelTimeoutMs: 120000,
  dailyRequestLimit: 100,
  backgroundRequestLimit: 20,
  backgroundInputLimit: 100000,
  backgroundOutputLimit: 10000,
} satisfies Config;
const app = await buildApp(db, config);
await app.ready();
const files = [
    new URL('../packages/contracts/openapi.json', import.meta.url),
    new URL(
      '../apps/apple/Packages/CompanionCore/Sources/CompanionCore/openapi.json',
      import.meta.url,
    ),
  ],
  output = JSON.stringify(app.swagger(), null, 2) + '\n';
for (const file of files) {
  if (process.argv.includes('--check')) {
    if ((await readFile(file, 'utf8')) !== output)
      throw new Error('OpenAPI drift: run npm run contracts:generate');
  } else await writeFile(file, output);
}
await app.close();
await db.end();
