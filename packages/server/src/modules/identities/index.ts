import { unresolvedEffects } from '../commands/effects.js';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';
import { command } from '../commands/index.js';
import { editEntityTx, worldLock, type Resource } from '../worlds/index.js';
const tables = {
  worlds: 'worlds',
  characters: 'character_templates',
  actors: 'world_characters',
  rooms: 'rooms',
  lore: 'lore_entries',
};
export async function deletionPreview(
  db: DB,
  owner: string,
  resource: Resource,
  id: string,
) {
  const row = (
    await db.query(
      `SELECT * FROM ${tables[resource]} WHERE owner_id=$1 AND id=$2 AND NOT deleted`,
      [owner, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Record not found');
  const rooms =
    resource === 'actors'
      ? (
          await db.query(
            'SELECT r.id,r.name,r.revision,rm.left_at FROM rooms r JOIN room_memberships rm ON rm.room_id=r.id WHERE rm.actor_id=$1 AND NOT r.deleted ORDER BY r.id',
            [id],
          )
        ).rows
      : resource === 'worlds'
        ? (
            await db.query(
              'SELECT id,name,revision FROM rooms WHERE world_id=$1 AND NOT deleted ORDER BY id',
              [id],
            )
          ).rows
        : [];
  const instances =
    resource === 'characters'
      ? (
          await db.query(
            'SELECT id,name,revision FROM world_characters WHERE template_id=$1 AND NOT deleted ORDER BY id',
            [id],
          )
        ).rows
      : [];
  const active = (
    await db.query(
      "SELECT id FROM runs WHERE owner_id=$1 AND (world_id=$2 OR room_id=$2 OR $2=ANY(COALESCE(speaker_ids,'{}'::uuid[]))) AND state IN ('queued','running','awaiting_approval','remote_pending') ORDER BY id",
      [owner, id],
    )
  ).rows;
  const assets = (
    await db.query(
      'SELECT a.id,a.revision,a.size,count(r.asset_id)::int AS references FROM assets a LEFT JOIN asset_references r ON r.asset_id=a.id WHERE a.owner_id=$1 AND (a.actor_id=$2 OR a.world_id=$2) GROUP BY a.id ORDER BY a.id',
      [owner, id],
    )
  ).rows;
  const projects = (
    await db.query(
      'SELECT p.id,p.name,p.revision,count(d.id)::int AS documents FROM projects p LEFT JOIN documents d ON d.project_id=p.id WHERE p.owner_id=$1 AND (p.world_id=$2 OR p.actor_id=$2) GROUP BY p.id ORDER BY p.id',
      [owner, id],
    )
  ).rows;
  const apps = (
    await db.query(
      'SELECT m.id,m.title,m.revision,m.state_revision FROM miniapps m JOIN world_characters a ON a.id=m.actor_id WHERE m.owner_id=$1 AND (m.actor_id=$2 OR a.world_id=$2) ORDER BY m.id',
      [owner, id],
    )
  ).rows;
  const media = (
    await db.query(
      'SELECT id,state FROM media_jobs WHERE owner_id=$1 AND (actor_id=$2 OR world_id=$2) ORDER BY id',
      [owner, id],
    )
  ).rows;
  const runtimes = (
    await db.query(
      "SELECT s.id,s.status FROM runtime_sessions s JOIN miniapps m ON m.id=s.app_id JOIN world_characters a ON a.id=m.actor_id WHERE s.owner_id=$1 AND (m.actor_id=$2 OR a.world_id=$2) AND s.status IN ('open','executing') AND s.expires_at>now()",
      [owner, id],
    )
  ).rows;
  const effects = await unresolvedEffects(db, owner, id);
  const value = {
    unresolved_effects: effects,
    apps,
    media,
    runtimes,
    id,
    resource,
    revision: row.revision,
    rooms,
    instances,
    projects,
    active_runs: active,
    assets,
    can_delete:
      !effects.length &&
      !active.length &&
      !runtimes.length &&
      !media.some((m) =>
        ['queued', 'submitting', 'polling'].includes(m.state),
      ) &&
      !instances.length &&
      !(resource === 'actors' && rooms.some((r) => r.left_at === null)),
    content_policy:
      'historical_content_retained; use explicit source erasure for privacy; shared originals retained',
  };
  return { ...value, preview_token: hash(canonical(value)) };
}
export async function deleteWithPreview(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    resource: Resource;
    expected_revision: number;
    preview_token: string;
  },
) {
  return command(
    db,
    owner,
    'entity.remove',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const row = (
        await tx.query(
          `SELECT * FROM ${tables[input.resource]} WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        )
      ).rows[0];
      if (row && (row.world_id || input.resource === 'worlds'))
        await worldLock(tx, owner, row.world_id ?? id);
      const preview = await deletionPreview(tx, owner, input.resource, id);
      if (
        preview.preview_token !== input.preview_token ||
        preview.revision !== input.expected_revision
      )
        throw new AppError(
          409,
          'revision_conflict',
          'Refresh deletion preview',
        );
      if (!preview.can_delete)
        throw new AppError(
          409,
          'resource_in_use',
          'Remove active relationships first; shared content is retained',
        );
      await editEntityTx(
        tx,
        owner,
        input.resource,
        'DELETE',
        null,
        id,
        input.expected_revision,
      );
      return { id, deleted: true };
    },
  );
}
