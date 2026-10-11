import { policyView } from '../autonomy/policy.js';
import { listConnections, grantView, callView } from '../mcp/connections.js';
import { listMemories, settingsView } from '../memory/repository.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import {
  worldView,
  characterView,
  actorView,
  loreView,
  stateView,
  eventView,
  roomView,
} from '../worlds/index.js';
import { AppError } from '../../security.js';
export const messageView = (r: Record<string, any>) => ({
  id: r.id,
  room_id: r.room_id,
  run_id: r.run_id,
  sequence: String(r.sequence),
  role: r.role,
  actor_id: r.actor_id ?? null,
  actor_name: r.actor_name ?? null,
  step_index: r.step_index ?? 0,
  content: r.content,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
});
export const runView = (r: Record<string, any>) => ({
  id: r.id,
  world_id: r.world_id,
  room_id: r.room_id,
  state: r.state,
  attempts: r.attempts,
  error_code: r.error_code,
  created_at: new Date(r.created_at).toISOString(),
});
export async function emit(
  tx: DB,
  ownerId: string,
  kind: string,
  entityId: string,
  data: unknown,
) {
  const r = await tx.query(
    'UPDATE sync_heads SET cursor=cursor+1 WHERE owner_id=$1 RETURNING cursor',
    [ownerId],
  );
  if (!r.rowCount) throw new Error('Missing sync head');
  await tx.query(
    'INSERT INTO sync_events(owner_id,cursor,kind,entity_id,data) VALUES($1,$2,$3,$4,$5)',
    [ownerId, r.rows[0].cursor, kind, entityId, JSON.stringify(data)],
  );
}
export async function sync(
  db: DB,
  ownerId: string,
  cursor: string,
  limit = 50,
) {
  if (BigInt(cursor) > 9223372036854775807n)
    throw new AppError(410, 'cursor_expired', 'Rebuild cache from a snapshot');
  // Retention can advance min_cursor concurrently. Read the watermark and its
  // events in one statement so a page cannot silently skip freshly pruned rows.
  const result = await db.query(
    `SELECT h.cursor AS head_cursor,h.min_cursor,e.cursor,e.kind,e.entity_id,e.data
     FROM sync_heads h LEFT JOIN LATERAL (
       SELECT cursor,kind,entity_id,data FROM sync_events
       WHERE owner_id=h.owner_id AND cursor>$2 ORDER BY cursor LIMIT $3
     ) e ON true WHERE h.owner_id=$1 ORDER BY e.cursor`,
    [ownerId, cursor, limit + 1],
  );
  const head = result.rows[0];
  if (
    !head ||
    BigInt(cursor) < BigInt(head.min_cursor) ||
    BigInt(cursor) > BigInt(head.head_cursor)
  )
    throw new AppError(410, 'cursor_expired', 'Rebuild cache from a snapshot');
  const rows = result.rows
    .filter((row) => row.cursor !== null)
    .map(({ cursor, kind, entity_id, data }) => ({
      cursor,
      kind,
      entity_id,
      data,
    }));
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: String(items.at(-1)?.cursor ?? cursor),
    has_more: rows.length > limit,
  };
}
export async function snapshot(db: pg.Pool, ownerId: string) {
  return transaction(
    db,
    async (tx) => {
      const metadata = (
        await tx.query(
          'SELECT server_instance_id,data_epoch FROM instance_metadata',
        )
      ).rows[0];
      const head = (
        await tx.query('SELECT cursor FROM sync_heads WHERE owner_id=$1', [
          ownerId,
        ])
      ).rows[0];
      const worlds = (
        await tx.query(
          'SELECT * FROM worlds WHERE owner_id=$1 AND NOT deleted ORDER BY id',
          [ownerId],
        )
      ).rows;
      const rooms = (
        await tx.query(
          'SELECT * FROM rooms WHERE owner_id=$1 AND NOT deleted ORDER BY id',
          [ownerId],
        )
      ).rows;
      const messages = (
        await tx.query(
          'SELECT m.* FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.owner_id=$1 AND NOT r.deleted AND NOT m.internal ORDER BY m.room_id,m.sequence',
          [ownerId],
        )
      ).rows.map(messageView);
      const runs = (
        await tx.query(
          'SELECT * FROM runs WHERE owner_id=$1 ORDER BY command_order',
          [ownerId],
        )
      ).rows.map(runView);
      return {
        ...metadata,
        owner_id: ownerId,
        high_water_cursor: String(head.cursor),
        worlds: worlds.map(worldView),
        autonomy_settings: (
          await tx.query('SELECT * FROM autonomy_settings WHERE owner_id=$1', [
            ownerId,
          ])
        ).rows.map(policyView),
        autonomy_policies: (
          await tx.query('SELECT * FROM autonomy_policies WHERE owner_id=$1', [
            ownerId,
          ])
        ).rows.map(policyView),
        mcp_connections: await listConnections(tx, ownerId),
        tool_grants: (
          await tx.query('SELECT * FROM tool_grants WHERE owner_id=$1', [
            ownerId,
          ])
        ).rows.map(grantView),
        tool_calls: (
          await tx.query(
            'SELECT * FROM tool_calls WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
            [ownerId],
          )
        ).rows.map(callView),
        memories: await listMemories(tx, ownerId),
        memory_settings: (
          await tx.query(
            'SELECT s.* FROM memory_settings s JOIN worlds w ON w.id=s.world_id WHERE s.owner_id=$1 AND NOT w.deleted',
            [ownerId],
          )
        ).rows.map(settingsView),
        rooms: await Promise.all(rooms.map((r) => roomView(tx, r))),
        characters: (
          await tx.query(
            'SELECT t.id,t.revision,v.data FROM character_templates t JOIN character_versions v ON v.template_id=t.id AND v.revision=t.revision WHERE t.owner_id=$1 AND NOT t.deleted ORDER BY t.id',
            [ownerId],
          )
        ).rows.map(characterView),
        actors: (
          await tx.query(
            'SELECT * FROM world_characters WHERE owner_id=$1 AND NOT deleted ORDER BY id',
            [ownerId],
          )
        ).rows.map(actorView),
        lore: (
          await tx.query(
            'SELECT * FROM lore_entries WHERE owner_id=$1 AND NOT deleted ORDER BY id',
            [ownerId],
          )
        ).rows.map(loreView),
        states: (
          await tx.query(
            'SELECT s.* FROM world_state s JOIN worlds w ON w.id=s.world_id WHERE s.owner_id=$1 AND NOT w.deleted ORDER BY s.world_id',
            [ownerId],
          )
        ).rows.map(stateView),
        world_events: (
          await tx.query(
            'SELECT e.* FROM world_events e JOIN worlds w ON w.id=e.world_id WHERE e.owner_id=$1 AND NOT w.deleted ORDER BY e.revision,e.id',
            [ownerId],
          )
        ).rows.map(eventView),
        messages,
        runs,
      };
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}

// A bounded, immutable snapshot session gives all pages the same commit watermark.
export async function beginSnapshot(db: pg.Pool, owner: string) {
  const data = await snapshot(db, owner);
  const metadata = {
    server_instance_id: data.server_instance_id,
    data_epoch: data.data_epoch,
    owner_id: owner,
    high_water_cursor: data.high_water_cursor,
  };
  const records: { kind: string; entity_id: string; data: unknown }[] = [];
  for (const [key, kind] of Object.entries({
    worlds: 'world',
    memories: 'memory',
    memory_settings: 'memory_settings',
    autonomy_settings: 'autonomy_settings',
    autonomy_policies: 'autonomy_policy',
    mcp_connections: 'mcp_connection',
    tool_grants: 'tool_grant',
    tool_calls: 'tool_call',
    rooms: 'room',
    characters: 'character',
    actors: 'actor',
    lore: 'lore',
    states: 'state',
    world_events: 'world_event',
    messages: 'message',
    runs: 'run',
  })) {
    for (const row of (data as any)[key])
      records.push({ kind, entity_id: row.id ?? row.world_id, data: row });
  }
  const id = randomUUID();
  await db.query(
    'DELETE FROM sync_snapshots WHERE owner_id=$1 AND expires_at<=now()',
    [owner],
  );
  await transaction(db, async (tx) => {
    const head = (
      await tx.query(
        'SELECT min_cursor FROM sync_heads WHERE owner_id=$1 FOR UPDATE',
        [owner],
      )
    ).rows[0];
    if (BigInt(data.high_water_cursor) < BigInt(head.min_cursor))
      throw new AppError(
        410,
        'snapshot_expired',
        'Data was erased while preparing snapshot',
      );
    await tx.query(
      'INSERT INTO sync_snapshots(id,owner_id,metadata,records) VALUES($1,$2,$3,$4)',
      [id, owner, JSON.stringify(metadata), JSON.stringify(records)],
    );
    await tx.query(
      `INSERT INTO sync_snapshot_pages(snapshot_id,page_number,records)
       SELECT s.id,((p.n-1)/500)::integer,jsonb_agg(p.value ORDER BY p.n)
       FROM sync_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.records) WITH ORDINALITY p(value,n)
       WHERE s.id=$1 GROUP BY s.id,((p.n-1)/500)::integer`,
      [id],
    );
    await tx.query('UPDATE sync_snapshots SET record_count=$2 WHERE id=$1', [
      id,
      records.length,
    ]);
  });
  return { snapshot_id: id, ...metadata, expires_in: 600 };
}
export async function snapshotPage(
  db: DB,
  owner: string,
  id: string,
  after: string,
  limit = 200,
) {
  if (BigInt(after) > 2147483647n)
    throw new AppError(
      400,
      'invalid_cursor',
      'Snapshot offset is out of range',
    );
  const record = (
    await db.query(
      `SELECT COALESCE(s.record_count,jsonb_array_length(s.records)) AS count,
       CASE WHEN s.record_count IS NULL THEN
         (SELECT jsonb_agg(value ORDER BY n) FROM jsonb_array_elements(s.records) WITH ORDINALITY page(value,n) WHERE n>$3::bigint AND n<=$3::bigint+$4::bigint)
       ELSE
         (SELECT jsonb_agg(p.value ORDER BY chunk.page_number,p.n)
          FROM sync_snapshot_pages chunk CROSS JOIN LATERAL jsonb_array_elements(chunk.records) WITH ORDINALITY p(value,n)
          WHERE chunk.snapshot_id=s.id AND chunk.page_number BETWEEN ($3::bigint/500) AND (($3::bigint+$4::bigint-1)/500)
          AND chunk.page_number*500+p.n>$3::bigint AND chunk.page_number*500+p.n<=$3::bigint+$4::bigint)
       END AS items
       FROM sync_snapshots s WHERE s.id=$1 AND s.owner_id=$2 AND s.expires_at>now()`,
      [id, owner, Number(after), limit],
    )
  ).rows[0];
  if (!record)
    throw new AppError(410, 'snapshot_expired', 'Start a new snapshot');
  if (Number(after) > record.count)
    throw new AppError(
      400,
      'invalid_cursor',
      'Snapshot offset is out of range',
    );
  const items = record.items ?? [];
  const next = Number(after) + items.length;
  return { items, next_cursor: String(next), has_more: next < record.count };
}
export async function pruneSync(db: pg.Pool) {
  await transaction(db, async (tx) => {
    const owners = (
      await tx.query('SELECT owner_id FROM sync_heads FOR UPDATE')
    ).rows;
    for (const row of owners) {
      const old = (
        await tx.query(
          "SELECT max(cursor) AS cursor FROM sync_events WHERE owner_id=$1 AND created_at<now()-interval '7 days'",
          [row.owner_id],
        )
      ).rows[0]?.cursor;
      if (old) {
        await tx.query(
          'DELETE FROM sync_events WHERE owner_id=$1 AND cursor<=$2',
          [row.owner_id, old],
        );
        await tx.query(
          'UPDATE sync_heads SET min_cursor=GREATEST(min_cursor,$2) WHERE owner_id=$1',
          [row.owner_id, old],
        );
      }
    }
    await tx.query('DELETE FROM sync_snapshots WHERE expires_at<=now()');
  });
}
