import { enqueueInTransaction } from '../runs/repository.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { canonical } from '../mcp/schema.js';
import { resolveMcp } from '../mcp/transport.js';
import { connectionView } from '../mcp/connections.js';
import { matchRevision } from '../worlds/index.js';
import { memoryActor } from '../memory/materials.js';
const error = (message: string) =>
  new AppError(400, 'invalid_manifest', message);
export function validateManifest(
  manifest: any,
  resources: Record<string, string>,
) {
  const keys = [
    'schemaVersion',
    'id',
    'version',
    'entrypoint',
    'resourceHashes',
    'requiredCapabilities',
    'runtime',
    'name',
    'description',
    'url',
  ];
  if (
    !manifest ||
    Object.keys(manifest).some((k) => !keys.includes(k)) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    typeof manifest.name !== 'string' ||
    typeof manifest.description !== 'string' ||
    !['instructions', 'web', 'python', 'card'].includes(manifest.runtime) ||
    !Array.isArray(manifest.requiredCapabilities) ||
    manifest.requiredCapabilities.some((c: any) => typeof c !== 'string') ||
    !manifest.resourceHashes ||
    typeof manifest.resourceHashes !== 'object'
  )
    throw error('Unsupported package manifest');
  if (
    Object.keys(resources).length > 128 ||
    Object.keys(resources).length !==
      Object.keys(manifest.resourceHashes).length
  )
    throw error('Resource inventory mismatch');
  let size = 0;
  for (const [path, body] of Object.entries(resources)) {
    if (
      !/^[A-Za-z0-9_.\/-]{1,200}$/.test(path) ||
      path.startsWith('/') ||
      path.split('/').some((p) => p === '..' || p === '.' || !p) ||
      typeof body !== 'string'
    )
      throw error('Unsafe resource path');
    size += Buffer.byteLength(body);
    if (size > 1048576 || hash(body) !== manifest.resourceHashes[path])
      throw error('Resource hash or size mismatch');
  }
  if (manifest.runtime === 'web') {
    let u: URL;
    try {
      u = new URL(manifest.url);
    } catch {
      throw error('Web app URL required');
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw error('HTTPS origin required');
  } else if (
    typeof manifest.entrypoint !== 'string' ||
    !(manifest.entrypoint in resources)
  )
    throw error('Entrypoint missing');
  return { manifest, resources };
}
async function connections(db: DB, owner: string) {
  return (
    await db.query(
      "SELECT * FROM mcp_connections WHERE owner_id=$1 AND runtime='remote' ORDER BY id",
      [owner],
    )
  ).rows;
}
const token = (rows: any[], data: any) =>
  hash(
    canonical({
      rows: rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        handle: r.handle,
      })),
      data,
    }),
  );
