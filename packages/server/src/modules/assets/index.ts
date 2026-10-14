import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { canonical } from '../mcp/schema.js';
import { emit } from '../sync/index.js';
import { matchRevision, worldLock } from '../worlds/index.js';

export const assetView = (a: any) => ({
  id: a.id,
  world_id: a.world_id,
  actor_id: a.actor_id,
  content_hash: a.content_hash,
  mime: a.mime,
  size: a.size,
  revision: a.revision,
  input_mode: a.input_mode,
  extracted_text: a.extracted_text,
});
async function getAsset(db: DB, owner: string, id: string, lock = false) {
  const row = (
    await db.query(
      `SELECT * FROM assets WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [owner, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'resource_missing', 'Asset not found');
  return row;
}
export async function createAsset(
  db: pg.Pool,
  owner: string,
  input: {
    operation_id: string;
    world_id: string;
    actor_id?: string;
    mime: string;
    content_base64: string;
  },
) {
  const content = Buffer.from(input.content_base64, 'base64');
  if (
    !content.length ||
    content.length > 1048576 ||
    content.toString('base64') !== input.content_base64
  )
    throw new AppError(
      400,
      'invalid_asset',
      'Use canonical base64 for an asset of 1 byte to 1 MiB',
    );
  const digest = hash(content);
  // Neither original bytes nor arbitrary content is copied into the command ledger.
  return command(
    db,
    owner,
    'asset.create',
    input.operation_id,
    {
      world: input.world_id,
      actor: input.actor_id ?? null,
      mime: input.mime,
      digest,
    },
    async (tx) => {
      const scope = (
        await tx.query(
          'SELECT id FROM worlds WHERE owner_id=$1 AND id=$2 AND NOT deleted',
          [owner, input.world_id],
        )
      ).rowCount;
      if (!scope) throw new AppError(404, 'not_found', 'World not found');
      if (
        input.actor_id &&
        !(
          await tx.query(
            'SELECT id FROM world_characters WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND NOT deleted',
            [owner, input.world_id, input.actor_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Actor not found in world');
      const prior = (
        await tx.query(
          'SELECT * FROM assets WHERE owner_id=$1 AND world_id=$2 AND actor_id IS NOT DISTINCT FROM $3 AND content_hash=$4 AND mime=$5',
          [owner, input.world_id, input.actor_id ?? null, digest, input.mime],
        )
      ).rows[0];
      if (prior) return assetView(prior);
      const row = (
        await tx.query(
          'INSERT INTO assets(id,owner_id,world_id,actor_id,content_hash,mime,size,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            randomUUID(),
            owner,
            input.world_id,
            input.actor_id ?? null,
            digest,
            input.mime,
            content.length,
            content,
          ],
        )
      ).rows[0];
      await emit(tx, owner, 'asset', row.id, assetView(row));
      return assetView(row);
    },
  );
}
export async function readAsset(db: DB, owner: string, id: string) {
  const a = await getAsset(db, owner, id);
  if (hash(a.content) !== a.content_hash)
    throw new AppError(409, 'asset_corrupt', 'Asset hash mismatch');
  return { ...assetView(a), content_base64: a.content.toString('base64') };
}
export async function referenceAsset(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    message_id: string;
    purpose: 'attachment' | 'reference';
    enabled: boolean;
  },
) {
  return command(
    db,
    owner,
    'asset.reference',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const scope = await getAsset(tx, owner, id);
      if (input.enabled) await worldLock(tx, owner, scope.world_id);
      const a = await getAsset(tx, owner, id, true);
      matchRevision(a, input.expected_revision);
      const message = (
        await tx.query(
          `SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id JOIN worlds w ON w.id=r.world_id
       WHERE m.owner_id=$1 AND m.id=$2 AND r.world_id=$3 AND NOT r.deleted AND NOT w.deleted
       AND NOT m.internal AND m.status<>'invalidated'`,
          [owner, input.message_id, a.world_id],
        )
      ).rows[0];
      // Unbinding remains possible after a source has been invalidated/deleted.
      if (input.enabled && !message)
        throw new AppError(
          404,
          'not_found',
          'Message not found in asset scope',
        );
      if (
        input.enabled &&
        a.actor_id &&
        (
          await tx.query(
            'SELECT 1 FROM message_audiences WHERE message_id=$1 AND actor_id<>$2 LIMIT 1',
            [input.message_id, a.actor_id],
          )
        ).rowCount
      )
        throw new AppError(
          403,
          'permission_denied',
          'Private asset cannot be shared with other actors',
        );
      if (input.enabled)
        await tx.query(
          'INSERT INTO asset_references(owner_id,asset_id,message_id,purpose,input_mode,extracted_text) SELECT $1,$2,$3,$4,input_mode,extracted_text FROM assets WHERE id=$2 ON CONFLICT DO NOTHING',
          [owner, id, input.message_id, input.purpose],
        );
      else
        await tx.query(
          'DELETE FROM asset_references WHERE owner_id=$1 AND asset_id=$2 AND message_id=$3 AND purpose=$4',
          [owner, id, input.message_id, input.purpose],
        );
      const updated = (
        await tx.query(
          'UPDATE assets SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
          [id],
        )
      ).rows[0];
      await emit(tx, owner, 'asset', id, assetView(updated));
      return assetView(updated);
    },
  );
}
async function preview(db: DB, owner: string, id: string) {
  const a = await getAsset(db, owner, id);
  const refs = (
    await db.query(
      'SELECT message_id,purpose FROM asset_references WHERE owner_id=$1 AND asset_id=$2 ORDER BY message_id,purpose',
      [owner, id],
    )
  ).rows;
  const documentRefs = (
    await db.query(
      'SELECT document_id,revision FROM document_version_assets WHERE owner_id=$1 AND asset_id=$2 ORDER BY document_id,revision',
      [owner, id],
    )
  ).rows;
  const mediaRefs = (
    await db.query(
      'SELECT job_id FROM media_job_assets WHERE asset_id=$1 ORDER BY job_id',
      [id],
    )
  ).rows;
  const shareRefs = (
    await db.query(
      'SELECT draft_id FROM share_draft_assets WHERE asset_id=$1 ORDER BY draft_id',
      [id],
    )
  ).rows;
  const voiceRefs = (
    await db.query(
      'SELECT id FROM voice_turns WHERE recording_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  return {
    ...assetView(a),
    media_references: mediaRefs,
    voice_references: voiceRefs,
    share_references: shareRefs,
    references: refs,
    document_references: documentRefs,
    can_delete:
      shareRefs.length === 0 &&
      refs.length === 0 &&
      documentRefs.length === 0 &&
      mediaRefs.length === 0 &&
      voiceRefs.length === 0,
    preview_token: hash(
      canonical({
        shareRefs,
        mediaRefs,
        voiceRefs,
        id,
        revision: a.revision,
        refs,
        documentRefs,
        hash: a.content_hash,
      }),
    ),
  };
}
export async function previewAssetDeletion(
  db: pg.Pool,
  owner: string,
  id: string,
) {
  return transaction(
    db,
    (tx) => preview(tx, owner, id),
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
export async function deleteAsset(
  db: pg.Pool,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    preview_token: string;
  },
) {
  return command(
    db,
    owner,
    'asset.delete',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const a = await getAsset(tx, owner, id, true);
      matchRevision(a, input.expected_revision);
      const p = await preview(tx, owner, id);
      if (p.preview_token !== input.preview_token)
        throw new AppError(
          409,
          'revision_conflict',
          'Refresh the deletion preview',
        );
      if (!p.can_delete)
        throw new AppError(
          409,
          'resource_in_use',
          'Remove all references before deleting the original',
        );
      await tx.query('DELETE FROM assets WHERE owner_id=$1 AND id=$2', [
        owner,
        id,
      ]);
      await emit(tx, owner, 'asset', id, { id, deleted: true });
      return { id, deleted: true };
    },
  );
}
