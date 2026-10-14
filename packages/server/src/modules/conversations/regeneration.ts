import type pg from 'pg';
import { command } from '../commands/index.js';
import { AppError, hash } from '../../security.js';
import { worldLock, matchRevision, bumpWorld } from '../worlds/index.js';
import { invalidateSources, purgeReplay } from '../memory/repository.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { emit, messageView } from '../sync/index.js';
export async function regenerateMessage(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    context_token: string;
    mode: 'keep' | 'truncate';
  },
) {
  return command(
    db,
    owner,
    'message.regenerate',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const m = (
        await tx.query(
          "SELECT m.*,r.world_id,r.next_sequence,run.command_order,run.user_message_id FROM messages m JOIN rooms r ON r.id=m.room_id JOIN runs run ON run.id=m.run_id WHERE m.owner_id=$1 AND m.id=$2 AND m.role='assistant' AND NOT m.internal AND m.status IN ('completed','interrupted') AND NOT r.deleted",
          [owner, id],
        )
      ).rows[0];
      if (!m) throw new AppError(404, 'not_found', 'Visible reply not found');
      const world = await worldLock(tx, owner, m.world_id);
      matchRevision(
        (await tx.query('SELECT revision FROM messages WHERE id=$1', [id]))
          .rows[0],
        input.expected_revision,
      );
      const room = (
        await tx.query('SELECT * FROM rooms WHERE id=$1', [m.room_id])
      ).rows[0];
      if (
        hash(`${m.room_id}:${room.next_sequence}:${world.revision}`) !==
        input.context_token
      )
        throw new AppError(409, 'revision_conflict', 'History changed');
      if (
        (
          await tx.query(
            "SELECT 1 FROM runs WHERE world_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending')",
            [m.world_id],
          )
        ).rowCount
      )
        throw new AppError(409, 'active_runs', 'Wait for active turns');
      const user = (
        await tx.query(
          "SELECT content FROM messages WHERE id=$1 AND status<>'invalidated'",
          [m.user_message_id],
        )
      ).rows[0];
      if (!user?.content)
        throw new AppError(409, 'incomplete_history', 'Original input missing');
      const included = (
        await tx.query(
          'SELECT id FROM messages WHERE room_id=$1 AND NOT memory_excluded',
          [m.room_id],
        )
      ).rows.map((r) => r.id);
      await invalidateSources(tx, owner, m.world_id, [id]);
      await tx.query(
        'UPDATE messages SET memory_excluded=false WHERE id=ANY($1::uuid[])',
        [included],
      );
      const tail = (
        await tx.query(
          "UPDATE messages SET context_stale=true,status=CASE WHEN $3='truncate' THEN 'invalidated' ELSE status END WHERE room_id=$1 AND sequence>$2 AND NOT internal AND status<>'invalidated' RETURNING *",
          [m.room_id, m.sequence, input.mode],
        )
      ).rows;
      for (const row of tail)
        await emit(tx, owner, 'message', row.id, messageView(row));
      if (input.mode === 'truncate')
        await tx.query(
          'UPDATE world_events SET invalidated=true WHERE message_id=ANY($1::uuid[])',
          [tail.map((r) => r.id)],
        );
      const ack = await enqueueInTransaction(
        tx,
        owner,
        m.room_id,
        {
          client_command_id: input.operation_id,
          content: user.content,
          addressed_actor_ids: m.actor_id ? [m.actor_id] : [],
        },
        hash(JSON.stringify({ id, ...input })),
      );
      await tx.query(
        'UPDATE runs SET replacement_message_id=$2,history_before_order=$3,history_before_sequence=$4,original_user_message_id=$5 WHERE id=$1',
        [ack.run_id, id, m.command_order, m.sequence, m.user_message_id],
      );
      await tx.query('UPDATE messages SET internal=true WHERE id=$1', [
        ack.message_id,
      ]);
      await purgeReplay(tx, owner);
      await bumpWorld(tx, owner, m.world_id);
      return ack;
    },
  );
}
export async function deleteVersion(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    version_id: string;
  },
) {
  return command(
    db,
    owner,
    'message.version.delete',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const m = (
        await tx.query(
          'SELECT m.*,r.world_id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.owner_id=$1 AND m.id=$2',
          [owner, id],
        )
      ).rows[0];
      if (!m) throw new AppError(404, 'not_found', 'Message not found');
      await worldLock(tx, owner, m.world_id);
      matchRevision(
        (await tx.query('SELECT revision FROM messages WHERE id=$1', [id]))
          .rows[0],
        input.expected_revision,
      );
      if (
        (
          await tx.query(
            "SELECT 1 FROM runs WHERE world_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending') LIMIT 1",
            [m.world_id],
          )
        ).rowCount
      )
        throw new AppError(409, 'active_runs', 'Wait for active turns');
      if (m.selected_version_id === input.version_id)
        throw new AppError(
          409,
          'selected_version',
          'Select another version before deleting',
        );
      if (
        !(
          await tx.query(
            'DELETE FROM message_versions WHERE owner_id=$1 AND message_id=$2 AND id=$3',
            [owner, id, input.version_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Version not found');
      const row = (
        await tx.query(
          'UPDATE messages SET revision=revision+1 WHERE id=$1 RETURNING *',
          [id],
        )
      ).rows[0];
      await tx.query(
        'DELETE FROM request_snapshots WHERE run_id IN (SELECT id FROM runs WHERE room_id=$1)',
        [m.room_id],
      );
      await tx.query('DELETE FROM time_recaps WHERE room_id=$1', [m.room_id]);
      await tx.query('DELETE FROM restore_sessions WHERE owner_id=$1', [owner]);
      await purgeReplay(tx, owner);
      await emit(tx, owner, 'message', id, messageView(row));
      return { id, revision: row.revision };
    },
  );
}