async function validateConnections(data: any[]) {
  if (
    !Array.isArray(data) ||
    data.length > 100 ||
    new Set(data.map((c) => c.handle)).size !== data.length
  )
    throw error('Invalid connection inventory');
  for (const c of data) {
    if (
      Object.keys(c).some(
        (k) =>
          ![
            'handle',
            'name',
            'url',
            'transport',
            'private_addresses',
            'enabled',
          ].includes(k),
      ) ||
      typeof c.handle !== 'string' ||
      !c.handle ||
      c.handle.length > 100 ||
      typeof c.name !== 'string' ||
      !c.name ||
      typeof c.enabled !== 'boolean' ||
      !['sse', 'streamable_http'].includes(c.transport) ||
      !Array.isArray(c.private_addresses) ||
      c.private_addresses.some((p: any) => typeof p !== 'string')
    )
      throw error('Invalid connection');
    const endpoint = await resolveMcp(c.url, c.private_addresses);
    if (endpoint.url.search) throw error('Credentials in query forbidden');
  }
}
export async function extensionCommand(
  db: pg.Pool,
  owner: string,
  input: any,
): Promise<any> {
  const p = input.payload;
  if (input.command === 'extensionLibrary')
    return {
      jobs: (
        await db.query(
          'SELECT * FROM extension_install_jobs WHERE owner_id=$1',
          [owner],
        )
      ).rows,
      installs: (
        await db.query(
          'SELECT * FROM extension_installs WHERE owner_id=$1 ORDER BY created_at',
          [owner],
        )
      ).rows,
      bindings: (
        await db.query('SELECT * FROM skill_bindings WHERE owner_id=$1', [
          owner,
        ])
      ).rows,
    };
  if (
    ['previewConnectionImport', 'applyConnectionImport'].includes(input.command)
  ) {
    await validateConnections(p.connections);
    if (input.command === 'previewConnectionImport') {
      const rows = await connections(db, owner);
      return {
        preview_token: token(rows, p.connections),
        remove: rows
          .filter((r) => !p.connections.some((c: any) => c.handle === r.handle))
          .map((r) => ({ id: r.id, name: r.name })),
        adopt: rows
          .filter((r) => p.connections.some((c: any) => c.handle === r.handle))
          .map((r) => r.id),
        create: p.connections
          .filter((c: any) => !rows.some((r) => r.handle === c.handle))
          .map((c: any) => c.handle),
      };
    }
  }
  if (
    ['previewExtension', 'installExtension'].includes(input.command) &&
    p.new_connections
  )
    await validateConnections(p.new_connections);
  if (input.command === 'previewExtension') {
    validateManifest(p.manifest, p.resources);
    return {
      preview_token: hash(canonical(p)),
      source: p.manifest.id,
      runtime: p.manifest.runtime,
      permissions: p.manifest.requiredCapabilities,
      adopted_connections: p.connection_ids,
      owned_connections: p.new_connections ?? [],
    };
  }
  return command(
    db,
    owner,
    input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (input.command === 'applyConnectionImport') {
        const rows = await connections(tx, owner);
        if (token(rows, p.connections) !== p.preview_token)
          throw new AppError(
            409,
            'revision_conflict',
            'Connection library changed',
          );
        const result = [];
        for (const c of p.connections) {
          const old = rows.find((r) => r.handle === c.handle);
          let row;
          if (old) {
            const changed =
              old.url !== c.url ||
              old.transport !== c.transport ||
              canonical(old.private_addresses) !==
                canonical(c.private_addresses);
            row = (
              await tx.query(
                "UPDATE mcp_connections SET name=$2,url=$3,transport=$4,private_addresses=$5,enabled=$6,revision=revision+1,credential=CASE WHEN $7 THEN NULL ELSE credential END,auth_type=CASE WHEN $7 THEN 'none' ELSE auth_type END,tools=CASE WHEN $7 THEN '[]'::jsonb ELSE tools END,discovered_at=CASE WHEN $7 THEN NULL ELSE discovered_at END WHERE id=$1 RETURNING *",
                [
                  old.id,
                  c.name,
                  c.url,
                  c.transport,
                  c.private_addresses,
                  c.enabled && !changed,
                  changed,
                ],
              )
            ).rows[0];
            if (changed)
              await tx.query(
                'UPDATE tool_grants SET enabled=false,revision=revision+1 WHERE connection_id=$1',
                [old.id],
              );
          } else
            row = (
              await tx.query(
                "INSERT INTO mcp_connections(id,owner_id,handle,name,url,transport,private_addresses,enabled,auth_type,header_name) VALUES($8,$1,$2,$3,$4,$5,$6,$7,'none','X-Api-Key') RETURNING *",
                [
                  owner,
                  c.handle,
                  c.name,
                  c.url,
                  c.transport,
                  c.private_addresses,
                  c.enabled,
                  randomUUID(),
                ],
              )
            ).rows[0];
          result.push(connectionView(row));
        }
        const removed = rows
          .filter((r) => !p.connections.some((c: any) => c.handle === r.handle))
          .map((r) => r.id);
        await tx.query(
          'UPDATE mcp_connections SET enabled=false,revision=revision+1 WHERE id=ANY($1::uuid[])',
          [removed],
        );
        await tx.query(
          'UPDATE tool_grants SET enabled=false,revision=revision+1 WHERE connection_id=ANY($1::uuid[])',
          [removed],
        );
        return { connections: result, removed };
      }
      if (input.command === 'installExtension') {
        validateManifest(p.manifest, p.resources);
        const { preview_token, ...preview } = p;
        if (hash(canonical(preview)) !== preview_token)
          throw error('Install preview changed');
        for (const id of p.connection_ids)
          if (
            !(
              await tx.query(
                'SELECT 1 FROM mcp_connections WHERE owner_id=$1 AND id=$2',
                [owner, id],
              )
            ).rowCount
          )
            throw error('Adopted connection missing');
        const owned = [];
        for (const c of p.new_connections ?? []) {
          if (
            (
              await tx.query(
                'SELECT 1 FROM mcp_connections WHERE owner_id=$1 AND handle=$2',
                [owner, c.handle],
              )
            ).rowCount
          )
            throw error(
              'New connection handle already exists; adopt it explicitly',
            );
          const id = randomUUID();
          await tx.query(
            "INSERT INTO mcp_connections(id,owner_id,handle,name,url,transport,private_addresses,enabled,auth_type,header_name) VALUES($1,$2,$3,$4,$5,$6,$7,false,'none','X-Api-Key')",
            [
              id,
              owner,
              c.handle,
              c.name,
              c.url,
              c.transport,
              c.private_addresses,
            ],
          );
          owned.push(id);
        }
        const installed = (
          await tx.query(
            'INSERT INTO extension_installs(owner_id,manifest,resources,adopted_connections) VALUES($1,$2,$3,$4) RETURNING *',
            [
              owner,
              JSON.stringify(p.manifest),
              JSON.stringify(p.resources),
              p.connection_ids,
            ],
          )
        ).rows[0];
        await tx.query(
          'UPDATE extension_installs SET owned_connections=$2 WHERE id=$1',
          [installed.id, owned],
        );
        return { ...installed, owned_connections: owned };
      }
      if (input.command === 'cancelRemoteInstall') {
        const j = (
          await tx.query(
            "UPDATE extension_install_jobs SET state='cancelled' WHERE id=$1 AND owner_id=$2 AND state IN ('prepared','submitted','unknown','cancelled') RETURNING *",
            [p.id, owner],
          )
        ).rows[0];
        if (!j)
          throw new AppError(
            409,
            'install_state',
            'Install is no longer cancellable',
          );
        return j;
      }
      const install = (
        await tx.query(
          'SELECT * FROM extension_installs WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, p.id],
        )
      ).rows[0];
      if (!install) throw new AppError(404, 'not_found', 'Extension not found');
      if (input.command === 'prepareRemoteInstall')
        return (
          await tx.query(
            'INSERT INTO extension_install_jobs(owner_id,install_id,operation_id,request_hash,remote_target) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [
              owner,
              install.id,
              input.operation_id,
              hash(canonical(p)),
              p.target,
            ],
          )
        ).rows[0];
      if (input.command === 'previewUninstall')
        return {
          id: install.id,
          revision: install.revision,
          preview_token: hash(canonical(install)),
          adopted_connections: install.adopted_connections,
          owned_connections: install.owned_connections,
          retained_resources: Object.keys(install.resources),
        };
      if (input.command === 'uninstallExtension') {
        matchRevision(install, input.expected_revision);
        if (hash(canonical(install)) !== p.preview_token)
          throw new AppError(
            409,
            'revision_conflict',
            'Uninstall preview changed',
          );
        await tx.query(
          "UPDATE extension_installs SET state='uninstalled',revision=revision+1 WHERE id=$1",
          [install.id],
        );
        const owned = install.owned_connections.filter(
          (id: string) => !install.adopted_connections.includes(id),
        );
        await tx.query(
          "UPDATE mcp_connections SET enabled=false,revision=revision+1 WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM extension_installs i WHERE i.id<>$2 AND i.state='installed' AND $3::uuid=i.owner_id AND mcp_connections.id=ANY(i.adopted_connections))",
          [owned, install.id, owner],
        );
        await tx.query(
          "UPDATE skill_bindings SET mode='off',revision=revision+1 WHERE install_id=$1",
          [install.id],
        );
        return {
          id: install.id,
          state: 'uninstalled',
          retained_connections: install.adopted_connections,
        };
      }
      if (input.command === 'setSkillMode') {
        await memoryActor(tx, owner, p.actor_id);
        if (
          install.state !== 'installed' ||
          install.manifest.runtime !== 'instructions'
        )
          throw error('Instruction package required');
        const old = (
          await tx.query(
            'SELECT * FROM skill_bindings WHERE install_id=$1 AND actor_id=$2',
            [install.id, p.actor_id],
          )
        ).rows[0];
        matchRevision(old ?? { revision: 0 }, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO skill_bindings(owner_id,install_id,actor_id,mode) VALUES($1,$2,$3,$4) ON CONFLICT(install_id,actor_id) DO UPDATE SET mode=$4,revision=skill_bindings.revision+1 RETURNING *',
            [owner, install.id, p.actor_id, p.mode],
          )
        ).rows[0];
      }
      if (input.command === 'createAppFromExtension') {
        await memoryActor(tx, owner, p.actor_id);
        if (
          install.state !== 'installed' ||
          !['python', 'card'].includes(install.manifest.runtime)
        )
          throw error('Executable package required');
        return (
          await tx.query(
            'INSERT INTO miniapps(owner_id,actor_id,title,language,source,resources) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              owner,
              p.actor_id,
              install.manifest.name,
              install.manifest.runtime === 'python' ? 'python' : 'html',
              install.resources[install.manifest.entrypoint],
              JSON.stringify(install.resources),
            ],
          )
        ).rows[0];
      }
      if (input.command === 'sendWithSkill') {
        await memoryActor(tx, owner, p.actor_id);
        if (
          install.state !== 'installed' ||
          !(
            await tx.query(
              "SELECT 1 FROM skill_bindings WHERE install_id=$1 AND actor_id=$2 AND mode<>'off'",
              [install.id, p.actor_id],
            )
          ).rowCount
        )
          throw new AppError(403, 'scope_denied', 'Skill unavailable');
        const ack = await enqueueInTransaction(
          tx,
          owner,
          p.room_id,
          {
            client_command_id: input.operation_id,
            content: p.content,
            addressed_actor_ids: [p.actor_id],
          },
          hash(canonical(p)),
        );
        await tx.query(
          'INSERT INTO run_skill_refs(run_id,install_id,actor_id) VALUES($1,$2,$3)',
          [ack.run_id, install.id, p.actor_id],
        );
        return ack;
      }
      if (input.command === 'useSkill') {
        const allowed = (
          await tx.query(
            "SELECT 1 FROM runs r JOIN skill_bindings b ON b.actor_id=$3 AND b.install_id=$2 WHERE r.owner_id=$1 AND r.id=$4 AND r.state='queued' AND b.mode IN ('manual','candidate','auto') AND EXISTS(SELECT 1 FROM message_audiences a WHERE a.message_id=r.user_message_id AND a.actor_id=$3)",
            [owner, install.id, p.actor_id, p.run_id],
          )
        ).rowCount;
        if (!allowed || install.state !== 'installed')
          throw new AppError(
            403,
            'scope_denied',
            'Skill is not authorized for queued run',
          );
        await tx.query(
          'INSERT INTO run_skill_refs(run_id,install_id,actor_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [p.run_id, install.id, p.actor_id],
        );
        return { id: install.id, run_id: p.run_id };
      }
      throw error('Unsupported extension action');
    },
  );
}
export async function skillPrompt(db: DB, run: any, actor: string) {
  const rows = (
    await db.query(
      "SELECT i.*,b.mode,EXISTS(SELECT 1 FROM run_skill_refs r WHERE r.run_id=$3 AND r.install_id=i.id AND r.actor_id=$2) AS selected FROM extension_installs i JOIN skill_bindings b ON b.install_id=i.id WHERE i.owner_id=$1 AND i.state='installed' AND b.actor_id=$2 AND b.mode<>'off' ORDER BY i.id LIMIT 16",
      [run.owner_id, actor, run.id],
    )
  ).rows;
  const existing = (
    await db.query(
      'SELECT entries FROM run_skill_snapshots WHERE run_id=$1 AND actor_id=$2',
      [run.id, actor],
    )
  ).rows[0];
  if (existing)
    return existing.entries.filter((entry: any) =>
      rows.some((r) => r.id === entry.install_id),
    );
  const entries = rows
    .filter((r) => r.mode !== 'manual' || r.selected)
    .map((r) => ({
      install_id: r.id,
      role: 'system',
      position: 'before_history',
      content:
        '扩展资料（不授予任何动作权限）：' +
        (r.mode === 'auto' || r.selected
          ? r.resources[r.manifest.entrypoint]
          : JSON.stringify({
              id: r.id,
              name: r.manifest.name,
              description: r.manifest.description,
            })),
      depth: 0,
    }));
  await db.query(
    'INSERT INTO run_skill_snapshots(run_id,actor_id,entries) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [run.id, actor, JSON.stringify(entries)],
  );
  return entries;
}

