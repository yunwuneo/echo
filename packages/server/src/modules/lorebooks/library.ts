import { Value } from '@sinclair/typebox/value';
import { FormatRegistry } from '@sinclair/typebox';
import { LoreInput } from '../../../../contracts/src/index.js';
import type pg from 'pg';
import { type DB } from '../../db/index.js';
import { AppError } from '../../security.js';
import { command } from '../commands/index.js';
import { worldLock, matchRevision, editEntityTx } from '../worlds/index.js';
import { randomUUID } from 'node:crypto';
export async function bookCommand(db: pg.Pool, owner: string, input: any) {
  const p = input.payload;
  if (input.command === 'bookLibrary')
    return {
      books: (
        await db.query(
          'SELECT * FROM worldbooks WHERE owner_id=$1 AND world_id=$2 ORDER BY name,id',
          [owner, p.world_id],
        )
      ).rows,
      bindings: (
        await db.query(
          'SELECT b.* FROM worldbook_bindings b JOIN worldbooks w ON w.id=b.book_id WHERE b.owner_id=$1 AND w.world_id=$2',
          [owner, p.world_id],
        )
      ).rows,
      entries: (
        await db.query(
          'SELECT * FROM lore_entries WHERE owner_id=$1 AND world_id=$2 AND book_id IS NOT NULL AND NOT deleted',
          [owner, p.world_id],
        )
      ).rows,
    };
  return command(
    db,
    owner,
    input.command,
    input.operation_id,
    input,
    async (tx) => {
      await worldLock(tx, owner, p.world_id);
      if (input.command === 'createBook') {
        return (
          await tx.query(
            'INSERT INTO worldbooks(owner_id,world_id,name) VALUES($1,$2,$3) RETURNING *',
            [owner, p.world_id, p.name],
          )
        ).rows[0];
      }
      const book = (
        await tx.query(
          'SELECT * FROM worldbooks WHERE id=$1 AND owner_id=$2 AND world_id=$3 FOR UPDATE',
          [p.book_id, owner, p.world_id],
        )
      ).rows[0];
      if (!book) throw new AppError(404, 'not_found', 'Worldbook not found');
      if (input.command === 'saveBookEntry') {
        FormatRegistry.Set('uuid', (v) =>
          /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v),
        );
        if (!Value.Check(LoreInput, p.data))
          throw new AppError(400, 'invalid_lore', 'Invalid entry data');
        if (
          p.id &&
          !(
            await tx.query(
              'SELECT 1 FROM lore_entries WHERE id=$1 AND book_id=$2',
              [p.id, book.id],
            )
          ).rowCount
        )
          throw new AppError(404, 'not_found', 'Entry not in book');
        const entry = await editEntityTx(
          tx,
          owner,
          'lore',
          p.id ? 'PUT' : 'POST',
          { ...p.data, timing_unit: 'messages', world_id: p.world_id },
          p.id ?? randomUUID(),
          input.expected_revision,
        );
        await tx.query('UPDATE lore_entries SET book_id=$2 WHERE id=$1', [
          entry.id,
          book.id,
        ]);
        await tx.query(
          'UPDATE worldbooks SET revision=revision+1 WHERE id=$1',
          [book.id],
        );
        return entry;
      }
      if (input.command === 'bindBook') {
        if (p.scope === 'global' && p.target_id !== owner)
          throw new AppError(
            403,
            'scope_denied',
            'Global binding requires owner',
          );
        if (
          p.scope === 'actor' &&
          !(
            await tx.query(
              'SELECT 1 FROM world_characters WHERE id=$1 AND owner_id=$2 AND world_id=$3 AND NOT deleted',
              [p.target_id, owner, p.world_id],
            )
          ).rowCount
        )
          throw new AppError(404, 'not_found', 'Actor not in book world');
        if (['room', 'group_member'].includes(p.scope)) {
          const r = (
            await tx.query(
              'SELECT * FROM rooms WHERE id=$1 AND owner_id=$2 AND world_id=$3 AND NOT deleted',
              [p.target_id, owner, p.world_id],
            )
          ).rows[0];
          if (!r)
            throw new AppError(404, 'not_found', 'Room not in book world');
          if (
            p.scope === 'group_member' &&
            (r.kind !== 'group' ||
              !(
                await tx.query(
                  'SELECT 1 FROM room_memberships WHERE room_id=$1 AND actor_id=$2 AND left_at IS NULL',
                  [r.id, p.actor_id],
                )
              ).rowCount)
          )
            throw new AppError(
              403,
              'scope_denied',
              'Current group member required',
            );
        }
        const old = (
          await tx.query(
            'SELECT * FROM worldbook_bindings WHERE book_id=$1 AND scope=$2 AND target_id=$3 AND actor_id IS NOT DISTINCT FROM $4',
            [
              book.id,
              p.scope,
              p.target_id,
              p.scope === 'group_member' ? p.actor_id : null,
            ],
          )
        ).rows[0];
        matchRevision(old ?? { revision: 0 }, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO worldbook_bindings(owner_id,book_id,scope,target_id,actor_id,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(book_id,scope,target_id,actor_id) DO UPDATE SET enabled=$6,revision=worldbook_bindings.revision+1 RETURNING *',
            [
              owner,
              book.id,
              p.scope,
              p.target_id,
              p.scope === 'group_member' ? p.actor_id : null,
              p.enabled,
            ],
          )
        ).rows[0];
      }
      throw new AppError(
        400,
        'unsupported_command',
        'Unknown worldbook command',
      );
    },
  );
}
export async function allowedBookEntries(
  db: DB,
  owner: string,
  world: string,
  room: string,
  actor: string,
) {
  return (
    await db.query(
      `SELECT e.*,CASE WHEN a.entry_id IS NULL THEN NULL ELSE jsonb_build_object('turn',a.turn,'sticky_until',a.sticky_until,'cooldown_until',a.cooldown_until,'pending_since',a.pending_since) END AS activation FROM lore_entries e JOIN rooms r ON r.id=$4 LEFT JOIN lore_activations a ON a.entry_id=e.id AND a.revision=e.revision AND a.room_id=r.id AND a.actor_id=$3 WHERE e.owner_id=$1 AND e.world_id=$2 AND NOT e.deleted AND (e.data->'audience_actor_ids'='[]'::jsonb OR e.data->'audience_actor_ids' ? $3::text) AND ((e.book_id IS NULL AND r.kind<>'group' AND r.parent_group_id IS NULL) OR EXISTS(SELECT 1 FROM worldbook_bindings b WHERE b.book_id=e.book_id AND b.enabled AND ((r.kind<>'group' AND r.parent_group_id IS NULL AND (b.scope='global' OR (b.scope='actor' AND b.target_id=$3))) OR (b.scope='room' AND b.target_id=COALESCE(r.parent_group_id,$4)) OR (b.scope='group_member' AND b.target_id=COALESCE(r.parent_group_id,$4) AND b.actor_id=$3))))`,
      [owner, world, actor, room],
    )
  ).rows;
}
