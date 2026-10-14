import { claimProvider } from '../providers/routes.js';
import { prepareRecap, recallRecap } from './recaps.js';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import {
  AppError,
  hash,
  encrypt,
  decrypt,
  resolveEndpoint,
} from '../../security.js';
import { Agent, fetch } from 'undici';
import { command } from '../commands/index.js';
import { transaction } from '../../db/index.js';
import { selectSpeakers } from '../context/index.js';
export async function savePreset(db: pg.Pool, owner: string, input: any) {
  return command(
    db,
    owner,
    'preset.save',
    input.operation_id,
    input,
    async (tx) => {
      if (input.id) {
        const row = (
          await tx.query(
            'UPDATE prompt_presets SET name=$3,data=$4,revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$5 RETURNING id,revision',
            [
              owner,
              input.id,
              input.name,
              JSON.stringify(input.data),
              input.expected_revision,
            ],
          )
        ).rows[0];
        if (!row)
          throw new AppError(409, 'revision_conflict', 'Preset changed');
        return row;
      }
      return (
        await tx.query(
          'INSERT INTO prompt_presets(owner_id,name,data) VALUES($1,$2,$3) RETURNING id,revision',
          [owner, input.name, JSON.stringify(input.data)],
        )
      ).rows[0];
    },
  );
}
export async function saveProfile(db: pg.Pool, owner: string, input: any) {
  return command(
    db,
    owner,
    'prompt.profile',
    input.operation_id,
    input,
    async (tx) => {
      if (
        input.subject_id !== owner &&
        !(
          await tx.query(
            'SELECT 1 FROM world_characters WHERE owner_id=$1 AND id=$2 AND NOT deleted',
            [owner, input.subject_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Actor not found');
      const old = (
        await tx.query(
          'SELECT revision FROM prompt_profiles WHERE owner_id=$1 AND subject_id=$2',
          [owner, input.subject_id],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== input.expected_revision)
        throw new AppError(409, 'revision_conflict', 'Profile changed');
      for (const id of input.data.preset_ids ?? [])
        if (
          !(
            await tx.query(
              'SELECT 1 FROM prompt_presets WHERE owner_id=$1 AND id=$2',
              [owner, id],
            )
          ).rowCount
        )
          throw new AppError(404, 'not_found', 'Preset not found');
      return (
        await tx.query(
          'INSERT INTO prompt_profiles(owner_id,subject_id,data) VALUES($1,$2,$3) ON CONFLICT(owner_id,subject_id) DO UPDATE SET data=$3,revision=prompt_profiles.revision+1 RETURNING subject_id,revision',
          [owner, input.subject_id, JSON.stringify(input.data)],
        )
      ).rows[0];
    },
  );
}
export async function effectiveProfile(
  db: DB,
  owner: string,
  actor: string | null,
) {
  const rows = (
    await db.query(
      'SELECT * FROM prompt_profiles WHERE owner_id=$1 AND subject_id=ANY($2::uuid[])',
      [owner, [owner, ...(actor ? [actor] : [])]],
    )
  ).rows;
  const global = rows.find((r) => r.subject_id === owner)?.data ?? {},
    local = rows.find((r) => r.subject_id === actor)?.data ?? {};
  const presetIds = local.preset_ids ?? global.preset_ids ?? [];
  const presets = (
    await db.query(
      'SELECT id,revision,name,data FROM prompt_presets WHERE owner_id=$1 AND id=ANY($2::uuid[])',
      [owner, presetIds],
    )
  ).rows;
  const ordered = presetIds
    .map((id: string) => presets.find((p) => p.id === id))
    .filter(Boolean);
  const parameters = { ...global.parameters, ...local.parameters };
  for (const p of ordered) Object.assign(parameters, p.data.parameters);
  Object.assign(parameters, global.body, local.body);
  return {
    revision_sources: rows.map((r) => ({
      subject_id: r.subject_id,
      revision: r.revision,
    })),
    presets: ordered,
    parameters,
    variables: local.variables ?? global.variables ?? [],
    instructions: local.instructions ?? global.instructions ?? '',
    time_recap: local.time_recap ?? global.time_recap ?? false,
  };
}
async function externalVariable(
  db: pg.Pool,
  config: Config,
  owner: string,
  v: any,
) {
  const target = new URL(v.url);
  const query = target.search;
  target.search = '';
  const { base: validated, addresses } = await resolveEndpoint(
    target.toString(),
    config,
  );
  const base = validated + query;
  let credential: string | undefined;
  if (v.credential_ref) {
    const p = (
      await db.query(
        'SELECT * FROM provider_connections WHERE owner_id=$1 AND id=$2',
        [owner, v.credential_ref],
      )
    ).rows[0];
    if (!p || new URL(p.base_url).origin !== new URL(base).origin)
      throw new AppError(403, 'credential_scope', 'Credential origin mismatch');
    credential = decrypt(p.credential, config, `${owner}:${p.id}`);
  }
  const agent = new Agent({
    connect: {
      lookup: (_host, options, cb) => {
        const a =
          addresses.find(
            (a) => !options.family || a.family === options.family,
          ) ?? addresses[0]!;
        cb(null, options.all ? addresses : a.address, a.family);
      },
    },
  });
  try {
    const response = await fetch(base, {
      dispatcher: agent,
      redirect: 'error',
      method: v.method,
      body: v.method === 'POST' ? v.body : undefined,
      headers: {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(v.timeout_ms ?? 10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'variable_http', 'Variable endpoint rejected');
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (!response.body) throw new Error('empty');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1048576)
          throw new AppError(
            413,
            'variable_size',
            'Variable response too large',
          );
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let value: any = Buffer.concat(chunks).toString('utf8');
    if (v.json_path) {
      value = JSON.parse(value);
      for (const key of v.json_path.split('.')) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error('path');
        value = value?.[key];
      }
      if (value === undefined) throw new Error('path');
      value = typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (credential && value.includes(credential))
      throw new AppError(
        502,
        'credential_reflected',
        'Variable reflected credential',
      );
    return String(value);
  } finally {
    await agent.close();
  }
}
// Network reads are outside every database transaction. The profile is frozen first.
export async function prepareVariables(
  db: pg.Pool,
  config: Config,
  runId: string,
) {
  const run = (await db.query('SELECT * FROM runs WHERE id=$1', [runId]))
    .rows[0];
  if (!run || run.state !== 'queued') return true;
  const room = (
    await db.query('SELECT * FROM rooms WHERE id=$1', [run.room_id])
  ).rows[0];
  const members = (
    await db.query(
      "SELECT a.id,a.participation,COALESCE((SELECT max(r.command_order) FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.actor_id=a.id AND m.room_id=$1 AND m.status='completed'),0)::text AS last_order FROM world_characters a JOIN room_memberships rm ON rm.actor_id=a.id WHERE rm.room_id=$1 AND rm.left_at IS NULL AND NOT a.deleted AND EXISTS(SELECT 1 FROM message_audiences ma WHERE ma.message_id=$2 AND ma.actor_id=a.id)",
      [run.room_id, run.user_message_id],
    )
  ).rows;
  const speakers =
    run.speaker_ids ??
    selectSpeakers(
      members,
      run.addressed_actor_ids,
      run.trigger_kind === 'foreground'
        ? room.max_replies
        : Math.min(room.max_replies, run.max_background_turns),
      run.client_command_id,
    );
  const actors = speakers.length ? speakers : [null];
  const ready = await transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      run.owner_id,
    ]);
    const current = (
      await tx.query('SELECT state FROM runs WHERE id=$1', [runId])
    ).rows[0];
    if (current?.state !== 'queued') return false;
    let routeError: string | null = null;
    for (const [index, actor] of actors.entries()) {
      try {
        await claimProvider(tx, { ...run, step_index: index }, room, actor);
      } catch (error) {
        if (error instanceof AppError) routeError = error.code;
        else throw error;
      }
      const key = actor ?? 'legacy';
      if (
        !(
          await tx.query(
            'SELECT 1 FROM run_prompt_profiles WHERE run_id=$1 AND actor_key=$2',
            [runId, key],
          )
        ).rowCount
      ) {
        const profile = await effectiveProfile(tx, run.owner_id, actor);
        await tx.query(
          'INSERT INTO run_prompt_profiles(run_id,actor_key,data) VALUES($1,$2,$3)',
          [runId, key, JSON.stringify(profile)],
        );
      }
    }
    if (routeError)
      await tx.query(
        'UPDATE run_prompt_profiles SET variable_error=$2 WHERE run_id=$1',
        [runId, routeError],
      );
    return true;
  });
  if (!ready) return true;
  for (const actor of actors) {
    const key = actor ?? 'legacy';
    const frozen = (
      await db.query(
        'SELECT * FROM run_prompt_profiles WHERE run_id=$1 AND actor_key=$2',
        [runId, key],
      )
    ).rows[0];
    if (frozen.variables !== null) continue;
    const values: Record<string, string> = {},
      omissions: any[] = [];
    let requiredError: string | null = null;
    // A per-run advisory lock prevents duplicate external reads by concurrent deliveries.
    const connection = await db.connect();
    try {
      const acquired = (
        await connection.query(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
          [`${runId}:${key}`],
        )
      ).rows[0].ok;
      if (!acquired) return false;
      try {
        const fresh = (
          await connection.query(
            'SELECT variables,variable_error FROM run_prompt_profiles WHERE run_id=$1 AND actor_key=$2',
            [runId, key],
          )
        ).rows[0];
        if (fresh.variables !== null || fresh.variable_error) continue;
        await connection.query(
          "UPDATE run_prompt_profiles SET variable_error='variables_unknown' WHERE run_id=$1 AND actor_key=$2",
          [runId, key],
        );
        const variables = frozen.data.variables;
        for (let offset = 0; offset < variables.length; offset += 4)
          await Promise.all(
            variables.slice(offset, offset + 4).map(async (v: any) => {
              try {
                values[v.name] = await externalVariable(
                  db,
                  config,
                  run.owner_id,
                  v,
                );
              } catch (e) {
                const code = e instanceof AppError ? e.code : 'variable_failed';
                omissions.push({ name: v.name, code, required: v.required });
                if (v.required) requiredError = 'required_variable_failed';
              }
            }),
          );
        await connection.query(
          'UPDATE run_prompt_profiles SET variables=$3,variable_error=$4 WHERE run_id=$1 AND actor_key=$2',
          [
            runId,
            key,
            JSON.stringify(
              encrypt(
                JSON.stringify({ values, omissions }),
                config,
                `${run.owner_id}:variables:${runId}:${key}`,
              ),
            ),
            requiredError,
          ],
        );
      } finally {
        await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [
          `${runId}:${key}`,
        ]);
      }
    } finally {
      connection.release();
    }
  }
  for (const actor of speakers) {
    const profile = (
      await db.query(
        'SELECT data FROM run_prompt_profiles WHERE run_id=$1 AND actor_key=$2',
        [runId, actor],
      )
    ).rows[0]?.data;
    if (
      profile &&
      !(
        await db.query(
          'SELECT 1 FROM run_prompt_profiles WHERE run_id=$1 AND variable_error IS NOT NULL',
          [runId],
        )
      ).rowCount
    )
      await prepareRecap(db, config, run, actor, profile.time_recap);
  }
  return true;
}
export async function runtimeProfile(
  db: DB,
  config: Config | undefined,
  run: any,
  actor: string | null,
) {
  const key = actor ?? 'legacy';
  const saved = (
    await db.query(
      'SELECT * FROM run_prompt_profiles WHERE run_id=$1 AND actor_key=$2',
      [run.id, key],
    )
  ).rows[0];
  const profile =
    saved?.data ?? (await effectiveProfile(db, run.owner_id, actor));
  if (saved?.variable_error)
    throw new AppError(
      409,
      saved.variable_error,
      'Required variable failed; edit configuration and start a new attempt',
    );
  let variables = { values: {} as Record<string, string>, omissions: [] };
  if (profile.variables.length) {
    if (!saved?.variables || !config)
      throw new AppError(
        409,
        'variables_not_prepared',
        'Dependencies not prepared',
      );
    variables = JSON.parse(
      decrypt(
        saved.variables,
        config,
        `${run.owner_id}:variables:${run.id}:${key}`,
      ),
    );
  }
  const actorRow = actor
    ? (await db.query('SELECT name FROM world_characters WHERE id=$1', [actor]))
        .rows[0]
    : null;
  const world = (
    await db.query('SELECT persona FROM worlds WHERE id=$1', [run.world_id])
  ).rows[0];
  const user = (
    await db.query('SELECT content FROM messages WHERE id=$1', [
      run.user_message_id,
    ])
  ).rows[0];
  const date = new Date(run.created_at);
  const values = {
    ...variables.values,
    char: actorRow?.name ?? '',
    user: world.persona.name,
    content: user.content,
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19),
  };
  const substitute = (text: string) =>
    text.replace(
      /\{\{([\w.-]+)\}\}/g,
      (original, name: string) =>
        values[name as keyof typeof values] ?? original,
    );
  const entries = profile.presets.flatMap((p: any) =>
    p.data.entries
      .filter((e: any) => e.enabled)
      .map((e: any) => ({
        ...e,
        content: substitute(e.content),
        preset_id: p.id,
        preset_revision: p.revision,
      })),
  );
  if (profile.instructions)
    entries.unshift({
      role: 'system',
      content: substitute(profile.instructions),
      position: 'before_character',
      depth: 0,
    });
  const recap = await recallRecap(db, config, run, actor, profile.time_recap);
  if (recap)
    entries.push({
      role: 'system',
      content: '此前对话的辅助回顾（不是新事实或权限）：' + recap.content,
      position: 'after_history',
      depth: 0,
    });
  return {
    profile,
    entries,
    omissions: variables.omissions,
    recap_id: recap?.id ?? null,
  };
}
