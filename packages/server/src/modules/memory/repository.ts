import { canonical } from '../mcp/schema.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { emit, messageView } from '../sync/index.js';
import {
  worldLock,
  matchRevision,
  bumpWorld,
  eventView,
} from '../worlds/index.js';
import { terms } from './retrieval.js';
export const memoryView = (r: any) => ({
  id: r.id,
  world_id: r.world_id,
  revision: r.revision,
  content: r.content,
  topic: r.topic,
  kind: r.kind,
  status: r.status,
  manual: r.manual,
  pinned: r.pinned,
  audience_actor_ids: r.audience_actor_ids,
  source_ids: r.source_ids ?? [],
  valid_from: new Date(r.valid_from).toISOString(),
  valid_to: r.valid_to ? new Date(r.valid_to).toISOString() : null,
});
export const settingsView = (r: any) => ({
  world_id: r.world_id,
  revision: r.revision,
  enabled: r.enabled,
  embedding_provider_id: r.embedding_provider_id,
  embedding_dimensions: r.embedding_dimensions,
  index_version: r.index_version,
});
export async function listMemories(db: DB, owner: string, world?: string) {
  return (
    await db.query(
      `SELECT m.*,ARRAY(SELECT message_id FROM memory_evidence WHERE memory_id=m.id ORDER BY message_id) AS source_ids FROM memories m JOIN worlds w ON w.id=m.world_id WHERE m.owner_id=$1 AND NOT w.deleted AND ($2::uuid IS NULL OR m.world_id=$2) ORDER BY m.created_at,m.id`,
      [owner, world ?? null],
    )
  ).rows.map(memoryView);
}
export async function publishMemory(db: DB, row: any) {
  const source_ids = (
    await db.query(
      'SELECT message_id FROM memory_evidence WHERE memory_id=$1 ORDER BY message_id',
      [row.id],
    )
  ).rows.map((r) => r.message_id);
  const view = memoryView({ ...row, source_ids });
  await db.query(
    'INSERT INTO memory_revisions(memory_id,revision,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [row.id, row.revision, JSON.stringify(view)],
  );
  await emit(db, row.owner_id, 'memory', row.id, view);
  return view;
}
export async function registerSources(db: DB, room: string) {
  await db.query(
    `INSERT INTO memory_sources(message_id,room_id) SELECT id,room_id FROM messages WHERE room_id=$1 AND status='completed' AND NOT memory_excluded ORDER BY sequence ON CONFLICT(message_id) DO NOTHING`,
    [room],
  );
  await db.query(
    'INSERT INTO memory_jobs(room_id) VALUES($1) ON CONFLICT DO NOTHING',
    [room],
  );
}
export async function saveSettings(
  db: pg.Pool,
  owner: string,
  world: string,
  revision: number,
  body: any,
) {
  body.embedding_provider_id ??= null;
  return transaction(db, async (tx) => {
    await worldLock(tx, owner, world);
    await tx.query(
      'INSERT INTO memory_settings(world_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [world, owner],
    );
    const before = (
      await tx.query(
        'SELECT * FROM memory_settings WHERE world_id=$1 FOR UPDATE',
        [world],
      )
    ).rows[0];
    matchRevision(before, revision);
    if (body.embedding_provider_id) {
      if (
        !body.embedding_dimensions ||
        !(
          await tx.query(
            'SELECT 1 FROM provider_connections WHERE id=$1 AND owner_id=$2',
            [body.embedding_provider_id, owner],
          )
        ).rowCount
      )
        throw new AppError(
          400,
          'invalid_embedding',
          'Choose an owned provider and its exact vector dimensions',
        );
    } else if (body.embedding_dimensions !== 0)
      throw new AppError(
        400,
        'invalid_embedding',
        'Disabled embeddings require zero dimensions',
      );
    const changed =
      before.embedding_provider_id !== body.embedding_provider_id ||
      before.embedding_dimensions !== body.embedding_dimensions;
    const row = (
      await tx.query(
        'UPDATE memory_settings SET enabled=$2,embedding_provider_id=$3,embedding_dimensions=$4,revision=revision+1,index_version=index_version+$5 WHERE world_id=$1 RETURNING *',
        [
          world,
          body.enabled,
          body.embedding_provider_id,
          body.embedding_dimensions,
          changed ? 1 : 0,
        ],
      )
    ).rows[0];

    await tx.query(
      'UPDATE worlds SET memory_epoch=memory_epoch+1 WHERE id=$1',
      [world],
    );
    await tx.query(
      'UPDATE memory_jobs SET attempts=0,error_code=NULL,next_attempt_at=now() WHERE room_id IN (SELECT id FROM rooms WHERE world_id=$1)',
      [world],
    );
    await emit(tx, owner, 'memory_settings', world, settingsView(row));
    return settingsView(row);
  });
}
// Redact persisted replay payloads too; old cursors must rebuild and snapshot sessions expire immediately.
export async function purgeReplay(db: DB, owner: string) {
  await db.query(
    'SELECT owner_id FROM sync_heads WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  await db.query('DELETE FROM sync_events WHERE owner_id=$1', [owner]);
  await db.query(
    'UPDATE sync_heads SET cursor=cursor+1,min_cursor=cursor+1 WHERE owner_id=$1',
    [owner],
  );
  await db.query('DELETE FROM sync_snapshots WHERE owner_id=$1', [owner]);
}
export async function invalidateSources(
  db: DB,
  owner: string,
  world: string,
  sourceIds: string[],
  erase = false,
) {
  // Conservative transitive invalidation follows actual prompt dependencies, including memories' evidence.
  const ids = (
    await db.query(
      `WITH RECURSIVE affected(id) AS (
    SELECT id FROM messages WHERE id=ANY($1::uuid[]) AND owner_id=$2
    UNION SELECT d.message_id FROM message_dependencies d JOIN affected a ON a.id=d.source_id
  ) SELECT id FROM affected`,
      [sourceIds, owner],
    )
  ).rows.map((r) => r.id);
  if (!ids.length) return;
  const materials = (
    await db.query(
      "UPDATE memory_materials SET source_missing=true,revision=revision+1 WHERE owner_id=$1 AND NOT independent AND EXISTS(SELECT 1 FROM jsonb_array_elements(source_snapshot) s WHERE s->>'id'=ANY($2::text[])) RETURNING id",
      [owner, ids],
    )
  ).rows;
  await db.query(
    'DELETE FROM memory_source_vectors WHERE message_id=ANY($1::uuid[])',
    [ids],
  );
  if (erase) {
    for (const material of materials)
      await db.query(
        "INSERT INTO privacy_deletions(owner_id,entity_id,kind) VALUES($1,$2,'memory') ON CONFLICT DO NOTHING",
        [owner, material.id],
      );
    await db.query(
      "UPDATE voice_turns SET transcript='' WHERE run_id IN(SELECT run_id FROM messages WHERE id=ANY($1::uuid[]))",
      [ids],
    );
    await db.query(
      "UPDATE memory_materials SET content='',summary='',title='',content_hash=$3 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, materials.map((m) => m.id), hash('')],
    );
    await db.query(
      "DELETE FROM memory_corrections WHERE owner_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(changes) c WHERE c->>'id'=ANY($2::text[]))",
      [owner, materials.map((m) => m.id)],
    );
    await db.query('DELETE FROM restore_sessions WHERE owner_id=$1', [owner]);
  }

  await db.query(
    'UPDATE worlds SET memory_epoch=memory_epoch+1 WHERE id=$1 AND owner_id=$2',
    [world, owner],
  );
  await db.query(
    'UPDATE messages SET memory_excluded=true WHERE id=ANY($1::uuid[])',
    [ids],
  );
  // Unreconciled actions retain their independent receipt until reconciled;
  // erasing a conversation must not destroy the target needed for reconciliation.
  const calls = (
    await db.query(
      "UPDATE tool_calls SET arguments=CASE WHEN state IN ('executing','outcome_unknown') THEN arguments ELSE '{}'::jsonb END,result=CASE WHEN state IN ('executing','outcome_unknown') THEN result ELSE NULL END,error_code='source_invalidated',state=CASE WHEN state IN ('pending','approved') THEN 'denied' ELSE state END WHERE run_id IN (SELECT run_id FROM messages WHERE id=ANY($1::uuid[])) RETURNING *",
      [ids],
    )
  ).rows;
  for (const call of calls) await emit(db, owner, 'tool_call', call.id, call);
  const affected = (
    await db.query(
      `UPDATE memories SET status='invalidated',content='',topic='',terms='{}',revision=revision+1,valid_to=now() WHERE owner_id=$1 AND world_id=$2 AND id IN (SELECT memory_id FROM memory_evidence WHERE message_id=ANY($3::uuid[])) AND status NOT IN ('deleted','invalidated') RETURNING *`,
      [owner, world, ids],
    )
  ).rows;
  for (const m of affected) {
    await db.query(
      "INSERT INTO privacy_deletions(owner_id,entity_id,kind) VALUES($1,$2,'memory') ON CONFLICT DO NOTHING",
      [owner, m.id],
    );
    await db.query(
      'INSERT INTO memory_tombstones(owner_id,world_id,content_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [owner, world, m.content_hash],
    );
    await db.query('DELETE FROM memory_vectors WHERE memory_id=$1', [m.id]);
    await db.query('DELETE FROM memory_revisions WHERE memory_id=$1', [m.id]);
    await publishMemory(db, m);
  }
  await db.query(
    'DELETE FROM time_recaps WHERE room_id IN (SELECT room_id FROM messages WHERE id=ANY($1::uuid[]))',
    [ids],
  );
  if (erase) {
    const runs = (
      await db.query(
        'SELECT DISTINCT run_id FROM messages WHERE id=ANY($1::uuid[])',
        [ids],
      )
    ).rows.map((r) => r.run_id);
    await db.query(
      'DELETE FROM share_draft_assets WHERE draft_id IN(SELECT id FROM share_drafts WHERE owner_id=$1 AND run_id=ANY($2::uuid[]))',
      [owner, runs],
    );
    await db.query(
      "UPDATE share_drafts SET content='',asset_ids='{}' WHERE owner_id=$1 AND run_id=ANY($2::uuid[])",
      [owner, runs],
    );
    const jobs = (
      await db.query(
        "SELECT * FROM host_jobs WHERE owner_id=$1 AND relay_run_id=ANY($2::uuid[]) AND state NOT IN ('accepted','executing','unknown')",
        [owner, runs],
      )
    ).rows;
    for (const job of jobs) {
      await db.query(
        "UPDATE host_jobs SET payload='{}',payload_hash=$2,result=NULL,error_code='source_invalidated',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE id=$1",
        [
          job.id,
          hash(
            canonical({ scope: job.scope, payload: {}, budget: job.budget }),
          ),
        ],
      );
      const receipts = (
        await db.query('SELECT * FROM host_receipts WHERE job_id=$1', [job.id])
      ).rows;
      for (const receipt of receipts) {
        const body = { ...receipt.body, result: { redacted: true } };
        await db.query(
          'UPDATE host_receipts SET body=$3,payload_hash=$4 WHERE job_id=$1 AND receipt_id=$2',
          [
            job.id,
            receipt.receipt_id,
            JSON.stringify(body),
            hash(canonical(body)),
          ],
        );
      }
    }
    await db.query(
      "UPDATE host_snapshots SET materials='[]',source_hash=$3,revision=revision+1 WHERE owner_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(materials) m WHERE m->>'id'=ANY($2::text[]))",
      [owner, materials.map((m) => m.id), hash('[]')],
    );
    // Completed command replay can contain a second copy of an erased share or Host result.
    await db.query(
      "UPDATE operation_receipts SET result=jsonb_build_object('redacted',true)||jsonb_strip_nulls(jsonb_build_object('id',result->'id','message_id',result->'message_id','run_id',result->'run_id')) WHERE owner_id=$1 AND (command_type LIKE 'host.%' OR command_type LIKE 'platform.%' OR command_type LIKE 'storage.%')",
      [owner],
    );
    await db.query('DELETE FROM restore_sessions WHERE owner_id=$1', [owner]);
    await db.query(
      'DELETE FROM request_snapshots WHERE run_id IN (SELECT run_id FROM messages WHERE id=ANY($1::uuid[]))',
      [ids],
    );
    await db.query(
      'DELETE FROM run_prompt_profiles WHERE run_id IN (SELECT run_id FROM messages WHERE id=ANY($1::uuid[]))',
      [ids],
    );
    // Consumed draft text is a second persisted copy of the user input.
    await db.query(
      "UPDATE conversation_inputs SET content='' WHERE owner_id=$1 AND consumed_run_id IN (SELECT run_id FROM messages WHERE id=ANY($2::uuid[]) AND role='user')",
      [owner, ids],
    );
    const assets = (
      await db.query(
        'DELETE FROM asset_references WHERE owner_id=$1 AND message_id=ANY($2::uuid[]) RETURNING asset_id',
        [owner, ids],
      )
    ).rows;
    for (const asset of new Set(assets.map((a) => a.asset_id))) {
      const row = (
        await db.query(
          'UPDATE assets SET revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING id,world_id,actor_id,content_hash,mime,size,revision',
          [owner, asset],
        )
      ).rows[0];
      if (row) await emit(db, owner, 'asset', row.id, row);
    }
    await db.query(
      "INSERT INTO privacy_deletions(owner_id,entity_id,kind) SELECT $1,unnest($2::uuid[]),'message' ON CONFLICT DO NOTHING",
      [owner, ids],
    );
    const messages = (
      await db.query(
        "UPDATE messages SET content='',status='invalidated' WHERE id=ANY($1::uuid[]) RETURNING *",
        [ids],
      )
    ).rows;
    for (const m of messages)
      await emit(db, owner, 'message', m.id, messageView(m));
    const events = (
      await db.query(
        "UPDATE world_events SET invalidated=true,data='{}' WHERE message_id=ANY($1::uuid[]) RETURNING *",
        [ids],
      )
    ).rows;
    for (const e of events)
      await emit(db, owner, 'world_event', e.id, eventView(e));
  }
  await purgeReplay(db, owner);
}
export async function editMemory(
  db: pg.Pool,
  owner: string,
  id: string,
  revision: number,
  body: any | null,
) {
  const initial = (
    await db.query(
      'SELECT world_id FROM memories WHERE id=$1 AND owner_id=$2',
      [id, owner],
    )
  ).rows[0];
  if (!initial) throw new AppError(404, 'not_found', 'Memory not found');
  return transaction(db, async (tx) => {
    await worldLock(tx, owner, initial.world_id);
    const old = (
      await tx.query(
        'SELECT * FROM memories WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      )
    ).rows[0];
    matchRevision(old, revision);
    if (['deleted', 'invalidated'].includes(old.status))
      throw new AppError(
        409,
        'memory_invalidated',
        'Source was forgotten or invalidated',
      );
    if (!body) {
      await tx.query(
        "INSERT INTO privacy_deletions(owner_id,entity_id,kind) VALUES($1,$2,'memory') ON CONFLICT DO NOTHING",
        [owner, id],
      );
      const ids = (
        await tx.query(
          'SELECT message_id FROM memory_evidence WHERE memory_id=$1',
          [id],
        )
      ).rows.map((r) => r.message_id);
      await invalidateSources(tx, owner, old.world_id, ids);
      const row = (
        await tx.query(
          "UPDATE memories SET status='deleted',content='',topic='',terms='{}',revision=revision+1,valid_to=now() WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await publishMemory(tx, row);
      await bumpWorld(tx, owner, old.world_id);
      return null;
    }
    if (
      body.valid_to != null &&
      (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(body.valid_to) ||
        !Number.isFinite(Date.parse(body.valid_to)))
    )
      throw new AppError(
        400,
        'invalid_expiry',
        'Use an ISO 8601 timestamp with timezone',
      );
    if (
      body.audience_actor_ids.some(
        (a: string) => !old.audience_actor_ids.includes(a),
      )
    )
      throw new AppError(
        400,
        'audience_expansion',
        'A correction cannot expand source visibility',
      );
    // The previous text stays in revision history for corrections; deletion later scrubs all revisions.
    await tx.query(
      'UPDATE worlds SET memory_epoch=memory_epoch+1 WHERE id=$1',
      [old.world_id],
    );
    const row = (
      await tx.query(
        `UPDATE memories SET content=$2,content_hash=$3,topic=$4,manual=true,pinned=$5,audience_actor_ids=$6,terms=$7,status='active',valid_from=now(),valid_to=$8,revision=revision+1 WHERE id=$1 RETURNING *`,
        [
          id,
          body.content,
          hash(body.content),
          body.topic,
          body.pinned,
          body.audience_actor_ids,
          terms(body.content + ' ' + body.topic),
          body.valid_to,
        ],
      )
    ).rows[0];
    await tx.query('DELETE FROM memory_vectors WHERE memory_id=$1', [id]);
    if (body.supersedes_id) {
      const other = (
        await tx.query(
          `UPDATE memories SET status='superseded',valid_to=now(),revision=revision+1 WHERE id=$1 AND owner_id=$2 AND world_id=$3 AND id<>$4 AND status IN ('active','claimed','conflict') RETURNING *`,
          [body.supersedes_id, owner, old.world_id, id],
        )
      ).rows[0];
      if (!other)
        throw new AppError(
          400,
          'invalid_supersedes',
          'Select a current memory in this world',
        );
      await tx.query('DELETE FROM memory_vectors WHERE memory_id=$1', [
        other.id,
      ]);
      await publishMemory(tx, other);
    }
    // Prevent later re-extraction of the exact corrected text, without granting broader knowledge.
    await tx.query(
      'INSERT INTO memory_tombstones(owner_id,world_id,content_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [owner, old.world_id, old.content_hash],
    );
    await bumpWorld(tx, owner, old.world_id);
    return publishMemory(tx, row);
  });
}
export async function deleteMessage(db: pg.Pool, owner: string, id: string) {
  const source = (
    await db.query(
      'SELECT m.*,r.world_id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=$1 AND m.owner_id=$2',
      [id, owner],
    )
  ).rows[0];
  if (!source) throw new AppError(404, 'not_found', 'Message not found');
  await transaction(db, async (tx) => {
    await worldLock(tx, owner, source.world_id);
    if (
      (
        await tx.query(
          "SELECT 1 FROM runs WHERE world_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending')",
          [source.world_id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        'active_runs',
        'Cancel active runs before deleting a source',
      );
    await invalidateSources(tx, owner, source.world_id, [id], true);
    await bumpWorld(tx, owner, source.world_id);
  });
}
export interface Candidate {
  content: string;
  topic: string;
  kind: string;
  source_ids: string[];
}
export function validateCandidates(
  value: unknown,
  sources: any[],
): Candidate[] {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join(',') !== 'candidates' ||
    !Array.isArray((value as any).candidates) ||
    (value as any).candidates.length > 40
  )
    throw new AppError(
      400,
      'invalid_extraction',
      'Expected at most 40 grounded candidates',
    );
  return (value as any).candidates.map((c: any) => {
    if (
      !c ||
      Object.keys(c).sort().join(',') !== 'content,kind,source_ids,topic' ||
      typeof c.content !== 'string' ||
      !c.content.trim() ||
      c.content.length > 2000 ||
      typeof c.topic !== 'string' ||
      !c.topic.trim() ||
      c.topic.length > 100 ||
      ![
        'statement',
        'claim',
        'preference',
        'agreement',
        'relationship',
      ].includes(c.kind) ||
      !Array.isArray(c.source_ids) ||
      !c.source_ids.length ||
      c.source_ids.length > 40 ||
      new Set(c.source_ids).size !== c.source_ids.length
    )
      throw new AppError(400, 'invalid_extraction', 'Invalid candidate schema');
    const evidence = c.source_ids.map((id: string) =>
      sources.find((s) => s.id === id),
    );
    if (
      evidence.some((s: any) => !s) ||
      !evidence.some((s: any) => s.content.includes(c.content)) ||
      !c.content.includes(c.topic)
    )
      throw new AppError(
        400,
        'ungrounded_extraction',
        'Candidates and topic must be verbatim source excerpts',
      );
    return c;
  });
}
export async function commitCandidates(
  db: DB,
  owner: string,
  world: string,
  candidates: Candidate[],
  sources: any[],
) {
  for (const c of candidates) {
    const evidence = c.source_ids.map((id) => sources.find((s) => s.id === id));
    const audience: string[] = evidence[0].audience
      .filter((a: string) => evidence.every((s) => s.audience.includes(a)))
      .sort();
    const contentHash = hash(c.content);
    if (
      (
        await db.query(
          'SELECT 1 FROM memory_tombstones WHERE owner_id=$1 AND world_id=$2 AND content_hash=$3',
          [owner, world, contentHash],
        )
      ).rowCount
    )
      continue;
    const existing = (
      await db.query(
        "SELECT * FROM memories WHERE owner_id=$1 AND world_id=$2 AND audience_actor_ids=$3 AND status IN ('active','claimed','conflict') AND (content_hash=$4 OR topic=$5) ORDER BY manual DESC,created_at",
        [owner, world, audience, contentHash, c.topic],
      )
    ).rows;
    const same = existing.find((m) => m.content_hash === contentHash);
    if (same) {
      // Evidence is merged only within exactly the same audience and trust class.
      if (
        !same.manual &&
        (same.kind === 'claim') === evidence.some((s) => s.role === 'assistant')
      ) {
        for (const s of evidence)
          await db.query(
            'INSERT INTO memory_evidence(memory_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [same.id, s.id],
          );
        const updated = (
          await db.query(
            'UPDATE memories SET revision=revision+1 WHERE id=$1 RETURNING *',
            [same.id],
          )
        ).rows[0];
        await publishMemory(db, updated);
      }
      continue;
    }
    const claimed =
      c.kind === 'claim' || evidence.some((s) => s.role === 'assistant');
    const row = (
      await db.query(
        `INSERT INTO memories(id,owner_id,world_id,content,content_hash,topic,kind,status,audience_actor_ids,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          randomUUID(),
          owner,
          world,
          c.content,
          contentHash,
          c.topic,
          claimed ? 'claim' : c.kind,
          existing.length ? 'conflict' : claimed ? 'claimed' : 'active',
          audience,
          terms(c.content + ' ' + c.topic),
        ],
      )
    ).rows[0];
    for (const s of evidence)
      await db.query(
        'INSERT INTO memory_evidence(memory_id,message_id) VALUES($1,$2)',
        [row.id, s.id],
      );
    await publishMemory(db, row);
  }
}
