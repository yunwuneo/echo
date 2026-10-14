import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import {
  backgroundAllowed,
  dayAt,
  quietAt,
  policies,
  policyView,
} from './policy.js';
import { emit, messageView } from '../sync/index.js';
import { worldLock } from '../worlds/index.js';
import { AppError } from '../../security.js';
export async function scheduleAutonomy(db: pg.Pool, clock?: Date) {
  const now =
    clock ?? (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const due = (
    await db.query(
      'SELECT world_id,owner_id FROM autonomy_policies WHERE enabled AND ((contact AND next_contact_at<=$1) OR (interaction AND next_interaction_at<=$1)) ORDER BY LEAST(next_contact_at,next_interaction_at),world_id LIMIT 20',
      [now],
    )
  ).rows;
  for (const item of due)
    await transaction(db, async (tx) => {
      await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
        item.owner_id,
      ]);
      const world = await worldLock(tx, item.owner_id, item.world_id);
      const { g, p } = await policies(tx, item.owner_id, item.world_id, true);
      if (world.deleted || !p.enabled) return;
      const kinds = ['contact', 'interaction'].filter(
        (k) => backgroundAllowed(g, p, k) && new Date(p[`next_${k}_at`]) <= now,
      );
      for (const kind of kinds) {
        let status: string | null = null;
        if (
          quietAt(now, g.timezone, p.quiet_start, p.quiet_end) &&
          !(kind === 'interaction' && p.quiet_interaction)
        )
          status = 'quiet_hours';
        if (now.getTime() - new Date(world.last_user_at).getTime() < 10 * 60000)
          status = 'user_active';
        if (
          (
            await tx.query(
              "SELECT 1 FROM runs WHERE owner_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending') AND (world_id=$2 OR trigger_kind<>'foreground') LIMIT 1",
              [item.owner_id, item.world_id],
            )
          ).rowCount
        )
          status = 'run_active';
        const day = dayAt(now, g.timezone);
        const count = Number(
          (
            await tx.query(
              'SELECT count FROM autonomy_daily WHERE world_id=$1 AND day=$2 AND kind=$3',
              [world.id, day, kind],
            )
          ).rows[0]?.count ?? 0,
        );
        if (count >= p[`${kind}_daily`]) status = 'daily_limit';
        const room = (
          await tx.query(
            'SELECT * FROM rooms WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND NOT deleted',
            [item.owner_id, world.id, p.room_id],
          )
        ).rows[0];
        if (!room || (kind === 'interaction' && room.kind !== 'group'))
          status = 'room_unavailable';
        const field =
          kind === 'contact' ? 'next_contact_at' : 'next_interaction_at';
        // Missed windows are evaluated once. Never create a backlog of old autonomous turns.
        await tx.query(
          `UPDATE autonomy_policies SET ${field}=$2::timestamptz+$3*interval '1 minute',last_status=$4 WHERE world_id=$1`,
          [world.id, now, status ? 1 : p.interval_minutes, status ?? 'queued'],
        );
        if (status) continue;
        const content =
          kind === 'contact'
            ? '这是已授权的主动联系机会。只在有合适话题时给玩家发一条消息；没有合适内容只输出 <skip>。不得伪造玩家发言或把现实时间当作剧情经过。'
            : '这是已授权的有限角色互动机会。根据可见已发生剧情与在场角色继续一条发言，不代替玩家行动；没有合适内容只输出 <skip>。不得编造未经历的离线故事。';
        const ack = await enqueueInTransaction(
          tx,
          item.owner_id,
          room.id,
          { client_command_id: randomUUID(), content },
          randomUUID(),
          {
            kind,
            globalRevision: g.revision,
            policyRevision: p.revision,
            maxTurns: kind === 'contact' ? 1 : p.max_turns,
          },
        );
        await tx.query(
          'INSERT INTO autonomy_daily(world_id,day,kind,count) VALUES($1,$2,$3,1) ON CONFLICT(world_id,day,kind) DO UPDATE SET count=autonomy_daily.count+1',
          [world.id, day, kind],
        );
        await emit(
          tx,
          item.owner_id,
          'autonomy_policy',
          world.id,
          policyView({ ...p, last_status: 'queued' }),
        );
        return ack;
      }
    });
}
export async function recaps(db: DB, owner: string, world: string, after = 0) {
  if (
    !(
      await db.query(
        'SELECT id FROM worlds WHERE owner_id=$1 AND id=$2 AND NOT deleted',
        [owner, world],
      )
    ).rowCount
  )
    throw new AppError(404, 'not_found', 'World not found');
  const seen = Number(
    (
      await db.query(
        'SELECT recap_revision FROM autonomy_policies WHERE owner_id=$1 AND world_id=$2',
        [owner, world],
      )
    ).rows[0]?.recap_revision ?? 0,
  );
  const rows = (
    await db.query(
      `SELECT m.*,e.revision AS event_revision,r.trigger_kind FROM world_events e JOIN messages m ON m.id=e.message_id JOIN runs r ON r.id=m.run_id JOIN rooms room ON room.id=m.room_id WHERE e.owner_id=$1 AND e.world_id=$2 AND e.kind='character_claim' AND NOT e.invalidated AND m.status='completed' AND NOT m.memory_excluded AND NOT room.deleted AND r.trigger_kind<>'foreground' AND e.revision>$3 ORDER BY e.revision LIMIT 101`,
      [owner, world, after],
    )
  ).rows;
  const items = rows.slice(0, 100).map((m) => ({
    ...messageView(m),
    event_revision: m.event_revision,
    trigger_kind: m.trigger_kind,
    unread: m.event_revision > seen,
  }));
  return {
    items,
    seen_revision: seen,
    next_revision: items.at(-1)?.event_revision ?? after,
    has_more: rows.length > 100,
  };
}
export async function readRecaps(
  db: pg.Pool,
  owner: string,
  world: string,
  revision: number,
) {
  return transaction(db, async (tx) => {
    const w = await worldLock(tx, owner, world);
    if (revision > w.revision)
      throw new AppError(
        400,
        'invalid_revision',
        'Recap revision is in the future',
      );
    const { p } = await policies(tx, owner, world, true);
    const row = (
      await tx.query(
        'UPDATE autonomy_policies SET recap_revision=GREATEST(recap_revision,$2) WHERE world_id=$1 RETURNING *',
        [world, revision],
      )
    ).rows[0];
    await emit(
      tx,
      owner,
      'autonomy_policy',
      world,
      policyView({ ...p, ...row }),
    );
  });
}
