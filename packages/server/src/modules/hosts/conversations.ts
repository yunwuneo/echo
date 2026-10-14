import type pg from 'pg';
import { command } from '../commands/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { claimProvider } from '../providers/routes.js';
import { AppError, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';
export async function localHostConversation(
  db: pg.Pool,
  owner: string,
  input: any,
) {
  const p = input.payload;
  if (input.command === 'hostConversationResult') {
    const r = (
      await db.query(
        'SELECT id,state,error_code FROM runs WHERE owner_id=$1 AND client_command_id=$2',
        [owner, p.operation_id],
      )
    ).rows[0];
    if (!r) return { found: false };
    return {
      found: true,
      ...r,
      messages: (
        await db.query(
          "SELECT content,actor_id FROM messages WHERE run_id=$1 AND role='assistant' AND status='completed' AND NOT internal ORDER BY sequence",
          [r.id],
        )
      ).rows,
    };
  }
  return command(
    db,
    owner,
    'host.local-conversation',
    input.operation_id,
    input,
    async (tx) => {
      const room = (
        await tx.query(
          "SELECT * FROM rooms WHERE id=$1 AND owner_id=$2 AND NOT deleted AND kind='direct' AND parent_group_id IS NULL",
          [p.room_id, owner],
        )
      ).rows[0];
      if (!room)
        throw new AppError(
          409,
          'host_identity_missing',
          'Choose a direct local Host conversation',
        );
      const members = (
        await tx.query(
          'SELECT actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL',
          [room.id],
        )
      ).rows;
      if (members.length !== 1)
        throw new AppError(
          409,
          'host_identity_missing',
          'Independent identity required',
        );
      const ack = await enqueueInTransaction(
        tx,
        owner,
        room.id,
        {
          client_command_id: input.operation_id,
          content: p.content,
          addressed_actor_ids: [members[0].actor_id],
        },
        hash(canonical(input)),
        undefined,
        { skipRelay: true },
      );
      await tx.query('UPDATE runs SET tool_limit=$2 WHERE id=$1', [
        ack.run_id,
        p.budget.tool_limit,
      ]);
      await claimProvider(
        tx,
        { id: ack.run_id, owner_id: owner, step_index: 0 },
        room,
        members[0].actor_id,
      );
      await tx.query(
        "UPDATE run_route_snapshots SET data=jsonb_set(data,'{max_output_tokens}',to_jsonb(least((data->>'max_output_tokens')::int,$2::int))) WHERE run_id=$1",
        [ack.run_id, p.budget.max_output_tokens],
      );
      return ack;
    },
  );
}
