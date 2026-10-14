import { validSchedule } from '../schedules/guard.js';
import { groupToolAllowed } from '../groups/index.js';
import { executeInternal, documentTools } from '../documents/tools.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, hash } from '../../security.js';
import { policies, backgroundAllowed } from '../autonomy/policy.js';
import { emit, runView, messageView } from '../sync/index.js';
import { owned, type Claim, type Usage } from '../runs/repository.js';
import { worldLock } from '../worlds/index.js';
import { settleBackground } from '../memory/usage.js';
import { purgeReplay } from '../memory/repository.js';
import { canonical, validateArguments, boundedResult } from './schema.js';
import { connectMcp, discover, hideCredential } from './transport.js';
import { callView } from './connections.js';
export async function availableTools(db: DB, run: any, actor: string | null) {
  if (!actor) return [];
  const { g, p } = await policies(db, run.owner_id, run.world_id);
  const grants = (
    await db.query(
      `SELECT g.*,c.tools,c.revision AS connection_revision FROM tool_grants g JOIN mcp_connections c ON c.id=g.connection_id WHERE g.owner_id=$1 AND g.world_id=$2 AND g.actor_id=$3 AND g.enabled AND c.enabled AND g.expires_at>now() ORDER BY g.id LIMIT 129`,
      [run.owner_id, run.world_id, actor],
    )
  ).rows;
  const permitted = [];
  for (const grant of grants)
    if (await groupToolAllowed(db, run, actor, grant.connection_id))
      permitted.push(grant);
  const counts = new Map<string, number>();
  return permitted
    .flatMap((grant) => {
      const tool = grant.tools.find(
        (t: any) =>
          t.name === grant.tool_name &&
          t.schema_hash === grant.schema_hash &&
          t.supported,
      );
      const key = grant.effect === 'read' ? 'tools_read' : 'tools_write';
      if (!tool || !g[key] || !p[key] || counts.get(grant.connection_id) === 32)
        return [];
      counts.set(
        grant.connection_id,
        (counts.get(grant.connection_id) ?? 0) + 1,
      );
      return [
        {
          grant,
          definition: {
            type: 'function',
            function: {
              name: 'mcp_' + grant.id.replaceAll('-', ''),
              description: (tool.description ?? tool.name).slice(0, 2000),
              parameters: tool.inputSchema,
            },
          },
        },
      ];
    })
    .slice(0, 64);
}
export async function toolTranscript(db: DB, run: any) {
  const calls = (
    await db.query(
      "SELECT * FROM tool_calls WHERE run_id=$1 AND step_index=$2 AND state IN ('succeeded','failed','resolved') ORDER BY ordinal",
      [run.id, run.step_index],
    )
  ).rows;
  return calls.flatMap((c) => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: c.model_call_id,
          type: 'function',
          function: { name: c.model_name, arguments: canonical(c.arguments) },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: c.model_call_id,
      content: c.result ?? JSON.stringify({ error: c.error_code }),
    },
  ]);
}
async function authorized(db: DB, run: any, call: any) {
  const world = await worldLock(db, run.owner_id, run.world_id);
  const { g, p } = await policies(db, run.owner_id, run.world_id, true);
  const grant = (
    await db.query(
      'SELECT * FROM tool_grants WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [call.grant_id, run.owner_id],
    )
  ).rows[0];
  const connection = grant
    ? (
        await db.query(
          'SELECT * FROM mcp_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [grant.connection_id, run.owner_id],
        )
      ).rows[0]
    : null;
  const actor = run.speaker_ids?.[run.step_index];
  const tool = connection?.tools.find(
    (t: any) =>
      t.name === call.tool_name &&
      t.schema_hash === call.schema_hash &&
      t.supported,
  );
  const flag = call.effect === 'read' ? 'tools_read' : 'tools_write';
  if (
    (connection?.runtime === 'internal' &&
      call.effect !==
        (['save_document', 'request_system_action'].includes(call.tool_name)
          ? 'write'
          : 'read')) ||
    !(await groupToolAllowed(
      db,
      run,
      actor,
      call.connection_id ?? connection?.id,
    )) ||
    !(await validSchedule(db, run)) ||
    !grant?.enabled ||
    !connection?.enabled ||
    !tool ||
    grant.actor_id !== actor ||
    grant.world_id !== run.world_id ||
    grant.revision !== call.grant_revision ||
    connection.revision !== call.connection_revision ||
    grant.schema_hash !== call.schema_hash ||
    new Date(grant.expires_at).getTime() <= Date.now() ||
    new Date(call.expires_at).getTime() <= Date.now() ||
    !g[flag] ||
    !p[flag] ||
    g.revision !== call.global_revision ||
    p.revision !== call.policy_revision ||
    world.revision !== call.world_revision ||
    (run.trigger_kind !== 'foreground' &&
      !backgroundAllowed(g, p, run.trigger_kind))
  )
    throw new AppError(
      409,
      'tool_authorization_changed',
      'Action or permissions changed; plan and approve a new action',
    );
  validateArguments(tool.inputSchema, call.arguments, grant.argument_scope);
  if (hash(canonical(call.arguments)) !== call.arguments_hash)
    throw new AppError(
      409,
      'tool_arguments_changed',
      'Action parameters changed',
    );
  return { connection, tool };
}
async function release(
  tx: DB,
  c: Claim,
  state: string,
  error: string | null,
  usage: Usage | null,
) {
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
  const r = (
    await tx.query(
      'UPDATE runs SET state=$2,error_code=$3,remaining_ms=GREATEST(0,EXTRACT(EPOCH FROM (deadline_at-clock_timestamp()))*1000)::integer,deadline_at=NULL,next_attempt_at=now(),step_attempts=0 WHERE id=$1 RETURNING *',
      [c.run.id, state, error],
    )
  ).rows[0];
  await tx.query(
    'UPDATE world_leases SET holder=NULL,run_id=NULL,expires_at=now() WHERE world_id=$1',
    [c.run.world_id],
  );
  if (state === 'queued')
    await tx.query(
      'INSERT INTO outbox(owner_id,run_id,attempt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [c.run.owner_id, c.run.id, c.run.attempts],
    );
  await emit(tx, c.run.owner_id, 'run', c.run.id, runView(r));
}
export async function proposeTool(
  db: pg.Pool,
  c: Claim,
  intent: { id: string; name: string; arguments: string },
  usage: Usage | null,
) {
  return owned(db, c, async (tx) => {
    const world = await worldLock(tx, c.run.owner_id, c.run.world_id);
    if (world.revision !== c.run.context_revision)
      throw new AppError(
        409,
        'context_changed',
        'World changed before tool proposal',
      );
    const count = Number(
      (
        await tx.query('SELECT count(*) FROM tool_calls WHERE run_id=$1', [
          c.run.id,
        ])
      ).rows[0].count,
    );
    if (count >= (c.run.tool_limit ?? 4))
      throw new AppError(
        400,
        'tool_loop_limit',
        'Run has reached its tool limit',
      );
    const available = await availableTools(
      tx,
      c.run,
      c.run.speaker_ids[c.run.step_index],
    );
    const selected = available.find(
      (t) => t.definition.function.name === intent.name,
    );
    if (!selected)
      throw new AppError(
        403,
        'tool_not_granted',
        'Tool was not granted to this actor',
      );
    let args: any;
    try {
      args = JSON.parse(intent.arguments);
    } catch {
      throw new AppError(
        400,
        'invalid_tool_arguments',
        'Tool arguments must be JSON',
      );
    }
    const prior = (
      await tx.query(
        'SELECT * FROM tool_calls WHERE run_id=$1 AND model_call_id=$2',
        [c.run.id, intent.id],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.model_name !== intent.name ||
        prior.arguments_hash !== hash(canonical(args))
      )
        throw new AppError(
          409,
          'idempotency_conflict',
          'Tool call identity reused with different arguments',
        );
      await release(
        tx,
        c,
        ['pending', 'executing', 'outcome_unknown'].includes(prior.state)
          ? 'awaiting_approval'
          : 'queued',
        null,
        usage,
      );
      return prior;
    }
    const { g, p } = await policies(tx, c.run.owner_id, c.run.world_id, true);
    const grant = selected.grant;
    const record = {
      grant_id: grant.id,
      grant_revision: grant.revision,
      connection_revision: grant.connection_revision,
      tool_name: grant.tool_name,
      schema_hash: grant.schema_hash,
      arguments: args,
      arguments_hash: hash(canonical(args)),
      effect: grant.effect,
      world_revision: world.revision,
      global_revision: g.revision,
      policy_revision: p.revision,
      expires_at: new Date(Date.now() + 86400000),
    };
    await authorized(tx, c.run, record);
    const approval = grant.effect === 'write' && grant.approval_mode === 'each';
    const id = randomUUID();
    const row = (
      await tx.query(
        'INSERT INTO tool_calls(id,owner_id,run_id,step_index,ordinal,actor_id,grant_id,grant_revision,connection_revision,tool_name,model_name,model_call_id,schema_hash,arguments,arguments_hash,effect,state,world_revision,global_revision,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',
        [
          id,
          c.run.owner_id,
          c.run.id,
          c.run.step_index,
          count,
          c.run.speaker_ids[c.run.step_index],
          grant.id,
          grant.revision,
          grant.connection_revision,
          grant.tool_name,
          intent.name,
          intent.id,
          grant.schema_hash,
          JSON.stringify(args),
          record.arguments_hash,
          grant.effect,
          approval ? 'pending' : 'approved',
          world.revision,
          g.revision,
          p.revision,
        ],
      )
    ).rows[0];
    row.authorization_snapshot = {
      approval_mode: grant.approval_mode,
      argument_scope: grant.argument_scope,
      expires_at: grant.expires_at,
    };
    await tx.query(
      'UPDATE tool_calls SET authorization_snapshot=$2 WHERE id=$1',
      [id, JSON.stringify(row.authorization_snapshot)],
    );
    await emit(tx, c.run.owner_id, 'tool_call', id, callView(row));
    await release(
      tx,
      c,
      approval ? 'awaiting_approval' : 'queued',
      null,
      usage,
    );
    return row;
  });
}
export async function pendingTool(db: DB, run: any) {
  return (
    await db.query(
      "SELECT * FROM tool_calls WHERE run_id=$1 AND step_index=$2 AND state='approved' ORDER BY ordinal LIMIT 1",
      [run.id, run.step_index],
    )
  ).rows[0];
}
export async function executeTool(
  db: pg.Pool,
  config: Config,
  c: Claim,
  call: any,
  signal: AbortSignal,
) {
  let session: Awaited<ReturnType<typeof connectMcp>> | undefined,
    dispatched = false;
  let outcome = 'failed',
    result: string | null = null,
    error: string | null = null,
    truncated = false;
  try {
    const validated = await owned(db, c, (tx) => authorized(tx, c.run, call));
    if (!validated) return;
    if (validated.connection.runtime === 'internal') {
      await owned(db, c, async (tx) => {
        await authorized(tx, c.run, call);
        if (
          !documentTools.some(
            (t) =>
              t.name === call.tool_name && t.schema_hash === call.schema_hash,
          )
        )
          throw new AppError(
            409,
            'tool_schema_changed',
            'Internal schema changed',
          );
        const fresh = (
          await tx.query(
            "SELECT * FROM tool_calls WHERE id=$1 AND state='approved' FOR UPDATE",
            [call.id],
          )
        ).rows[0];
        if (!fresh) return;
        const result = boundedResult(await executeInternal(tx, c.run, fresh));
        const row = (
          await tx.query(
            "UPDATE tool_calls SET state='succeeded',result=$2,truncated=$3,dispatched_at=now() WHERE id=$1 RETURNING *",
            [call.id, result.text, result.truncated],
          )
        ).rows[0];
        await emit(tx, c.run.owner_id, 'tool_call', call.id, callView(row));
        await release(tx, c, 'queued', null, null);
      });
      return;
    }
    session = await connectMcp(validated.connection, config, signal);
    const tools = await discover(session.client, signal);
    if (
      !tools.some(
        (t) =>
          t.name === call.tool_name &&
          t.schema_hash === call.schema_hash &&
          t.supported,
      )
    )
      throw new AppError(
        409,
        'tool_schema_changed',
        'Live tool definition changed',
      );
    const marked = await owned(db, c, async (tx) => {
      await authorized(tx, c.run, call);
      const row = (
        await tx.query(
          "UPDATE tool_calls SET state='executing',dispatched_at=now() WHERE id=$1 AND state='approved' RETURNING *",
          [call.id],
        )
      ).rows[0];
      if (!row) return false;
      // Persist uncertainty before crossing the network boundary. Never replay this action after a crash.
      if (call.effect === 'write')
        await tx.query(
          'UPDATE runs SET has_external_effects=true WHERE id=$1',
          [c.run.id],
        );
      await emit(tx, c.run.owner_id, 'tool_call', call.id, callView(row));
      return true;
    });
    if (!marked) return;
    dispatched = true;
    const response = await session.client.callTool(
      { name: call.tool_name, arguments: call.arguments },
      undefined,
      { signal, timeout: 30000 },
    );
    const bounded = boundedResult(
      hideCredential(validated.connection, config, response),
    );
    result = bounded.text;
    truncated = bounded.truncated;
    outcome = response.isError ? 'failed' : 'succeeded';
  } catch (e) {
    error = e instanceof AppError ? e.code : 'mcp_request_failed';
    outcome = dispatched ? 'outcome_unknown' : 'failed';
  } finally {
    await session?.close();
  }
  // The tool outcome remains useful even after cancellation/fence loss; it cannot publish character text.
  await transaction(db, async (tx) => {
    const row = (
      await tx.query(
        "UPDATE tool_calls SET state=$2,result=$3,truncated=$4,error_code=$5 WHERE id=$1 AND state IN ('approved','executing') AND error_code IS DISTINCT FROM 'source_invalidated' RETURNING *",
        [call.id, outcome, result, truncated, error],
      )
    ).rows[0];
    if (row)
      await emit(tx, c.run.owner_id, 'tool_call', call.id, callView(row));
  });
  await owned(db, c, async (tx) => {
    await release(
      tx,
      c,
      outcome === 'outcome_unknown' ? 'awaiting_approval' : 'queued',
      outcome === 'outcome_unknown' ? 'tool_outcome_unknown' : null,
      null,
    );
    return true;
  });
}
export async function decide(
  db: pg.Pool,
  owner: string,
  id: string,
  decision: string,
) {
  const initial = (
    await db.query('SELECT * FROM tool_calls WHERE owner_id=$1 AND id=$2', [
      owner,
      id,
    ])
  ).rows[0];
  if (!initial) throw new AppError(404, 'not_found', 'Tool action not found');
  return transaction(db, async (tx) => {
    const run = (
      await tx.query('SELECT * FROM runs WHERE id=$1', [initial.run_id])
    ).rows[0];
    await tx.query(
      'SELECT world_id FROM world_leases WHERE world_id=$1 FOR UPDATE',
      [run.world_id],
    );
    await worldLock(tx, owner, run.world_id);
    const freshRun = (
      await tx.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [run.id])
    ).rows[0];
    const call = (
      await tx.query('SELECT * FROM tool_calls WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    const cancelledReconciliation =
      ['cancelled', 'interrupted'].includes(freshRun.state) &&
      call.state === 'outcome_unknown' &&
      ['confirmed_success', 'confirmed_failure'].includes(decision);
    if (freshRun.state !== 'awaiting_approval' && !cancelledReconciliation)
      throw new AppError(409, 'approval_inactive', 'Run is no longer waiting');
    let state: string;
    if (decision === 'approve') {
      if (call.state !== 'pending')
        throw new AppError(
          409,
          'approval_inactive',
          'Action is not pending approval',
        );
      await authorized(tx, freshRun, call);
      state = 'approved';
    } else if (decision === 'deny') {
      if (call.state !== 'pending')
        throw new AppError(
          409,
          'approval_inactive',
          'Action is not pending approval',
        );
      state = 'denied';
    } else {
      if (call.state !== 'outcome_unknown')
        throw new AppError(
          409,
          'approval_inactive',
          'Action is not awaiting reconciliation',
        );
      state = 'resolved';
    }
    const row = (
      await tx.query(
        "UPDATE tool_calls SET state=$2,result=CASE WHEN $2='resolved' THEN $3 ELSE result END,arguments=CASE WHEN $2='resolved' AND error_code='source_invalidated' THEN '{}'::jsonb ELSE arguments END,decision=$4,decided_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          state,
          JSON.stringify({
            human_reported_outcome:
              decision === 'confirmed_success' ? 'succeeded' : 'failed',
            verified_by_tool: false,
          }),
          decision,
        ],
      )
    ).rows[0];
    if (state === 'resolved' && call.error_code === 'source_invalidated')
      await purgeReplay(tx, owner);
    if (cancelledReconciliation) {
      await emit(tx, owner, 'tool_call', id, callView(row));
      return callView(row);
    }
    const updated = (
      await tx.query(
        'UPDATE runs SET state=$2,error_code=$3,next_attempt_at=now() WHERE id=$1 RETURNING *',
        [
          run.id,
          state === 'denied' ? 'cancelled' : 'queued',
          state === 'denied' ? 'approval_denied' : null,
        ],
      )
    ).rows[0];
    if (state === 'denied') await cancelMessages(tx, owner, run.id);
    else
      await tx.query(
        'INSERT INTO outbox(owner_id,run_id,attempt) VALUES($1,$2,$3) ON CONFLICT(run_id,attempt) DO UPDATE SET dispatched_at=NULL,available_at=now()',
        [owner, run.id, run.attempts],
      );
    await emit(tx, owner, 'tool_call', id, callView(row));
    await emit(tx, owner, 'run', run.id, runView(updated));
    return callView(row);
  });
}
export async function expireApprovals(db: pg.Pool) {
  const rows = (
    await db.query(
      "SELECT id,owner_id,run_id FROM tool_calls WHERE state='pending' AND expires_at<=now() LIMIT 100",
    )
  ).rows;
  for (const c of rows)
    await transaction(db, async (tx) => {
      const run = (
        await tx.query(
          "UPDATE runs SET state='cancelled',error_code='approval_expired' WHERE id=$1 AND state='awaiting_approval' RETURNING *",
          [c.run_id],
        )
      ).rows[0];
      if (!run) return;
      const call = (
        await tx.query(
          "UPDATE tool_calls SET state='expired' WHERE id=$1 AND state='pending' RETURNING *",
          [c.id],
        )
      ).rows[0];
      await cancelMessages(tx, c.owner_id, c.run_id);
      if (call) await emit(tx, c.owner_id, 'tool_call', c.id, callView(call));
      await emit(tx, c.owner_id, 'run', run.id, runView(run));
    });
}

async function cancelMessages(tx: DB, owner: string, run: string) {
  const messages = (
    await tx.query(
      "UPDATE messages SET status='cancelled' WHERE run_id=$1 AND status IN ('accepted','streaming') RETURNING *",
      [run],
    )
  ).rows;
  for (const m of messages)
    if (!m.internal) await emit(tx, owner, 'message', m.id, messageView(m));
}
