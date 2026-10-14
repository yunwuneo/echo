import { pairHost, hostRPC } from './modules/hosts/index.js';
import { receiveEvent } from './modules/schedules/index.js';
import { milestone } from './modules/conversations/api.js';
import { assertAvailable, diagnostics } from './modules/operations/index.js';
import {
  createAsset,
  readAsset,
  referenceAsset,
  previewAssetDeletion,
  deleteAsset,
} from './modules/assets/index.js';
import { listModelRoutes, saveModelRoute } from './modules/providers/routes.js';
import { exportOwner } from './modules/exports/index.js';
import {
  notificationStatus,
  beginBinding,
  enableBinding,
  queueRevocation,
  resolveNotification,
} from './modules/notifications/index.js';
import { transaction } from './db/index.js';
import {
  globalDefaults,
  policyView,
  savePolicy,
  autonomyView,
} from './modules/autonomy/policy.js';
import { recaps, readRecaps } from './modules/autonomy/scheduler.js';
import {
  listConnections,
  saveConnection,
  refreshTools,
  saveGrant,
  revokeGrant,
  grantView,
  callView,
} from './modules/mcp/connections.js';
import { decide } from './modules/mcp/gateway.js';
import {
  listMemories,
  saveSettings,
  editMemory,
  deleteMessage,
  settingsView,
} from './modules/memory/repository.js';
import {
  previewImport,
  commitImport,
  exportImport,
} from './modules/imports/index.js';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import type pg from 'pg';
import type { Writable } from 'node:stream';
import {
  routes,
  type ProviderInput,
  type MessageInput,
} from '../../contracts/src/index.js';
import type { Config } from './config.js';
import { AppError } from './security.js';
import {
  authenticate,
  createPairingCode,
  pair,
  refresh,
  revoke,
  type Identity,
} from './modules/pairing/auth.js';
import {
  createProvider,
  updateProvider,
  providerView,
} from './modules/providers/index.js';
import { command } from './modules/commands/index.js';
import { branchConversation } from './modules/conversations/branches.js';
import {
  queuedInputs,
  queueInput,
  updateQueuedInput,
  startQueuedTurn,
} from './modules/conversations/queue.js';
import {
  messageVersions,
  editMessage,
  exportConversation,
} from './modules/conversations/versions.js';
import {
  cancel,
  enqueue,
  getRun,
  regenerate,
} from './modules/runs/repository.js';
import {
  messageView,
  runView,
  snapshot,
  sync,
  beginSnapshot,
  snapshotPage,
} from './modules/sync/index.js';
import {
  editEntity,
  correctState,
  type Resource,
} from './modules/worlds/index.js';
export async function buildApp(
  db: pg.Pool,
  config: Config,
  options: { logger?: boolean; logStream?: Writable } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          stream: options.logStream,
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body',
            'res.headers',
          ],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
            err: () => ({ type: 'Error', message: 'redacted', stack: '' }),
          },
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32768,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Echo API', version: '0.6.0' },
      components: {
        securitySchemes: { deviceBearer: { type: 'http', scheme: 'bearer' } },
      },
    },
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { validation?: unknown; statusCode?: number };
    const status =
      e instanceof AppError
        ? e.status
        : e.validation
          ? 400
          : e.statusCode && e.statusCode >= 400 && e.statusCode < 500
            ? e.statusCode
            : 500;
    if (status >= 500)
      request.log.error(
        { code: e instanceof AppError ? e.code : 'internal_error' },
        'request_failed',
      );
    void reply.code(status).send({
      error: {
        code:
          e instanceof AppError
            ? e.code
            : status < 500
              ? 'invalid_request'
              : 'internal_error',
        message:
          e instanceof AppError
            ? e.message
            : status < 500
              ? 'Request does not match API schema'
              : 'Request failed',
      },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Endpoint not found' } }),
  );
  let serverStopping = false;
  app.addHook('preClose', async () => {
    serverStopping = true;
  });
  const identities = new WeakMap<FastifyRequest, Identity>();
  const owner = (r: FastifyRequest) => identities.get(r)!.ownerId;
  const id = (r: FastifyRequest) => (r.params as { id: string }).id;
  const handlers: Record<
    string,
    (r: FastifyRequest, reply: any) => Promise<unknown>
  > = {
    hostPair: async (r) => pairHost(db, r.body),
    hostRPC: async (r) =>
      hostRPC(
        db,
        r.headers.authorization,
        r.body,
        String(r.headers['x-echo-signature'] ?? ''),
      ),
    receiveEvent: async (r) =>
      receiveEvent(
        db,
        config,
        id(r),
        r.body,
        String(r.headers['x-echo-signature'] ?? ''),
      ),
    notificationStatus: async (r) =>
      notificationStatus(db, config, identities.get(r)!),
    beginPushBinding: async (r) => beginBinding(db, config, identities.get(r)!),
    enablePush: async (r) =>
      enableBinding(db, config, identities.get(r)!, (r.body as any).ticket),
    disablePush: async (r, reply) => {
      await transaction(db, (tx) =>
        queueRevocation(tx, owner(r), identities.get(r)!.deviceId),
      );
      reply.code(204);
      return null;
    },
    resolvePush: async (r) =>
      resolveNotification(db, identities.get(r)!, id(r)),
    exportData: async (r) => exportOwner(db, owner(r)),
    diagnostics: async () => diagnostics(db),
    memories: async (r) => ({ items: await listMemories(db, owner(r), id(r)) }),
    autonomySettings: async (r) =>
      policyView(
        (
          await db.query('SELECT * FROM autonomy_settings WHERE owner_id=$1', [
            owner(r),
          ])
        ).rows[0] ?? { ...globalDefaults, owner_id: owner(r) },
      ),
    saveAutonomySettings: async (r) =>
      savePolicy(db, owner(r), null, Number(r.headers['if-match']), r.body),
    autonomyPolicy: async (r) => autonomyView(db, owner(r), id(r)),
    saveAutonomyPolicy: async (r) =>
      savePolicy(db, owner(r), id(r), Number(r.headers['if-match']), r.body),
    recaps: async (r) => recaps(db, owner(r), id(r), (r.query as any).after),
    readRecaps: async (r, reply) => {
      await readRecaps(db, owner(r), id(r), (r.body as any).revision);
      reply.code(204);
      return null;
    },
    backgroundUsage: async (r) => ({
      items: (
        await db.query(
          'SELECT * FROM background_usage WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner(r)],
        )
      ).rows,
      daily: (
        await db.query(
          'SELECT * FROM background_daily WHERE owner_id=$1 ORDER BY day DESC LIMIT 31',
          [owner(r)],
        )
      ).rows,
      worlds: (
        await db.query(
          'SELECT s.* FROM background_scopes s JOIN worlds w ON w.id=s.world_id WHERE w.owner_id=$1 ORDER BY day DESC LIMIT 100',
          [owner(r)],
        )
      ).rows,
    }),
    mcpConnections: async (r) => ({
      items: await listConnections(db, owner(r)),
    }),
    createMcpConnection: async (r, reply) => {
      reply.code(201);
      return saveConnection(db, config, owner(r), r.body);
    },
    updateMcpConnection: async (r) =>
      saveConnection(
        db,
        config,
        owner(r),
        r.body,
        id(r),
        Number(r.headers['if-match']),
      ),
    discoverMcpTools: async (r) => refreshTools(db, config, owner(r), id(r)),
    toolGrants: async (r) => ({
      items: (
        await db.query(
          'SELECT * FROM tool_grants WHERE owner_id=$1 ORDER BY id LIMIT 1000',
          [owner(r)],
        )
      ).rows.map(grantView),
    }),
    createToolGrant: async (r, reply) => {
      reply.code(201);
      return saveGrant(db, owner(r), r.body);
    },
    updateToolGrant: async (r) =>
      saveGrant(db, owner(r), r.body, id(r), Number(r.headers['if-match'])),
    revokeToolGrant: async (r, reply) => {
      await revokeGrant(db, owner(r), id(r));
      reply.code(204);
      return null;
    },
    toolCalls: async (r) => ({
      items: (
        await db.query(
          'SELECT * FROM tool_calls WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner(r)],
        )
      ).rows.map(callView),
    }),
    approvals: async (r) => ({
      items: (
        await db.query(
          "SELECT * FROM tool_calls WHERE owner_id=$1 AND state IN ('pending','outcome_unknown') ORDER BY created_at LIMIT 100",
          [owner(r)],
        )
      ).rows.map(callView),
    }),
    decideTool: async (r) =>
      decide(db, owner(r), id(r), (r.body as any).decision),
    memorySettings: async (r) =>
      saveSettings(db, owner(r), id(r), Number(r.headers['if-match']), r.body),
    memoryUpdate: async (r) =>
      editMemory(db, owner(r), id(r), Number(r.headers['if-match']), r.body),
    memoryDelete: async (r, reply) => {
      await editMemory(
        db,
        owner(r),
        id(r),
        Number(r.headers['if-match']),
        null,
      );
      reply.code(204);
      return null;
    },
    messageDelete: async (r, reply) => {
      await deleteMessage(db, owner(r), id(r));
      reply.code(204);
      return null;
    },
    memoryRevisions: async (r) => ({
      items: (
        await db.query(
          'SELECT v.revision,v.data FROM memory_revisions v JOIN memories m ON m.id=v.memory_id WHERE m.owner_id=$1 AND m.id=$2 ORDER BY v.revision',
          [owner(r), id(r)],
        )
      ).rows,
    }),
    memoryStatus: async (r) => {
      const w = (
        await db.query(
          'SELECT id FROM worlds WHERE owner_id=$1 AND id=$2 AND NOT deleted',
          [owner(r), id(r)],
        )
      ).rows[0];
      if (!w) throw new AppError(404, 'not_found', 'World not found');
      const s = (
        await db.query('SELECT * FROM memory_settings WHERE world_id=$1', [
          id(r),
        ])
      ).rows[0];
      return {
        settings: settingsView(s),
        recall_mode:
          s.embedding_provider_id && !s.index_error ? 'hybrid' : 'lexical',
        index_error: s.index_error,
        jobs: (
          await db.query(
            'SELECT j.room_id,j.cursor::text,j.attempts,j.error_code,j.lease_until FROM memory_jobs j JOIN rooms r ON r.id=j.room_id WHERE r.world_id=$1',
            [id(r)],
          )
        ).rows,
        indexed: (
          await db.query(
            'SELECT count(*)::int AS count FROM memory_vectors v JOIN memories m ON m.id=v.memory_id WHERE m.world_id=$1 AND v.index_version=$2 AND v.revision=m.revision',
            [id(r), s.index_version],
          )
        ).rows[0].count,
        usage: (
          await db.query(
            'SELECT kind,state,input_reserved,output_reserved,input_tokens,output_tokens,error_code,created_at FROM background_usage WHERE owner_id=$1 AND world_id=$2 ORDER BY created_at DESC LIMIT 50',
            [owner(r), id(r)],
          )
        ).rows,
      };
    },
    memoryRetry: async (r, reply) => {
      await db.query(
        'UPDATE memory_jobs SET attempts=0,next_attempt_at=now(),error_code=NULL WHERE room_id IN (SELECT id FROM rooms WHERE owner_id=$1 AND world_id=$2)',
        [owner(r), id(r)],
      );
      await db.query(
        'UPDATE memory_settings SET index_next_at=now() WHERE owner_id=$1 AND world_id=$2',
        [owner(r), id(r)],
      );
      reply.code(204);
      return null;
    },
    importPreview: async (r) => previewImport(db, owner(r), id(r), r.body),
    importCommit: async (r) => commitImport(db, owner(r), id(r), r.body),
    importExport: async (r) => exportImport(db, owner(r), id(r)),
    state: async (r) =>
      correctState(db, owner(r), id(r), Number(r.headers['if-match']), r.body),
    regenerate: async (r, reply) => {
      reply.code(202);
      return regenerate(
        db,
        owner(r),
        id(r),
        (r.body as { client_command_id: string }).client_command_id,
      );
    },
    manifests: async (r) => {
      await getRun(db, owner(r), id(r));
      return {
        items: (
          await db.query(
            'SELECT attempt,data FROM prompt_manifests WHERE run_id=$1 ORDER BY attempt',
            [id(r)],
          )
        ).rows,
      };
    },
    health: async () => {
      await db.query('SELECT 1');
      return { status: 'ok' };
    },
    capabilities: async () => {
      const meta = (
        await db.query(
          'SELECT server_instance_id,data_epoch FROM instance_metadata',
        )
      ).rows[0];
      const o = (await db.query('SELECT id FROM owners')).rows[0];
      return {
        ...meta,
        protocol_version: 1,
        owner_id: o?.id ?? null,
        features: [
          'pairing',
          'devices',
          'text-runs',
          'sync',
          'sse',
          'usage',
          'worlds',
          'characters',
          'group-runs',
          'lore-keywords',
          'prompt-manifests',
          'paged-snapshots',
          'memory',
          'lore-rules',
          'card-imports',
          'mcp-tools',
          'autonomy',
          'recaps',
          'notifications',
          'owner-export',
          'diagnostics',
          'actor-model-routes',
          'asset-references',
          'message-versions',
        ],
      };
    },
    pair: async (r, reply) => {
      const b = r.body as { code: string; device_name: string };
      reply.code(201);
      return pair(db, b.code, b.device_name, r.ip);
    },
    pairingCode: async (r, reply) => {
      reply.code(201);
      return createPairingCode(db, owner(r));
    },
    refresh: async (r) =>
      refresh(db, (r.body as { refresh_token: string }).refresh_token),
    devices: async (r) => ({
      items: (
        await db.query(
          'SELECT id,name,created_at,revoked_at FROM devices WHERE owner_id=$1 ORDER BY created_at',
          [owner(r)],
        )
      ).rows.map((d) => ({
        ...d,
        created_at: d.created_at.toISOString(),
        revoked_at: d.revoked_at?.toISOString() ?? null,
      })),
    }),
    revoke: async (r, reply) => {
      await revoke(db, identities.get(r)!, id(r));
      reply.code(204);
      return null;
    },
    createAsset: async (r, reply) => {
      reply.code(201);
      return createAsset(
        db,
        owner(r),
        r.body as Parameters<typeof createAsset>[2],
      );
    },
    messageVersions: async (r) => messageVersions(db, owner(r), id(r)),
    editMessage: async (r) =>
      editMessage(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof editMessage>[3],
      ),
    exportConversation: async (r) => exportConversation(db, owner(r), id(r)),
    readAsset: async (r) => readAsset(db, owner(r), id(r)),
    referenceAsset: async (r) =>
      referenceAsset(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof referenceAsset>[3],
      ),
    previewAssetDeletion: async (r) =>
      previewAssetDeletion(db, owner(r), id(r)),
    deleteAsset: async (r) =>
      deleteAsset(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof deleteAsset>[3],
      ),
    milestone: async (r) =>
      milestone(db, config, owner(r), r.body, identities.get(r)!.deviceId),
    modelRoutes: async (r) => ({ items: await listModelRoutes(db, owner(r)) }),
    branchConversation: async (r) =>
      branchConversation(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof branchConversation>[3],
      ),
    queuedInputs: async (r) => ({
      items: await queuedInputs(db, owner(r), id(r)),
    }),
    queueInput: async (r) =>
      queueInput(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof queueInput>[3],
      ),
    updateQueuedInput: async (r) =>
      updateQueuedInput(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof updateQueuedInput>[3],
      ),
    startQueuedTurn: async (r) =>
      startQueuedTurn(
        db,
        owner(r),
        id(r),
        r.body as Parameters<typeof startQueuedTurn>[3],
      ),
    saveModelRoute: async (r) =>
      saveModelRoute(
        db,
        owner(r),
        r.body as Parameters<typeof saveModelRoute>[2],
      ),
    providers: async (r) => ({
      items: (
        await db.query(
          "SELECT id,name,base_url,model,context_window,max_output_tokens,tools_enabled,vision_enabled,revision,(credential ? 'data') AS credential_present FROM provider_connections WHERE owner_id=$1 ORDER BY id",
          [owner(r)],
        )
      ).rows.map(providerView),
    }),
    createProvider: async (r, reply) => {
      reply.code(201);
      const input = r.body as ProviderInput;
      return input.operation_id
        ? command(
            db,
            owner(r),
            'provider.create',
            input.operation_id,
            input,
            (tx) => createProvider(tx, config, owner(r), input),
          )
        : createProvider(db, config, owner(r), input);
    },
    updateProvider: async (r) =>
      updateProvider(
        db,
        config,
        owner(r),
        id(r),
        Number(r.headers['if-match']),
        r.body as Parameters<typeof updateProvider>[5],
      ),
    send: async (r, reply) => {
      reply.code(202);
      return enqueue(db, owner(r), id(r), r.body as MessageInput);
    },
    messages: async (r) => {
      const room = (
        await db.query('SELECT id FROM rooms WHERE owner_id=$1 AND id=$2', [
          owner(r),
          id(r),
        ])
      ).rowCount;
      if (!room) throw new AppError(404, 'not_found', 'Room not found');
      const q = r.query as { after?: string; limit?: number };
      if (BigInt(q.after ?? '0') > 9223372036854775807n)
        throw new AppError(
          400,
          'invalid_cursor',
          'Cursor exceeds database range',
        );
      const rows = (
        await db.query(
          'SELECT * FROM messages WHERE owner_id=$1 AND room_id=$2 AND NOT internal AND sequence>$3 ORDER BY sequence LIMIT $4',
          [owner(r), id(r), q.after ?? '0', q.limit ?? 50],
        )
      ).rows;
      return {
        items: rows.map(messageView),
        next_cursor: String(rows.at(-1)?.sequence ?? q.after ?? '0'),
      };
    },
    run: async (r) => runView(await getRun(db, owner(r), id(r))),
    cancel: async (r) => cancel(db, owner(r), id(r)),
    sync: async (r) => {
      const q = r.query as { cursor: string; limit?: number };
      return sync(db, owner(r), q.cursor, q.limit);
    },
    snapshot: async (r) => snapshot(db, owner(r)),
    beginSnapshot: async (r, reply) => {
      reply.code(201);
      return beginSnapshot(db, owner(r));
    },
    snapshotPage: async (r) => {
      const q = r.query as { after: string; limit?: number };
      return snapshotPage(db, owner(r), id(r), q.after, q.limit);
    },
    usage: async (r) => ({
      items: (
        await db.query(
          'SELECT id,run_id,attempt,state,input_tokens,output_tokens,estimated_input_tokens,reserved_output_tokens,error_code,created_at FROM usage_ledger WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner(r)],
        )
      ).rows,
    }),
    events: async (r, reply) => {
      let cursor =
        (r.query as { cursor?: string }).cursor ??
        r.headers['last-event-id'] ??
        '0';
      if (typeof cursor !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(cursor))
        throw new AppError(400, 'invalid_cursor', 'Invalid event cursor');
      await sync(db, owner(r), cursor); // Validate before sending stream headers.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      let stopped = false;
      const close = () => {
        stopped = true;
      };
      reply.raw.on('close', close);
      try {
        while (!serverStopping && !stopped && !reply.raw.destroyed) {
          await assertAvailable(db);
          await authenticate(db, r.headers.authorization);
          const batch = await sync(db, owner(r), cursor);
          for (const event of batch.items) {
            if (stopped) break;
            const frame = `id: ${event.cursor}\nevent: sync\ndata: ${JSON.stringify(event)}\n\n`;
            if (reply.raw.writableLength > 262144) {
              stopped = true;
              break;
            }
            reply.raw.write(frame);
            cursor = String(event.cursor);
          }
          if (!batch.items.length) reply.raw.write(': heartbeat\n\n');
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500);
            timeout.unref();
          });
        }
      } catch {
        /* Revocation/expiry ends the stream; REST re-authenticates on reconnect. */
      } finally {
        reply.raw.end();
        reply.raw.off('close', close);
      }
    },
  };
  for (const resource of [
    'worlds',
    'characters',
    'actors',
    'rooms',
    'lore',
  ] as Resource[]) {
    for (const [prefix, method] of [
      ['create', 'POST'],
      ['update', 'PUT'],
      ['delete', 'DELETE'],
    ] as const)
      handlers[`${prefix}${resource}`] = async (r, reply) => {
        const result = await editEntity(
          db,
          owner(r),
          resource,
          method,
          r.body
            ? Object.fromEntries(
                Object.entries(r.body as object).filter(
                  ([k]) => k !== 'operation_id',
                ),
              )
            : undefined,
          method === 'POST' ? undefined : id(r),
          Number(r.headers['if-match']),
          (r.body as any)?.operation_id,
        );
        reply.code(method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200);
        return result;
      };
  }
  for (const [name, route] of Object.entries(routes))
    app.route({
      ...route,
      ...(name === 'importPreview' ? { bodyLimit: 15 * 1024 * 1024 } : {}),
      ...(name === 'hostRPC' ? { bodyLimit: 3 * 1024 * 1024 } : {}),
      ...(name === 'milestone' ? { bodyLimit: 24 * 1024 * 1024 } : {}),
      ...(name === 'createAsset' ? { bodyLimit: 1500000 } : {}),
      preHandler: async (r) => {
        await assertAvailable(db);
        if (route.schema.security.length)
          identities.set(r, await authenticate(db, r.headers.authorization));
      },
      handler: handlers[name]!,
    });
  return app;
}
