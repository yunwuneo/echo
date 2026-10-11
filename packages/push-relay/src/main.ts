import { readFile } from 'node:fs/promises';
import { pool } from '../../server/src/db/index.js';
import { loadConfig } from '../../server/src/config.js';
import {
  initializeRelay,
  invite,
  buildRelay,
  type RelayConfig,
} from './app.js';
import { apnsSender } from './apns.js';
const crypto = loadConfig({
  ...process.env,
  MASTER_KEY: process.env.RELAY_MASTER_KEY,
});
const db = pool(crypto.databaseURL);
try {
  const topics = (process.env.APNS_TOPICS ?? process.env.APNS_TOPIC ?? '')
    .split(',')
    .filter(Boolean);
  const topic = topics[0],
    environment = process.env.APNS_ENVIRONMENT;
  if (
    !topic ||
    topics.length > 10 ||
    topics.some((t) => !/^[A-Za-z0-9.-]{3,200}$/.test(t)) ||
    !['sandbox', 'production'].includes(environment ?? '')
  )
    throw new Error('Relay configuration required');
  const config: RelayConfig = {
    crypto,
    topic,
    topics,
    environment: environment as RelayConfig['environment'],
  };
  await initializeRelay(db, config);
  if (process.argv[2] === 'invite') {
    const selected = process.argv[3] ?? topic;
    if (!topics.includes(selected)) throw new Error('Topic is not allowed');
    process.stdout.write(
      JSON.stringify({
        invitation: await invite(db, { ...config, topic: selected }),
        expires_in: 600,
      }) + '\n',
    );
    await db.end();
  } else {
    const send = apnsSender(
      process.env.APNS_TEAM_ID ?? '',
      process.env.APNS_KEY_ID ?? '',
      await readFile(process.env.APNS_KEY_FILE ?? '', 'utf8'),
    );
    const app = buildRelay(db, config, send);
    await app.listen({ port: crypto.port, host: '0.0.0.0' });
    // Retain idempotency rows through ticket expiry; expired tickets can never replay old IDs.
    const cleanup = setInterval(() => {
      void db
        .query(
          'DELETE FROM push_relay.deliveries WHERE ticket_hash IN (SELECT hash FROM push_relay.tickets WHERE expires_at<now())',
        )
        .then(() =>
          db.query('DELETE FROM push_relay.tickets WHERE expires_at<now()'),
        )
        .then(() =>
          db.query(
            "DELETE FROM push_relay.invitations WHERE expires_at<now(); DELETE FROM push_relay.limits WHERE window_start<now()-interval '2 hours'",
          ),
        )
        .catch(() => process.stderr.write('relay_cleanup_failed\n'));
    }, 3600000);
    const stop = async () => {
      clearInterval(cleanup);
      await app.close();
      await db.end();
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    process.stdout.write('relay_ready\n');
  }
} catch {
  await db.end();
  process.stderr.write(
    'relay_failed: check database, relay key, APNs configuration\n',
  );
  process.exitCode = 1;
}
