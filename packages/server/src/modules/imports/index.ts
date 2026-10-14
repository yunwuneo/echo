import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import {
  worldLock,
  bumpWorld,
  validateActors,
  characterView,
  actorView,
  loreView,
  archiveRevision,
} from '../worlds/index.js';
import { emit } from '../sync/index.js';
import { decodeImport } from './parse.js';
export async function previewImport(
  db: pg.Pool,
  owner: string,
  world: string,
  body: any,
) {
  const { bytes, plan } = decodeImport(body);
  const fileHash = hash(bytes);
  return transaction(db, async (tx) => {
    const w = await worldLock(tx, owner, world);
    await validateActors(tx, owner, world, body.audience_actor_ids);
    const existing = (
      await tx.query(
        'SELECT * FROM import_jobs WHERE owner_id=$1 AND world_id=$2 AND file_hash=$3 AND adapter_version=1',
        [owner, world, fileHash],
      )
    ).rows[0];
    if (existing?.result)
      return { id: existing.id, ...existing.preview, result: existing.result };
    const names = (
      await tx.query(
        "SELECT data->>'name' AS name FROM lore_entries WHERE world_id=$1 AND NOT deleted",
        [world],
      )
    ).rows.map((r) => r.name);
    const chars = (
      await tx.query(
        'SELECT name FROM world_characters WHERE world_id=$1 AND NOT deleted',
        [world],
      )
    ).rows.map((r) => r.name);
    const conflicts = [
      ...(plan.character && chars.includes(plan.character.name)
        ? [`角色：${plan.character.name}`]
        : []),
      ...plan.entries
        .filter((e) => names.includes(e.name))
        .map((e) => `世界书：${e.name}`),
    ];
    const preview = {
      ...plan,
      world_revision: w.revision,
      audience_actor_ids: body.audience_actor_ids,
      conflicts,
    };
    const id = existing?.id ?? randomUUID();
    await tx.query(
      'INSERT INTO import_jobs(id,owner_id,world_id,file_hash,adapter_version,format,raw,preview) VALUES($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT(owner_id,world_id,file_hash,adapter_version) DO UPDATE SET preview=EXCLUDED.preview',
      [id, owner, world, fileHash, body.format, bytes, JSON.stringify(preview)],
    );
    return { id, ...preview, result: null };
  });
}
export async function commitImport(
  db: pg.Pool,
  owner: string,
  id: string,
  body: any,
) {
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      owner,
    ]);
    const initial = (
      await tx.query('SELECT * FROM import_jobs WHERE id=$1 AND owner_id=$2', [
        id,
        owner,
      ])
    ).rows[0];
    if (!initial)
      throw new AppError(404, 'not_found', 'Import preview not found');
    const world = await worldLock(tx, owner, initial.world_id);
    const job = (
      await tx.query('SELECT * FROM import_jobs WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (job.result) {
      if (
        job.result.strategy !== body.strategy ||
        Boolean(job.result.enable_prompt_suggestions) !==
          Boolean(body.enable_prompt_suggestions)
      )
        throw new AppError(
          409,
          'import_already_committed',
          'Batch already committed using another strategy',
        );
      return job.result;
    }
    const p = job.preview;
    if (p.errors.length)
      throw new AppError(
        400,
        'import_needs_repair',
        'Repair every preview error before importing',
      );
    if (world.revision !== p.world_revision)
      throw new AppError(
        409,
        'import_preview_stale',
        'World changed. Preview the original file again',
      );
    const result: {
      strategy: string;
      enable_prompt_suggestions: boolean;
      character_id: string | null;
      actor_id: string | null;
      lore_ids: string[];
      book_id: string | null;
      skipped: string[];
    } = {
      strategy: body.strategy,
      enable_prompt_suggestions: Boolean(body.enable_prompt_suggestions),
      character_id: null,
      actor_id: null,
      lore_ids: [],
      book_id: null,
      skipped: [],
    };
    let audience = p.audience_actor_ids;
    if (p.character) {
      if (
        body.strategy === 'skip' &&
        p.conflicts.includes(`角色：${p.character.name}`)
      ) {
        result.skipped.push(`角色及关联世界书：${p.character.name}`);
        await tx.query('UPDATE import_jobs SET result=$2 WHERE id=$1', [
          id,
          JSON.stringify(result),
        ]);
        return result;
      }
      const template = randomUUID(),
        actor = randomUUID();
      const name =
        body.strategy === 'copy' &&
        p.conflicts.includes(`角色：${p.character.name}`)
          ? `${p.character.name.slice(0, 72)}（副本）`
          : p.character.name;
      const data = {
        ...p.character,
        name,
        prompt_suggestions: {
          ...p.character.prompt_suggestions,
          enabled: Boolean(body.enable_prompt_suggestions),
        },
      };
      await tx.query(
        'INSERT INTO character_templates(id,owner_id) VALUES($1,$2)',
        [template, owner],
      );
      await tx.query(
        'INSERT INTO character_versions(template_id,owner_id,revision,data) VALUES($1,$2,1,$3)',
        [template, owner, JSON.stringify(data)],
      );
      const av = (
        await tx.query(
          'INSERT INTO world_characters(id,owner_id,world_id,template_id,template_revision,name) VALUES($1,$2,$3,$4,1,$5) RETURNING *',
          [actor, owner, world.id, template, name],
        )
      ).rows[0];
      const cv = characterView({ id: template, revision: 1, data });
      await archiveRevision(tx, owner, 'character', template, cv);
      await archiveRevision(tx, owner, 'actor', actor, actorView(av));
      await emit(tx, owner, 'character', template, cv);
      await emit(tx, owner, 'actor', actor, actorView(av));
      result.character_id = template;
      result.actor_id = actor;
      audience = [actor];
    }
    for (const entry of p.entries) {
      if (
        body.strategy === 'skip' &&
        p.conflicts.includes(`世界书：${entry.name}`)
      ) {
        result.skipped.push(`世界书：${entry.name}`);
        continue;
      }
      const data = {
        ...entry,
        audience_actor_ids: audience,
        timing_unit: 'messages',
      };
      if (!result.book_id)
        result.book_id = (
          await tx.query(
            'INSERT INTO worldbooks(owner_id,world_id,name) VALUES($1,$2,$3) RETURNING id',
            [owner, world.id, p.character?.name ?? '导入设定书'],
          )
        ).rows[0].id;
      if (
        body.strategy === 'copy' &&
        p.conflicts.includes(`世界书：${entry.name}`)
      )
        data.name = `${entry.name.slice(0, 72)}（副本）`;
      const row = (
        await tx.query(
          'INSERT INTO lore_entries(id,owner_id,world_id,data,book_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [randomUUID(), owner, world.id, JSON.stringify(data), result.book_id],
        )
      ).rows[0];
      await archiveRevision(tx, owner, 'lore', row.id, loreView(row));
      await emit(tx, owner, 'lore', row.id, loreView(row));
      result.lore_ids.push(row.id);
    }
    await bumpWorld(tx, owner, world.id);
    await tx.query('UPDATE import_jobs SET result=$2 WHERE id=$1', [
      id,
      JSON.stringify(result),
    ]);
    return result;
  });
}
export async function exportImport(db: pg.Pool, owner: string, id: string) {
  const row = (
    await db.query(
      'SELECT raw,format,file_hash FROM import_jobs WHERE id=$1 AND owner_id=$2',
      [id, owner],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Import not found');
  return {
    format: row.format,
    file_hash: row.file_hash,
    data_base64: row.raw.toString('base64'),
  };
}
