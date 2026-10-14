import { requireScheduledAuthority } from '../schedules/guard.js';
import { settleRelay } from './relay.js';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import { randomUUID, createPublicKey, verify } from 'node:crypto';
import { AppError, token, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';
import { command } from '../commands/index.js';
import { memoryActor } from '../memory/materials.js';
import { matchRevision } from '../worlds/index.js';
const fail = (code = 'host_scope') =>
  new AppError(409, code, 'Host scope, execution authority or receipt changed');
const view = (h: any) => {
  const { token_hash, public_key, ...rest } = h;
  return {
    ...rest,
    key_fingerprint: hash(public_key),
    online:
      !h.revoked_at &&
      Date.now() - new Date(h.last_seen_at ?? 0).getTime() < 60000,
  };
};
export async function pairHost(db: pg.Pool, p: any) {
  const code = (
    await db.query(
      'UPDATE host_pairing_codes SET attempts=attempts+1 WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING *',
      [p.pairing_id],
    )
  ).rows[0];
  if (!code || code.attempts > 5 || hash(p.code) !== code.code_hash)
    throw fail('host_pairing_denied');
  try {
    const key = createPublicKey(p.public_key);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(
        null,
        Buffer.from(
          canonical({ pairing_id: p.pairing_id, code: p.code, name: p.name }),
        ),
        key,
        Buffer.from(p.proof, 'base64'),
      )
    )
      throw Error();
  } catch {
    throw fail('host_identity_invalid');
  }
  const secret = token();
  return transaction(db, async (tx) => {
    const ok = await tx.query(
      'UPDATE host_pairing_codes SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id',
      [code.id],
    );
    if (!ok.rowCount) throw fail('host_pairing_denied');
    if (
      (
        await tx.query(
          'SELECT 1 FROM host_nodes WHERE owner_id=$1 AND public_key=$2',
          [code.owner_id, p.public_key],
        )
      ).rowCount
    )
      throw fail('host_already_paired');
    const h = (
      await tx.query(
        'INSERT INTO host_nodes(owner_id,name,public_key,token_hash) VALUES($1,$2,$3,$4) RETURNING *',
        [code.owner_id, p.name, p.public_key, hash(secret)],
      )
    ).rows[0];
    return { protocolVersion: 1, host_id: h.id, token: secret };
  });
}
export async function hostCommand(
  db: pg.Pool,
  owner: string,
  input: any,
): Promise<any> {
  const p = input.payload;
  if (input.command === 'hostLibrary')
    return {
      hosts: (
        await db.query('SELECT * FROM host_nodes WHERE owner_id=$1', [owner])
      ).rows.map(view),
      links: (
        await db.query('SELECT * FROM host_identity_links WHERE owner_id=$1', [
          owner,
        ])
      ).rows,
      jobs: (
        await db.query(
          'SELECT * FROM host_jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
      delegations: (
        await db.query(
          'SELECT * FROM execution_delegations WHERE owner_id=$1',
          [owner],
        )
      ).rows,
      relay:
        (
          await db.query('SELECT * FROM reply_relays WHERE owner_id=$1', [
            owner,
          ])
        ).rows[0] ?? null,
      plugins: (
        await db.query('SELECT * FROM host_plugins WHERE owner_id=$1', [owner])
      ).rows,
    };
  if (input.command === 'createHostPairing') {
    // Pairing secrets do not enter ordinary operation receipts.
    const secret = token(),
      id = randomUUID();
    await db.query(
      "INSERT INTO host_pairing_codes(id,owner_id,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [id, owner, hash(secret)],
    );
    return { pairing_id: id, code: secret, expires_in: 600 };
  }
  return command(
    db,
    owner,
    'host.' + input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (input.command === 'setHostGrants' || input.command === 'revokeHost') {
        const h = (
          await tx.query(
            'SELECT * FROM host_nodes WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        if (!h) throw fail();
        matchRevision(h, input.expected_revision);
        if (input.command === 'revokeHost') {
          await tx.query(
            "UPDATE host_jobs SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END,error_code='host_revoked' WHERE host_id=$1 AND state IN ('pending','accepted','executing')",
            [h.id],
          );
          await tx.query(
            "UPDATE execution_delegations SET state='pending',epoch=epoch+1,revision=revision+1,lease_until=now(),pending_executor='cloud',pending_host_id=NULL,revocation_ack=true WHERE host_id=$1",
            [h.id],
          );
          await tx.query(
            'UPDATE schedules SET enabled=false,epoch=epoch+1,revision=revision+1 WHERE host_id=$1',
            [h.id],
          );
          return view(
            (
              await tx.query(
                'UPDATE host_nodes SET revoked_at=now(),revision=revision+1 WHERE id=$1 RETURNING *',
                [h.id],
              )
            ).rows[0],
          );
        }
        if (h.revoked_at) throw fail();
        return view(
          (
            await tx.query(
              'UPDATE host_nodes SET grants=$2,revision=revision+1 WHERE id=$1 RETURNING *',
              [h.id, JSON.stringify(p.grants)],
            )
          ).rows[0],
        );
      }
      if (input.command === 'linkHostIdentity') {
        await memoryActor(tx, owner, p.actor_id);
        if (
          !(
            await tx.query(
              'SELECT 1 FROM host_nodes WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL',
              [p.host_id, owner],
            )
          ).rowCount
        )
          throw fail();
        const old = (
          await tx.query(
            'SELECT * FROM host_identity_links WHERE host_id=$1 AND actor_id=$2',
            [p.host_id, p.actor_id],
          )
        ).rows[0];
        matchRevision(old ?? { revision: 0 }, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO host_identity_links(owner_id,host_id,actor_id,remote_identity,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(host_id,actor_id) DO UPDATE SET remote_identity=$4,enabled=$5,revision=host_identity_links.revision+1 RETURNING *',
            [owner, p.host_id, p.actor_id, p.remote_identity, p.enabled],
          )
        ).rows[0];
      }
      if (input.command === 'publishHostSnapshot') {
        const l = await link(tx, owner, p.link_id);
        const rows = (
          await tx.query(
            "SELECT id,kind,title,summary,content,revision,content_hash FROM memory_materials WHERE owner_id=$1 AND actor_id=$2 AND kind IN ('fact','profile') AND id=ANY($3::uuid[]) AND NOT source_missing",
            [owner, l.actor_id, p.material_ids],
          )
        ).rows;
        if (rows.length !== p.material_ids.length) throw fail('snapshot_scope');
        return (
          await tx.query(
            'INSERT INTO host_snapshots(owner_id,link_id,materials,source_hash) VALUES($1,$2,$3,$4) RETURNING *',
            [owner, l.id, JSON.stringify(rows), hash(canonical(rows))],
          )
        ).rows[0];
      }
      if (input.command === 'setReplyRelay') {
        if (p.enabled) await link(tx, owner, p.link_id);
        const old = (
          await tx.query('SELECT * FROM reply_relays WHERE owner_id=$1', [
            owner,
          ])
        ).rows[0];
        matchRevision(old ?? { revision: 0 }, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO reply_relays(owner_id,link_id,enabled) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET link_id=$2,enabled=$3,revision=reply_relays.revision+1 RETURNING *',
            [owner, p.link_id ?? null, p.enabled],
          )
        ).rows[0];
      }
      if (input.command === 'submitHostJob')
        return submitHostJobTx(tx, owner, p, input.operation_id);
      if (input.command === 'reconcileHostJob') {
        const j = (
          await tx.query(
            'SELECT * FROM host_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        if (!j) throw fail();
        matchRevision(j, input.expected_revision);
        if (j.state !== 'unknown' || !p.confirmed || !p.evidence?.trim())
          throw fail('reconciliation_required');
        const body = {
          state: p.state,
          result: p.result,
          evidence: p.evidence,
          verified_by: 'owner',
          execution_repeated: false,
        };
        await settleRelay(tx, j, body);
        await tx.query(
          'INSERT INTO host_receipts(job_id,receipt_id,payload_hash,body) VALUES($1,$2,$3,$4)',
          [
            j.id,
            input.operation_id,
            hash(canonical(body)),
            JSON.stringify(body),
          ],
        );
        return (
          await tx.query(
            'UPDATE host_jobs SET state=$2,result=$3,error_code=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
            [j.id, p.state, JSON.stringify(p.result), 'owner_reconciled'],
          )
        ).rows[0];
      }
      if (input.command === 'cancelHostJob') {
        const j = (
          await tx.query(
            'SELECT * FROM host_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        if (!j) throw fail();
        matchRevision(j, input.expected_revision);
        return (
          await tx.query(
            "UPDATE host_jobs SET state=CASE WHEN state='pending' THEN 'cancelled' WHEN state IN ('accepted','executing') THEN 'unknown' ELSE state END,revision=revision+1,error_code='cancel_requested' WHERE id=$1 RETURNING *",
            [j.id],
          )
        ).rows[0];
      }
      if (input.command === 'configureHostPlugin') {
        const h = (
          await tx.query(
            'SELECT * FROM host_nodes WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL',
            [p.host_id, owner],
          )
        ).rows[0];
        const i = (
          await tx.query(
            "SELECT * FROM extension_installs WHERE id=$1 AND owner_id=$2 AND state='installed'",
            [p.install_id, owner],
          )
        ).rows[0];
        if (!h || !i) throw fail();
        for (const root of p.directories)
          if (!h.grants.roots?.includes(root)) throw fail('plugin_directory');
        for (const origin of p.network)
          if (
            new URL(origin).origin !== origin ||
            !origin.startsWith('https://')
          )
            throw fail('plugin_network');
        if (p.id) {
          const old = (
            await tx.query(
              'SELECT * FROM host_plugins WHERE id=$1 AND owner_id=$2',
              [p.id, owner],
            )
          ).rows[0];
          matchRevision(old, input.expected_revision);
          if (old.host_id !== h.id || old.install_id !== i.id) throw fail();
          return (
            await tx.query(
              'UPDATE host_plugins SET network=$2,directories=$3,budget=$4,enabled=$5,revision=revision+1 WHERE id=$1 RETURNING *',
              [
                old.id,
                JSON.stringify(p.network),
                JSON.stringify(p.directories),
                JSON.stringify(p.budget),
                p.enabled,
              ],
            )
          ).rows[0];
        }
        return (
          await tx.query(
            'INSERT INTO host_plugins(owner_id,host_id,install_id,network,directories,budget,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              owner,
              h.id,
              i.id,
              JSON.stringify(p.network),
              JSON.stringify(p.directories),
              JSON.stringify(p.budget),
              p.enabled,
            ],
          )
        ).rows[0];
      }
      if (['beginHandoff', 'confirmHandoff'].includes(input.command))
        return handoff(tx, owner, input);
      throw fail('unknown_command');
    },
  );
}
async function link(tx: DB, owner: string, id: string) {
  const l = (
    await tx.query(
      'SELECT l.*,h.grants,h.capabilities FROM host_identity_links l JOIN host_nodes h ON h.id=l.host_id WHERE l.id=$1 AND l.owner_id=$2 AND l.enabled AND h.revoked_at IS NULL',
      [id, owner],
    )
  ).rows[0];
  if (!l) throw fail('host_link');
  await memoryActor(tx, owner, l.actor_id);
  return l;
}
export async function submitHostJobTx(
  tx: DB,
  owner: string,
  p: any,
  operation: string,
) {
  const l = await link(tx, owner, p.link_id);
  if (p.schedule_id) await requireScheduledAuthority(tx, owner, l.actor_id);
  if (!l.grants.actions?.includes(p.kind) || !l.capabilities.includes(p.kind))
    throw fail('host_capability');
  if (p.scope.root && !l.grants.roots?.includes(p.scope.root))
    throw fail('host_directory');
  if (
    Buffer.byteLength(JSON.stringify(p.payload)) > 1048576 ||
    !Number.isInteger(p.budget.max_output_tokens) ||
    p.budget.max_output_tokens < 1 ||
    p.budget.max_output_tokens > 8192 ||
    p.budget.tool_limit < 0 ||
    p.budget.tool_limit > 5
  )
    throw fail('host_budget');
  const payload = { ...p.payload, remote_identity: l.remote_identity };
  if (p.kind === 'plugin') {
    const plugin = (
      await tx.query(
        'SELECT * FROM host_plugins WHERE id=$1 AND host_id=$2 AND owner_id=$3 AND enabled',
        [p.payload.plugin_id, l.host_id, owner],
      )
    ).rows[0];
    if (!plugin) throw fail('plugin_permission');
    const install = (
      await tx.query(
        "SELECT * FROM extension_installs WHERE id=$1 AND state='installed'",
        [plugin.install_id],
      )
    ).rows[0];
    if (!install || install.manifest.runtime !== 'python')
      throw fail('plugin_runtime');
    if (
      p.budget.tool_limit > (plugin.budget.tool_limit ?? 0) ||
      p.budget.max_output_tokens > (plugin.budget.max_output_tokens ?? 1)
    )
      throw fail('plugin_budget');
    Object.assign(payload, {
      source: install.resources[install.manifest.entrypoint],
      network: plugin.network,
      directories: plugin.directories,
      plugin_revision: plugin.revision,
    });
  }
  return (
    await tx.query(
      'INSERT INTO host_jobs(owner_id,host_id,link_id,operation_id,kind,scope,payload,payload_hash,budget,epoch,schedule_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        owner,
        l.host_id,
        l.id,
        operation,
        p.kind,
        JSON.stringify(p.scope),
        JSON.stringify(payload),
        hash(canonical({ scope: p.scope, payload, budget: p.budget })),
        JSON.stringify(p.budget),
        p.epoch ?? null,
        p.schedule_id ?? null,
      ],
    )
  ).rows[0];
}
async function handoff(tx: pg.PoolClient, owner: string, input: any) {
  const p = input.payload,
    s = (
      await tx.query(
        'SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [p.schedule_id, owner],
      )
    ).rows[0];
  if (!s) throw fail();
  matchRevision(s, input.expected_revision);
  const d = (
    await tx.query(
      'SELECT * FROM execution_delegations WHERE schedule_id=$1 FOR UPDATE',
      [s.id],
    )
  ).rows[0];
  if (input.command === 'beginHandoff') {
    if (d?.state === 'pending') throw fail('handoff_pending');
    if (
      p.executor === 'host' &&
      !(
        await tx.query(
          'SELECT 1 FROM host_identity_links l JOIN host_nodes h ON h.id=l.host_id WHERE l.actor_id=$1 AND l.host_id=$2 AND l.enabled AND h.revoked_at IS NULL',
          [s.actor_id, p.host_id],
        )
      ).rowCount
    )
      throw fail('host_link');
    await tx.query(
      'UPDATE schedules SET epoch=epoch+1,revision=revision+1,enabled=false WHERE id=$1',
      [s.id],
    );
    return (
      await tx.query(
        "INSERT INTO execution_delegations(schedule_id,owner_id,epoch,host_id,pending_host_id,pending_executor,state,lease_until) VALUES($1,$2,$3,$4,$5,$6,'pending',now()) ON CONFLICT(schedule_id) DO UPDATE SET epoch=$3,pending_host_id=$5,pending_executor=$6,state='pending',revocation_ack=false,revision=execution_delegations.revision+1 RETURNING *",
        [s.id, owner, s.epoch + 1, s.host_id, p.host_id ?? null, p.executor],
      )
    ).rows[0];
  }
  if (!d || d.state !== 'pending') throw fail('handoff_state');
  if (
    (
      await tx.query(
        "SELECT 1 FROM host_jobs WHERE schedule_id=$1 AND state IN ('accepted','executing','unknown') UNION ALL SELECT 1 FROM runs WHERE schedule_id=$1 AND state IN ('queued','running','awaiting_approval','remote_pending')",
        [s.id],
      )
    ).rowCount
  )
    throw fail('reconciliation_required');
  if (d.host_id && !d.revocation_ack) throw fail('revocation_unconfirmed');
  await tx.query(
    "UPDATE host_jobs SET state='cancelled',error_code='epoch_revoked' WHERE schedule_id=$1 AND state='pending'",
    [s.id],
  );
  await tx.query(
    "UPDATE execution_delegations SET host_id=pending_host_id,state='active',lease_until=now()+interval '60 seconds',pending_host_id=NULL,pending_executor=NULL,revision=revision+1 WHERE schedule_id=$1",
    [s.id],
  );
  return (
    await tx.query(
      'UPDATE schedules SET executor=$2,host_id=$3,enabled=$4,revision=revision+1 WHERE id=$1 RETURNING *',
      [s.id, d.pending_executor, d.pending_host_id, p.enabled],
    )
  ).rows[0];
}
export async function hostRPC(
  db: pg.Pool,
  auth: string | undefined,
  p: any,
  signature: string,
): Promise<any> {
  if (
    p.protocolVersion !== 1 ||
    !Number.isFinite(p.timestamp) ||
    Math.abs(Date.now() - p.timestamp) > 300000
  )
    throw fail('host_protocol');
  const h = (
    await db.query(
      'SELECT * FROM host_nodes WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL',
      [p.host_id, hash((auth ?? '').replace(/^Bearer /, ''))],
    )
  ).rows[0];
  if (!h) throw fail('host_auth');
  try {
    if (
      !verify(
        null,
        Buffer.from(canonical(p)),
        createPublicKey(h.public_key),
        Buffer.from(signature, 'base64'),
      )
    )
      throw Error();
  } catch {
    throw fail('host_signature');
  }
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      h.owner_id,
    ]);
    const live = (
      await tx.query(
        'SELECT * FROM host_nodes WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',
        [h.id],
      )
    ).rows[0];
    if (!live) throw fail('host_revoked');
    await tx.query('UPDATE host_nodes SET last_seen_at=now() WHERE id=$1', [
      h.id,
    ]);
    if (p.action === 'poll') {
      const capabilities = Array.isArray(p.payload.capabilities)
        ? p.payload.capabilities.filter((s: any) =>
            [
              'chat',
              'file_read',
              'file_write',
              'file_list',
              'plugin',
              'backup_put',
              'backup_list',
              'backup_delete',
              'mcp',
            ].includes(s),
          )
        : [];
      await tx.query('UPDATE host_nodes SET capabilities=$2 WHERE id=$1', [
        h.id,
        JSON.stringify(capabilities),
      ]);
      const snapshots = (
        await tx.query(
          'SELECT DISTINCT ON(s.link_id) s.* FROM host_snapshots s JOIN host_identity_links l ON l.id=s.link_id WHERE l.host_id=$1 AND l.enabled ORDER BY s.link_id,s.created_at DESC',
          [h.id],
        )
      ).rows;
      for (const snapshot of snapshots) {
        const l = await link(tx, h.owner_id, snapshot.link_id);
        const liveRows = (
          await tx.query(
            "SELECT id,revision FROM memory_materials WHERE actor_id=$1 AND id=ANY($2::uuid[]) AND kind IN ('fact','profile') AND NOT source_missing",
            [l.actor_id, snapshot.materials.map((m: any) => m.id)],
          )
        ).rows;
        snapshot.valid = snapshot.materials.every((m: any) =>
          liveRows.some((r: any) => r.id === m.id && r.revision === m.revision),
        );
        if (!snapshot.valid) snapshot.materials = [];
      }
      return {
        snapshots,
        jobs: (
          await tx.query(
            "SELECT j.*,l.remote_identity FROM host_jobs j JOIN host_identity_links l ON l.id=j.link_id WHERE j.host_id=$1 AND j.state IN ('pending','accepted','executing','unknown') ORDER BY j.created_at LIMIT 20",
            [h.id],
          )
        ).rows,
        revocations: (
          await tx.query(
            "SELECT schedule_id,epoch FROM execution_delegations WHERE host_id=$1 AND state='pending'",
            [h.id],
          )
        ).rows,
      };
    }
    if (p.action === 'ackRevoke') {
      if (
        (
          await tx.query(
            "SELECT 1 FROM host_jobs WHERE host_id=$1 AND schedule_id=$2 AND state IN ('accepted','executing','unknown')",
            [h.id, p.payload.schedule_id],
          )
        ).rowCount
      )
        throw fail('reconciliation_required');
      const r = await tx.query(
        "UPDATE execution_delegations SET revocation_ack=true WHERE host_id=$1 AND schedule_id=$2 AND epoch=$3 AND state='pending' RETURNING *",
        [h.id, p.payload.schedule_id, p.payload.epoch],
      );
      if (!r.rowCount) throw fail('epoch_invalid');
      return r.rows[0];
    }
    if (p.action === 'lease') {
      const r = await tx.query(
        "UPDATE execution_delegations SET lease_until=now()+interval '60 seconds' WHERE host_id=$1 AND schedule_id=$2 AND epoch=$3 AND state='active' AND EXISTS(SELECT 1 FROM schedules s WHERE s.id=execution_delegations.schedule_id AND s.epoch=execution_delegations.epoch AND s.executor='host' AND s.host_id=execution_delegations.host_id) RETURNING *",
        [h.id, p.payload.schedule_id, p.payload.epoch],
      );
      if (!r.rowCount) throw fail('epoch_invalid');
      return r.rows[0];
    }
    const j = (
      await tx.query(
        'SELECT * FROM host_jobs WHERE id=$1 AND host_id=$2 FOR UPDATE',
        [p.payload.job_id, h.id],
      )
    ).rows[0];
    if (!j) throw fail('job_scope');
    if (p.action === 'query') return j;
    if (p.action === 'accept' || p.action === 'begin') {
      if (
        hash(
          canonical({ scope: j.scope, payload: j.payload, budget: j.budget }),
        ) !== j.payload_hash
      )
        throw fail('job_integrity');
      if (
        ['completed', 'rejected', 'failed', 'cancelled', 'unknown'].includes(
          j.state,
        )
      )
        return j;
      if (!live.grants.actions?.includes(j.kind))
        throw fail('host_permission_revoked');
      const l = await link(tx, h.owner_id, j.link_id);
      if (j.schedule_id)
        await requireScheduledAuthority(tx, h.owner_id, l.actor_id);
      if (l.remote_identity !== j.payload.remote_identity)
        throw fail('host_identity_changed');
      if (j.scope.root && !live.grants.roots?.includes(j.scope.root))
        throw fail('host_directory');
      if (
        j.schedule_id &&
        !(
          await tx.query(
            "SELECT 1 FROM execution_delegations WHERE schedule_id=$1 AND host_id=$2 AND epoch=$3 AND state='active' AND lease_until>now() AND EXISTS(SELECT 1 FROM schedules s WHERE s.id=execution_delegations.schedule_id AND s.epoch=execution_delegations.epoch AND s.executor='host' AND s.host_id=execution_delegations.host_id)",
            [j.schedule_id, h.id, j.epoch],
          )
        ).rowCount
      )
        throw fail('epoch_invalid');
      if (
        j.scope.backup_plan_id &&
        !(
          await tx.query(
            'SELECT 1 FROM remote_backup_plans WHERE id=$1 AND revision=$2',
            [j.scope.backup_plan_id, j.scope.backup_plan_revision],
          )
        ).rowCount
      )
        throw fail('backup_plan_changed');
      if (j.execution_id && j.execution_id !== p.payload.execution_id)
        throw fail('execution_identity');
      if (p.action === 'begin' && j.state === 'executing')
        return { ...j, started_now: false };
      if (j.kind === 'plugin') {
        const plugin = (
          await tx.query(
            'SELECT * FROM host_plugins WHERE id=$1 AND host_id=$2 AND enabled',
            [j.payload.plugin_id, h.id],
          )
        ).rows[0];
        if (!plugin || plugin.revision !== j.payload.plugin_revision)
          throw fail('plugin_permission');
      }
      if (p.action === 'begin' && j.state === 'pending')
        throw fail('job_not_accepted');
      const changed = (
        await tx.query(
          "UPDATE host_jobs SET state=CASE WHEN $3='begin' THEN 'executing' WHEN state='pending' THEN 'accepted' ELSE state END,execution_id=$2,accepted_at=COALESCE(accepted_at,now()),updated_at=now(),revision=revision+1 WHERE id=$1 RETURNING *",
          [j.id, p.payload.execution_id, p.action],
        )
      ).rows[0];
      return { ...changed, started_now: p.action === 'begin' };
    }
    if (p.action === 'receipt') {
      const b = p.payload;
      if (
        !['completed', 'failed', 'unknown', 'rejected'].includes(b.state) ||
        Buffer.byteLength(JSON.stringify(b.result)) > 2097152
      )
        throw fail('receipt_invalid');
      if (j.execution_id && j.execution_id !== b.execution_id)
        throw fail('execution_identity');
      const digest = hash(canonical(b)),
        previous = (
          await tx.query(
            'SELECT * FROM host_receipts WHERE job_id=$1 AND receipt_id=$2',
            [j.id, b.receipt_id],
          )
        ).rows[0];
      if (previous) {
        if (previous.payload_hash !== digest) throw fail('receipt_conflict');
        return j;
      }
      if (['completed', 'failed', 'rejected'].includes(j.state))
        throw fail('receipt_terminal');
      if (
        b.state === 'rejected' &&
        (j.state !== 'pending' ||
          !b.not_accepted ||
          !['unsupported_route', 'unsupported_capability'].includes(
            b.error_code,
          ))
      )
        throw fail('fallback_unsafe');
      if (
        b.state === 'completed' &&
        !['accepted', 'executing', 'unknown'].includes(j.state)
      )
        throw fail('job_not_accepted');
      await tx.query(
        'INSERT INTO host_receipts(job_id,receipt_id,payload_hash,body) VALUES($1,$2,$3,$4)',
        [j.id, b.receipt_id, digest, JSON.stringify(b)],
      );
      await settleRelay(tx, j, b);
      return (
        await tx.query(
          'UPDATE host_jobs SET state=$2,result=$3,error_code=$4,updated_at=now(),revision=revision+1 WHERE id=$1 RETURNING *',
          [j.id, b.state, JSON.stringify(b.result), b.error_code ?? null],
        )
      ).rows[0];
    }
    throw fail('host_protocol');
  });
}
