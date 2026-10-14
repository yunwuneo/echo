import { randomUUID } from 'node:crypto';
import type { DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError } from '../../security.js';
import { backgroundAllowed, dayAt, policies } from '../autonomy/policy.js';
export async function reserveBackground(
  db: DB,
  config: Config,
  owner: string,
  world: string,
  kind: string,
  input: number,
  output: number,
  manual = false,
) {
  const { g, p } = await policies(db, owner, world, true);
  if (!manual && !backgroundAllowed(g, p, kind))
    throw new AppError(
      429,
      'autonomy_disabled',
      'Background category is paused',
    );
  const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const day = dayAt(now, g.timezone),
    category = kind.startsWith('memory') ? 'memory' : kind;
  await db.query(
    'INSERT INTO background_daily(owner_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [owner, day],
  );
  for (const scope of ['all', category])
    await db.query(
      'INSERT INTO background_scopes(world_id,day,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [world, day, scope],
    );
  const global = (
    await db.query(
      'SELECT * FROM background_daily WHERE owner_id=$1 AND day=$2 FOR UPDATE',
      [owner, day],
    )
  ).rows[0];
  const scopes = (
    await db.query(
      'SELECT * FROM background_scopes WHERE world_id=$1 AND day=$2 AND kind=ANY($3::text[]) FOR UPDATE',
      [world, day, ['all', category]],
    )
  ).rows;
  const over = (r: any, requests: number, ins: number, outs: number) =>
    r.requests + 1 > requests ||
    r.input_tokens + input > ins ||
    r.output_tokens + output > outs;
  if (
    over(
      global,
      Math.min(g.request_limit, config.backgroundRequestLimit),
      Math.min(g.input_limit, config.backgroundInputLimit),
      Math.min(g.output_limit, config.backgroundOutputLimit),
    ) ||
    scopes.some((r) =>
      over(
        r,
        r.kind === 'all' ? p.request_limit : p.category_limit,
        p.input_limit,
        p.output_limit,
      ),
    )
  )
    throw new AppError(
      429,
      'background_budget_exceeded',
      'Background daily budget exhausted',
    );
  await db.query(
    'UPDATE background_daily SET requests=requests+1,input_tokens=input_tokens+$3,output_tokens=output_tokens+$4 WHERE owner_id=$1 AND day=$2',
    [owner, day, input, output],
  );
  await db.query(
    'UPDATE background_scopes SET requests=requests+1,input_tokens=input_tokens+$4,output_tokens=output_tokens+$5 WHERE world_id=$1 AND day=$2 AND kind=ANY($3::text[])',
    [world, day, ['all', category], input, output],
  );
  const id = randomUUID();
  await db.query(
    'INSERT INTO background_usage(id,owner_id,world_id,kind,input_reserved,output_reserved,day,global_revision,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, owner, world, kind, input, output, day, g.revision, p.revision],
  );
  if (manual)
    await db.query('UPDATE background_usage SET manual=true WHERE id=$1', [id]);
  return id;
}
export async function settleBackground(
  db: DB,
  id: string,
  usage: { input: number; output: number } | null,
  error: string | null = null,
) {
  // Keep conservative reservations charged, including lost workers. Actual usage is separate.
  await db.query(
    "UPDATE background_usage SET state=$2,input_tokens=$3,output_tokens=$4,error_code=$5 WHERE id=$1 AND state='reserved'",
    [
      id,
      usage ? 'known' : 'unknown',
      usage?.input ?? null,
      usage?.output ?? null,
      error,
    ],
  );
}
