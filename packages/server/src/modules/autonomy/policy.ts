import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import { AppError } from '../../security.js';
import { worldLock } from '../worlds/index.js';
import { emit } from '../sync/index.js';
export const globalDefaults = {
  revision: 1,
  enabled: false,
  timezone: 'Asia/Shanghai',
  tools_read: false,
  tools_write: false,
  request_limit: 20,
  input_limit: 100000,
  output_limit: 10000,
};
export const policyDefaults = {
  revision: 1,
  enabled: false,
  memory: false,
  contact: false,
  interaction: false,
  tools_read: false,
  tools_write: false,
  room_id: null,
  max_turns: 3,
  contact_daily: 3,
  interaction_daily: 4,
  interval_minutes: 120,
  quiet_start: '22:30',
  quiet_end: '08:00',
  quiet_interaction: false,
  request_limit: 20,
  input_limit: 100000,
  output_limit: 10000,
  category_limit: 20,
  last_status: null,
  recap_revision: 0,
};
export function dayAt(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((k) => parts.find((p) => p.type === k)!.value)
    .join('-');
}
export function quietAt(
  now: Date,
  timezone: string,
  start: string,
  end: string,
) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return start === end
    ? false
    : start < end
      ? time >= start && time < end
      : time >= start || time < end;
}
export async function policies(
  db: DB,
  owner: string,
  world: string,
  lock = false,
) {
  // Callers that mutate a world take its lock before these rows. Global edits never acquire world locks.
  if (lock) {
    await db.query(
      'INSERT INTO autonomy_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
      [owner],
    );
    await db.query(
      'INSERT INTO autonomy_policies(owner_id,world_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [owner, world],
    );
  }
  const g = (
    await db.query(
      `SELECT * FROM autonomy_settings WHERE owner_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [owner],
    )
  ).rows[0] ?? { ...globalDefaults, owner_id: owner };
  const p = (
    await db.query(
      `SELECT * FROM autonomy_policies WHERE owner_id=$1 AND world_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [owner, world],
    )
  ).rows[0] ?? { ...policyDefaults, owner_id: owner, world_id: world };
  return { g, p };
}
export function backgroundAllowed(g: any, p: any, kind: string) {
  return (
    g.enabled && p.enabled && p[kind.startsWith('memory') ? 'memory' : kind]
  );
}
export async function validBackground(
  db: DB,
  owner: string,
  world: string,
  kind: string,
  globalRevision?: number,
  policyRevision?: number,
) {
  const { g, p } = await policies(db, owner, world, true);
  return (
    backgroundAllowed(g, p, kind) &&
    (globalRevision === undefined || g.revision === globalRevision) &&
    (policyRevision === undefined || p.revision === policyRevision)
  );
}
export async function validReservation(db: DB, id: string) {
  const u = (await db.query('SELECT * FROM background_usage WHERE id=$1', [id]))
    .rows[0];
  return (
    !!u &&
    (await validBackground(
      db,
      u.owner_id,
      u.world_id,
      u.kind,
      u.global_revision,
      u.policy_revision,
    ))
  );
}
export async function savePolicy(
  db: pg.Pool,
  owner: string,
  world: string | null,
  revision: number,
  input: any,
) {
  return transaction(db, async (tx) => {
    if (world) await worldLock(tx, owner, world);
    if (!world) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
      } catch {
        throw new AppError(400, 'invalid_timezone', 'Use an IANA time zone');
      }
      await tx.query(
        'INSERT INTO autonomy_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [owner],
      );
    } else {
      await policies(tx, owner, world, true);
      if (input.room_id) {
        const room = (
          await tx.query(
            'SELECT kind FROM rooms WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND NOT deleted',
            [owner, world, input.room_id],
          )
        ).rows[0];
        if (
          !room ||
          room.kind === 'legacy' ||
          (input.interaction && room.kind !== 'group')
        )
          throw new AppError(
            400,
            'invalid_autonomy_room',
            'Select a current group room for character interaction',
          );
      } else if (input.contact || input.interaction)
        throw new AppError(400, 'autonomy_room_required', 'Select a room');
    }
    const table = world ? 'autonomy_policies' : 'autonomy_settings',
      key = world ? 'world_id' : 'owner_id';
    const fields = Object.keys(world ? policyDefaults : globalDefaults).filter(
      (k) => !['revision', 'last_status', 'recap_revision'].includes(k),
    );
    const values = fields.map(
      (k) => input[k] ?? (world ? policyDefaults : (globalDefaults as any))[k],
    );
    const row = (
      await tx.query(
        `UPDATE ${table} SET ${fields.map((k, i) => `${k}=$${i + 3}`).join(',')},revision=revision+1 WHERE ${key}=$1 AND revision=$2 RETURNING *`,
        [world ?? owner, revision, ...values],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        409,
        'revision_conflict',
        'Settings changed; reload before saving',
      );
    await emit(
      tx,
      owner,
      world ? 'autonomy_policy' : 'autonomy_settings',
      world ?? owner,
      policyView(row),
    );
    return policyView(row);
  });
}
export function policyView(row: any) {
  const { owner_id, ...rest } = row;
  return { ...rest, id: row.world_id ?? owner_id };
}
export async function autonomyView(db: DB, owner: string, world: string) {
  const exists = (
    await db.query(
      'SELECT id FROM worlds WHERE owner_id=$1 AND id=$2 AND NOT deleted',
      [owner, world],
    )
  ).rowCount;
  if (!exists) throw new AppError(404, 'not_found', 'World not found');
  const { g, p } = await policies(db, owner, world);
  return { global: policyView(g), world: policyView(p) };
}
