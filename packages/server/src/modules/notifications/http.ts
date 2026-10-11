import { Agent, fetch } from 'undici';
import { resolveEndpoint, AppError } from '../../security.js';
import type { Config } from '../../config.js';
// Dedicated, bounded JSON transport. No redirects, ambient credentials or unpinned DNS.
export async function relayRequest(
  config: Config,
  base: string,
  path: string,
  ticket?: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const { addresses } = await resolveEndpoint(base, config);
  const agent = new Agent({
    connect: {
      lookup: (_host, options, cb) => {
        const a =
          addresses.find(
            (a) => !options.family || a.family === options.family,
          ) ?? addresses[0]!;
        cb(null, options.all ? addresses : a.address, a.family);
      },
    },
  });
  try {
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      dispatcher: agent,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        'content-type': 'application/json',
        ...(ticket ? { authorization: `Bearer ${ticket}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    let text = '';
    for await (const part of response.body ?? []) {
      text += Buffer.from(part).toString('utf8');
      if (text.length > 16384)
        throw new AppError(
          502,
          'relay_response_limit',
          'Relay response exceeded limit',
        );
    }
    if (!response.ok)
      throw new AppError(
        response.status,
        'relay_rejected',
        'Relay rejected request',
      );
    return JSON.parse(text);
  } finally {
    await agent.destroy();
  }
}
