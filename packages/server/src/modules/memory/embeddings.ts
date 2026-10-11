import { validReservation } from '../autonomy/policy.js';
import type pg from 'pg';
import { Agent, fetch } from 'undici';
import { transaction } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, decrypt, resolveEndpoint } from '../../security.js';
import { worldLock } from '../worlds/index.js';
import { reserveBackground, settleBackground } from './usage.js';
import type { QueryVector } from './retrieval.js';
export async function embedding(
  config: Config,
  provider: any,
  owner: string,
  content: string,
  dimensions: number,
  signal: AbortSignal,
) {
  const { base, addresses } = await resolveEndpoint(provider.base_url, config);
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, options, callback) => {
        const selected =
          addresses.find(
            (a) => !options.family || a.family === options.family,
          ) ?? addresses[0]!;
        callback(
          null,
          options.all ? addresses : selected.address,
          selected.family,
        );
      },
    },
  });
  try {
    const response = await fetch(`${base}/embeddings`, {
      dispatcher,
      redirect: 'error',
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${decrypt(provider.credential, config, `${owner}:${provider.id}`)}`,
      },
      body: JSON.stringify({
        model: provider.model,
        input: content,
        encoding_format: 'float',
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError(
        503,
        'embedding_unavailable',
        'Embedding service unavailable',
      );
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 262144) throw new Error('embedding_limit');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const vector = result.data?.[0]?.embedding;
    if (
      result.data?.length !== 1 ||
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some(
        (v: any) =>
          typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e10,
      ) ||
      vector.every((v: number) => v === 0)
    )
      throw new AppError(
        400,
        'embedding_dimensions',
        'Embedding response dimensions or values do not match configuration',
      );
    const tokens = result.usage?.total_tokens;
    return {
      vector: vector as number[],
      usage:
        Number.isSafeInteger(tokens) && tokens >= 0
          ? { input: tokens, output: 0 }
          : null,
    };
  } finally {
    await dispatcher.close();
  }
}
export async function embedContent(
  db: pg.Pool,
  config: Config,
  worldId: string,
  content: string,
  kind: string,
  stopping?: AbortSignal,
) {
  const c = await transaction(db, async (tx) => {
    const base = (
      await tx.query(
        'SELECT owner_id FROM worlds WHERE id=$1 AND NOT deleted',
        [worldId],
      )
    ).rows[0];
    if (!base) return null;
    const world = await worldLock(tx, base.owner_id, worldId);
    const settings = (
      await tx.query(
        'SELECT * FROM memory_settings WHERE world_id=$1 AND embedding_provider_id IS NOT NULL AND index_next_at<=now()',
        [worldId],
      )
    ).rows[0];
    if (!settings) return null;
    const provider = (
      await tx.query(
        'SELECT * FROM provider_connections WHERE id=$1 AND owner_id=$2',
        [settings.embedding_provider_id, base.owner_id],
      )
    ).rows[0];
    const usageId = await reserveBackground(
      tx,
      config,
      base.owner_id,
      worldId,
      kind,
      Buffer.byteLength(content) + 16,
      0,
    );
    // One in-flight embedding per world; a crashed worker only delays rebuild, never blocks text recall.
    await tx.query(
      "UPDATE memory_settings SET index_next_at=now()+interval '2 minutes' WHERE world_id=$1",
      [worldId],
    );
    return { world, settings, provider, usageId };
  }).catch((e) => {
    if (e instanceof AppError && e.status === 429) return null;
    throw e;
  });
  if (!c) return null;
  try {
    const signal = stopping
      ? AbortSignal.any([stopping, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const result = await embedding(
      config,
      c.provider,
      c.world.owner_id,
      content,
      c.settings.embedding_dimensions,
      signal,
    );
    await settleBackground(db, c.usageId, result.usage);
    await db.query(
      'UPDATE memory_settings SET index_error=NULL,index_next_at=now() WHERE world_id=$1 AND index_version=$2',
      [worldId, c.settings.index_version],
    );
    if (!(await transaction(db, (tx) => validReservation(tx, c.usageId))))
      return null;
    return { ...c, vector: result.vector };
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'embedding_unavailable';
    await settleBackground(db, c.usageId, null, code);
    await db.query(
      "UPDATE memory_settings SET index_error=$2,index_next_at=now()+interval '5 minutes' WHERE world_id=$1 AND index_version=$3",
      [worldId, code, c.settings.index_version],
    );
    return null;
  }
}
export async function rebuildEmbedding(
  db: pg.Pool,
  config: Config,
  worldId: string,
  stopping?: AbortSignal,
) {
  const m = (
    await db.query(
      `SELECT m.* FROM memories m JOIN memory_settings s ON s.world_id=m.world_id LEFT JOIN memory_vectors v ON v.memory_id=m.id AND v.revision=m.revision AND v.index_version=s.index_version WHERE m.world_id=$1 AND m.status IN ('active','claimed') AND (m.valid_to IS NULL OR m.valid_to>now()) AND v.memory_id IS NULL ORDER BY m.created_at LIMIT 1`,
      [worldId],
    )
  ).rows[0];
  if (!m) return;
  const c = await embedContent(
    db,
    config,
    worldId,
    m.content,
    'memory_embedding',
    stopping,
  );
  if (!c) return;
  await transaction(db, async (tx) => {
    const world = await worldLock(tx, m.owner_id, worldId);
    if (
      world.memory_epoch !== c.world.memory_epoch ||
      !(await validReservation(tx, c.usageId))
    )
      return;
    await tx.query(
      `INSERT INTO memory_vectors(memory_id,revision,index_version,embedding) SELECT m.id,m.revision,s.index_version,$4::vector FROM memories m JOIN memory_settings s ON s.world_id=m.world_id WHERE m.id=$1 AND m.revision=$2 AND s.index_version=$3 AND m.status IN ('active','claimed') ON CONFLICT(memory_id) DO UPDATE SET revision=EXCLUDED.revision,index_version=EXCLUDED.index_version,embedding=EXCLUDED.embedding`,
      [m.id, m.revision, c.settings.index_version, JSON.stringify(c.vector)],
    );
  });
}
export async function queryEmbedding(
  db: pg.Pool,
  config: Config,
  runId: string,
  stopping?: AbortSignal,
): Promise<QueryVector | undefined> {
  const run = (
    await db.query(
      "SELECT r.world_id,m.content FROM runs r JOIN messages m ON m.id=r.user_message_id WHERE r.id=$1 AND r.state='queued' AND m.memory_excluded=false",
      [runId],
    )
  ).rows[0];
  if (!run) return;
  const c = await embedContent(
    db,
    config,
    run.world_id,
    run.content,
    'recall_query',
    stopping,
  );
  if (!c) return;
  return {
    version: c.settings.index_version,
    dimensions: c.settings.embedding_dimensions,
    vector: c.vector,
  };
}
