import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type pg from 'pg';
import type { DB } from '../../db/index.js';
import { transaction } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, encrypt } from '../../security.js';
import {
  connectMcp,
  discover,
  resolveMcp,
  hideCredential,
} from './transport.js';
import { emit } from '../sync/index.js';
import { worldLock } from '../worlds/index.js';
import { canonical, validateArguments } from './schema.js';
export const connectionView = (r: any) => {
  const { owner_id, credential, ...rest } = r;
  return { ...rest, credential_present: !!credential };
};
export const grantView = (r: any) => {
  const { owner_id, ...rest } = r;
  return rest;
};
export const callView = (r: any) => {
  const { owner_id, ...rest } = r;
  return rest;
};
export async function listConnections(db: DB, owner: string) {
  return (
    await db.query(
      'SELECT * FROM mcp_connections WHERE owner_id=$1 ORDER BY name,id LIMIT 100',
      [owner],
    )
  ).rows.map(connectionView);
}
export async function saveConnection(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
  id?: string,
  revision?: number,
) {
  if (input.private_addresses.some((ip: string) => !isIP(ip)))
    throw new AppError(
      400,
      'invalid_allowlist',
      'Use exact IP addresses for a connection',
    );
  if (!/^(X-[A-Za-z0-9-]+|Api-Key)$/i.test(input.header_name))
    throw new AppError(
      400,
      'invalid_auth_header',
      'API keys require an X- header or Api-Key',
    );
  const endpoint = await resolveMcp(input.url, input.private_addresses);
  if (endpoint.url.search)
    throw new AppError(
      400,
      'invalid_endpoint',
      'Use explicit credential fields, not URL query authentication',
    );

  const connection = id ?? randomUUID();
  return transaction(db, async (tx) => {
    await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
      owner,
    ]);
    if (
      !id &&
      Number(
        (
          await tx.query(
            'SELECT count(*) FROM mcp_connections WHERE owner_id=$1',
            [owner],
          )
        ).rows[0].count,
      ) >= 100
    )
      throw new AppError(
        400,
        'connection_limit',
        'At most 100 MCP connections',
      );
    const credential = input.credential
      ? encrypt(input.credential, config, `${owner}:mcp:${connection}`)
      : null;
    let row;
    if (id) {
      const previous = (
        await tx.query(
          'SELECT * FROM mcp_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, id],
        )
      ).rows[0];
      if (!previous || previous.revision !== revision)
        throw new AppError(409, 'revision_conflict', 'Connection changed');
      // Empty credentials retain the secret only when endpoint and auth identity remain identical.
      const secret =
        credential ??
        (previous.url === input.url &&
        previous.auth_type === input.auth_type &&
        previous.header_name === input.header_name
          ? previous.credential
          : null);
      if (input.auth_type !== 'none' && !secret)
        throw new AppError(
          400,
          'credential_required',
          'Provide credentials for the changed endpoint',
        );
      row = (
        await tx.query(
          "UPDATE mcp_connections SET name=$3,url=$4,transport=$5,enabled=$6,auth_type=$7,header_name=$8,credential=$9,private_addresses=$10,revision=revision+1,tools='[]',discovered_at=NULL WHERE owner_id=$1 AND id=$2 RETURNING *",
          [
            owner,
            id,
            input.name,
            input.url,
            input.transport,
            input.enabled,
            input.auth_type,
            input.header_name,
            input.auth_type === 'none' ? null : secret,
            input.private_addresses,
          ],
        )
      ).rows[0];
      const revoked = (
        await tx.query(
          'UPDATE tool_grants SET enabled=false,revision=revision+1 WHERE connection_id=$1 RETURNING *',
          [id],
        )
      ).rows;
      for (const grant of revoked)
        await emit(tx, owner, 'tool_grant', grant.id, grantView(grant));
    } else {
      if (input.auth_type !== 'none' && !credential)
        throw new AppError(
          400,
          'credential_required',
          'Provide connection credentials',
        );
      row = (
        await tx.query(
          'INSERT INTO mcp_connections(id,owner_id,name,url,transport,enabled,auth_type,header_name,credential,private_addresses) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            connection,
            owner,
            input.name,
            input.url,
            input.transport,
            input.enabled,
            input.auth_type,
            input.header_name,
            input.auth_type === 'none' ? null : credential,
            input.private_addresses,
          ],
        )
      ).rows[0];
    }
    await emit(tx, owner, 'mcp_connection', connection, connectionView(row));
    return connectionView(row);
  });
}
export async function refreshTools(
  db: pg.Pool,
  config: Config,
  owner: string,
  id: string,
) {
  const c = (
    await db.query(
      'SELECT * FROM mcp_connections WHERE owner_id=$1 AND id=$2 AND enabled',
      [owner, id],
    )
  ).rows[0];
  if (!c)
    throw new AppError(404, 'not_found', 'Enabled MCP connection not found');
  const signal = AbortSignal.timeout(30000);
  let tools: any[], session: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    session = await connectMcp(c, config, signal);
    tools = await discover(session.client, signal);
    if (canonical(hideCredential(c, config, tools)) !== canonical(tools))
      throw new AppError(
        400,
        'credential_reflected',
        'Tool definitions must not contain connection credentials',
      );
  } catch (e) {
    await db.query(
      "UPDATE mcp_connections SET discovery_error='mcp_discovery_failed' WHERE id=$1 AND revision=$2",
      [id, c.revision],
    );
    throw e;
  } finally {
    await session?.close();
  }
  return transaction(db, async (tx) => {
    const fresh = (
      await tx.query('SELECT * FROM mcp_connections WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (fresh.revision !== c.revision)
      throw new AppError(
        409,
        'revision_conflict',
        'Connection changed during discovery',
      );
    const changed = canonical(fresh.tools) !== canonical(tools);
    const row = (
      await tx.query(
        'UPDATE mcp_connections SET tools=$2,discovered_at=now(),discovery_error=NULL,revision=revision+$3 WHERE id=$1 RETURNING *',
        [id, JSON.stringify(tools), changed ? 1 : 0],
      )
    ).rows[0];
    await emit(tx, owner, 'mcp_connection', id, connectionView(row));
    return connectionView(row);
  });
}
export async function saveGrant(
  db: pg.Pool,
  owner: string,
  input: any,
  id?: string,
  revision?: number,
) {
  return transaction(db, async (tx) => {
    await worldLock(tx, owner, input.world_id);
    const connection = (
      await tx.query(
        'SELECT * FROM mcp_connections WHERE owner_id=$1 AND id=$2 AND enabled FOR UPDATE',
        [owner, input.connection_id],
      )
    ).rows[0];
    const tool = connection?.tools.find(
      (t: any) =>
        t.name === input.tool_name &&
        t.schema_hash === input.schema_hash &&
        t.supported,
    );
    if (!tool)
      throw new AppError(
        409,
        'tool_schema_changed',
        'Discover and select a supported current tool',
      );
    const actor = (
      await tx.query(
        'SELECT id FROM world_characters WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND NOT deleted',
        [owner, input.world_id, input.actor_id],
      )
    ).rowCount;
    if (!actor)
      throw new AppError(
        400,
        'invalid_actor',
        'Actor must belong to the world',
      );
    if (
      new Date(input.expires_at).getTime() <= Date.now() ||
      new Date(input.expires_at).getTime() > Date.now() + 366 * 86400000
    )
      throw new AppError(
        400,
        'invalid_expiry',
        'Grant expiry must be within one year',
      );
    if (
      input.effect === 'write' &&
      input.approval_mode === 'scoped' &&
      !Object.keys(input.argument_scope).length
    )
      throw new AppError(
        400,
        'scope_required',
        'Standing write grants require exact resource parameters',
      );
    if (Buffer.byteLength(canonical(input.argument_scope)) > 16384)
      throw new AppError(413, 'scope_limit', 'Scope is too large');
    for (const [key, value] of Object.entries(input.argument_scope))
      validateArguments(
        {
          type: 'object',
          properties: {
            [key]: tool.inputSchema.properties?.[key] ?? { type: 'null' },
          },
          required: [key],
          additionalProperties: false,
        },
        { [key]: value },
        {},
      );
    const grant = id ?? randomUUID();
    const fields = [
      'world_id',
      'actor_id',
      'connection_id',
      'tool_name',
      'schema_hash',
      'effect',
      'approval_mode',
      'argument_scope',
      'expires_at',
      'enabled',
    ];
    const values = fields.map((k) =>
      k === 'argument_scope' ? JSON.stringify(input[k]) : input[k],
    );
    const row = id
      ? (
          await tx.query(
            `UPDATE tool_grants SET ${fields.map((k, i) => `${k}=$${i + 4}`).join(',')},revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$3 RETURNING *`,
            [owner, id, revision, ...values],
          )
        ).rows[0]
      : (
          await tx.query(
            `INSERT INTO tool_grants(id,owner_id,${fields.join(',')}) VALUES($1,$2,${fields.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`,
            [grant, owner, ...values],
          )
        ).rows[0];
    if (!row) throw new AppError(409, 'revision_conflict', 'Grant changed');
    await emit(tx, owner, 'tool_grant', grant, grantView(row));
    return grantView(row);
  });
}
export async function revokeGrant(db: pg.Pool, owner: string, id: string) {
  return transaction(db, async (tx) => {
    const row = (
      await tx.query(
        'UPDATE tool_grants SET enabled=false,revision=revision+1 WHERE owner_id=$1 AND id=$2 RETURNING *',
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Grant not found');
    await emit(tx, owner, 'tool_grant', id, grantView(row));
  });
}
