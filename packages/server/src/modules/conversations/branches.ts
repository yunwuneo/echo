import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { command } from '../commands/index.js';
import { AppError, hash } from '../../security.js';
import {
  worldLock,
  matchRevision,
  roomView,
  bumpWorld,
} from '../worlds/index.js';
import { emit, messageView, runView } from '../sync/index.js';

export async function branchConversation(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    context_token: string;
    name: string;
  },
) {
  return command(
    db,
    owner,
    'conversation.branch',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const source = (
        await tx.query(
          "SELECT m.*,r.world_id,r.next_sequence,r.name,r.provider_id,r.kind,r.max_replies,run.command_order FROM messages m JOIN rooms r ON r.id=m.room_id JOIN runs run ON run.id=m.run_id WHERE m.owner_id=$1 AND m.id=$2 AND NOT r.deleted AND NOT m.internal AND m.status='completed'",
          [owner, id],
        )
      ).rows[0];
      if (!source)
        throw new AppError(
          404,
          'not_found',
          'Completed source message not found',
        );
      const w = await worldLock(tx, owner, source.world_id);
      const current = (
        await tx.query(
          'SELECT m.revision,r.next_sequence,r.deleted FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=$1',
          [id],
        )
      ).rows[0];
      matchRevision(current, input.expected_revision);
      if (
        current.deleted ||
        hash(`${source.room_id}:${current.next_sequence}:${w.revision}`) !==
          input.context_token
      )
        throw new AppError(
          409,
          'revision_conflict',
          'Conversation changed; refresh before branching',
        );
      if (
        (
          await tx.query(
            "SELECT 1 FROM runs WHERE world_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending')",
            [w.id],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          'active_runs',
          'Wait for or cancel active turns before branching',
        );
      // Include the entire selected turn, even when the chosen message is a
      // mid-turn group reply. Internal tool transcripts/receipts are not executable
      // branch content and are never copied or scheduled.
      const messages = (
        await tx.query(
          "SELECT m.*,r.state AS source_run_state FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.owner_id=$1 AND m.room_id=$2 AND r.command_order<=$3 AND NOT m.internal AND m.status='completed' ORDER BY m.sequence LIMIT 1001",
          [owner, source.room_id, source.command_order],
        )
      ).rows;
      if (messages.length > 1000)
        throw new AppError(
          409,
          'branch_limit',
          'Branch exceeds 1000 visible messages',
        );
      const room = randomUUID();
      await tx.query(
        'INSERT INTO rooms(id,owner_id,world_id,name,provider_id,kind,max_replies) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          room,
          owner,
          w.id,
          input.name,
          source.provider_id,
          source.kind,
          source.max_replies,
        ],
      );
      await tx.query(
        'INSERT INTO room_memberships(owner_id,world_id,room_id,actor_id) SELECT owner_id,world_id,$2,actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL',
        [source.room_id, room],
      );
      await tx.query(
        'INSERT INTO conversation_branches(room_id,owner_id,source_room_id,source_message_id,source_revision) VALUES($1,$2,$3,$4,$5)',
        [room, owner, source.room_id, id, source.revision],
      );
      const byRun = new Map<string, any[]>();
      for (const m of messages)
        byRun.set(m.run_id, [...(byRun.get(m.run_id) ?? []), m]);
      let sequence = 0;
      const assetIds = new Set<string>();
      for (const [oldRun, list] of byRun) {
        if (!list.some((m) => m.role === 'user'))
          throw new AppError(
            409,
            'incomplete_history',
            'A source turn has no visible user input; branch from another complete turn',
          );
        const ids = new Map<string, string>(
          list.map((m) => [m.id, randomUUID()]),
        );
        const run = randomUUID();
        const order = (
          await tx.query(
            'UPDATE worlds SET next_command=next_command+1 WHERE id=$1 RETURNING next_command',
            [w.id],
          )
        ).rows[0].next_command;
        const copied = (
          await tx.query(
            'INSERT INTO runs(id,owner_id,world_id,room_id,client_command_id,request_hash,user_message_id,reply_message_id,command_order,state,history_source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [
              run,
              owner,
              w.id,
              room,
              randomUUID(),
              hash(`branch:${room}:${oldRun}`),
              ids.get(list.find((m) => m.role === 'user')?.id) ?? randomUUID(),
              ids.get(list.find((m) => m.role === 'assistant')?.id) ??
                randomUUID(),
              order,
              list[0].source_run_state,
              oldRun,
            ],
          )
        ).rows[0];
        for (const m of list) {
          const next = ids.get(m.id)!;
          const row = (
            await tx.query(
              "INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,content,status,actor_id,actor_name,step_index,memory_excluded,context_stale) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12) RETURNING *",
              [
                next,
                owner,
                room,
                run,
                ++sequence,
                m.role,
                m.content,
                m.actor_id,
                m.actor_name,
                m.step_index,
                m.memory_excluded,
                m.context_stale,
              ],
            )
          ).rows[0];
          await tx.query(
            'INSERT INTO message_audiences(message_id,actor_id) SELECT $2,a.actor_id FROM message_audiences a JOIN room_memberships rm ON rm.room_id=$3 AND rm.actor_id=a.actor_id AND rm.left_at IS NULL WHERE a.message_id=$1',
            [m.id, next, room],
          );
          await tx.query(
            'INSERT INTO message_dependencies(message_id,source_id) VALUES($1,$2)',
            [next, m.id],
          );
          const refs = (
            await tx.query(
              'INSERT INTO asset_references(owner_id,asset_id,message_id,purpose,input_mode,extracted_text) SELECT owner_id,asset_id,$2,purpose,input_mode,extracted_text FROM asset_references WHERE message_id=$1 RETURNING asset_id',
              [m.id, next],
            )
          ).rows;
          for (const ref of refs) assetIds.add(ref.asset_id);
          await emit(tx, owner, 'message', next, messageView(row));
        }
        await emit(tx, owner, 'run', run, runView(copied));
      }
      for (const asset of assetIds) {
        const row = (
          await tx.query(
            'UPDATE assets SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING id,world_id,actor_id,content_hash,mime,size,revision',
            [asset],
          )
        ).rows[0];
        await emit(tx, owner, 'asset', asset, row);
      }
      const r = (
        await tx.query(
          'UPDATE rooms SET next_sequence=$2 WHERE id=$1 RETURNING *',
          [room, sequence],
        )
      ).rows[0];
      await bumpWorld(tx, owner, w.id);
      await emit(tx, owner, 'room', room, await roomView(tx, r));
      return {
        room_id: room,
        copied_messages: sequence,
        source_message_id: id,
      };
    },
  );
}
