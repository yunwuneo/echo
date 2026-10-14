import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import {
  worldLock,
  bumpWorld,
  matchRevision,
  eventView,
  addEvent,
} from '../worlds/index.js';
import { invalidateSources } from '../memory/repository.js';
import { emit, messageView } from '../sync/index.js';

async function source(db: DB, owner: string, id: string) {
  const m = (
    await db.query(
      `SELECT m.*,r.world_id,r.next_sequence,w.revision AS world_revision FROM messages m
     JOIN rooms r ON r.id=m.room_id JOIN worlds w ON w.id=r.world_id
     WHERE m.owner_id=$1 AND m.id=$2 AND NOT r.deleted AND NOT w.deleted AND NOT m.internal AND m.status<>'invalidated'`,
      [owner, id],
    )
  ).rows[0];
  if (!m) throw new AppError(404, 'not_found', 'Message not found');
  return m;
}
const contextToken = (m: any) =>
  hash(`${m.room_id}:${m.next_sequence}:${m.world_revision}`);
export async function messageVersions(db: pg.Pool, owner: string, id: string) {
  return transaction(
    db,
    async (tx) => {
      const m = await source(tx, owner, id);
      return {
        message: messageView(m),
        context_token: contextToken(m),
        later_messages: (
          await tx.query(
            "SELECT count(*)::int AS count FROM messages WHERE room_id=$1 AND sequence>$2 AND status<>'invalidated' AND NOT internal",
            [m.room_id, m.sequence],
          )
        ).rows[0].count,
        items: (
          await tx.query(
            'SELECT id,content,status,base_context_revision,created_at FROM message_versions WHERE owner_id=$1 AND message_id=$2 ORDER BY created_at,id LIMIT 200',
            [owner, id],
          )
        ).rows,
      };
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
type Edit = {
  operation_id: string;
  expected_revision: number;
  context_token: string;
  mode: 'keep' | 'truncate';
  content?: string;
  version_id?: string;
};
export async function editMessage(
  db: pg.Pool,
  owner: string,
  id: string,
  input: Edit,
) {
  return command(
    db,
    owner,
    'message.edit',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const initial = await source(tx, owner, id);
      await worldLock(tx, owner, initial.world_id);
      const m = await source(tx, owner, id);
      matchRevision(m, input.expected_revision);
      if (contextToken(m) !== input.context_token)
        throw new AppError(
          409,
          'revision_conflict',
          'Conversation changed; refresh the impact preview',
        );
      if (
        (
          await tx.query(
            "SELECT 1 FROM runs WHERE world_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending') LIMIT 1",
            [m.world_id],
          )
        ).rowCount
      )
        throw new AppError(
          409,
          'active_runs',
          'Wait for or cancel active turns before editing history',
        );
      if (
        !['completed', 'interrupted', 'failed', 'cancelled'].includes(m.status)
      )
        throw new AppError(
          409,
          'message_not_settled',
          'Message is not settled',
        );
      let content = input.content,
        version = input.version_id;
      if (version) {
        const v = (
          await tx.query(
            'SELECT content FROM message_versions WHERE owner_id=$1 AND message_id=$2 AND id=$3',
            [owner, id, version],
          )
        ).rows[0];
        if (!v) throw new AppError(404, 'not_found', 'Version not found');
        content = v.content;
      }
      if (!content || (input.content !== undefined && version))
        throw new AppError(
          400,
          'invalid_request',
          'Supply content or a version',
        );
      if (
        (
          await tx.query(
            'SELECT count(*)::int AS count FROM message_versions WHERE message_id=$1',
            [id],
          )
        ).rows[0].count >= 200 &&
        !version
      )
        throw new AppError(
          409,
          'version_limit',
          'Message version limit reached',
        );
      const tail = (
        await tx.query(
          "SELECT id,memory_excluded FROM messages WHERE owner_id=$1 AND room_id=$2 AND sequence>$3 AND status<>'invalidated' LIMIT 10001",
          [owner, m.room_id, m.sequence],
        )
      ).rows;
      if (tail.length > 10000)
        throw new AppError(
          409,
          'history_edit_limit',
          'Too many later messages to edit in one operation',
        );
      // Invalidate derived memories/transcripts without treating an edit as erasure
      // of the selected message or its retained later conversation.
      const included = (
        await tx.query(
          `WITH RECURSIVE affected(id) AS (
      SELECT id FROM messages WHERE owner_id=$1 AND id=$2
      UNION SELECT d.message_id FROM message_dependencies d JOIN affected a ON a.id=d.source_id
    ) SELECT m.id FROM messages m JOIN affected a ON a.id=m.id WHERE m.owner_id=$1 AND NOT m.memory_excluded LIMIT 10001`,
          [owner, id],
        )
      ).rows.map((r) => r.id);
      if (included.length > 10000)
        throw new AppError(
          409,
          'history_edit_limit',
          'Too many dependent messages to edit in one operation',
        );
      await invalidateSources(tx, owner, m.world_id, [id]);
      await tx.query(
        'UPDATE messages SET memory_excluded=false WHERE id=ANY($1::uuid[])',
        [included],
      );
      if (input.mode === 'truncate') {
        await tx.query(
          "UPDATE messages SET status='invalidated',context_stale=true WHERE id=ANY($1::uuid[])",
          [tail.map((t) => t.id)],
        );
        await tx.query(
          'UPDATE world_events SET invalidated=true WHERE message_id=ANY($1::uuid[])',
          [tail.map((t) => t.id)],
        );
      } else
        await tx.query(
          'UPDATE messages SET context_stale=true WHERE id=ANY($1::uuid[])',
          [tail.map((t) => t.id)],
        );
      const updated = (
        await tx.query(
          `UPDATE messages SET content=$3,status='completed',selected_version_id=COALESCE($4::uuid,selected_version_id),context_stale=false
       WHERE owner_id=$1 AND id=$2 RETURNING *`,
          [owner, id, content, version ?? null],
        )
      ).rows[0];
      await tx.query(
        'UPDATE world_events SET invalidated=true WHERE message_id=$1',
        [id],
      );
      const worldRevision = await bumpWorld(tx, owner, m.world_id);
      const eventIds =
        input.mode === 'truncate' ? [id, ...tail.map((t) => t.id)] : [id];
      for (const event of (
        await tx.query(
          'SELECT * FROM world_events WHERE owner_id=$1 AND message_id=ANY($2::uuid[])',
          [owner, eventIds],
        )
      ).rows)
        await emit(tx, owner, 'world_event', event.id, eventView(event));
      const audience = (
        await tx.query(
          'SELECT actor_id FROM message_audiences WHERE message_id=$1',
          [id],
        )
      ).rows.map((a) => a.actor_id);
      await addEvent(
        tx,
        owner,
        m.world_id,
        'user_correction',
        worldRevision,
        {
          edited_message_id: id,
          selected_version_id: updated.selected_version_id,
          mode: input.mode,
        },
        audience,
      );
      for (const row of (
        await tx.query('SELECT * FROM messages WHERE id=ANY($1::uuid[])', [
          [id, ...tail.map((t) => t.id)],
        ])
      ).rows)
        await emit(tx, owner, 'message', row.id, messageView(row));
      // Receipts have no body copy, so subsequent privacy erasure is complete.
      return {
        id,
        revision: updated.revision,
        selected_version_id: updated.selected_version_id,
      };
    },
  );
}
export async function exportConversation(
  db: pg.Pool,
  owner: string,
  room: string,
) {
  return transaction(
    db,
    async (tx) => {
      if (
        !(
          await tx.query(
            'SELECT id FROM rooms WHERE owner_id=$1 AND id=$2 AND NOT deleted',
            [owner, room],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Conversation not found');
      const rows = (
        await tx.query(
          `SELECT id,role,actor_name,content,sequence,context_stale FROM messages WHERE owner_id=$1 AND room_id=$2
       AND NOT internal AND status='completed' ORDER BY sequence LIMIT 10001`,
          [owner, room],
        )
      ).rows;
      if (
        rows.length > 10000 ||
        Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024
      )
        throw new AppError(
          413,
          'export_too_large',
          'Conversation export exceeds 8 MiB or 10000 messages',
        );
      const attachments = (
        await tx.query(
          `SELECT ar.message_id,a.id,a.mime,a.content_hash,a.size FROM asset_references ar JOIN assets a ON a.id=ar.asset_id JOIN messages m ON m.id=ar.message_id WHERE m.owner_id=$1 AND m.room_id=$2 AND m.status='completed' AND NOT m.internal ORDER BY m.sequence,a.id`,
          [owner, room],
        )
      ).rows;
      const originals = (
        await tx.query(
          'SELECT id,mime,content_hash,size,content FROM assets WHERE owner_id=$1 AND id=ANY($2::uuid[])',
          [owner, [...new Set(attachments.map((a) => a.id))]],
        )
      ).rows.map((a) => {
        const valid = hash(a.content) === a.content_hash;
        return {
          id: a.id,
          mime: a.mime,
          content_hash: a.content_hash,
          size: a.size,
          available: valid,
          ...(valid
            ? { content_base64: a.content.toString('base64') }
            : { error: 'asset_corrupt' }),
        };
      });
      const result = {
        format: 'echo-conversation',
        format_version: 1,
        room_id: room,
        messages: rows,
        excludes: ['unselected_versions', 'tool_arguments', 'reasoning'],
        attachments,
        originals,
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
        throw new AppError(
          413,
          'export_too_large',
          'Conversation export including originals exceeds 8 MiB',
        );
      return result;
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
