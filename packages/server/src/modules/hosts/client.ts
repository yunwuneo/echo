import { Agent, fetch } from 'undici';
import { resolveEndpoint, AppError } from '../../security.js';
import type { Config } from '../../config.js';
export async function hostHTTP(
  config: Config,
  baseURL: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const { base, addresses } = await resolveEndpoint(baseURL, config);
  const dispatcher = new Agent({
    connect: {
      lookup: (_h, o, cb) => {
        const a =
          addresses.find((x) => !o.family || x.family === o.family) ??
          addresses[0]!;
        cb(null, a.address, a.family);
      },
    },
  });
  try {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(config.modelTimeoutMs),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reader = r.body?.getReader();
    let bytes = 0;
    const chunks: Buffer[] = [];
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 3 * 1048576) {
          await reader.cancel();
          throw new AppError(
            413,
            'host_response_limit',
            'Host response exceeded limit',
          );
        }
        chunks.push(Buffer.from(part.value));
      }
    const data = Buffer.concat(chunks).toString('utf8');
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new AppError(
        502,
        'host_invalid_response',
        'Host did not return JSON',
      );
    }
    if (!r.ok)
      throw new AppError(
        r.status,
        value.error?.code ?? 'host_http',
        'Host request failed',
      );
    return value;
  } finally {
    await dispatcher.close();
  }
}
