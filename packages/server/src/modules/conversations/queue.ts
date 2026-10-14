import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { canonical } from '../mcp/schema.js';
import { emit } from '../sync/index.js';
import { worldLock, matchRevision } from '../worlds/index.js';
import { purgeReplay } from '../memory/repository.js';

export const queuedView = (r: any) => ({
  id: r.id,
  room_id: r.room_id,
  revision: r.revision,
  content: r.content,
  state: r.state,
  consumed_run_id: r.consumed_run_id,
  created_at: new Date(r.created_at).toISOString(),
});
async function roomScope(db: DB, owner: string, room: string) {
  const r = (
    await db.query(
      'SELECT r.* FROM rooms r JOIN worlds w ON w.id=r.world_id WHERE r.owner_id=$1 AND r.id=$2 AND NOT r.deleted AND NOT w.deleted',
      [owner, room],
    )
  ).rows[0];
  if (!r) throw new AppError(404, 'not_found', 'Conversation not found');
  return r;
}
export async function queuedInputs(db: DB, owner: string, room: string) {
  await roomScope(db, owner, room);
  return (
    await db.query(
      "SELECT * FROM conversation_inputs WHERE owner_id=$1 AND room_id=$2 AND state='pending' ORDER BY created_at,id",
      [owner, room],
    )
  ).rows.map(queuedView);
}
export async function queueInput(
  db: pg.Pool,
  owner: string,
  room: string,
  input: { operation_id: string; content: string },
) {
  return command(
    db,
    owner,
    'conversation.queue',
    input.operation_id,
    { room, ...input },
    async (tx) => {
      const r = await roomScope(tx, owner, room);
      await worldLock(tx, owner, r.world_id);
      await roomScope(tx, owner, room);
      if ((await queuedInputs(tx, owner, room)).length >= 32)
        throw new AppError(409, 'queue_limit', 'At most 32 pending inputs');
      const members = (
        await tx.query(
          'SELECT actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL ORDER BY actor_id',
          [room],
        )
      ).rows.map((r) => r.actor_id);
      const row = (
        await tx.query(
          'INSERT INTO conversation_inputs(owner_id,room_id,content,audience_actor_ids) VALUES($1,$2,$3,$4) RETURNING *',
          [owner, room, input.content, members],
        )
      ).rows[0];
      await emit(tx, owner, 'queued_input', row.id, queuedView(row));
      return { id: row.id, revision: row.revision };
    },
  );
}
export async function updateQueuedInput(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    content?: string;
    remove?: boolean;
  },
) {
  return command(
    db,
    owner,
    'conversation.queue.edit',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const row = (
        await tx.query(
          'SELECT * FROM conversation_inputs WHERE owner_id=$1 AND id=$2',
          [owner, id],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'not_found', 'Input not found');
      const room = await roomScope(tx, owner, row.room_id);
      await worldLock(tx, owner, room.world_id);
      await roomScope(tx, owner, row.room_id);
      matchRevision(row, input.expected_revision);
      if (row.state !== 'pending')
        throw new AppError(
          409,
          'input_frozen',
          'Input was already consumed or deleted',
        );
      if (Boolean(input.remove) === (input.content !== undefined))
        throw new AppError(400, 'invalid_request', 'Supply content or remove');
      const changed = (
        await tx.query(
          'UPDATE conversation_inputs SET content=$2,state=$3,revision=revision+1 WHERE id=$1 RETURNING *',
          [
            id,
            input.remove ? '' : input.content,
            input.remove ? 'deleted' : 'pending',
          ],
        )
      ).rows[0];
      if (input.remove) await purgeReplay(tx, owner);
      await emit(tx, owner, 'queued_input', id, queuedView(changed));
      return { id, revision: changed.revision };
    },
  );
}
export async function startQueuedTurn(
  db: pg.Pool,
  owner: string,
  room: string,
  input: {
    operation_id: string;
    items: { id: string; revision: number }[];
    addressed_actor_ids?: string[];
  },
) {
  return command(
    db,
    owner,
    'conversation.start',
    input.operation_id,
    { room, ...input },
    async (tx) => {
      const r = await roomScope(tx, owner, room);
      await worldLock(tx, owner, r.world_id);
      if (
        !input.items.length ||
        input.items.length > 32 ||
        new Set(input.items.map((i) => i.id)).size !== input.items.length
      )
        throw new AppError(
          400,
          'invalid_request',
          'Select distinct queued inputs',
        );
      const rows = (
        await tx.query(
          'SELECT * FROM conversation_inputs WHERE owner_id=$1 AND room_id=$2 AND id=ANY($3::uuid[]) ORDER BY created_at,id',
          [owner, room, input.items.map((i) => i.id)],
        )
      ).rows;
      if (rows.length !== input.items.length)
        throw new AppError(404, 'not_found', 'Input not found in conversation');
      for (const row of rows)
        matchRevision(row, input.items.find((i) => i.id === row.id)!.revision);
      if (
        rows.every(
          (row) =>
            row.state === 'consumed' &&
            row.consumed_run_id === rows[0].consumed_run_id,
        )
      ) {
        const prior = (
          await tx.query(
            'SELECT id,user_message_id,addressed_actor_ids FROM runs WHERE owner_id=$1 AND id=$2',
            [owner, rows[0].consumed_run_id],
          )
        ).rows[0];
        const total = (
          await tx.query(
            'SELECT count(*)::int AS n FROM conversation_inputs WHERE consumed_run_id=$1',
            [prior.id],
          )
        ).rows[0].n;
        if (
          total !== rows.length ||
          canonical(prior.addressed_actor_ids) !==
            canonical(input.addressed_actor_ids ?? [])
        )
          throw new AppError(
            409,
            'input_frozen',
            'Input selection was already consumed',
          );
        return { run_id: prior.id, message_id: prior.user_message_id };
      }
      if (rows.some((row) => row.state !== 'pending'))
        throw new AppError(409, 'input_frozen', 'Input selection changed');
      if (
        (
          await tx.query(
            "SELECT 1 FROM runs WHERE owner_id=$1 AND room_id=$2 AND state IN ('queued','running','awaiting_approval','remote_pending')",
            [owner, room],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          'active_runs',
          'Wait for or cancel the current turn',
        );
      const members = (
        await tx.query(
          'SELECT actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL',
          [room],
        )
      ).rows.map((r) => r.actor_id);
      if (
        rows.some((row) =>
          members.some((m) => !row.audience_actor_ids.includes(m)),
        )
      )
        throw new AppError(
          409,
          'audience_changed',
          'New members cannot read previously queued input; review and queue it again',
        );
      const content =
        rows.length === 1
          ? rows[0].content
          : rows.map((row, i) => `[${i + 1}]\n${row.content}`).join('\n\n');
      if ([...content].length > 16000)
        throw new AppError(
          413,
          'input_too_large',
          'Combined input exceeds 16000 characters; select fewer entries',
        );
      const ack = await enqueueInTransaction(
        tx,
        owner,
        room,
        {
          client_command_id: input.operation_id,
          content,
          addressed_actor_ids: input.addressed_actor_ids,
        },
        hash(
          canonical({
            room,
            queue: input.items,
            content,
            addressed: input.addressed_actor_ids ?? [],
          }),
        ),
      );
      const consumed = (
        await tx.query(
          "UPDATE conversation_inputs SET state='consumed',consumed_run_id=$2 WHERE id=ANY($1::uuid[]) RETURNING *",
          [rows.map((r) => r.id), ack.run_id],
        )
      ).rows;
      for (const row of consumed)
        await emit(tx, owner, 'queued_input', row.id, queuedView(row));
      return ack;
    },
  );
}
