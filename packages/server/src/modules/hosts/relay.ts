import type { DB } from '../../db/index.js';
import { AppError } from '../../security.js';
import { submitHostJobTx } from './index.js';
import { emit, messageView, runView } from '../sync/index.js';
export async function relayRun(
  tx: DB,
  owner: string,
  run: string,
  room: any,
  actorIDs: string[],
  input: any,
) {
  const relay = (
    await tx.query(
      'SELECT r.*,l.actor_id FROM reply_relays r JOIN host_identity_links l ON l.id=r.link_id WHERE r.owner_id=$1 AND r.enabled',
      [owner],
    )
  ).rows[0];
  if (!relay) return;
  if (
    room.kind !== 'direct' ||
    actorIDs.length !== 1 ||
    actorIDs[0] !== relay.actor_id ||
    input.asset_ids?.length
  )
    throw new AppError(
      409,
      'relay_route_unsupported',
      'Choose the linked ordinary text conversation or explicitly disable relay',
    );
  const job = await submitHostJobTx(
    tx,
    owner,
    {
      link_id: relay.link_id,
      kind: 'chat',
      scope: { room_id: room.id },
      payload: { content: input.content },
      budget: { max_output_tokens: 2048, tool_limit: 4 },
    },
    run,
  );
  await tx.query('UPDATE host_jobs SET relay_run_id=$2 WHERE id=$1', [
    job.id,
    run,
  ]);
  await tx.query('DELETE FROM outbox WHERE run_id=$1', [run]);
  await tx.query("UPDATE runs SET state='remote_pending' WHERE id=$1", [run]);
}
export async function settleRelay(tx: DB, j: any, receipt: any) {
  if (!j.relay_run_id) return;
  const run = (
    await tx.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [
      j.relay_run_id,
    ])
  ).rows[0];
  if (!run || run.state !== 'remote_pending') return;
  if (
    receipt.state === 'rejected' &&
    receipt.not_accepted &&
    ['unsupported_route', 'unsupported_capability'].includes(receipt.error_code)
  ) {
    const r = (
      await tx.query(
        "UPDATE runs SET state='queued',error_code=NULL WHERE id=$1 RETURNING *",
        [run.id],
      )
    ).rows[0];
    await tx.query(
      'INSERT INTO outbox(owner_id,run_id,attempt) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
      [run.owner_id, run.id],
    );
    await emit(tx, run.owner_id, 'run', run.id, runView(r));
    return;
  }
  if (receipt.state === 'unknown') return;
  if (receipt.state === 'completed') {
    const room = (
      await tx.query('SELECT * FROM rooms WHERE id=$1 AND NOT deleted', [
        run.room_id,
      ])
    ).rows[0];
    const link = (
      await tx.query(
        'SELECT * FROM host_identity_links WHERE id=$1 AND enabled',
        [j.link_id],
      )
    ).rows[0];
    if (
      !room ||
      !link ||
      !(
        await tx.query(
          'SELECT 1 FROM room_memberships WHERE room_id=$1 AND actor_id=$2 AND left_at IS NULL',
          [room.id, link.actor_id],
        )
      ).rowCount
    )
      throw new AppError(
        409,
        'relay_scope_changed',
        'Remote receipt retained for reconciliation; conversation scope changed',
      );
    const messages = receipt.result?.messages;
    if (
      !Array.isArray(messages) ||
      messages.length !== 1 ||
      typeof messages[0].content !== 'string' ||
      !messages[0].content ||
      Buffer.byteLength(messages[0].content) > 65536
    )
      throw new AppError(
        409,
        'host_result_invalid',
        'Expected one actual completed Host reply',
      );
    const seq = (
      await tx.query(
        'UPDATE rooms SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence',
        [room.id],
      )
    ).rows[0].next_sequence;
    const actor = (
      await tx.query('SELECT name FROM world_characters WHERE id=$1', [
        link.actor_id,
      ])
    ).rows[0];
    const m = (
      await tx.query(
        "INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,actor_id,actor_name,content,status,external_origin) VALUES($1,$2,$3,$4,$5,'assistant',$6,$7,$8,'completed',$9) RETURNING *",
        [
          run.reply_message_id,
          run.owner_id,
          room.id,
          run.id,
          seq,
          link.actor_id,
          actor.name,
          messages[0].content,
          JSON.stringify({
            host_id: j.host_id,
            job_id: j.id,
            execution_id: j.execution_id,
          }),
        ],
      )
    ).rows[0];
    await tx.query(
      'INSERT INTO message_audiences(message_id,actor_id) VALUES($1,$2)',
      [m.id, link.actor_id],
    );
    await emit(tx, run.owner_id, 'message', m.id, messageView(m));
  }
  const state = receipt.state === 'completed' ? 'completed' : 'failed';
  const r = (
    await tx.query(
      'UPDATE runs SET state=$2,error_code=$3 WHERE id=$1 RETURNING *',
      [run.id, state, receipt.error_code ?? null],
    )
  ).rows[0];
  const u = (
    await tx.query('UPDATE messages SET status=$2 WHERE id=$1 RETURNING *', [
      run.user_message_id,
      state,
    ])
  ).rows[0];
  await emit(tx, run.owner_id, 'message', u.id, messageView(u));
  await emit(tx, run.owner_id, 'run', run.id, runView(r));
}
