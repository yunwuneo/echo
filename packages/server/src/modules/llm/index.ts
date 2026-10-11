import type { Config } from '../../config.js';
import { Agent, fetch } from 'undici';
import { decrypt, resolveEndpoint } from '../../security.js';
import type { Claim, Usage } from '../runs/repository.js';
export class ModelError extends Error {
  constructor(
    public code: string,
    public retryable = false,
  ) {
    super(code);
  }
}
export async function streamModel(
  c: Pick<Claim, 'provider' | 'run' | 'messages'> & { tools?: any[] },
  config: Config,
  signal: AbortSignal,
  onContent: (content: string) => Promise<void>,
): Promise<{
  content: string;
  usage: Usage | null;
  tool?: { id: string; name: string; arguments: string };
}> {
  const { base, addresses } = await resolveEndpoint(
    c.provider.base_url,
    config,
  );
  const credential = decrypt(
    c.provider.credential,
    config,
    `${c.run.owner_id}:${c.provider.id}`,
  );
  const dispatcher = new Agent({
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
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${base}/chat/completions`, {
      dispatcher,
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        model: c.provider.model,
        messages: c.messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: c.provider.max_output_tokens,
        ...(c.tools?.length
          ? { tools: c.tools, parallel_tool_calls: false, tool_choice: 'auto' }
          : {}),
      }),
    });
  } catch {
    await dispatcher.close();
    throw new ModelError(
      signal.aborted ? 'model_timeout' : 'model_unavailable',
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    await dispatcher.close();
    throw new ModelError(
      `model_http_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    await response.body?.cancel();
    await dispatcher.close();
    throw new ModelError('invalid_model_stream');
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let tool: { id: string; name: string; arguments: string } | undefined;
  let buffer = '',
    content = '',
    usage: Usage | null = null,
    done = false,
    stopped = false;
  const frame = async (raw: string) => {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (done) throw new ModelError('invalid_model_stream');
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      throw new ModelError('invalid_model_stream');
    }
    if (json.error || !Array.isArray(json.choices))
      throw new ModelError('invalid_model_stream');
    if (json.usage) {
      const input = json.usage.prompt_tokens,
        output = json.usage.completion_tokens;
      if (
        Number.isSafeInteger(input) &&
        input >= 0 &&
        Number.isSafeInteger(output) &&
        output >= 0
      )
        usage = { input, output };
    }
    for (const choice of json.choices) {
      if (choice.index !== 0) throw new ModelError('invalid_model_stream');
      const delta = choice.delta;
      if (delta?.function_call) throw new ModelError('tools_not_supported');
      if (delta?.tool_calls) {
        if (!c.tools?.length || !Array.isArray(delta.tool_calls) || stopped)
          throw new ModelError('tools_not_supported');
        for (const part of delta.tool_calls) {
          if (part.index !== 0 || (part.type && part.type !== 'function'))
            throw new ModelError('parallel_tools_not_supported');
          tool ??= { id: '', name: '', arguments: '' };
          for (const [key, value] of Object.entries({
            id: part.id,
            name: part.function?.name,
            arguments: part.function?.arguments,
          })) {
            if (value !== undefined) {
              if (typeof value !== 'string')
                throw new ModelError('invalid_tool_call');
              tool[key as keyof typeof tool] += value;
            }
          }
          if (
            Buffer.byteLength(tool.arguments) > 16384 ||
            tool.id.length > 128 ||
            tool.name.length > 128
          )
            throw new ModelError('tool_arguments_limit');
        }
      }
      if (delta?.content !== undefined && delta.content !== null) {
        if (stopped || typeof delta.content !== 'string')
          throw new ModelError('invalid_model_stream');
        content += delta.content;
        if (Buffer.byteLength(content) > 65536)
          throw new ModelError('output_limit_exceeded');
        await onContent(content);
      }
      if (choice.finish_reason) {
        if (choice.finish_reason !== (tool ? 'tool_calls' : 'stop'))
          throw new ModelError('model_output_incomplete');
        stopped = true;
      }
    }
  };
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder
        .decode(part.value, { stream: true })
        .replace(/\r\n/g, '\n');
      if (Buffer.byteLength(buffer) > 131072)
        throw new ModelError('invalid_model_stream');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        await frame(raw);
      }
    }
    if (
      !done ||
      !stopped ||
      (!content && !tool) ||
      (tool && (!tool.id || !tool.name || !tool.arguments))
    )
      throw new ModelError('model_stream_interrupted');
    return { content, usage, ...(tool ? { tool } : {}) };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(
      signal.aborted ? 'model_timeout' : 'model_stream_interrupted',
      !content,
    );
  } finally {
    await reader.cancel().catch(() => {});
    await dispatcher.close();
  }
}
