import type { DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';
const invalid = (kind: string) => {
  throw new AppError(
    400,
    'backup_integrity',
    'Invalid backup relationship: ' + kind,
  );
};
/** Validate the portable graph before staging, not just during SQL insertion. */
export async function validateGraph(db: DB, pack: any) {
  const tables = pack.tables as Record<string, any[]>;
  const constraints = (
    await db.query(`
    SELECT child.relname child,parent.relname parent,
      array_agg(ca.attname::text ORDER BY ck.ord) child_keys,
      array_agg(pa.attname::text ORDER BY ck.ord) parent_keys
    FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
    JOIN pg_class parent ON parent.oid=c.confrelid
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY ck(attnum,ord)
    JOIN LATERAL unnest(c.confkey) WITH ORDINALITY pk(attnum,ord) ON pk.ord=ck.ord
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=ck.attnum
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=pk.attnum
    WHERE c.contype='f' AND c.connamespace=current_schema()::regnamespace
    GROUP BY c.oid,child.relname,parent.relname`)
  ).rows;
  for (const c of constraints) {
    if (!tables[c.child] || !tables[c.parent]) continue;
    const keys = new Set(
      tables[c.parent]!.map((r) =>
        canonical(c.parent_keys.map((k: string) => r[k])),
      ),
    );
    for (const r of tables[c.child]!) {
      const tuple = c.child_keys.map((k: string) => r[k]);
      if (tuple.some((v: any) => v === null)) continue;
      if (!keys.has(canonical(tuple))) invalid(c.child + ' → ' + c.parent);
    }
  }
  const byId = (t: string) =>
    new Map<string, any>(tables[t]!.map((r) => [r.id, r]));
  const actors = byId('world_characters'),
    rooms = byId('rooms'),
    assets = byId('assets'),
    links = byId('host_identity_links');
  const member = (actor: string, room: string) =>
    tables.room_memberships!.some(
      (m) => m.actor_id === actor && m.room_id === room,
    );
  for (const d of tables.share_drafts!) {
    const room = rooms.get(d.room_id),
      actor = actors.get(d.actor_id);
    if (
      !room ||
      !actor ||
      room.world_id !== actor.world_id ||
      !member(actor.id, room.id)
    )
      invalid('share scope');
    const refs = tables
      .share_draft_assets!.filter((r) => r.draft_id === d.id)
      .map((r) => r.asset_id)
      .sort();
    if (
      !Array.isArray(d.asset_ids) ||
      canonical([...d.asset_ids].sort()) !== canonical(refs)
    )
      invalid('share assets');
    for (const id of d.asset_ids) {
      const a = assets.get(id);
      if (
        !a ||
        a.world_id !== room.world_id ||
        (a.actor_id && a.actor_id !== actor.id)
      )
        invalid('share asset audience');
    }
  }
  for (const s of [
    ...tables.schedules!,
    ...tables.event_triggers!,
    ...tables.voice_sessions!,
    ...tables.voice_invites!,
  ]) {
    const a = actors.get(s.actor_id),
      r = s.room_id ? rooms.get(s.room_id) : null;
    if (
      !a ||
      (s.room_id && (!r || r.world_id !== a.world_id || !member(a.id, r.id)))
    )
      invalid('actor target');
  }
  for (const a of tables.system_actions!)
    if (hash(canonical(a.payload)) !== a.payload_hash)
      invalid('system action hash');
  for (const j of tables.host_jobs!) {
    const l = links.get(j.link_id);
    if (!l || l.host_id !== j.host_id) invalid('Host job link');
    if (
      hash(
        canonical({ scope: j.scope, payload: j.payload, budget: j.budget }),
      ) !== j.payload_hash
    )
      invalid('Host job hash');
  }
  for (const r of tables.host_receipts!)
    if (hash(canonical(r.body)) !== r.payload_hash)
      invalid('Host receipt hash');
  for (const s of tables.host_snapshots!) {
    const l = links.get(s.link_id);
    if (
      !l ||
      !Array.isArray(s.materials) ||
      hash(canonical(s.materials)) !== s.source_hash
    )
      invalid('Host snapshot hash');
    // Older snapshots can be stale, but must never contain another actor's materials.
    for (const m of s.materials) {
      const source = tables.memory_materials!.find((r) => r.id === m.id);
      if (
        !source ||
        source.actor_id !== l.actor_id ||
        !['fact', 'profile'].includes(m.kind)
      )
        invalid('Host snapshot scope');
    }
  }
  const docs = byId('documents'),
    projects = byId('projects');
  for (const b of tables.external_documents!) {
    const l = links.get(b.link_id),
      p = projects.get(docs.get(b.document_id)?.project_id);
    if (!l || !p || l.actor_id !== b.actor_id || p.actor_id !== b.actor_id)
      invalid('external document scope');
  }
}
