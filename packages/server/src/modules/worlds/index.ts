import { unresolvedEffects } from '../commands/effects.js';
import { validateLore } from '../lorebooks/index.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import { command } from '../commands/index.js';
import { AppError } from '../../security.js';
import { emit } from '../sync/index.js';

export const worldView = (r: any) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  persona: r.persona,
  revision: r.revision,
});
export const characterView = (r: any) => ({
  id: r.id,
  revision: r.revision,
  ...r.data,
});
export const actorView = (r: any) => ({
  id: r.id,
  world_id: r.world_id,
  template_id: r.template_id,
  template_revision: r.template_revision,
  name: r.name,
  participation: r.participation,
  revision: r.revision,
});
export const loreView = (r: any) => ({
  id: r.id,
  world_id: r.world_id,
  revision: r.revision,
  match_mode: 'keywords',
  sticky_turns: 0,
  cooldown_turns: 0,
  delay_turns: 0,
  ...r.data,
});
export const stateView = (r: any) => ({
  world_id: r.world_id,
  revision: r.revision,
  data: r.data,
  audience_actor_ids: r.audience_actor_ids,
});
export const eventView = (r: any) => ({
  id: r.id,
  world_id: r.world_id,
  run_id: r.run_id,
  message_id: r.message_id,
  kind: r.kind,
  revision: r.revision,
  data: r.data,
  audience_actor_ids: r.audience_actor_ids,
  invalidated: r.invalidated,
  created_at: new Date(r.created_at).toISOString(),
});
export async function roomView(db: DB, r: any) {
  const members = (
    await db.query(
      'SELECT actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL ORDER BY actor_id',
      [r.id],
    )
  ).rows;
  return {
    id: r.id,
    world_id: r.world_id,
    name: r.name,
    provider_id: r.provider_id,
    revision: r.revision,
    kind: r.kind,
    max_replies: r.max_replies,
    behavior: r.behavior,
    parent_group_id: r.parent_group_id,
    lane_actor_id: r.lane_actor_id,
    memory_participation: r.memory_participation,
    actor_ids: members.map((m) => m.actor_id),
  };
}
export async function worldLock(db: DB, owner: string, id: string) {
  const row = (
    await db.query(
      'SELECT * FROM worlds WHERE owner_id=$1 AND id=$2 AND NOT deleted FOR UPDATE',
      [owner, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'World not found');
  return row;
}
export async function archiveRevision(
  db: DB,
  owner: string,
  kind: string,
  id: string,
  view: any,
) {
  await db.query(
    'INSERT INTO configuration_revisions(owner_id,kind,entity_id,revision,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [owner, kind, id, view.revision, JSON.stringify(view)],
  );
}
export async function bumpWorld(db: DB, owner: string, id: string) {
  const r = (
    await db.query(
      'UPDATE worlds SET revision=revision+1 WHERE owner_id=$1 AND id=$2 RETURNING *',
      [owner, id],
    )
  ).rows[0];
  await archiveRevision(db, owner, 'world', id, worldView(r));
  await emit(db, owner, 'world', id, worldView(r));
  return r.revision as number;
}
export function matchRevision(row: any, revision?: number) {
  if (!row) throw new AppError(404, 'not_found', 'Record not found');
  if (row.revision !== revision)
    throw new AppError(
      409,
      'revision_conflict',
      'Configuration changed. Reload and compare before saving.',
    );
}
export async function validateActors(
  db: DB,
  owner: string,
  world: string,
  ids: string[],
) {
  const rows = (
    await db.query(
      'SELECT id FROM world_characters WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::uuid[]) AND NOT deleted',
      [owner, world, ids],
    )
  ).rows;
  if (new Set(ids).size !== ids.length || rows.length !== ids.length)
    throw new AppError(
      400,
      'invalid_actor',
      'Actors must belong to this world',
    );
}
const tables = {
  worlds: 'worlds',
  characters: 'character_templates',
  actors: 'world_characters',
  rooms: 'rooms',
  lore: 'lore_entries',
} as const;
export type Resource = keyof typeof tables;
export async function editEntity(
  db: pg.Pool,
  owner: string,
  resource: Resource,
  method: string,
  body: any,
  id: string = randomUUID(),
  revision?: number,
  operation?: string,
) {
  const apply = async (tx: pg.PoolClient) =>
    editEntityTx(tx, owner, resource, method, body, id, revision);
  if (!operation) return transaction(db, apply);
  const saved = await command(
    db,
    owner,
    `entity.${resource}.${method}`,
    operation,
    {
      id: method === 'POST' ? null : id,
      revision: revision ?? null,
      body: body ?? null,
    },
    async (tx) => {
      const view = await apply(tx);
      return { id: view?.id ?? id };
    },
  );
  if (method === 'DELETE') return null;
  return entityView(db, owner, resource, saved.id);
}
export async function entityView(
  db: DB,
  owner: string,
  resource: Resource,
  id: string,
) {
  const row = (
    await db.query(
      `SELECT * FROM ${tables[resource]} WHERE owner_id=$1 AND id=$2`,
      [owner, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Record not found');
  if (resource === 'characters')
    return characterView({
      ...row,
      data: (
        await db.query(
          'SELECT data FROM character_versions WHERE template_id=$1 AND revision=$2',
          [id, row.revision],
        )
      ).rows[0].data,
    });
  if (resource === 'rooms') return roomView(db, row);
  return ({ worlds: worldView, actors: actorView, lore: loreView } as const)[
    resource
  ](row);
}
export async function editEntityTx(
  tx: pg.PoolClient,
  owner: string,
  resource: Resource,
  method: string,
  body: any,
  id: string = randomUUID(),
  revision?: number,
) {
  await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
    owner,
  ]);
  const table = tables[resource];
  const create = method === 'POST',
    remove = method === 'DELETE';
  let previous = create
    ? null
    : (
        await tx.query(
          `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2 AND NOT deleted`,
          [owner, id],
        )
      ).rows[0];
  const world =
    resource === 'worlds' ? id : (previous?.world_id ?? body?.world_id);
  if (world && !(resource === 'worlds' && create))
    await worldLock(tx, owner, world);
  if (!create) {
    previous = (
      await tx.query(
        `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2 AND NOT deleted FOR UPDATE`,
        [owner, id],
      )
    ).rows[0];
    matchRevision(previous, revision);
  }
  if (
    previous?.world_id &&
    body?.world_id &&
    body.world_id !== previous.world_id
  )
    throw new AppError(
      400,
      'immutable_world',
      'A record cannot move between worlds',
    );
  if (remove) {
    if (
      resource === 'characters' &&
      (
        await tx.query(
          'SELECT 1 FROM world_characters WHERE template_id=$1 AND NOT deleted',
          [id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        'template_in_world',
        'Remove world instances before deleting their template',
      );
    if (
      resource === 'actors' &&
      (
        await tx.query(
          'SELECT 1 FROM room_memberships WHERE actor_id=$1 AND left_at IS NULL',
          [id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        'actor_in_room',
        'Remove the actor from rooms first',
      );
    if (
      (resource === 'worlds' || resource === 'rooms') &&
      (
        await tx.query(
          `SELECT 1 FROM runs WHERE ${resource === 'worlds' ? 'world_id' : 'room_id'}=$1 AND state IN ('queued','running','awaiting_approval','remote_pending')`,
          [id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        'active_runs',
        'Cancel active runs before deleting',
      );
    if ((await unresolvedEffects(tx, owner, id)).length)
      throw new AppError(
        409,
        'reconciliation_required',
        'Reconcile pending external effects before deleting their source',
      );
    await tx.query(
      `UPDATE ${table} SET deleted=true,revision=revision+1 WHERE id=$1`,
      [id],
    );
    if (resource === 'rooms')
      await tx.query(
        'UPDATE room_memberships SET left_at=now() WHERE room_id=$1',
        [id],
      );
    if (resource === 'worlds') {
      for (const [child, kind] of [
        ['rooms', 'room'],
        ['world_characters', 'actor'],
        ['lore_entries', 'lore'],
      ] as const) {
        const rows = (
          await tx.query(
            `UPDATE ${child} SET deleted=true WHERE world_id=$1 RETURNING id`,
            [id],
          )
        ).rows;
        for (const row of rows)
          await emit(tx, owner, `${kind}_deleted`, row.id, { id: row.id });
      }
      await tx.query(
        'UPDATE room_memberships SET left_at=now() WHERE world_id=$1',
        [id],
      );
    } else if (world) await bumpWorld(tx, owner, world);
    await emit(
      tx,
      owner,
      `${{ worlds: 'world', characters: 'character', actors: 'actor', rooms: 'room', lore: 'lore' }[resource]}_deleted`,
      id,
      { id },
    );
    return null;
  }
  let row: any, view: any, kind: string;
  if (resource === 'worlds') {
    row = (
      await tx.query(
        create
          ? 'INSERT INTO worlds(id,owner_id,name,description,persona) VALUES($1,$2,$3,$4,$5) RETURNING *'
          : 'UPDATE worlds SET name=$3,description=$4,persona=$5,revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING *',
        [id, owner, body.name, body.description, JSON.stringify(body.persona)],
      )
    ).rows[0];
    if (create) {
      await tx.query(
        'INSERT INTO memory_settings(world_id,owner_id) VALUES($1,$2)',
        [id, owner],
      );
      await emit(tx, owner, 'memory_settings', id, {
        world_id: id,
        revision: 1,
        enabled: false,
        embedding_provider_id: null,
        embedding_dimensions: 0,
        index_version: 1,
      });
      const state = (
        await tx.query(
          'INSERT INTO world_state(world_id,owner_id) VALUES($1,$2) RETURNING *',
          [id, owner],
        )
      ).rows[0];
      await archiveRevision(tx, owner, 'state', id, stateView(state));
      await emit(tx, owner, 'state', id, stateView(state));
    }
    kind = 'world';
    view = worldView(row);
  } else if (resource === 'characters') {
    row = (
      await tx.query(
        create
          ? 'INSERT INTO character_templates(id,owner_id) VALUES($1,$2) RETURNING *'
          : 'UPDATE character_templates SET revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING *',
        [id, owner],
      )
    ).rows[0];
    if (!create)
      body = {
        ...(
          await tx.query(
            'SELECT data FROM character_versions WHERE template_id=$1 AND revision=$2',
            [id, row.revision - 1],
          )
        ).rows[0].data,
        ...body,
      };
    await tx.query(
      'INSERT INTO character_versions(template_id,owner_id,revision,data) VALUES($1,$2,$3,$4)',
      [id, owner, row.revision, JSON.stringify(body)],
    );
    kind = 'character';
    view = characterView({ ...row, data: body });
  } else if (resource === 'actors') {
    const version = (
      await tx.query(
        'SELECT 1 FROM character_versions v JOIN character_templates t ON t.id=v.template_id WHERE v.owner_id=$1 AND v.template_id=$2 AND v.revision=$3 AND NOT t.deleted',
        [owner, body.template_id, body.template_revision],
      )
    ).rowCount;
    if (!version)
      throw new AppError(400, 'invalid_version', 'Character version not found');
    row = (
      await tx.query(
        create
          ? 'INSERT INTO world_characters(id,owner_id,world_id,template_id,template_revision,name,participation) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *'
          : 'UPDATE world_characters SET template_id=$4,template_revision=$5,name=$6,participation=$7,revision=revision+1 WHERE id=$1 AND owner_id=$2 AND world_id=$3 RETURNING *',
        [
          id,
          owner,
          world,
          body.template_id,
          body.template_revision,
          body.name,
          body.participation,
        ],
      )
    ).rows[0];
    kind = 'actor';
    view = actorView(row);
  } else if (resource === 'rooms') {
    if (
      previous?.parent_group_id &&
      (body.kind !== 'direct' ||
        body.actor_ids.length !== 1 ||
        body.actor_ids[0] !== previous.lane_actor_id)
    )
      throw new AppError(
        409,
        'private_lane_membership',
        'Private lane belongs to its original member',
      );
    await validateActors(tx, owner, world, body.actor_ids);
    if (body.kind === 'direct' && body.actor_ids.length !== 1)
      throw new AppError(
        400,
        'invalid_members',
        'Direct rooms require one actor',
      );
    if (
      !(
        await tx.query(
          'SELECT 1 FROM provider_connections WHERE owner_id=$1 AND id=$2',
          [owner, body.provider_id],
        )
      ).rowCount
    )
      throw new AppError(400, 'invalid_provider', 'Provider not found');
    row = (
      await tx.query(
        create
          ? 'INSERT INTO rooms(id,owner_id,world_id,name,provider_id,kind,max_replies) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *'
          : 'UPDATE rooms SET name=$4,provider_id=$5,kind=$6,max_replies=$7,revision=revision+1 WHERE id=$1 AND owner_id=$2 AND world_id=$3 RETURNING *',
        [
          id,
          owner,
          world,
          body.name,
          body.provider_id,
          body.kind,
          body.max_replies,
        ],
      )
    ).rows[0];
    await tx.query(
      'UPDATE room_memberships SET left_at=now() WHERE room_id=$1 AND NOT(actor_id=ANY($2::uuid[])) AND left_at IS NULL',
      [id, body.actor_ids],
    );
    for (const actor of body.actor_ids)
      await tx.query(
        'INSERT INTO room_memberships(owner_id,world_id,room_id,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,actor_id) DO UPDATE SET joined_at=CASE WHEN room_memberships.left_at IS NULL THEN room_memberships.joined_at ELSE now() END,left_at=NULL',
        [owner, world, id, actor],
      );
    if (create) {
      const defaults = (
        await tx.query(
          'SELECT behavior FROM conversation_defaults WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
      if (defaults)
        row = (
          await tx.query(
            'UPDATE rooms SET behavior=$2 WHERE id=$1 RETURNING *',
            [
              id,
              JSON.stringify({ ...defaults.behavior, start_message_id: null }),
            ],
          )
        ).rows[0];
    }
    if (
      body.behavior?.start_message_id &&
      !(
        await tx.query(
          "SELECT 1 FROM messages WHERE owner_id=$1 AND room_id=$2 AND id=$3 AND status='completed' AND NOT internal",
          [owner, id, body.behavior.start_message_id],
        )
      ).rowCount
    )
      throw new AppError(
        404,
        'not_found',
        'History anchor not in conversation',
      );
    if (body.behavior)
      row = (
        await tx.query('UPDATE rooms SET behavior=$2 WHERE id=$1 RETURNING *', [
          id,
          JSON.stringify(body.behavior),
        ])
      ).rows[0];
    kind = 'room';
    view = await roomView(tx, row);
  } else {
    await validateActors(tx, owner, world, body.audience_actor_ids);
    // Optional new fields preserve P3 settings when a P2 client edits a record.
    const { world_id: _, ...data } = { ...previous?.data, ...body };
    validateLore(data);
    row = (
      await tx.query(
        create
          ? 'INSERT INTO lore_entries(id,owner_id,world_id,data) VALUES($1,$2,$3,$4) RETURNING *'
          : 'UPDATE lore_entries SET data=$4,revision=revision+1 WHERE id=$1 AND owner_id=$2 AND world_id=$3 RETURNING *',
        [id, owner, world, JSON.stringify(data)],
      )
    ).rows[0];
    kind = 'lore';
    view = loreView(row);
  }
  if (world && resource !== 'worlds') await bumpWorld(tx, owner, world);
  await archiveRevision(tx, owner, kind, id, view);
  await emit(tx, owner, kind, id, view);
  return view;
}
export async function correctState(
  db: pg.Pool,
  owner: string,
  world: string,
  revision: number,
  body: any,
) {
  return transaction(db, async (tx) => {
    await worldLock(tx, owner, world);
    await tx.query(
      'INSERT INTO world_state(world_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [world, owner],
    );
    const before = (
      await tx.query('SELECT * FROM world_state WHERE world_id=$1 FOR UPDATE', [
        world,
      ])
    ).rows[0];
    matchRevision(before, revision);
    await validateActors(tx, owner, world, body.audience_actor_ids);
    await validateActors(tx, owner, world, body.data.present_actor_ids);
    const row = (
      await tx.query(
        'UPDATE world_state SET data=$2,audience_actor_ids=$3,revision=revision+1 WHERE world_id=$1 RETURNING *',
        [world, JSON.stringify(body.data), body.audience_actor_ids],
      )
    ).rows[0];
    const nextRevision = await bumpWorld(tx, owner, world);
    await addEvent(
      tx,
      owner,
      world,
      'user_correction',
      nextRevision,
      { state_revision: row.revision, data: body.data },
      body.audience_actor_ids,
    );
    await archiveRevision(tx, owner, 'state', world, stateView(row));
    await emit(tx, owner, 'state', world, stateView(row));
    return stateView(row);
  });
}
export async function addEvent(
  db: DB,
  owner: string,
  world: string,
  kind: string,
  revision: number,
  data: unknown,
  audience: string[],
  run: string | null = null,
  message: string | null = null,
) {
  const event = (
    await db.query(
      'INSERT INTO world_events(id,owner_id,world_id,kind,revision,data,audience_actor_ids,run_id,message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(message_id,kind) DO NOTHING RETURNING *',
      [
        randomUUID(),
        owner,
        world,
        kind,
        revision,
        JSON.stringify(data),
        audience,
        run,
        message,
      ],
    )
  ).rows[0];
  if (event) await emit(db, owner, 'world_event', event.id, eventView(event));
}
