import type pg from 'pg';
import { type DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { worldLock, matchRevision, editEntityTx } from '../worlds/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { canonical } from '../mcp/schema.js';
import { invalidateSources, purgeReplay } from '../memory/repository.js';
import { randomUUID } from 'node:crypto';
const fail = () => new AppError(404, 'not_found', 'Group not found');
export async function groupScope(db: DB, owner: string, room: string) {
  const r = (
    await db.query(
      'SELECT * FROM rooms WHERE id=$1 AND owner_id=$2 AND NOT deleted',
      [room, owner],
    )
  ).rows[0];
  if (!r) return null;
  const id = r.parent_group_id ?? (r.kind === 'group' ? r.id : null);
  if (!id) return null;
  const policy = (
    await db.query(
      'SELECT * FROM group_policies WHERE room_id=$1 AND owner_id=$2',
      [id, owner],
    )
  ).rows[0] ?? {
    room_id: id,
    revision: 0,
    instruction: '',
    mcp_ids: [],
    memory_enabled: false,
    image_provider_id: null,
    reply_policy: 'turns',
  };
  const members = (
    await db.query('SELECT * FROM group_member_policies WHERE room_id=$1', [id])
  ).rows;
  return { ...policy, members };
}
export async function groupToolAllowed(
  db: DB,
  run: any,
  actor: string,
  connection: string,
) {
  const g = await groupScope(db, run.owner_id, run.room_id);
  if (!g) return true;
  const frozen = run.group_snapshot ?? g;
  return (
    frozen.mcp_ids.includes(connection) &&
    frozen.members.some((m: any) => m.actor_id === actor && m.tools_enabled) &&
    g.mcp_ids.includes(connection) &&
    g.members.some((m: any) => m.actor_id === actor && m.tools_enabled)
  );
}
export async function groupCommand(db: pg.Pool, owner: string, input: any) {
  const p = input.payload;
  if (input.command === 'groupPolicy') return groupScope(db, owner, p.room_id);
  return command(
    db,
    owner,
    input.command,
    input.operation_id,
    input,
    async (tx) => {
      const r = (
        await tx.query(
          "SELECT * FROM rooms WHERE id=$1 AND owner_id=$2 AND kind='group' AND NOT deleted FOR UPDATE",
          [p.room_id, owner],
        )
      ).rows[0];
      if (!r) throw fail();
      await worldLock(tx, owner, r.world_id);
      const group = await groupScope(tx, owner, r.id);
      if (input.command === 'saveGroupPolicy') {
        matchRevision(group, input.expected_revision);
        for (const id of p.mcp_ids)
          if (
            !(
              await tx.query(
                'SELECT 1 FROM mcp_connections WHERE id=$1 AND owner_id=$2',
                [id, owner],
              )
            ).rowCount
          )
            throw fail();
        if (
          p.image_provider_id &&
          !(
            await tx.query(
              'SELECT 1 FROM provider_connections WHERE id=$1 AND owner_id=$2',
              [p.image_provider_id, owner],
            )
          ).rowCount
        )
          throw fail();
        return (
          await tx.query(
            'INSERT INTO group_policies(owner_id,room_id,instruction,mcp_ids,memory_enabled,image_provider_id,reply_policy) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(room_id) DO UPDATE SET instruction=$3,mcp_ids=$4,memory_enabled=$5,image_provider_id=$6,reply_policy=$7,revision=group_policies.revision+1 RETURNING *',
            [
              owner,
              r.id,
              p.instruction,
              p.mcp_ids,
              p.memory_enabled,
              p.image_provider_id ?? null,
              p.reply_policy,
            ],
          )
        ).rows[0];
      }
      if (input.command === 'setGroupMember') {
        if (
          !(
            await tx.query(
              'SELECT 1 FROM room_memberships WHERE room_id=$1 AND actor_id=$2 AND left_at IS NULL',
              [r.id, p.actor_id],
            )
          ).rowCount
        )
          throw fail();
        const old = group.members.find((m: any) => m.actor_id === p.actor_id);
        matchRevision(old ?? { revision: 0 }, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO group_member_policies(room_id,actor_id,tools_enabled,memory_enabled,instruction) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,actor_id) DO UPDATE SET tools_enabled=$3,memory_enabled=$4,instruction=$5,revision=group_member_policies.revision+1 RETURNING *',
            [
              r.id,
              p.actor_id,
              p.tools_enabled,
              p.memory_enabled,
              p.instruction,
            ],
          )
        ).rows[0];
      }
      if (input.command === 'sendPrivateLane') {
        if (
          !(
            await tx.query(
              'SELECT 1 FROM room_memberships WHERE room_id=$1 AND actor_id=$2 AND left_at IS NULL',
              [r.id, p.actor_id],
            )
          ).rowCount
        )
          throw fail();
        let lane = (
          await tx.query(
            'SELECT * FROM rooms WHERE parent_group_id=$1 AND lane_actor_id=$2 AND NOT deleted',
            [r.id, p.actor_id],
          )
        ).rows[0];
        if (!lane) {
          lane = await editEntityTx(
            tx,
            owner,
            'rooms',
            'POST',
            {
              world_id: r.world_id,
              name: r.name + ' · 私密支线',
              kind: 'direct',
              actor_ids: [p.actor_id],
              provider_id: r.provider_id,
              max_replies: 1,
            },
            randomUUID(),
          );
          await tx.query(
            'UPDATE rooms SET parent_group_id=$2,lane_actor_id=$3 WHERE id=$1',
            [lane.id, r.id, p.actor_id],
          );
        }
        const ack = await enqueueInTransaction(
          tx,
          owner,
          lane.id,
          {
            client_command_id: input.operation_id,
            content: p.content,
            addressed_actor_ids: [p.actor_id],
          },
          hash(canonical(p)),
        );
        return { room_id: lane.id, ...ack };
      }
      if (['previewDisband', 'disbandGroup'].includes(input.command)) {
        const rooms = (
          await tx.query(
            'SELECT id,revision FROM rooms WHERE id=$1 OR parent_group_id=$1 ORDER BY id',
            [r.id],
          )
        ).rows;
        const messages = (
          await tx.query(
            'SELECT id,revision,status FROM messages WHERE room_id=ANY($1::uuid[]) ORDER BY id',
            [rooms.map((r) => r.id)],
          )
        ).rows;
        const active = (
          await tx.query(
            "SELECT id FROM runs WHERE room_id=ANY($1::uuid[]) AND state IN ('queued','running','awaiting_approval','remote_pending')",
            [rooms.map((r) => r.id)],
          )
        ).rows;
        const token = hash(canonical({ rooms, messages, group }));
        if (input.command === 'previewDisband')
          return {
            preview_token: token,
            rooms: rooms.length,
            messages: messages.length,
            active: active.length,
            revision: r.revision,
          };
        if (token !== p.preview_token || active.length)
          throw new AppError(
            409,
            'revision_conflict',
            'Group changed or has active work',
          );
        await invalidateSources(
          tx,
          owner,
          r.world_id,
          messages.map((m) => m.id),
          true,
        );
        await tx.query(
          "UPDATE messages SET content='',status='invalidated',revision=revision+1 WHERE room_id=ANY($1::uuid[])",
          [rooms.map((r) => r.id)],
        );
        await tx.query(
          'DELETE FROM asset_references WHERE message_id=ANY($1::uuid[])',
          [messages.map((m) => m.id)],
        );
        await tx.query(
          'UPDATE rooms SET deleted=true,revision=revision+1 WHERE id=ANY($1::uuid[])',
          [rooms.map((r) => r.id)],
        );
        await tx.query(
          'UPDATE room_memberships SET left_at=now() WHERE room_id=ANY($1::uuid[])',
          [rooms.map((r) => r.id)],
        );
        await purgeReplay(tx, owner);
        return { disbanded: true };
      }
      throw fail();
    },
  );
}
