import { readFile } from 'node:fs/promises';
import {
  setMaintenance,
  rotateKey,
  prepareRestored,
  diagnostics,
  offline,
  inventory,
  deletionLedger,
  applyDeletionLedger,
} from './modules/operations/index.js';
import { exportOwner } from './modules/exports/index.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { pool, transaction } from './db/index.js';
import { migrate } from './db/migrate.js';
import {
  createPairingCode,
  initializeOwner,
  verifyKey,
} from './modules/pairing/auth.js';
const config = loadConfig(),
  db = pool(config.databaseURL);
try {
  const command = process.argv[2];
  if (command === 'migrate') {
    await migrate(db, pathToFileURL(resolve('migrations') + '/'));
    process.stdout.write('migrations_applied\n');
  } else if (command === 'init') {
    const owner = await initializeOwner(db, config);
    process.stdout.write(
      JSON.stringify({
        owner_id: owner,
        ...(await createPairingCode(db, owner)),
      }) + '\n',
    );
  } else {
    await verifyKey(db, config);
    const owner = (await db.query('SELECT id FROM owners')).rows[0]?.id;
    if (!owner) throw new Error('Initialize owner first');
    if (command === 'maintenance') {
      const mode = process.argv[3];
      if (!['on', 'off'].includes(mode ?? ''))
        throw new Error('Use maintenance on|off');
      await setMaintenance(db, mode === 'on');
      process.stdout.write(
        JSON.stringify({ maintenance: mode === 'on' }) + '\n',
      );
    } else if (command === 'diagnostics')
      process.stdout.write(JSON.stringify(await diagnostics(db)) + '\n');
    else if (command === 'backup-check')
      process.stdout.write(
        JSON.stringify(
          await offline(db, async (tx) => ({
            diagnostics: await diagnostics(tx),
            inventory: await inventory(tx),
          })),
        ) + '\n',
      );
    else if (command === 'restore-prepare')
      process.stdout.write(
        JSON.stringify(await prepareRestored(db, config)) + '\n',
      );
    else if (command === 'privacy-export')
      process.stdout.write(JSON.stringify(await deletionLedger(db)) + '\n');
    else if (command === 'privacy-apply') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new Error('Ledger too large');
        chunks.push(chunk);
      }
      // Hold the exclusive process lock across all deletion transactions.
      process.stdout.write(
        JSON.stringify(
          await offline(db, () =>
            applyDeletionLedger(
              db,
              JSON.parse(Buffer.concat(chunks).toString('utf8')),
            ),
          ),
        ) + '\n',
      );
    } else if (command === 'export')
      process.stdout.write(JSON.stringify(await exportOwner(db, owner)) + '\n');
    else if (command === 'rotate-key') {
      if (!process.env.NEW_MASTER_KEY_FILE)
        throw new Error('NEW_MASTER_KEY_FILE required');
      const next = loadConfig({
        ...process.env,
        MASTER_KEY: (
          await readFile(process.env.NEW_MASTER_KEY_FILE, 'utf8')
        ).trim(),
        MASTER_KEY_VERSION: String(config.keyVersion + 1),
      });
      process.stdout.write(
        JSON.stringify(await rotateKey(db, config, next)) + '\n',
      );
    } else if (command === 'pair')
      process.stdout.write(
        JSON.stringify(await createPairingCode(db, owner)) + '\n',
      );
    else if (command === 'seed') {
      const provider = process.argv[3];
      if (!provider) throw new Error('Provide a provider ID after seed');
      const ids = await transaction(db, async (tx) => {
        const p = (
          await tx.query(
            'SELECT id FROM provider_connections WHERE owner_id=$1 AND id=$2',
            [owner, provider],
          )
        ).rowCount;
        if (!p) throw new Error('Provider unavailable');
        const world = randomUUID(),
          room = randomUUID();
        await tx.query(
          'INSERT INTO worlds(id,owner_id,name) VALUES($1,$2,$3)',
          [world, owner, '星港 · P1 协议验证'],
        );
        await tx.query(
          'INSERT INTO memory_settings(world_id,owner_id) VALUES($1,$2)',
          [world, owner],
        );
        await tx.query(
          'INSERT INTO rooms(id,owner_id,world_id,name,provider_id) VALUES($1,$2,$3,$4,$5)',
          [room, owner, world, '文本验证室', provider],
        );
        return { world_id: world, room_id: room };
      });
      process.stdout.write(JSON.stringify(ids) + '\n');
    } else
      throw new Error(
        'Use migrate, init, pair, seed, diagnostics, maintenance, backup-check, restore-prepare, privacy-export, privacy-apply, export or rotate-key',
      );
  }
} catch {
  process.stderr.write(
    'cli_failed: check command, configuration and database\n',
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