// Adapter-facing receipt reconciliation. A future authenticated Host adapter supplies
// its actual receipt; receipt ingestion never sends or replays an installation.
export async function reconcileInstallReceipt(
  db: pg.Pool,
  owner: string,
  jobID: string,
  target: string,
  receipt: { job_id: string; state: 'completed' | 'failed'; data: unknown },
) {
  const { transaction } = await import('../../db/index.js');
  return transaction(db, async (tx) => {
    const j = (
      await tx.query(
        'SELECT * FROM extension_install_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [jobID, owner],
      )
    ).rows[0];
    if (
      !j ||
      j.remote_target !== target ||
      receipt.job_id !== j.id ||
      !['completed', 'failed'].includes(receipt.state)
    )
      throw new AppError(
        409,
        'receipt_scope',
        'Remote receipt identity mismatch',
      );
    if (j.receipt) {
      if (canonical(j.receipt) !== canonical(receipt))
        throw new AppError(409, 'receipt_conflict', 'Receipt already recorded');
      return j;
    }
    if (Buffer.byteLength(JSON.stringify(receipt)) > 65536)
      throw error('Receipt too large');
    const late = j.state === 'cancelled';
    const result = (
      await tx.query(
        'UPDATE extension_install_jobs SET receipt=$2,state=$3,late=$4 WHERE id=$1 RETURNING *',
        [
          j.id,
          JSON.stringify(receipt),
          late ? 'cancelled' : receipt.state,
          late,
        ],
      )
    ).rows[0];
    if (late)
      await tx.query(
        'UPDATE extension_installs SET late_receipts=late_receipts||$2::jsonb,revision=revision+1 WHERE id=$1',
        [j.install_id, JSON.stringify([receipt])],
      );
    return result;
  });
}
