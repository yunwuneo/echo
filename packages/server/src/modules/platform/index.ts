import type pg from 'pg';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { canonical } from '../mcp/schema.js';
import { memoryActor } from '../memory/materials.js';
import { matchRevision } from '../worlds/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
const fail = (code = 'system_permission') =>
  new AppError(409, code, 'System permission or action state changed');
export const systemActions = [
  'calendar.query',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'reminders.query',
  'reminders.create',
  'reminders.update',
  'reminders.complete',
  'reminders.delete',
  'contacts.search',
  'contacts.create',
  'health.query',
  'health.write',
  'health.delete',
  'photos.query',
  'location.query',
  'weather.query',
  'battery.query',
  'notifications.create',
  'notifications.delete',
  'timer.create',
  'timer.delete',
  'shortcut.run',
] as const;
export async function platformCommand(
  db: pg.Pool,
  owner: string,
  input: any,
  device?: string,
): Promise<any> {
  const p = input.payload;
  if (input.command === 'platformLibrary')
    return {
      capabilities: (
        await db.query('SELECT * FROM device_capabilities WHERE owner_id=$1', [
          owner,
        ])
      ).rows,
      policies: (
        await db.query('SELECT * FROM system_policies WHERE owner_id=$1', [
          owner,
        ])
      ).rows,
      actions: (
        await db.query(
          'SELECT * FROM system_actions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
      drafts: (
        await db.query(
          "SELECT * FROM share_drafts WHERE owner_id=$1 AND state='draft' ORDER BY created_at",
          [owner],
        )
      ).rows,
    };
  if (input.command === 'todaySummary')
    return {
      sources: (
        await db.query(
          "SELECT *,CASE WHEN updated_at<now()-interval '30 minutes' AND state IN ('available','empty') THEN 'stale' ELSE state END AS state FROM today_sources WHERE owner_id=$1 AND device_id=$2",
          [owner, device],
        )
      ).rows,
    };
  if (input.command === 'collaboratorContent') {
    const a = await memoryActor(db, owner, p.actor_id);
    return {
      nodes: (
        await db.query(
          'SELECT h.id,h.name,h.revoked_at,h.last_seen_at FROM host_nodes h JOIN host_identity_links l ON l.host_id=h.id WHERE l.owner_id=$1 AND l.actor_id=$2 AND l.enabled',
          [owner, a.id],
        )
      ).rows,
      actor_id: a.id,
      documents: (
        await db.query(
          'SELECT d.id,d.title,d.revision FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.owner_id=$1 AND p.actor_id=$2',
          [owner, a.id],
        )
      ).rows,
      media: (
        await db.query(
          'SELECT id,mime,size FROM assets WHERE owner_id=$1 AND actor_id=$2',
          [owner, a.id],
        )
      ).rows,
      apps: (
        await db.query(
          'SELECT id,title,language,run_enabled FROM miniapps WHERE owner_id=$1 AND actor_id=$2',
          [owner, a.id],
        )
      ).rows,
      rooms: (
        await db.query(
          'SELECT r.id,r.name FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE r.owner_id=$1 AND m.actor_id=$2 AND m.left_at IS NULL AND NOT r.deleted',
          [owner, a.id],
        )
      ).rows,
      memory: (
        await db.query(
          'SELECT kind,count(*)::int count FROM memory_materials WHERE owner_id=$1 AND actor_id=$2 GROUP BY kind',
          [owner, a.id],
        )
      ).rows,
    };
  }
  return command(
    db,
    owner,
    'platform.' + input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (
        [
          'reportCapability',
          'reportTodaySource',
          'claimSystemAction',
          'completeSystemAction',
        ].includes(input.command) &&
        !device
      )
        throw fail('device_required');
      if (input.command === 'reportCapability')
        return (
          await tx.query(
            'INSERT INTO device_capabilities(owner_id,device_id,capability,state,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(device_id,capability) DO UPDATE SET state=$4,detail=$5,revision=device_capabilities.revision+1,updated_at=now() RETURNING *',
            [owner, device, p.capability, p.state, JSON.stringify(p.detail)],
          )
        ).rows[0];
      if (input.command === 'reportTodaySource') {
        if (Buffer.byteLength(JSON.stringify(p.data)) > 65536)
          throw fail('source_limit');
        return (
          await tx.query(
            'INSERT INTO today_sources(owner_id,device_id,source,state,data,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,source) DO UPDATE SET state=$4,data=$5,detail=$6,updated_at=now() RETURNING *',
            [
              owner,
              device,
              p.source,
              p.state,
              JSON.stringify(p.data),
              p.detail,
            ],
          )
        ).rows[0];
      }
      if (
        input.command === 'setSystemPolicy' ||
        input.command === 'createSystemAction'
      ) {
        await memoryActor(tx, owner, p.actor_id);
        if (!systemActions.includes(p.action)) throw fail('unsupported_action');
        if (
          !(
            await tx.query(
              'SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL',
              [p.device_id, owner],
            )
          ).rowCount
        )
          throw fail();
        const policy = (
          await tx.query(
            'SELECT * FROM system_policies WHERE actor_id=$1 AND device_id=$2 AND action=$3',
            [p.actor_id, p.device_id, p.action],
          )
        ).rows[0];
        if (input.command === 'setSystemPolicy') {
          matchRevision(policy ?? { revision: 0 }, input.expected_revision);
          return (
            await tx.query(
              'INSERT INTO system_policies(owner_id,actor_id,device_id,action,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(actor_id,device_id,action) DO UPDATE SET enabled=$5,revision=system_policies.revision+1 RETURNING *',
              [owner, p.actor_id, p.device_id, p.action, p.enabled],
            )
          ).rows[0];
        }
        if (!policy?.enabled) throw fail();
        if (Buffer.byteLength(JSON.stringify(p.arguments)) > 16384)
          throw fail('action_limit');
        return (
          await tx.query(
            'INSERT INTO system_actions(owner_id,actor_id,device_id,action,payload,payload_hash,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              owner,
              p.actor_id,
              p.device_id,
              p.action,
              JSON.stringify(p.arguments),
              hash(canonical(p.arguments)),
              policy.revision,
            ],
          )
        ).rows[0];
      }
      if (input.command === 'receiveShareDraft') {
        await memoryActor(tx, owner, p.actor_id);
        if (
          !(
            await tx.query(
              'SELECT 1 FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE r.owner_id=$1 AND r.id=$2 AND m.actor_id=$3 AND m.left_at IS NULL AND NOT r.deleted',
              [owner, p.room_id, p.actor_id],
            )
          ).rowCount
        )
          throw fail('share_target');
        for (const id of p.asset_ids)
          if (
            !(
              await tx.query(
                'SELECT 1 FROM assets a JOIN rooms r ON r.world_id=a.world_id WHERE a.id=$1 AND a.owner_id=$2 AND r.id=$3 AND (a.actor_id IS NULL OR a.actor_id=$4)',
                [id, owner, p.room_id, p.actor_id],
              )
            ).rowCount
          )
            throw fail('share_asset');
        const draft = (
          await tx.query(
            'INSERT INTO share_drafts(owner_id,actor_id,room_id,content,asset_ids) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [owner, p.actor_id, p.room_id, p.content, p.asset_ids],
          )
        ).rows[0];
        for (const id of p.asset_ids)
          await tx.query(
            'INSERT INTO share_draft_assets(draft_id,asset_id) VALUES($1,$2)',
            [draft.id, id],
          );
        return draft;
      }
      if (input.command === 'sendShareDraft') {
        const d = (
          await tx.query(
            'SELECT * FROM share_drafts WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        if (!d || d.state !== 'draft') throw fail('draft_state');
        const ack = await enqueueInTransaction(
          tx,
          owner,
          d.room_id,
          {
            client_command_id: d.id,
            content: d.content || '请查看附件',
            asset_ids: d.asset_ids,
            addressed_actor_ids: [d.actor_id],
          },
          hash(canonical(d)),
        );
        await tx.query(
          "UPDATE share_drafts SET state='sent',run_id=$2 WHERE id=$1",
          [d.id, ack.run_id],
        );
        return ack;
      }
      const a = (
        await tx.query(
          'SELECT * FROM system_actions WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [p.id, owner],
        )
      ).rows[0];
      if (!a) throw fail('not_found');
      matchRevision(a, input.expected_revision);
      if (input.command === 'decideSystemAction') {
        if (a.state !== 'pending') throw fail();
        return (
          await tx.query(
            'UPDATE system_actions SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
            [a.id, p.approve ? 'approved' : 'denied'],
          )
        ).rows[0];
      }
      if (input.command === 'reconcileSystemAction') {
        if (
          !p.confirmed ||
          !p.evidence?.trim() ||
          !['executing', 'unknown'].includes(a.state)
        )
          throw fail('reconciliation_required');
        if (
          p.state === 'completed' &&
          !p.external_id &&
          !a.action.endsWith('.query') &&
          !a.action.endsWith('.search')
        )
          throw fail('external_receipt_required');
        return (
          await tx.query(
            'UPDATE system_actions SET state=$2,external_id=$3,result=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
            [
              a.id,
              p.state,
              p.external_id ?? null,
              JSON.stringify({
                verified_by: 'owner',
                evidence: p.evidence,
                reconciling_device: device ?? null,
                execution_repeated: false,
              }),
            ],
          )
        ).rows[0];
      }
      if (a.device_id !== device) throw fail('device_scope');
      if (input.command === 'claimSystemAction') {
        await memoryActor(tx, owner, a.actor_id);
        if (hash(canonical(a.payload)) !== a.payload_hash)
          throw fail('action_integrity');
        if (
          !(
            await tx.query(
              'SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL',
              [device, owner],
            )
          ).rowCount
        )
          throw fail('device_scope');
        const policy = (
          await tx.query(
            'SELECT * FROM system_policies WHERE actor_id=$1 AND device_id=$2 AND action=$3',
            [a.actor_id, device, a.action],
          )
        ).rows[0];
        const capability = (
          await tx.query(
            'SELECT * FROM device_capabilities WHERE device_id=$1 AND capability=$2',
            [device, a.action.split('.')[0]],
          )
        ).rows[0];
        if (
          a.state !== 'approved' ||
          !policy?.enabled ||
          policy.revision !== a.policy_revision ||
          !['authorized', 'limited'].includes(capability?.state) ||
          Date.now() - new Date(capability.updated_at).getTime() > 300000
        )
          throw fail();
        return (
          await tx.query(
            "UPDATE system_actions SET state='executing',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [a.id],
          )
        ).rows[0];
      }
      if (input.command === 'completeSystemAction') {
        if (Buffer.byteLength(JSON.stringify(p.result)) > 65536)
          throw fail('result_limit');
        if (!['executing', 'unknown'].includes(a.state)) throw fail();
        if (
          p.state === 'completed' &&
          !p.external_id &&
          !a.action.endsWith('.query') &&
          !a.action.endsWith('.search')
        )
          throw fail('external_receipt_required');
        return (
          await tx.query(
            'UPDATE system_actions SET state=$2,external_id=$3,result=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
            [a.id, p.state, p.external_id ?? null, JSON.stringify(p.result)],
          )
        ).rows[0];
      }
      throw fail('unknown_command');
    },
  );
}
