import type { DB } from '../../db/index.js';
export function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('und');
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) result.add(word);
      for (let i = 0; i < chars.length - 1; i++)
        result.add(chars.slice(i, i + 2).join(''));
    } else result.add(word);
  }
  return [...result].slice(0, 2048);
}
export function rankMemories(rows: any[], query: string, limit = 5) {
  const q = new Set(terms(query));
  return rows
    .map((row) => {
      const overlap = (row.terms as string[]).filter((t) => q.has(t)).length;
      const lexical =
        overlap / Math.max(1, Math.sqrt(q.size * row.terms.length));
      const semantic =
        row.similarity == null ? 0 : Math.max(0, Number(row.similarity));
      return {
        ...row,
        score:
          lexical +
          semantic * 0.4 +
          (row.manual ? 0.1 : 0) +
          (row.pinned ? 1 : 0),
        relevant: overlap > 0 || semantic >= 0.65 || row.pinned,
      };
    })
    .filter((r) => r.relevant)
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}
export interface QueryVector {
  version: number;
  dimensions: number;
  vector: number[];
}
export async function retrieve(
  db: DB,
  owner: string,
  world: string,
  actor: string,
  query: string,
  vector?: QueryVector,
) {
  // Materialize the permission boundary before computing any similarity. Empty audiences are owner-only.
  const rows = (
    await db.query(
      `WITH allowed AS MATERIALIZED (
    SELECT m.* FROM memories m JOIN worlds w ON w.id=m.world_id WHERE m.owner_id=$1 AND m.world_id=$2 AND NOT w.deleted
    AND m.status IN ('active','claimed') AND (m.valid_to IS NULL OR m.valid_to>now()) AND $3=ANY(m.audience_actor_ids)
    AND NOT EXISTS(SELECT 1 FROM memory_evidence e JOIN messages s ON s.id=e.message_id WHERE e.memory_id=m.id AND (s.memory_excluded OR s.status<>'completed'))
  ) SELECT a.*,NULL::float AS similarity FROM allowed a WHERE pinned OR terms && $4::text[] ORDER BY manual DESC,valid_from DESC LIMIT 200`,
      [owner, world, actor, terms(query)],
    )
  ).rows;
  if (vector) {
    const candidates = (
      await db.query(
        `WITH allowed AS MATERIALIZED (
      SELECT m.*,v.embedding FROM memories m JOIN worlds w ON w.id=m.world_id JOIN memory_vectors v ON v.memory_id=m.id AND v.revision=m.revision
      JOIN memory_settings s ON s.world_id=m.world_id AND s.index_version=v.index_version
      WHERE m.owner_id=$1 AND m.world_id=$2 AND NOT w.deleted AND $3=ANY(m.audience_actor_ids) AND m.status IN ('active','claimed')
      AND (m.valid_to IS NULL OR m.valid_to>now()) AND s.index_version=$4 AND s.embedding_dimensions=$5 AND vector_dims(v.embedding)=$5
      AND NOT EXISTS(SELECT 1 FROM memory_evidence e JOIN messages src ON src.id=e.message_id WHERE e.memory_id=m.id AND (src.memory_excluded OR src.status<>'completed'))
    ) SELECT *,1-(embedding <=> $6::vector) AS similarity FROM allowed ORDER BY embedding <=> $6::vector LIMIT 30`,
        [
          owner,
          world,
          actor,
          vector.version,
          vector.dimensions,
          JSON.stringify(vector.vector),
        ],
      )
    ).rows;
    for (const row of candidates) {
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    }
  }
  return rankMemories(rows, query);
}
