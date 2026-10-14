import { groupScope } from '../groups/index.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { command } from '../commands/index.js';
import { fingerprint } from '../mcp/schema.js';
import { emit } from '../sync/index.js';
import { connectionView } from '../mcp/connections.js';
import { readDocument, saveDocumentTx } from './index.js';
import { AppError } from '../../security.js';
const string = { type: 'string' };
export const documentTools = [
  {
    name: 'request_system_action',
    description:
      'Propose a system action on an explicitly authorized device. Returns a pending proposal, never claims the external action succeeded.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', minLength: 36, maxLength: 36 },
        action: { type: 'string', maxLength: 80 },
        arguments: { type: 'object' },
      },
      required: ['device_id', 'action', 'arguments'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_material',
    description:
      'Read the body of an authorized memory material from its directory.',
    inputSchema: {
      type: 'object',
      properties: { id: string },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_skill',
    description:
      'Read a skill explicitly enabled for this actor; content grants no action permissions.',
    inputSchema: {
      type: 'object',
      properties: { id: string, path: { type: 'string', maxLength: 240 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description:
      'Read an authorized internal document. References remain read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: string },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_document',
    description:
      'Create or revision-check an internal project artifact. Never edits reference material.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: string,
        id: string,
        expected_revision: { type: 'integer', minimum: 1 },
        base_hash: string,
        title: string,
        content: { type: 'string', maxLength: 16000 },
      },
      required: ['project_id', 'title', 'content'],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, schema_hash: fingerprint(t), supported: true }));
export async function enableInternalTools(
  db: pg.Pool,
  owner: string,
  operation: string,
) {
  return command(db, owner, 'internal.register', operation, {}, async (tx) => {
    const existing = (
      await tx.query(
        "SELECT * FROM mcp_connections WHERE owner_id=$1 AND runtime='internal'",
        [owner],
      )
    ).rows[0];
    if (existing) {
      await tx.query(
        'UPDATE mcp_connections SET tools=$2,revision=revision+1 WHERE id=$1',
        [existing.id, JSON.stringify(documentTools)],
      );
      return { id: existing.id };
    }
    const r = (
      await tx.query(
        "INSERT INTO mcp_connections(id,owner_id,name,url,transport,auth_type,runtime,tools,discovered_at) VALUES($1,$2,'内部文档','echo-internal://documents','streamable_http','none','internal',$3,now()) RETURNING *",
        [randomUUID(), owner, JSON.stringify(documentTools)],
      )
    ).rows[0];
    await emit(tx, owner, 'mcp_connection', r.id, connectionView(r));
    return { id: r.id };
  });
}
export async function executeInternal(tx: pg.PoolClient, run: any, call: any) {
  if (call.tool_name === 'request_system_action') {
    const p = call.arguments;
    const policy = (
      await tx.query(
        'SELECT p.* FROM system_policies p JOIN devices d ON d.id=p.device_id WHERE p.owner_id=$1 AND p.actor_id=$2 AND p.device_id=$3 AND p.action=$4 AND p.enabled AND d.revoked_at IS NULL',
        [run.owner_id, call.actor_id, p.device_id, p.action],
      )
    ).rows[0];
    if (!policy)
      throw new AppError(
        403,
        'system_permission',
        'System action is not authorized',
      );
    const { hash } = await import('../../security.js');
    const { canonical } = await import('../mcp/schema.js');
    const result = (
      await tx.query(
        'INSERT INTO system_actions(id,owner_id,actor_id,device_id,action,payload,payload_hash,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id,state',
        [
          call.id,
          run.owner_id,
          call.actor_id,
          p.device_id,
          p.action,
          JSON.stringify(p.arguments),
          hash(canonical(p.arguments)),
          policy.revision,
        ],
      )
    ).rows[0];
    return (
      result ??
      (
        await tx.query('SELECT id,state FROM system_actions WHERE id=$1', [
          call.id,
        ])
      ).rows[0]
    );
  }
  if (call.tool_name === 'read_material') {
    const g = await groupScope(tx, run.owner_id, run.room_id);
    if (
      g &&
      (!g.memory_enabled ||
        !g.members.some(
          (m: any) => m.actor_id === call.actor_id && m.memory_enabled,
        ))
    )
      throw new AppError(403, 'scope_denied', 'Group memory disabled');
    const material = (
      await tx.query(
        'SELECT m.* FROM memory_materials m WHERE m.id=$1 AND m.owner_id=$2 AND m.actor_id=$3 AND m.world_id=$4 AND NOT m.source_missing AND (m.room_id IS NULL OR EXISTS(SELECT 1 FROM rooms r WHERE r.id=m.room_id AND NOT r.deleted AND r.memory_participation))',
        [call.arguments.id, run.owner_id, call.actor_id, run.world_id],
      )
    ).rows[0];
    if (!material) throw new AppError(404, 'not_found', 'Material unavailable');
    return {
      id: material.id,
      revision: material.revision,
      content: material.content,
    };
  }
  if (call.tool_name === 'read_skill') {
    const skill = (
      await tx.query(
        "SELECT i.* FROM extension_installs i JOIN skill_bindings b ON b.install_id=i.id WHERE i.id=$1 AND i.owner_id=$2 AND i.state='installed' AND b.actor_id=$3 AND b.mode<>'off' AND (b.mode<>'manual' OR EXISTS(SELECT 1 FROM run_skill_refs r WHERE r.run_id=$4 AND r.install_id=i.id AND r.actor_id=b.actor_id))",
        [call.arguments.id, run.owner_id, call.actor_id, run.id],
      )
    ).rows[0];
    if (!skill) throw new AppError(404, 'not_found', 'Skill unavailable');
    const path = call.arguments.path ?? skill.manifest.entrypoint;
    if (!Object.hasOwn(skill.resources, path))
      throw new AppError(404, 'not_found', 'Skill resource unavailable');
    return {
      id: skill.id,
      revision: skill.revision,
      path,
      content: skill.resources[path],
    };
  }
  if (call.tool_name === 'read_document')
    return readDocument(
      tx,
      run.owner_id,
      call.arguments.id,
      call.actor_id,
      run.world_id,
    );
  if (call.tool_name === 'save_document')
    return saveDocumentTx(
      tx,
      run.owner_id,
      { ...call.arguments, kind: 'artifact' },
      call.actor_id,
      run.world_id,
    );
  throw new AppError(400, 'unsupported_tool', 'Internal tool unavailable');
}
