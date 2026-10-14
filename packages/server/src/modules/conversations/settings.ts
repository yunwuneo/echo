import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { AppError } from '../../security.js';
import { command } from '../commands/index.js';
import { worldLock, matchRevision, roomView } from '../worlds/index.js';
import { emit } from '../sync/index.js';
export const behaviorDefaults = {
  history_mode: 'all',
  history_count: 20,
  history_tokens: 8192,
  image_history: 'recent_two',
  start_message_id: null,
};
export function admitHistory<
  T extends { id: string; run_id?: string; content: string },
>(rows: T[], settings: any, anchorRun?: string) {
  let selected = rows;
  if (
    settings.history_mode === 'start' &&
    settings.start_message_id &&
    anchorRun
  ) {
    const start = rows.findIndex((r) => r.run_id === anchorRun);
    selected = start < 0 ? [] : rows.slice(start);
  } else if (settings.history_mode === 'recent') {
    const i = Math.max(0, rows.length - settings.history_count);
    const run = rows[i]?.run_id;
    selected = rows.slice(run ? rows.findIndex((r) => r.run_id === run) : i);
  } else if (settings.history_mode === 'tokens') {
    let tokens = 0;
    const groups: T[][] = [];
    for (const row of rows) {
      const prior = groups.at(-1);
      if (prior && prior[0]?.run_id && prior[0].run_id === row.run_id)
        prior.push(row);
      else groups.push([row]);
    }
    const keep: T[][] = [];
    for (const group of groups.reverse()) {
      const cost = group.reduce(
        (n, r) => n + Buffer.byteLength(r.content) + 16,
        0,
      );
      if (tokens + cost > settings.history_tokens) break;
      tokens += cost;
      keep.unshift(group);
    }
    selected = keep.flat();
  }
  return selected;
}
export async function saveBehavior(
  db: pg.Pool,
  owner: string,
  room: string | null,
  input: { operation_id: string; expected_revision: number; behavior: any },
) {
  return command(
    db,
    owner,
    'conversation.behavior',
    input.operation_id,
    { room, ...input },
    async (tx) => {
      if (!room) {
        const old = (
          await tx.query(
            'SELECT * FROM conversation_defaults WHERE owner_id=$1',
            [owner],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== input.expected_revision)
          throw new AppError(409, 'revision_conflict', 'Defaults changed');
        const b = { ...input.behavior, start_message_id: null };
        return (
          await tx.query(
            'INSERT INTO conversation_defaults(owner_id,behavior) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET behavior=$2,revision=conversation_defaults.revision+1 RETURNING revision',
            [owner, JSON.stringify(b)],
          )
        ).rows[0];
      }
      const old = (
        await tx.query(
          'SELECT * FROM rooms WHERE owner_id=$1 AND id=$2 AND NOT deleted',
          [owner, room],
        )
      ).rows[0];
      if (!old) throw new AppError(404, 'not_found', 'Conversation not found');
      await worldLock(tx, owner, old.world_id);
      const current = (
        await tx.query('SELECT * FROM rooms WHERE id=$1', [room])
      ).rows[0];
      matchRevision(current, input.expected_revision);
      if (
        input.behavior.start_message_id &&
        !(
          await tx.query(
            "SELECT 1 FROM messages WHERE owner_id=$1 AND room_id=$2 AND id=$3 AND status='completed' AND NOT internal",
            [owner, room, input.behavior.start_message_id],
          )
        ).rowCount
      )
        throw new AppError(
          404,
          'not_found',
          'History anchor not in conversation',
        );
      const row = (
        await tx.query(
          'UPDATE rooms SET behavior=$2,revision=revision+1 WHERE id=$1 RETURNING *',
          [room, JSON.stringify(input.behavior)],
        )
      ).rows[0];
      await emit(tx, owner, 'room', room, await roomView(tx, row));
      return { id: room, revision: row.revision };
    },
  );
}
