import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { Agent, fetch as request } from 'undici';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Config } from '../../config.js';
import { AppError, blockedIP, decrypt } from '../../security.js';
import { supported, matches, fingerprint } from './schema.js';
export async function resolveMcp(
  value: string,
  allowed: string[],
  resolver: (
    host: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = lookup,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'invalid_endpoint', 'Invalid MCP URL');
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new AppError(
      400,
      'invalid_endpoint',
      'MCP requires an HTTP(S) endpoint without URL credentials',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((a) => {
      const ip = a.address.toLowerCase();
      const forbidden =
        ip.startsWith('169.254.') ||
        /^fe[89ab]/.test(ip) ||
        ip.startsWith('::ffff:') ||
        ip === '100.100.100.200' ||
        (isIP(ip) === 4 &&
          (Number(ip.split('.')[0]) === 0 ||
            Number(ip.split('.')[0]) >= 224)) ||
        ip === '::' ||
        ip.startsWith('ff');
      return forbidden || (blockedIP(ip) && !allowed.includes(ip));
    })
  )
    throw new AppError(
      400,
      'blocked_destination',
      'MCP destination is not permitted',
    );
  if (
    url.protocol === 'http:' &&
    addresses.some((a) => !allowed.includes(a.address))
  )
    throw new AppError(
      400,
      'insecure_endpoint',
      'HTTP requires explicitly permitted addresses on this connection',
    );
  return { url, addresses };
}
const validator: jsonSchemaValidator = {
  getValidator<T>(s: any) {
    return (input: unknown) =>
      supported(s) && matches(s, input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : {
            valid: false,
            data: undefined,
            errorMessage: 'Unsupported or invalid output schema',
          };
  },
};
export async function connectMcp(
  connection: any,
  config: Config,
  signal: AbortSignal,
) {
  const origin = new URL(connection.url).origin,
    agents: Agent[] = [];
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const credential = connection.credential
    ? decrypt(
        connection.credential,
        config,
        `${connection.owner_id}:mcp:${connection.id}`,
      )
    : null;
  let total = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (target.origin !== origin)
      throw new AppError(
        400,
        'mcp_origin_changed',
        'Cross-origin MCP endpoints are disabled',
      );
    const { addresses } = await resolveMcp(
      target.href,
      connection.private_addresses,
    );
    const agent = new Agent({
      connect: {
        lookup: (_host, options, callback) => {
          const selected =
            addresses.find(
              (a) => !options.family || a.family === options.family,
            ) ?? addresses[0]!;
          callback(
            null,
            options.all ? addresses : selected.address,
            selected.family,
          );
        },
      },
    });
    agents.push(agent);
    const headers = new Headers(init?.headers);
    if (credential)
      headers.set(
        connection.auth_type === 'bearer'
          ? 'Authorization'
          : connection.header_name,
        connection.auth_type === 'bearer' ? `Bearer ${credential}` : credential,
      );
    const response = await request(target, {
      ...(init as any),
      headers: Object.fromEntries(headers),
      dispatcher: agent,
      redirect: 'error',
      signal: init?.signal
        ? AbortSignal.any([init.signal, combined])
        : combined,
    });
    if (!response.body)
      return new Response(null, {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            c.close();
            return;
          }
          total += r.value.length;
          if (total > 1048576) {
            controller.abort();
            throw new AppError(
              413,
              'mcp_response_limit',
              'MCP connection response limit exceeded',
            );
          }
          c.enqueue(r.value);
        } catch (e) {
          c.error(e);
          await reader.cancel().catch(() => {});
        }
      },
      async cancel() {
        await reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
  const options = {
    fetch: guardedFetch,
    requestInit: { redirect: 'error' as const },
    redirectPolicy: 'follow' as const,
  };
  const transport =
    connection.transport === 'sse'
      ? new SSEClientTransport(new URL(connection.url), {
          ...options,
          eventSourceInit: { fetch: guardedFetch },
        })
      : new StreamableHTTPClientTransport(new URL(connection.url), {
          ...options,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        });
  const client = new Client(
    { name: 'Echo', version: '0.4.0' },
    { capabilities: {}, jsonSchemaValidator: validator },
  );
  const close = async () => {
    controller.abort();
    await client.close().catch(() => {});
    await Promise.allSettled(agents.map((a) => a.destroy()));
  };
  const abort = () => {
    void close();
  };
  combined.addEventListener(
    'abort',
    () => {
      void client.close().catch(() => {});
    },
    { once: true },
  );
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport, { timeout: 30000, signal: combined });
  } catch {
    await close();
    signal.removeEventListener('abort', abort);
    throw new AppError(
      503,
      'mcp_connect_failed',
      'MCP connection failed; check endpoint and authentication',
    );
  }
  return {
    client,
    close: async () => {
      signal.removeEventListener('abort', abort);
      await close();
    },
  };
}
export async function discover(client: Client, signal: AbortSignal) {
  const tools: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout: 30000,
    });
    for (const tool of result.tools) {
      if (tools.some((t) => t.name === tool.name) || tools.length >= 128)
        throw new AppError(
          400,
          'mcp_discovery_limit',
          'Duplicate tools or discovery limit exceeded',
        );
      tools.push({
        ...tool,
        schema_hash: fingerprint(tool),
        supported:
          Buffer.byteLength(JSON.stringify(tool)) <= 16384 &&
          supported(tool.inputSchema) &&
          (!tool.outputSchema || supported(tool.outputSchema)),
      });
    }
    cursor = result.nextCursor;
    if (!cursor) return tools;
  }
  throw new AppError(400, 'mcp_discovery_limit', 'Too many tool pages');
}

export function hideCredential(
  connection: any,
  config: Config,
  value: unknown,
) {
  if (!connection.credential) return value;
  const secret = decrypt(
    connection.credential,
    config,
    `${connection.owner_id}:mcp:${connection.id}`,
  );
  const encoded = JSON.stringify(secret).slice(1, -1);
  return JSON.parse(JSON.stringify(value).replaceAll(encoded, '[REDACTED]'));
}
