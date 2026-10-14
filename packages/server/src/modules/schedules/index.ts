import { submitHostJobTx } from '../hosts/index.js';
import type pg from 'pg';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { transaction, type DB } from '../../db/index.js';
import { AppError, hash, token, encrypt, decrypt } from '../../security.js';
import type { Config } from '../../config.js';
import { command } from '../commands/index.js';
import { canonical } from '../mcp/schema.js';
import { memoryActor } from '../memory/materials.js';
import { matchRevision } from '../worlds/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { policies, backgroundAllowed } from '../autonomy/policy.js';
import { emit, messageView, runView } from '../sync/index.js';
import { dueSlot, firstTime } from './time.js';
const fail = (code = 'schedule_state') =>
  new AppError(409, code, 'Schedule or event authorization changed');
async function target(tx: DB, owner: string, actor: string, room?: string) {
  const r = (
    await tx.query(
      "SELECT r.* FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE r.owner_id=$1 AND m.actor_id=$2 AND m.left_at IS NULL AND NOT r.deleted AND r.parent_group_id IS NULL AND ($3::uuid IS NULL AND r.kind='direct' OR r.id=$3) ORDER BY (SELECT max(created_at) FROM messages WHERE room_id=r.id) DESC NULLS LAST,r.id LIMIT 1",
      [owner, actor, room ?? null],
    )
  ).rows[0];
  if (!r) throw fail('schedule_target');
  return r;
}
export async function scheduleCommand(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
  device?: string,
): Promise<any> {
  const p = input.payload;
  if (input.command === 'scheduleLibrary')
    return {
      schedules: (
        await db.query(
          'SELECT * FROM schedules WHERE owner_id=$1 ORDER BY created_at',
          [owner],
        )
      ).rows,
      occurrences: (
        await db.query(
          'SELECT o.* FROM schedule_occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE s.owner_id=$1 ORDER BY o.created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
      triggers: (
        await db.query(
          'SELECT id,actor_id,room_id,name,mode,service,node_id,enabled,state,external_id,revision FROM event_triggers WHERE owner_id=$1',
          [owner],
        )
      ).rows,
    };
  return command(
    db,
    owner,
    'schedule.' + input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (input.command === 'saveSchedule') {
        await memoryActor(tx, owner, p.actor_id);
        await target(tx, owner, p.actor_id, p.room_id);
        if (p.executor === 'device' && p.device_id !== device)
          throw fail('device_scope');
        if (p.executor === 'host') throw fail('use_explicit_handoff');
        const next = firstTime(p);
        if (p.id) {
          const s = (
            await tx.query(
              'SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [p.id, owner],
            )
          ).rows[0];
          matchRevision(s, input.expected_revision);
          if (s.executor === 'host') throw fail('handoff_required');
          return (
            await tx.query(
              'UPDATE schedules SET actor_id=$3,room_id=$4,name=$5,prompt=$6,rule=$7,timezone=$8,at=$9,interval_seconds=$10,enabled=$11,catch_up=$12,executor=$13,device_id=$14,tool_limit=$15,next_at=$16,revision=revision+1,epoch=epoch+1 WHERE id=$1 AND owner_id=$2 RETURNING *',
              [
                p.id,
                owner,
                p.actor_id,
                p.room_id ?? null,
                p.name,
                p.prompt,
                p.rule,
                p.timezone,
                p.at,
                p.interval_seconds,
                p.enabled,
                p.catch_up,
                p.executor,
                p.device_id ?? null,
                p.tool_limit,
                next,
              ],
            )
          ).rows[0];
        }
        return (
          await tx.query(
            'INSERT INTO schedules(owner_id,actor_id,room_id,name,prompt,rule,timezone,at,interval_seconds,enabled,catch_up,executor,device_id,tool_limit,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
            [
              owner,
              p.actor_id,
              p.room_id ?? null,
              p.name,
              p.prompt,
              p.rule,
              p.timezone,
              p.at,
              p.interval_seconds,
              p.enabled,
              p.catch_up,
              p.executor,
              p.device_id ?? null,
              p.tool_limit,
              next,
            ],
          )
        ).rows[0];
      }
      if (input.command === 'registerTrigger') {
        await memoryActor(tx, owner, p.actor_id);
        await target(tx, owner, p.actor_id, p.room_id);
        if (!p.service.trim() || !p.node_id.trim())
          throw fail('event_identity');
        const id = randomUUID(),
          secret = token();
        await tx.query(
          "INSERT INTO event_triggers(id,owner_id,actor_id,room_id,name,mode,service,node_id,secret,enabled,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'registered')",
          [
            id,
            owner,
            p.actor_id,
            p.room_id,
            p.name,
            p.mode,
            p.service,
            p.node_id,
            encrypt(secret, config, owner + ':event:' + id),
            p.enabled,
          ],
        );
        // Secret is returned once to the owner; the ordinary command receipt contains only its reference.
        return { id, registration_required: true, revision: 1 };
      }
      if (
        input.command === 'revokeTrigger' ||
        input.command === 'registrationReceipt'
      ) {
        const t = (
          await tx.query(
            'SELECT * FROM event_triggers WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        matchRevision(t, input.expected_revision);
        if (input.command === 'revokeTrigger')
          return (
            await tx.query(
              "UPDATE event_triggers SET enabled=false,state='revoke_pending',revision=revision+1 WHERE id=$1 RETURNING id,state,revision",
              [t.id],
            )
          ).rows[0];
        if (
          t.state === 'revoke_pending' &&
          !['revoked', 'revoke_pending'].includes(p.state)
        )
          throw fail('revocation_pending');
        return (
          await tx.query(
            "UPDATE event_triggers SET state=$2,external_id=COALESCE($3,external_id),enabled=enabled AND $2='active',revision=revision+1 WHERE id=$1 RETURNING id,state,revision",
            [t.id, p.state, p.external_id ?? null],
          )
        ).rows[0];
      }
      const s = (
        await tx.query(
          'SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [p.id, owner],
        )
      ).rows[0];
      if (!s) throw fail();
      if (input.command === 'reportScheduleNotification') {
        if (s.executor !== 'device' || s.device_id !== device)
          throw fail('device_scope');
        matchRevision(s, input.expected_revision);
        return (
          await tx.query(
            'UPDATE schedules SET notification_state=$2,notification_id=$3 WHERE id=$1 RETURNING id,notification_state',
            [s.id, p.state, p.notification_id ?? null],
          )
        ).rows[0];
      }
      if (input.command === 'pauseSchedule') {
        matchRevision(s, input.expected_revision);
        return (
          await tx.query(
            'UPDATE schedules SET enabled=false,revision=revision+1,epoch=epoch+1 WHERE id=$1 RETURNING *',
            [s.id],
          )
        ).rows[0];
      }
      if (input.command === 'runOccurrence') {
        if (s.executor === 'device' && s.device_id !== device)
          throw fail('device_scope');
        if (s.executor === 'host') throw fail('execution_owner');
        const o = (
          await tx.query(
            'SELECT * FROM schedule_occurrences WHERE schedule_id=$1 AND slot=$2 FOR UPDATE',
            [s.id, p.slot],
          )
        ).rows[0];
        if (!o || (o.state === 'missed' && !p.allow_missed))
          throw fail('occurrence_missing');
        if (o.run_id) return o;
        if (!['pending', 'missed'].includes(o.state) || o.epoch !== s.epoch)
          throw fail();
        return start(tx, owner, s, o);
      }
      throw fail('unknown_command');
    },
  );
}
async function start(tx: pg.PoolClient, owner: string, s: any, o: any) {
  const room = await target(tx, owner, s.actor_id, s.room_id);
  const { g, p } = await policies(tx, owner, room.world_id, true);
  if (!backgroundAllowed(g, p, 'contact')) throw fail('autonomy_disabled');
  const ack = await enqueueInTransaction(
    tx,
    owner,
    room.id,
    {
      client_command_id: o.id,
      content: s.prompt,
      addressed_actor_ids: [s.actor_id],
    },
    hash(canonical({ schedule: s.id, slot: o.slot, prompt: s.prompt })),
    {
      kind: 'contact',
      globalRevision: g.revision,
      policyRevision: p.revision,
      maxTurns: 1,
    },
  );
  await tx.query(
    'UPDATE runs SET tool_limit=$2,schedule_id=$3,schedule_revision=$4,schedule_epoch=$5 WHERE id=$1',
    [ack.run_id, s.tool_limit, s.id, s.revision, s.epoch],
  );
  return (
    await tx.query(
      "UPDATE schedule_occurrences SET state='started',run_id=$2 WHERE id=$1 RETURNING *",
      [o.id, ack.run_id],
    )
  ).rows[0];
}
export async function tickSchedules(db: pg.Pool, now = new Date()) {
  const due = (
    await db.query(
      'SELECT id,owner_id FROM schedules WHERE enabled AND next_at<=$1 ORDER BY next_at LIMIT 20',
      [now],
    )
  ).rows;
  for (const item of due)
    await transaction(db, async (tx) => {
      await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
        item.owner_id,
      ]);
      const s = (
        await tx.query('SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [
          item.id,
        ])
      ).rows[0];
      if (!s.enabled) return;
      const slot = dueSlot(s, now.getTime());
      if (!slot) return;
      await tx.query(
        "UPDATE schedules SET next_at=$2,enabled=CASE WHEN rule='once' THEN false ELSE enabled END WHERE id=$1",
        [s.id, new Date(slot.next)],
      );
      const o = (
        await tx.query(
          'INSERT INTO schedule_occurrences(schedule_id,slot,scheduled_at,state,executor,epoch) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *',
          [
            s.id,
            slot.slot,
            new Date(slot.at),
            slot.missed ? 'missed' : 'pending',
            s.executor,
            s.epoch,
          ],
        )
      ).rows[0];
      if (!o || slot.missed || s.executor === 'device') return;
      await tx.query('SAVEPOINT trigger_run');
      try {
        if (s.executor === 'host') {
          const l = (
            await tx.query(
              'SELECT id FROM host_identity_links WHERE host_id=$1 AND actor_id=$2 AND enabled',
              [s.host_id, s.actor_id],
            )
          ).rows[0];
          if (!l) throw fail('host_link');
          const j = await submitHostJobTx(
            tx,
            s.owner_id,
            {
              link_id: l.id,
              kind: 'chat',
              scope: { schedule_id: s.id },
              payload: { content: s.prompt },
              budget: { max_output_tokens: 2048, tool_limit: s.tool_limit },
              epoch: s.epoch,
              schedule_id: s.id,
            },
            o.id,
          );
          await tx.query(
            "UPDATE schedule_occurrences SET state='started',host_job_id=$2 WHERE id=$1",
            [o.id, j.id],
          );
        } else await start(tx, s.owner_id, s, o);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT trigger_run');
        await tx.query('UPDATE schedule_occurrences SET state=$2 WHERE id=$1', [
          o.id,
          e instanceof AppError ? 'blocked' : 'failed',
        ]);
      }
    });
  await db.query(
    "UPDATE schedule_occurrences o SET state=j.state FROM host_jobs j WHERE j.id=o.host_job_id AND j.state IN ('completed','failed','cancelled','unknown','rejected') AND o.state='started'",
  );
  await db.query(
    "UPDATE schedule_occurrences o SET state=r.state FROM runs r WHERE r.id=o.run_id AND r.state IN ('completed','failed','cancelled','interrupted') AND o.state='started'",
  );
}
export async function revealTriggerSecret(
  db: DB,
  config: Config,
  owner: string,
  id: string,
) {
  const t = (
    await db.query(
      "SELECT * FROM event_triggers WHERE id=$1 AND owner_id=$2 AND state NOT IN ('revoked','revoke_pending','failed')",
      [id, owner],
    )
  ).rows[0];
  if (!t) throw fail();
  return {
    secret: decrypt(t.secret, config, owner + ':event:' + id),
    trigger_id: id,
  };
}
export async function receiveEvent(
  db: pg.Pool,
  config: Config,
  id: string,
  body: any,
  signature: string,
) {
  if (
    !body ||
    typeof body.event_id !== 'string' ||
    body.event_id.length > 200 ||
    typeof body.content !== 'string' ||
    body.content.length > 16000 ||
    !Number.isFinite(body.timestamp) ||
    Math.abs(Date.now() - body.timestamp) > 300000
  )
    throw fail('event_expired');
  const t = (await db.query('SELECT * FROM event_triggers WHERE id=$1', [id]))
    .rows[0];
  if (
    !t ||
    !t.enabled ||
    t.state !== 'active' ||
    body.service !== t.service ||
    body.node_id !== t.node_id
  )
    throw fail('event_identity');
  const expected = createHmac(
    'sha256',
    decrypt(t.secret, config, t.owner_id + ':event:' + id),
  )
    .update(canonical(body))
    .digest();
  const sig = Buffer.from(signature, 'hex');
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected))
    throw fail('event_signature');
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      t.owner_id,
    ]);
    const current = (
      await tx.query('SELECT * FROM event_triggers WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (
      !current.enabled ||
      current.state !== 'active' ||
      current.revision !== t.revision
    )
      throw fail('event_revoked');
    const digest = hash(canonical(body)),
      prior = (
        await tx.query(
          'SELECT * FROM received_events WHERE trigger_id=$1 AND event_id=$2',
          [id, body.event_id],
        )
      ).rows[0];
    if (prior) {
      if (prior.payload_hash !== digest) throw fail('event_replay_conflict');
      return prior;
    }
    const room = await target(tx, t.owner_id, t.actor_id, t.room_id);
    const { g, p } = await policies(tx, t.owner_id, room.world_id, true);
    if (t.mode === 'background' && !backgroundAllowed(g, p, 'contact'))
      throw fail('autonomy_disabled');
    const ack = await enqueueInTransaction(
      tx,
      t.owner_id,
      t.room_id,
      {
        client_command_id: randomUUID(),
        content: body.content,
        addressed_actor_ids: [t.actor_id],
      },
      digest,
      t.mode === 'background'
        ? {
            kind: 'contact',
            globalRevision: g.revision,
            policyRevision: p.revision,
            maxTurns: 1,
          }
        : undefined,
      {
        skipRelay: true,
        ...(t.mode === 'trusted_assistant'
          ? {
              trustedOrigin: {
                service: t.service,
                node_id: t.node_id,
                event_id: body.event_id,
              },
            }
          : {}),
      },
    );
    await tx.query('UPDATE runs SET tool_limit=5 WHERE id=$1', [ack.run_id]);
    return (
      await tx.query(
        'INSERT INTO received_events(trigger_id,event_id,payload_hash,run_id,message_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [id, body.event_id, digest, ack.run_id, ack.message_id],
      )
    ).rows[0];
  });
}
