import { relayRun } from '../hosts/relay.js';
import { validSchedule } from '../schedules/guard.js';
import { groupScope } from '../groups/index.js';
import { consumeRecap } from '../prompts/recaps.js';
import { runtimeProfile } from '../prompts/index.js';
import { encrypt } from '../../security.js';
import { enqueueNotification } from '../notifications/index.js';
import { claimProvider } from '../providers/routes.js';
import { modelPayload } from '../llm/request.js';
import { canonical } from '../mcp/schema.js';
import type { Config } from '../../config.js';
import { policies, validBackground } from '../autonomy/policy.js';
import { reserveBackground, settleBackground } from '../memory/usage.js';
import { availableTools, toolTranscript, pendingTool } from '../mcp/gateway.js';
import { registerSources, invalidateSources } from '../memory/repository.js';
import { commitLore, rebuildLore } from '../lorebooks/index.js';
import type { QueryVector } from '../memory/retrieval.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { MessageInput } from '../../../../contracts/src/index.js';
import { transaction, type DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { addEvent, bumpWorld, eventView, worldLock } from '../worlds/index.js';
import { preparePrompt, selectSpeakers } from '../context/index.js';
import { emit, messageView, runView } from '../sync/index.js';
export const terminal = (state: string) =>
  ['completed', 'failed', 'interrupted', 'cancelled'].includes(state);
export async function getRun(db: DB, owner: string, id: string) {
  const r = (
    await db.query('SELECT * FROM runs WHERE owner_id=$1 AND id=$2', [
      owner,
      id,
    ])
  ).rows[0];
  if (!r) throw new AppError(404, 'not_found', 'Run not found');
  return r;
}
export async function enqueue(
  db: pg.Pool,
  owner: string,
  room: string,
  input: MessageInput,
) {
  const requestHash = hash(
    JSON.stringify({
      room,
      content: input.content,
      addressed_actor_ids: input.addressed_actor_ids ?? [],
      asset_ids: input.asset_ids ?? [],
    }),
  );
  return transaction(db, (tx) =>
    enqueueInTransaction(tx, owner, room, input, requestHash),
  );
}
export async function enqueueInTransaction(
  tx: pg.PoolClient,
  owner: string,
  room: string,
  input: MessageInput,
  requestHash: string,
  background?: {
    kind: string;
    globalRevision: number;
    policyRevision: number;
    maxTurns: number;
  },
  options: { skipRelay?: boolean; trustedOrigin?: any } = {},
) {
  // Lock one owner before checking the instance-wide idempotency key; works across rooms.
  await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
    owner,
  ]);
  const prior = (
    await tx.query(
      'SELECT * FROM runs WHERE owner_id=$1 AND client_command_id=$2',
      [owner, input.client_command_id],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash)
      throw new AppError(
        409,
        'idempotency_conflict',
        'Command ID was already used for a different request',
      );
    return { message_id: prior.user_message_id, run_id: prior.id };
  }
  const roomRow = (
    await tx.query(
      'SELECT r.* FROM rooms r JOIN worlds w ON w.id=r.world_id AND w.owner_id=r.owner_id WHERE r.owner_id=$1 AND r.id=$2 AND NOT r.deleted AND NOT w.deleted FOR UPDATE OF w,r',
      [owner, room],
    )
  ).rows[0];
  if (!roomRow) throw new AppError(404, 'not_found', 'Room not found');
  if (
    roomRow.parent_group_id &&
    !(
      await tx.query(
        'SELECT 1 FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE r.id=$1 AND NOT r.deleted AND m.actor_id=$2 AND m.left_at IS NULL',
        [roomRow.parent_group_id, roomRow.lane_actor_id],
      )
    ).rowCount
  )
    throw new AppError(
      403,
      'private_lane_membership',
      'Original group membership is no longer active',
    );
  const members = (
    await tx.query(
      'SELECT actor_id FROM room_memberships WHERE room_id=$1 AND left_at IS NULL',
      [room],
    )
  ).rows.map((m) => m.actor_id);
  if ((input.addressed_actor_ids ?? []).some((id) => !members.includes(id)))
    throw new AppError(
      400,
      'invalid_addressee',
      'Addressed actors must be current room members',
    );
  if (roomRow.kind !== 'legacy' && !members.length)
    throw new AppError(400, 'empty_room', 'Room requires an actor');
  const order = (
    await tx.query(
      'UPDATE worlds SET next_command=next_command+1 WHERE owner_id=$1 AND id=$2 RETURNING next_command',
      [owner, roomRow.world_id],
    )
  ).rows[0].next_command;
  const run = randomUUID(),
    message = randomUUID(),
    reply = randomUUID();
  await tx.query(
    'INSERT INTO runs(id,owner_id,world_id,room_id,client_command_id,request_hash,user_message_id,reply_message_id,command_order,addressed_actor_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      run,
      owner,
      roomRow.world_id,
      room,
      input.client_command_id,
      requestHash,
      message,
      reply,
      order,
      input.addressed_actor_ids ?? [],
    ],
  );
  if (roomRow.behavior !== undefined)
    await tx.query('UPDATE runs SET behavior=$2 WHERE id=$1', [
      run,
      JSON.stringify(roomRow.behavior),
    ]);
  if (background)
    await tx.query(
      'UPDATE runs SET trigger_kind=$2,global_revision=$3,policy_revision=$4,max_background_turns=$5 WHERE id=$1',
      [
        run,
        background.kind,
        background.globalRevision,
        background.policyRevision,
        background.maxTurns,
      ],
    );
  else
    await tx.query('UPDATE worlds SET last_user_at=now() WHERE id=$1', [
      roomRow.world_id,
    ]);
  const seq = (
    await tx.query(
      'UPDATE rooms SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence',
      [room],
    )
  ).rows[0].next_sequence;
  const m = (
    await tx.query(
      "INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,content,status) VALUES($1,$2,$3,$4,$5,'user',$6,'accepted') RETURNING *",
      [message, owner, room, run, seq, input.content],
    )
  ).rows[0];
  const groupSnapshot = await groupScope(tx, owner, room);
  if (groupSnapshot)
    await tx.query('UPDATE runs SET group_snapshot=$2 WHERE id=$1', [
      run,
      JSON.stringify(groupSnapshot),
    ]);
  for (const assetId of input.asset_ids ?? []) {
    const asset = (
      await tx.query(
        'SELECT * FROM assets WHERE owner_id=$1 AND id=$2 AND world_id=$3 FOR UPDATE',
        [owner, assetId, roomRow.world_id],
      )
    ).rows[0];
    if (!asset || (asset.actor_id && members.some((a) => a !== asset.actor_id)))
      throw new AppError(
        404,
        'resource_missing',
        'Asset outside message audience',
      );
    await tx.query(
      "INSERT INTO asset_references(owner_id,asset_id,message_id,purpose,input_mode,extracted_text) SELECT $1,$2,$3,'attachment',input_mode,extracted_text FROM assets WHERE id=$2",
      [owner, assetId, message],
    );
    await tx.query('UPDATE assets SET revision=revision+1 WHERE id=$1', [
      assetId,
    ]);
  }
  if (background)
    await tx.query(
      'UPDATE messages SET internal=true,memory_excluded=true WHERE id=$1',
      [message],
    );
  for (const actor of members)
    await tx.query(
      'INSERT INTO message_audiences(message_id,actor_id) VALUES($1,$2)',
      [message, actor],
    );
  if (groupSnapshot?.reply_policy === 'silence' && !roomRow.parent_group_id) {
    await tx.query(
      "UPDATE runs SET state='completed',speaker_ids='{}' WHERE id=$1",
      [run],
    );
    await tx.query("UPDATE messages SET status='completed' WHERE id=$1", [
      message,
    ]);
    m.status = 'completed';
  } else {
    if (groupSnapshot?.reply_policy === 'random' && !roomRow.parent_group_id) {
      const candidates = input.addressed_actor_ids?.length
        ? input.addressed_actor_ids
        : members;
      const chosen = [...candidates].sort((a, b) =>
        hash(input.client_command_id + a).localeCompare(
          hash(input.client_command_id + b),
        ),
      )[0];
      await tx.query('UPDATE runs SET speaker_ids=$2 WHERE id=$1', [
        run,
        [chosen],
      ]);
    }
    await tx.query(
      'INSERT INTO outbox(owner_id,run_id,attempt) VALUES($1,$2,0)',
      [owner, run],
    );
  }
  if (options.trustedOrigin) {
    await tx.query('DELETE FROM outbox WHERE run_id=$1', [run]);
    await tx.query(
      "UPDATE runs SET state='completed',speaker_ids='{}' WHERE id=$1",
      [run],
    );
    Object.assign(
      m,
      (
        await tx.query(
          "UPDATE messages SET role='assistant',status='completed',actor_id=$2,external_origin=$3 WHERE id=$1 RETURNING *",
          [message, members[0], JSON.stringify(options.trustedOrigin)],
        )
      ).rows[0],
    );
  } else if (!background && !options.skipRelay)
    await relayRun(tx, owner, run, roomRow, members, input);
  if (!background) await emit(tx, owner, 'message', message, messageView(m));
  await emit(tx, owner, 'run', run, runView(await getRun(tx, owner, run)));
  return { message_id: message, run_id: run };
}
export async function cancel(db: pg.Pool, owner: string, id: string) {
  const initial = await getRun(db, owner, id);
  return transaction(db, async (tx) => {
    await tx.query(
      'SELECT world_id FROM world_leases WHERE world_id=$1 FOR UPDATE',
      [initial.world_id],
    );
    await tx.query(
      'SELECT id FROM runs WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, id],
    );
    const run = await getRun(tx, owner, id);
    if (terminal(run.state)) return runView(run);
    if (run.state === 'remote_pending') {
      const j = (
        await tx.query(
          "UPDATE host_jobs SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END,error_code='cancel_requested',revision=revision+1 WHERE relay_run_id=$1 AND state IN ('pending','accepted','executing','unknown') RETURNING *",
          [id],
        )
      ).rows[0];
      if (j && j.state === 'unknown')
        return {
          ...runView(run),
          error_code: 'remote_reconciliation_required',
        };
    }
    const r = (
      await tx.query(
        "UPDATE runs SET state='cancelled',error_code='user_cancelled' WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    const messages = (
      await tx.query(
        "UPDATE messages SET status='cancelled' WHERE run_id=$1 AND status IN ('accepted','streaming') RETURNING *",
        [id],
      )
    ).rows;
    for (const m of messages)
      if (!m.internal) await emit(tx, owner, 'message', m.id, messageView(m));
    await tx.query(
      "UPDATE usage_ledger SET state='unknown',error_code='user_cancelled' WHERE run_id=$1 AND state='reserved'",
      [id],
    );
    await tx.query(
      'UPDATE world_leases SET holder=NULL,run_id=NULL,fencing_token=fencing_token+1,expires_at=now() WHERE world_id=$1 AND run_id=$2',
      [initial.world_id, id],
    );
    const calls = (
      await tx.query(
        "UPDATE tool_calls SET state=CASE WHEN state='executing' THEN 'outcome_unknown' ELSE 'denied' END,error_code='user_cancelled' WHERE run_id=$1 AND state IN ('pending','approved','executing') RETURNING *",
        [id],
      )
    ).rows;
    for (const call of calls) await emit(tx, owner, 'tool_call', call.id, call);
    await emit(tx, owner, 'run', id, runView(r));
    return runView(r);
  });
}
export interface Claim {
  run: Record<string, any>;
  provider: Record<string, any>;
  holder: string;
  fence: string;
  usageId: string;
  messages: any[];
  tools?: any[];
  toolOnly?: any;
}
export async function claim(
  db: pg.Pool,
  id: string,
  leaseMs: number,
  dailyLimit: number,
  runTimeoutMs = 120000,
  queryVector?: QueryVector,
  config?: Config,
): Promise<Claim | null> {
  const initial = (
    await db.query('SELECT world_id,owner_id FROM runs WHERE id=$1', [id])
  ).rows[0];
  if (!initial) return null;
  return transaction(db, async (tx) => {
    // Configuration edits use this same short owner lock. Freeze all speakers'
    // routes consistently before allowing a configuration writer to proceed.
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      initial.owner_id,
    ]);
    await tx.query(
      'INSERT INTO world_leases(world_id) VALUES($1) ON CONFLICT DO NOTHING',
      [initial.world_id],
    );
    const lease = (
      await tx.query(
        'SELECT *,expires_at>clock_timestamp() AS active FROM world_leases WHERE world_id=$1 FOR UPDATE',
        [initial.world_id],
      )
    ).rows[0];
    if (lease.holder && lease.active) return null;
    const earliest = (
      await tx.query(
        "SELECT id FROM runs WHERE world_id=$1 AND state IN ('queued','running') ORDER BY (trigger_kind='foreground') DESC,command_order LIMIT 1",
        [initial.world_id],
      )
    ).rows[0];
    if (earliest?.id !== id) return null;
    const run = (
      await tx.query(
        'SELECT *,next_attempt_at<=clock_timestamp() AS due FROM runs WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (run.state !== 'queued' || !run.due || run.history_source_run_id)
      return null;
    const world = await worldLock(tx, run.owner_id, run.world_id);
    const room = (
      await tx.query('SELECT * FROM rooms WHERE id=$1', [run.room_id])
    ).rows[0];
    const members = (
      await tx.query(
        `SELECT a.id,a.participation,COALESCE((SELECT max(r.command_order) FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.actor_id=a.id AND m.room_id=$1 AND m.status='completed'),0)::text AS last_order FROM world_characters a JOIN room_memberships rm ON rm.actor_id=a.id WHERE rm.room_id=$1 AND rm.left_at IS NULL AND NOT a.deleted AND EXISTS(SELECT 1 FROM message_audiences ma WHERE ma.message_id=$2 AND ma.actor_id=a.id)`,
        [run.room_id, run.user_message_id],
      )
    ).rows;
    const speakers: string[] =
      run.speaker_ids ??
      selectSpeakers(
        members,
        run.addressed_actor_ids,
        run.trigger_kind === 'foreground'
          ? room.max_replies
          : Math.min(room.max_replies, run.max_background_turns),
        run.client_command_id,
      );
    const actorId = speakers[run.step_index] ?? null;
    let provider: any;
    let routeError: string | null = null;
    try {
      if (!run.speaker_ids) {
        for (const [index, speaker] of speakers.entries()) {
          await claimProvider(tx, { ...run, step_index: index }, room, speaker);
        }
      }
      provider = await claimProvider(tx, run, room, actorId);
    } catch (e) {
      if (e instanceof AppError) routeError = e.code;
      else throw e;
    }
    const toolOnly = await pendingTool(tx, run);
    const tools =
      !run.replacement_message_id && provider?.tools_enabled
        ? await availableTools(tx, run, actorId)
        : [];
    const transcript = await toolTranscript(tx, run);
    const toolCost =
      Buffer.byteLength(JSON.stringify(tools.map((t) => t.definition))) +
      Buffer.byteLength(JSON.stringify(transcript)) +
      64;
    const backgroundValid =
      (await validSchedule(tx, run)) &&
      (run.trigger_kind === 'foreground' ||
        (await validBackground(
          tx,
          run.owner_id,
          run.world_id,
          run.trigger_kind,
          run.global_revision,
          run.policy_revision,
        )));

    const sourceInvalid = !!(
      await tx.query(
        'SELECT 1 FROM messages WHERE run_id=$1 AND memory_excluded AND NOT internal LIMIT 1',
        [run.id],
      )
    ).rowCount;
    let error: string | null =
      routeError ??
      (sourceInvalid
        ? 'source_invalidated'
        : !backgroundValid
          ? 'autonomy_disabled'
          : run.remaining_ms <= 0
            ? 'run_deadline_exceeded'
            : run.deadline_at &&
                new Date(run.deadline_at).getTime() <= Date.now()
              ? 'run_deadline_exceeded'
              : !provider
                ? 'provider_missing'
                : room.kind !== 'legacy' &&
                    (!actorId || !members.some((m) => m.id === actorId))
                  ? 'actor_unavailable'
                  : null);
    let promptProfile: any;
    let compiled: Awaited<ReturnType<typeof preparePrompt>> | undefined;
    if (!error) {
      try {
        promptProfile = await runtimeProfile(tx, config, run, actorId);
        provider = {
          ...provider,
          parameters: promptProfile.profile.parameters,
        };
        compiled = await preparePrompt(
          tx,
          run,
          { ...provider, context_window: provider.context_window - toolCost },
          actorId,
          world,
          queryVector,
          promptProfile,
        );
      } catch (e) {
        if (e instanceof AppError) error = e.code;
        else throw e;
      }
    }
    const messages: any[] = [...(compiled?.messages ?? []), ...transcript];
    if (compiled) {
      compiled.manifest.estimated_input_tokens += toolCost;
      Object.assign(compiled.manifest, {
        dispatch_kind: toolOnly ? 'tool_execution' : 'model_request',
        payload_sha256: toolOnly
          ? null
          : hash(
              canonical(
                modelPayload({
                  provider,
                  messages,
                  tools: tools.map((t) => t.definition),
                }),
              ),
            ),
        model_route: {
          provider_id: provider.id,
          provider_revision: provider.revision,
          model: provider.model,
          route: provider.route,
          actor_id: actorId,
        },
        tool_grants: tools.map((t) => ({
          id: t.grant.id,
          revision: t.grant.revision,
          schema_hash: t.grant.schema_hash,
        })),
        tool_history_count: transcript.length / 2,
      });
    }
    const inputEstimate = compiled?.manifest.estimated_input_tokens ?? 0;
    let backgroundUsageId: string | null = null;
    if (!error && !toolOnly) {
      if (run.trigger_kind !== 'foreground') {
        try {
          if (!config)
            throw new AppError(
              429,
              'background_config_missing',
              'Background budget configuration required',
            );
          backgroundUsageId = await reserveBackground(
            tx,
            config,
            run.owner_id,
            run.world_id,
            run.trigger_kind,
            inputEstimate,
            provider.max_output_tokens,
          );
        } catch (e) {
          if (e instanceof AppError) error = e.code;
          else throw e;
        }
      } else {
        await tx.query(
          'INSERT INTO usage_daily(owner_id,day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',
          [run.owner_id],
        );
        const reservation = await tx.query(
          'UPDATE usage_daily SET requests=requests+1 WHERE owner_id=$1 AND day=CURRENT_DATE AND requests<$2 RETURNING requests',
          [run.owner_id, dailyLimit],
        );
        if (!reservation.rowCount) error = 'request_budget_exceeded';
      }
    }
    if (error) {
      const r = (
        await tx.query(
          "UPDATE runs SET state='failed',error_code=$2 WHERE id=$1 RETURNING *",
          [id, error],
        )
      ).rows[0];
      await tx.query("UPDATE messages SET status='failed' WHERE id=$1", [
        run.user_message_id,
      ]);
      const m = (
        await tx.query('SELECT * FROM messages WHERE id=$1', [
          run.user_message_id,
        ])
      ).rows[0];
      if (!m.internal)
        await emit(tx, run.owner_id, 'message', m.id, messageView(m));
      await emit(tx, run.owner_id, 'run', id, runView(r));
      return null;
    }
    const holder = randomUUID();
    const fence = (
      await tx.query(
        "UPDATE world_leases SET holder=$2,run_id=$3,fencing_token=fencing_token+1,expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE world_id=$1 RETURNING fencing_token",
        [run.world_id, holder, id, leaseMs],
      )
    ).rows[0].fencing_token;
    const started = (
      await tx.query(
        "UPDATE runs SET state='running',attempts=attempts+1,step_attempts=step_attempts+1,lease_holder=$2,fence=$3,error_code=NULL,speaker_ids=$4,context_revision=$5,deadline_at=COALESCE(deadline_at,clock_timestamp()+$6*interval '1 millisecond') WHERE id=$1 RETURNING *",
        [
          id,
          holder,
          fence,
          speakers,
          world.revision,
          Math.min(runTimeoutMs, run.remaining_ms),
        ],
      )
    ).rows[0];
    await tx.query('UPDATE runs SET background_usage_id=$2 WHERE id=$1', [
      id,
      backgroundUsageId,
    ]);
    started.background_usage_id = backgroundUsageId;
    started.memory_epoch = world.memory_epoch;
    const existing = (
      await tx.query('SELECT id FROM messages WHERE id=$1', [
        run.reply_message_id,
      ])
    ).rowCount;
    if (!existing) {
      const seq = (
        await tx.query(
          'UPDATE rooms SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence',
          [run.room_id],
        )
      ).rows[0].next_sequence;
      await tx.query(
        "INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,status,actor_id,actor_name,step_index) VALUES($1,$2,$3,$4,$5,'assistant','streaming',$6,$7,$8)",
        [
          run.reply_message_id,
          run.owner_id,
          run.room_id,
          id,
          seq,
          actorId,
          actorId
            ? (
                await tx.query(
                  'SELECT name FROM world_characters WHERE id=$1',
                  [actorId],
                )
              ).rows[0].name
            : null,
          run.step_index,
        ],
      );
    } else
      await tx.query("UPDATE messages SET status='streaming' WHERE id=$1", [
        run.reply_message_id,
      ]);
    if (run.replacement_message_id)
      await tx.query('UPDATE messages SET internal=true WHERE id=$1', [
        run.reply_message_id,
      ]);
    await tx.query(
      'INSERT INTO message_audiences(message_id,actor_id) SELECT $1,a.actor_id FROM message_audiences a JOIN room_memberships rm ON rm.actor_id=a.actor_id AND rm.room_id=$3 AND rm.left_at IS NULL WHERE a.message_id=$2 ON CONFLICT DO NOTHING',
      [run.reply_message_id, run.user_message_id, run.room_id],
    );
    await tx.query(
      'INSERT INTO prompt_manifests(run_id,attempt,data) VALUES($1,$2,$3)',
      [id, started.attempts, JSON.stringify(compiled!.manifest)],
    );
    if (config && !toolOnly) {
      const payload = modelPayload({
        provider,
        messages,
        tools: tools.map((t) => t.definition),
      });
      await tx.query(
        'INSERT INTO request_snapshots(run_id,attempt,owner_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          started.attempts,
          run.owner_id,
          JSON.stringify(
            encrypt(
              JSON.stringify(payload),
              config,
              `${run.owner_id}:request:${id}:${started.attempts}`,
            ),
          ),
          hash(canonical(payload)),
        ],
      );
    }
    const sourceIds = [
      run.user_message_id,
      ...((compiled!.manifest as any).recalled_source_ids ?? []),
      ...compiled!.manifest.decisions
        .filter((d) => d.kind === 'message' && d.included)
        .map((d) => d.id),
    ];
    const memoryIds = compiled!.manifest.decisions
      .filter((d) => d.kind === 'memory' && d.included)
      .map((d) => d.id);
    const evidence = (
      await tx.query(
        "SELECT message_id FROM memory_evidence WHERE memory_id=ANY($1::uuid[]) UNION SELECT (s->>'id')::uuid AS message_id FROM memory_materials m CROSS JOIN LATERAL jsonb_array_elements(m.source_snapshot) s WHERE m.id=ANY($1::uuid[])",
        [memoryIds],
      )
    ).rows.map((e) => e.message_id);
    for (const source of new Set([...sourceIds, ...evidence]))
      await tx.query(
        'INSERT INTO message_dependencies(message_id,source_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [run.reply_message_id, source],
      );
    const usageId = randomUUID();
    if (!toolOnly)
      await tx.query(
        "INSERT INTO usage_ledger(id,owner_id,run_id,attempt,state,estimated_input_tokens,reserved_output_tokens) VALUES($1,$2,$3,$4,'reserved',$5,$6)",
        [
          usageId,
          run.owner_id,
          id,
          started.attempts,
          inputEstimate,
          provider.max_output_tokens,
        ],
      );
    await emit(tx, run.owner_id, 'run', id, runView(started));
    return {
      run: started,
      provider,
      holder,
      fence,
      usageId,
      messages,
      tools: tools.map((t) => t.definition),
      toolOnly,
    };
  });
}
// Every write locks and verifies both the lease and run, including expiry. Old workers cannot publish.
export async function owned<T>(
  db: pg.Pool,
  c: Claim,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T | null> {
  return transaction(db, async (tx) => {
    const valid = (
      await tx.query(
        'SELECT world_id FROM world_leases WHERE world_id=$1 AND holder=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() FOR UPDATE',
        [c.run.world_id, c.holder, c.fence],
      )
    ).rowCount;
    if (!valid) return null;
    const run = (
      await tx.query(
        "SELECT id FROM runs WHERE id=$1 AND state='running' AND fence=$2 AND lease_holder=$3 FOR UPDATE",
        [c.run.id, c.fence, c.holder],
      )
    ).rowCount;
    if (!run) return null;
    return fn(tx);
  });
}
export async function heartbeat(db: pg.Pool, c: Claim, leaseMs: number) {
  return owned(db, c, async (tx) => {
    await tx.query(
      "UPDATE world_leases SET expires_at=clock_timestamp()+$2*interval '1 millisecond' WHERE world_id=$1",
      [c.run.world_id, leaseMs],
    );
    return true;
  });
}
export async function savePartial(db: pg.Pool, c: Claim, content: string) {
  return owned(db, c, async (tx) => {
    if (c.run.trigger_kind !== 'foreground') return true;
    const m = (
      await tx.query(
        "UPDATE messages SET content=$2,status='streaming' WHERE id=$1 RETURNING *",
        [c.run.reply_message_id, content],
      )
    ).rows[0];
    if (!m.internal)
      await emit(tx, c.run.owner_id, 'message', m.id, messageView(m));
    return true;
  });
}
export interface Usage {
  input: number;
  output: number;
}
export async function finish(
  db: pg.Pool,
  c: Claim,
  content: string,
  state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
  error: string | null,
  usage: Usage | null,
  retryable = false,
) {
  return owned(db, c, async (tx) => {
    const world = await worldLock(tx, c.run.owner_id, c.run.world_id);
    if (
      world.revision !== c.run.context_revision ||
      world.memory_epoch !== c.run.memory_epoch
    ) {
      state = content ? 'interrupted' : 'failed';
      error = 'context_changed';
      if (world.memory_epoch !== c.run.memory_epoch) content = '';
      retryable = false;
    }
    const allowed =
      (await validSchedule(tx, c.run)) &&
      (c.run.trigger_kind === 'foreground' ||
        (await validBackground(
          tx,
          c.run.owner_id,
          c.run.world_id,
          c.run.trigger_kind,
          c.run.global_revision,
          c.run.policy_revision,
        )));
    const skipped =
      c.run.trigger_kind !== 'foreground' && content.trim() === '<skip>';
    if (!allowed || skipped) {
      state = 'cancelled';
      content = '';
      error = skipped ? 'autonomy_skip' : 'autonomy_disabled';
      retryable = false;
    }
    if ((skipped || !allowed) && c.run.trigger_kind !== 'foreground')
      await tx.query('UPDATE messages SET internal=true WHERE id=$1', [
        c.run.reply_message_id,
      ]);
    const hasTools = !!(
      await tx.query('SELECT 1 FROM tool_calls WHERE run_id=$1 LIMIT 1', [
        c.run.id,
      ])
    ).rowCount;
    const retry = retryable && !content && c.run.step_attempts < 3 && !hasTools;
    const userWaiting =
      c.run.trigger_kind !== 'foreground' &&
      !!(
        await tx.query(
          "SELECT 1 FROM runs WHERE world_id=$1 AND trigger_kind='foreground' AND state='queued' LIMIT 1",
          [c.run.world_id],
        )
      ).rowCount;
    const more =
      state === 'completed' &&
      !userWaiting &&
      c.run.step_index + 1 < c.run.speaker_ids.length;
    const next = retry || more ? 'queued' : state;
    const r = (
      await tx.query(
        "UPDATE runs SET state=$2,error_code=$3,next_attempt_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING *",
        [c.run.id, next, error],
      )
    ).rows[0];
    const m = (
      await tx.query(
        'UPDATE messages SET content=$2,status=$3 WHERE id=$1 RETURNING *',
        [c.run.reply_message_id, content, retry ? 'streaming' : state],
      )
    ).rows[0];
    if (state === 'completed') await consumeRecap(tx, c.run);
    if (c.run.replacement_message_id && state === 'completed') {
      const version = randomUUID();
      await tx.query(
        "INSERT INTO message_versions(id,owner_id,message_id,content,status,base_context_revision) VALUES($1,$2,$3,$4,'completed',$5)",
        [
          version,
          c.run.owner_id,
          c.run.replacement_message_id,
          content,
          c.run.context_revision,
        ],
      );

      const replacement = (
        await tx.query(
          "UPDATE messages SET content=$2,status='completed',context_stale=false,selected_version_id=$3 WHERE id=$1 RETURNING *",
          [c.run.replacement_message_id, content, version],
        )
      ).rows[0];
      await emit(
        tx,
        c.run.owner_id,
        'message',
        replacement.id,
        messageView(replacement),
      );
    }
    const u = (
      await tx.query('UPDATE messages SET status=$2 WHERE id=$1 RETURNING *', [
        c.run.user_message_id,
        retry || more
          ? 'accepted'
          : state === 'completed'
            ? 'completed'
            : state,
      ])
    ).rows[0];
    await tx.query(
      'UPDATE usage_ledger SET state=$2,input_tokens=$3,output_tokens=$4,error_code=$5 WHERE id=$1',
      [
        c.usageId,
        usage ? 'known' : 'unknown',
        usage?.input ?? null,
        usage?.output ?? null,
        error,
      ],
    );
    if (c.run.background_usage_id)
      await settleBackground(tx, c.run.background_usage_id, usage, error);
    await tx.query(
      'UPDATE world_leases SET holder=NULL,run_id=NULL,expires_at=now() WHERE world_id=$1',
      [c.run.world_id],
    );
    if (state === 'completed') {
      await enqueueNotification(tx, m);
      const manifest = (
        await tx.query(
          'SELECT data FROM prompt_manifests WHERE run_id=$1 AND attempt=$2',
          [c.run.id, c.run.attempts],
        )
      ).rows[0].data;
      await commitLore(tx, m, manifest);
      await registerSources(tx, c.run.room_id);
      const revision = await bumpWorld(tx, c.run.owner_id, c.run.world_id);
      const audience = (
        await tx.query(
          'SELECT actor_id FROM message_audiences WHERE message_id=$1 ORDER BY actor_id',
          [m.id],
        )
      ).rows.map((a) => a.actor_id);
      if (c.run.trigger_kind === 'foreground')
        await addEvent(
          tx,
          c.run.owner_id,
          c.run.world_id,
          'user_message',
          revision,
          {},
          audience,
          c.run.id,
          u.id,
        );
      await addEvent(
        tx,
        c.run.owner_id,
        c.run.world_id,
        'character_claim',
        revision,
        { actor_id: m.actor_id },
        audience,
        c.run.id,
        m.id,
      );
      await tx.query('UPDATE runs SET final_revision=$2 WHERE id=$1', [
        c.run.id,
        revision,
      ]);
    }
    if (more)
      await tx.query(
        'UPDATE runs SET step_index=step_index+1,step_attempts=0,reply_message_id=$2,next_attempt_at=now() WHERE id=$1',
        [c.run.id, randomUUID()],
      );
    if (retry || more)
      await tx.query(
        "INSERT INTO outbox(owner_id,run_id,attempt,available_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 second') ON CONFLICT DO NOTHING",
        [c.run.owner_id, c.run.id, c.run.attempts],
      );
    if (!m.internal)
      await emit(tx, c.run.owner_id, 'message', m.id, messageView(m));
    if (!u.internal)
      await emit(tx, c.run.owner_id, 'message', u.id, messageView(u));
    await emit(tx, c.run.owner_id, 'run', r.id, runView(r));
    return true;
  });
}
export async function recover(db: pg.Pool) {
  const expired = (
    await db.query(
      'SELECT world_id FROM world_leases WHERE holder IS NOT NULL AND expires_at<=clock_timestamp()',
    )
  ).rows;
  for (const item of expired)
    await transaction(db, async (tx) => {
      const lease = (
        await tx.query(
          'SELECT * FROM world_leases WHERE world_id=$1 AND holder IS NOT NULL AND expires_at<=clock_timestamp() FOR UPDATE',
          [item.world_id],
        )
      ).rows[0];
      if (!lease) return;
      const run = (
        await tx.query(
          'SELECT *,next_attempt_at<=clock_timestamp() AS due FROM runs WHERE id=$1 FOR UPDATE',
          [lease.run_id],
        )
      ).rows[0];
      await tx.query(
        'UPDATE world_leases SET holder=NULL,run_id=NULL,fencing_token=fencing_token+1 WHERE world_id=$1',
        [lease.world_id],
      );
      if (!run || terminal(run.state)) return;
      const message = (
        await tx.query('SELECT * FROM messages WHERE id=$1', [
          run.reply_message_id,
        ])
      ).rows[0];
      const uncertain = (
        await tx.query(
          "UPDATE tool_calls SET state='outcome_unknown',error_code='worker_lost' WHERE run_id=$1 AND state='executing' RETURNING *",
          [run.id],
        )
      ).rows;
      for (const call of uncertain)
        await emit(tx, run.owner_id, 'tool_call', call.id, call);
      const state = uncertain.length
        ? 'awaiting_approval'
        : message?.content
          ? 'interrupted'
          : run.step_attempts >= 3
            ? 'failed'
            : 'queued';
      const r = (
        await tx.query(
          "UPDATE runs SET state=$2,error_code='worker_lost',next_attempt_at=now() WHERE id=$1 RETURNING *",
          [run.id, state],
        )
      ).rows[0];
      await tx.query(
        "UPDATE usage_ledger SET state='unknown',error_code='worker_lost' WHERE run_id=$1 AND state='reserved'",
        [run.id],
      );
      if (state === 'queued')
        await tx.query(
          'INSERT INTO outbox(owner_id,run_id,attempt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [run.owner_id, run.id, run.attempts],
        );
      else if (state !== 'awaiting_approval') {
        const rows = (
          await tx.query(
            "UPDATE messages SET status=$2 WHERE run_id=$1 AND status IN ('accepted','streaming') RETURNING *",
            [run.id, state],
          )
        ).rows;
        for (const m of rows)
          await emit(tx, run.owner_id, 'message', m.id, messageView(m));
      }
      await emit(tx, run.owner_id, 'run', run.id, runView(r));
    });
  // Jobs may complete without claiming a busy world. Re-dispatch pending commands after a bounded delay.
  await db.query(
    "UPDATE outbox o SET dispatched_at=NULL FROM runs r WHERE r.id=o.run_id AND r.state='queued' AND o.attempt=r.attempts AND o.dispatched_at<clock_timestamp()-interval '2 seconds'",
  );
}

export async function regenerate(
  db: pg.Pool,
  owner: string,
  id: string,
  command: string,
) {
  const requestHash = hash(JSON.stringify({ regenerate: id }));
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      owner,
    ]);
    const prior = (
      await tx.query(
        'SELECT * FROM runs WHERE owner_id=$1 AND client_command_id=$2',
        [owner, command],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(409, 'idempotency_conflict', 'Command already used');
      return { message_id: prior.user_message_id, run_id: prior.id };
    }
    const original = await getRun(tx, owner, id);
    await tx.query(
      'SELECT world_id FROM world_leases WHERE world_id=$1 FOR UPDATE',
      [original.world_id],
    );
    const world = await worldLock(tx, owner, original.world_id);
    if (
      original.state !== 'completed' ||
      original.history_source_run_id !== null ||
      original.has_external_effects ||
      original.trigger_kind !== 'foreground' ||
      !!(
        await tx.query('SELECT 1 FROM tool_calls WHERE run_id=$1 LIMIT 1', [id])
      ).rowCount ||
      world.revision !== original.final_revision ||
      String(world.next_command) !== String(original.command_order)
    )
      throw new AppError(
        409,
        'regeneration_unsafe',
        'Only the last completed turn without later changes or external effects can be regenerated',
      );
    const messages = (
      await tx.query(
        "UPDATE messages SET status='invalidated' WHERE run_id=$1 RETURNING *",
        [id],
      )
    ).rows;
    await invalidateSources(
      tx,
      owner,
      original.world_id,
      messages.map((m) => m.id),
    );
    await rebuildLore(tx, original.room_id);
    for (const m of messages)
      await emit(tx, owner, 'message', m.id, messageView(m));
    const events = (
      await tx.query(
        'UPDATE world_events SET invalidated=true WHERE run_id=$1 RETURNING *',
        [id],
      )
    ).rows;
    for (const event of events)
      await emit(tx, owner, 'world_event', event.id, eventView(event));
    const revision = await bumpWorld(tx, owner, original.world_id);
    await addEvent(
      tx,
      owner,
      original.world_id,
      'regeneration',
      revision,
      { invalidated_run_id: id },
      [],
      id,
    );
    const result = await enqueueInTransaction(
      tx,
      owner,
      original.room_id,
      {
        client_command_id: command,
        content: messages.find((m) => m.role === 'user').content,
        addressed_actor_ids: original.addressed_actor_ids,
      },
      requestHash,
    );
    await tx.query('UPDATE runs SET regenerated_from=$2 WHERE id=$1', [
      result.run_id,
      id,
    ]);
    return result;
  });
}
