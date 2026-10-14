import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import type { Config } from '../../config.js';
import { hash } from '../../security.js';
import { embedContent } from './embeddings.js';
import { validReservation } from '../autonomy/policy.js';
import { worldLock } from '../worlds/index.js';
import type { QueryVector } from './retrieval.js';
const allowed = `m.owner_id=a.owner_id AND m.status='completed' AND NOT m.internal AND NOT m.memory_excluded AND r.memory_participation AND NOT r.deleted AND (COALESCE(p.vector_scope,'both')='both' OR m.role='user') AND EXISTS(SELECT 1 FROM message_audiences u WHERE u.message_id=m.id AND u.actor_id=a.id) AND EXISTS(SELECT 1 FROM room_memberships u WHERE u.room_id=r.id AND u.actor_id=a.id AND u.left_at IS NULL)`;
export async function rebuildSourceVectors(
  db: pg.Pool,
  config: Config,
  world: string,
  signal?: AbortSignal,
) {
  const actors = (
    await db.query(
      "SELECT a.id,a.owner_id,COALESCE(p.vector_scope,'both') AS scope,s.index_version FROM world_characters a JOIN memory_settings s ON s.world_id=a.world_id LEFT JOIN memory_policies p ON p.actor_id=a.id WHERE a.world_id=$1 AND NOT a.deleted AND s.embedding_provider_id IS NOT NULL",
      [world],
    )
  ).rows;
  for (const actor of actors) {
    const m = (
      await db.query(
        `SELECT m.* FROM messages m JOIN rooms r ON r.id=m.room_id JOIN world_characters a ON a.id=$1 LEFT JOIN memory_policies p ON p.actor_id=a.id LEFT JOIN memory_source_vectors v ON v.actor_id=a.id AND v.message_id=m.id AND v.index_version=$2 AND v.scope=$3 AND v.revision=m.revision WHERE r.world_id=$4 AND ${allowed} AND v.message_id IS NULL AND NOT EXISTS(SELECT 1 FROM memory_source_shards f WHERE f.actor_id=a.id AND f.message_id=m.id AND f.index_version=$2 AND f.scope=$3 AND f.state='skipped') ORDER BY m.created_at LIMIT 1`,
        [actor.id, actor.index_version, actor.scope, world],
      )
    ).rows[0];
    if (!m) {
      await transaction(db, async (tx) => {
        await worldLock(tx, actor.owner_id, world);
        const current = (
          await tx.query(
            "SELECT s.index_version,COALESCE(p.vector_scope,'both') AS scope FROM memory_settings s LEFT JOIN memory_policies p ON p.actor_id=$2 WHERE s.world_id=$1",
            [world, actor.id],
          )
        ).rows[0];
        if (
          current?.index_version !== actor.index_version ||
          current.scope !== actor.scope
        )
          return;
        await tx.query(
          'INSERT INTO memory_source_indexes(actor_id,active_version,active_scope) VALUES($1,$2,$3) ON CONFLICT(actor_id) DO UPDATE SET active_version=$2,active_scope=$3',
          [actor.id, actor.index_version, actor.scope],
        );
        await tx.query(
          'DELETE FROM memory_source_vectors WHERE actor_id=$1 AND (index_version<>$2 OR scope<>$3)',
          [actor.id, actor.index_version, actor.scope],
        );
      });
      continue;
    }
    const c = await embedContent(
      db,
      config,
      world,
      m.content,
      'memory_embedding',
      signal,
    );
    if (!c) {
      await db.query(
        "INSERT INTO memory_source_shards(actor_id,message_id,index_version,scope,state,error_code) SELECT $1,$2,index_version,$3,'failed',index_error FROM memory_settings WHERE world_id=$4 AND index_error IS NOT NULL ON CONFLICT(actor_id,message_id,index_version,scope) DO UPDATE SET state='failed',error_code=EXCLUDED.error_code",
        [actor.id, m.id, actor.scope, world],
      );
      return;
    }
    await transaction(db, async (tx) => {
      const w = await worldLock(tx, actor.owner_id, world);
      if (
        w.memory_epoch !== c.world.memory_epoch ||
        !(await validReservation(tx, c.usageId))
      )
        return;
      await tx.query(
        `INSERT INTO memory_source_vectors(actor_id,message_id,index_version,scope,revision,content_hash,embedding) SELECT $1,m.id,$2,$3,m.revision,$5,$6::vector FROM messages m JOIN rooms r ON r.id=m.room_id JOIN world_characters a ON a.id=$1 LEFT JOIN memory_policies p ON p.actor_id=a.id WHERE m.id=$4 AND m.revision=$7 AND ${allowed} AND COALESCE(p.vector_scope,'both')=$3 ON CONFLICT(actor_id,message_id,index_version,scope) DO UPDATE SET revision=EXCLUDED.revision,content_hash=EXCLUDED.content_hash,embedding=EXCLUDED.embedding`,
        [
          actor.id,
          c.settings.index_version,
          actor.scope,
          m.id,
          hash(m.content),
          JSON.stringify(c.vector),
          m.revision,
        ],
      );
      await tx.query(
        'DELETE FROM memory_source_shards WHERE actor_id=$1 AND message_id=$2 AND index_version=$3 AND scope=$4',
        [actor.id, m.id, actor.index_version, actor.scope],
      );
    });
    return;
  }
}
export async function recallSourceVectors(
  db: DB,
  owner: string,
  actor: string,
  vector: QueryVector,
) {
  return (
    await db.query(
      `WITH permitted AS MATERIALIZED(SELECT m.*,v.embedding FROM memory_source_vectors v JOIN memory_source_indexes i ON i.actor_id=v.actor_id AND i.active_version=v.index_version AND i.active_scope=v.scope JOIN messages m ON m.id=v.message_id AND m.revision=v.revision JOIN rooms r ON r.id=m.room_id JOIN world_characters a ON a.id=v.actor_id LEFT JOIN memory_policies p ON p.actor_id=a.id WHERE a.id=$1 AND a.owner_id=$2 AND NOT a.deleted AND ${allowed} AND v.scope=COALESCE(p.vector_scope,'both') AND v.index_version=$3 AND vector_dims(v.embedding)=$4) SELECT id,revision,content,room_id,role,1-(embedding<=>$5::vector) AS similarity FROM permitted WHERE 1-(embedding<=>$5::vector)>=0.65 ORDER BY embedding<=>$5::vector LIMIT 3`,
      [
        actor,
        owner,
        vector.version,
        vector.dimensions,
        JSON.stringify(vector.vector),
      ],
    )
  ).rows;
}
