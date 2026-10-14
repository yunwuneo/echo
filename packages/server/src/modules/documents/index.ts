import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import { hash, AppError } from '../../security.js';
import { command } from '../commands/index.js';
import { worldLock, matchRevision } from '../worlds/index.js';
import { emit } from '../sync/index.js';
async function project(
  db: DB,
  owner: string,
  id: string,
  actor?: string,
  world?: string,
) {
  const p = (
    await db.query(
      'SELECT p.* FROM projects p JOIN worlds w ON w.id=p.world_id WHERE p.owner_id=$1 AND p.id=$2 AND NOT w.deleted',
      [owner, id],
    )
  ).rows[0];
  if (
    !p ||
    (world && p.world_id !== world) ||
    (actor && p.actor_id && p.actor_id !== actor)
  )
    throw new AppError(404, 'not_found', 'Project not in scope');
  return p;
}
export async function createProject(db: pg.Pool, owner: string, input: any) {
  return command(
    db,
    owner,
    'project.create',
    input.operation_id,
    input,
    async (tx) => {
      await worldLock(tx, owner, input.world_id);
      if (
        input.actor_id &&
        !(
          await tx.query(
            'SELECT 1 FROM world_characters WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND NOT deleted',
            [owner, input.world_id, input.actor_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Actor not in world');
      const p = (
        await tx.query(
          'INSERT INTO projects(owner_id,world_id,actor_id,name) VALUES($1,$2,$3,$4) RETURNING *',
          [owner, input.world_id, input.actor_id ?? null, input.name],
        )
      ).rows[0];
      await emit(tx, owner, 'project', p.id, p);
      return { id: p.id, revision: p.revision };
    },
  );
}
export async function readDocument(
  db: DB,
  owner: string,
  id: string,
  actor?: string,
  world?: string,
) {
  const d = (
    await db.query('SELECT * FROM documents WHERE owner_id=$1 AND id=$2', [
      owner,
      id,
    ])
  ).rows[0];
  if (!d) throw new AppError(404, 'not_found', 'Document not found');
  await project(db, owner, d.project_id, actor, world);
  if (hash(d.content) !== d.content_hash)
    throw new AppError(409, 'document_corrupt', 'Document hash mismatch');
  return d;
}
export async function saveDocumentTx(
  tx: pg.PoolClient,
  owner: string,
  input: any,
  actor?: string,
  world?: string,
) {
  const p = await project(tx, owner, input.project_id, actor, world);
  await worldLock(tx, owner, p.world_id);
  let old: any;
  if (input.id) {
    old = await readDocument(tx, owner, input.id, actor, world);
    if (old.project_id !== p.id)
      throw new AppError(
        400,
        'immutable_project',
        'Document cannot move silently',
      );
    matchRevision(old, input.expected_revision);
    if (input.base_hash !== old.content_hash)
      throw new AppError(409, 'revision_conflict', 'Document baseline changed');
    if (actor && old.kind === 'reference')
      throw new AppError(
        403,
        'read_only',
        'Reference documents are read-only for tools',
      );
  }
  if (actor && input.kind === 'reference')
    throw new AppError(
      403,
      'read_only',
      'Tools cannot create or overwrite reference material',
    );
  let content = input.content,
    title = input.title,
    assets: string[] | undefined;
  if (input.restore_revision !== undefined) {
    if (!old)
      throw new AppError(400, 'invalid_request', 'Restore needs a document');
    const v = (
      await tx.query(
        'SELECT * FROM document_versions WHERE document_id=$1 AND revision=$2',
        [old.id, input.restore_revision],
      )
    ).rows[0];
    if (!v) throw new AppError(404, 'not_found', 'Version not found');
    content = v.content;
    title = v.title;
    assets = v.asset_ids;
  }
  if (typeof content !== 'string' || Buffer.byteLength(content) > 262144)
    throw new AppError(413, 'document_size', 'Document limit is 256 KiB');
  if (
    old &&
    (
      await tx.query(
        'SELECT count(*)::int AS n FROM document_versions WHERE document_id=$1',
        [old.id],
      )
    ).rows[0].n >= 200
  )
    throw new AppError(409, 'version_limit', 'Document version limit reached');
  const d = old
    ? (
        await tx.query(
          'UPDATE documents SET title=$3,content=$4,content_hash=$5,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *',
          [owner, old.id, title, content, hash(content)],
        )
      ).rows[0]
    : (
        await tx.query(
          'INSERT INTO documents(owner_id,project_id,title,kind,content,content_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [owner, p.id, title, input.kind, content, hash(content)],
        )
      ).rows[0];
  if (input.asset_ids !== undefined) assets = input.asset_ids;
  if (assets !== undefined) {
    for (const id of assets) {
      const a = (
        await tx.query(
          'SELECT * FROM assets WHERE owner_id=$1 AND id=$2 AND world_id=$3',
          [owner, id, p.world_id],
        )
      ).rows[0];
      if (!a || (a.actor_id && a.actor_id !== p.actor_id))
        throw new AppError(
          404,
          'resource_missing',
          'Asset outside document scope',
        );
    }
    const previous = (
      await tx.query(
        'DELETE FROM document_assets WHERE document_id=$1 RETURNING asset_id',
        [d.id],
      )
    ).rows;
    for (const id of assets)
      await tx.query(
        'INSERT INTO document_assets(owner_id,document_id,asset_id) VALUES($1,$2,$3)',
        [owner, d.id, id],
      );
    for (const id of new Set([...assets, ...previous.map((a) => a.asset_id)])) {
      const a = (
        await tx.query(
          'UPDATE assets SET revision=revision+1 WHERE id=$1 RETURNING id,world_id,actor_id,content_hash,mime,size,revision',
          [id],
        )
      ).rows[0];
      await emit(tx, owner, 'asset', id, a);
    }
  }
  const refs = (
    await tx.query(
      'SELECT asset_id FROM document_assets WHERE document_id=$1 ORDER BY asset_id',
      [d.id],
    )
  ).rows.map((r) => r.asset_id);
  await tx.query(
    'INSERT INTO document_versions(owner_id,document_id,revision,content,content_hash,title,asset_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [owner, d.id, d.revision, d.content, d.content_hash, d.title, refs],
  );
  for (const asset of refs)
    await tx.query(
      'INSERT INTO document_version_assets(owner_id,document_id,revision,asset_id) VALUES($1,$2,$3,$4)',
      [owner, d.id, d.revision, asset],
    );
  await emit(tx, owner, 'document', d.id, { ...d, asset_ids: refs });
  return { id: d.id, revision: d.revision, content_hash: d.content_hash };
}
export async function saveDocument(db: pg.Pool, owner: string, input: any) {
  return command(db, owner, 'document.save', input.operation_id, input, (tx) =>
    saveDocumentTx(tx, owner, input),
  );
}
export async function documentDetails(db: pg.Pool, owner: string, id: string) {
  return transaction(
    db,
    async (tx) => {
      const document = await readDocument(tx, owner, id);
      const versions = (
        await tx.query(
          'SELECT * FROM document_versions WHERE document_id=$1 ORDER BY revision DESC',
          [id],
        )
      ).rows;
      return {
        document,
        versions,
        asset_ids: (
          await tx.query(
            'SELECT asset_id FROM document_assets WHERE document_id=$1 ORDER BY asset_id',
            [id],
          )
        ).rows.map((r) => r.asset_id),
      };
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
export async function contentLibrary(db: DB, owner: string) {
  return {
    projects: (
      await db.query(
        'SELECT p.* FROM projects p JOIN worlds w ON w.id=p.world_id WHERE p.owner_id=$1 AND NOT w.deleted ORDER BY p.name,p.id',
        [owner],
      )
    ).rows,
    documents: (
      await db.query(
        'SELECT d.id,d.project_id,d.title,d.kind,d.revision,d.content_hash,d.updated_at FROM documents d JOIN projects p ON p.id=d.project_id JOIN worlds w ON w.id=p.world_id WHERE d.owner_id=$1 AND NOT w.deleted ORDER BY d.updated_at DESC',
        [owner],
      )
    ).rows,
  };
}
