import { AppError } from '../../security.js';
const fail = (code: string): never => {
  throw new AppError(
    409,
    code,
    'Configured protocol does not support this request',
  );
};
export function protocolRequest(c: {
  provider: any;
  messages: any[];
  tools?: any[];
}) {
  const p = c.provider,
    protocol = p.protocol ?? 'openai',
    parameters = p.parameters ?? {};
  if (protocol === 'openai')
    return {
      ...parameters,
      model: p.model,
      messages: c.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: p.max_output_tokens,
      ...(c.tools?.length
        ? { tools: c.tools, parallel_tool_calls: false, tool_choice: 'auto' }
        : {}),
    };
  if (
    Object.keys(parameters).some(
      (k) => !['temperature', 'top_p', 'top_k', 'stop'].includes(k),
    )
  )
    fail('protocol_parameter_unsupported');
  const systems = c.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content);
  if (systems.some((s) => typeof s !== 'string'))
    fail('protocol_system_unsupported');
  const names = new Map<string, string>();
  for (const m of c.messages)
    for (const t of m.tool_calls ?? []) names.set(t.id, t.function.name);
  const image = (v: any) => {
    const match =
      /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
        v.image_url?.url ?? '',
      );
    if (!match) fail('protocol_image_unsupported');
    return { mime: match![1], data: match![2] };
  };
  const parts = (m: any, claude: boolean) => {
    if (m.role === 'tool') {
      const name = names.get(m.tool_call_id);
      if (!name) fail('protocol_tool_history');
      return [
        claude
          ? {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content,
            }
          : { functionResponse: { name, response: { result: m.content } } },
      ];
    }
    const content =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : (m.content ?? []);
    const result = content
      .filter((x: any) => x.type !== 'text' || x.text)
      .map((x: any) => {
        if (x.type === 'text') return claude ? x : { text: x.text };
        if (x.type === 'image_url') {
          const i = image(x);
          return claude
            ? {
                type: 'image',
                source: { type: 'base64', media_type: i.mime, data: i.data },
              }
            : { inlineData: { mimeType: i.mime, data: i.data } };
        }
        return fail('protocol_content_unsupported');
      });
    for (const t of m.tool_calls ?? []) {
      let args;
      try {
        args = JSON.parse(t.function.arguments);
      } catch {
        fail('protocol_tool_history');
      }
      result.push(
        claude
          ? { type: 'tool_use', id: t.id, name: t.function.name, input: args }
          : { functionCall: { name: t.function.name, args } },
      );
    }
    return result;
  };
  const functions = c.tools?.map((t) => t.function) ?? [];
  if (protocol === 'claude')
    return {
      ...Object.fromEntries(
        Object.entries(parameters).filter(([k]) => k !== 'stop'),
      ),
      model: p.model,
      stream: true,
      max_tokens: p.max_output_tokens,
      ...(systems.length ? { system: systems.join('\n\n') } : {}),
      messages: c.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: parts(m, true),
        })),
      ...(parameters.stop ? { stop_sequences: parameters.stop } : {}),
      ...(functions.length
        ? {
            tools: functions.map((f) => ({
              name: f.name,
              description: f.description,
              input_schema: f.parameters,
            })),
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          }
        : {}),
    };
  if (!['gemini', 'vertex'].includes(protocol)) fail('protocol_unsupported');
  return {
    contents: c.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: parts(m, false),
      })),
    ...(systems.length
      ? { systemInstruction: { parts: [{ text: systems.join('\n\n') }] } }
      : {}),
    generationConfig: {
      maxOutputTokens: p.max_output_tokens,
      ...(parameters.temperature !== undefined
        ? { temperature: parameters.temperature }
        : {}),
      ...(parameters.top_p !== undefined ? { topP: parameters.top_p } : {}),
      ...(parameters.top_k !== undefined ? { topK: parameters.top_k } : {}),
      ...(parameters.stop ? { stopSequences: parameters.stop } : {}),
    },
    ...(functions.length
      ? {
          tools: [
            {
              functionDeclarations: functions.map((f) => ({
                name: f.name,
                description: f.description,
                parametersJsonSchema: f.parameters,
              })),
            },
          ],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }
      : {}),
  };
}
export function protocolEndpoint(p: any, base: string, secret: string) {
  switch (p.protocol ?? 'openai') {
    case 'openai':
      return {
        url: base + '/chat/completions',
        headers: { Authorization: 'Bearer ' + secret },
      };
    case 'claude':
      return {
        url: base + '/messages',
        headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
      };
    case 'gemini':
      return {
        url:
          base +
          '/models/' +
          encodeURIComponent(p.model) +
          ':streamGenerateContent?alt=sse',
        headers: { 'x-goog-api-key': secret },
      };
    case 'vertex': {
      if (
        !/^projects\/[a-zA-Z0-9_-]+\/locations\/[a-zA-Z0-9_-]+\/publishers\/google\/models\/[a-zA-Z0-9_.-]+$/.test(
          p.model,
        )
      )
        fail('vertex_model_resource');
      return {
        url: base + '/' + p.model + ':streamGenerateContent?alt=sse',
        headers: { Authorization: 'Bearer ' + secret },
      };
    }
    default:
      return fail('protocol_unsupported');
  }
}
/** Normalize only visible text and declared function calls; never persist thinking deltas. */
export class ProtocolFrames {
  private input = 0;
  private output = 0;
  private toolIndex = -1;
  private tool = false;
  private stopped = false;
  private serial = 0;
  constructor(readonly protocol: string) {}
  frame(v: any): any[] {
    if (this.protocol === 'openai') return [v];
    if (v.error || v.type === 'error') return fail('model_stream_error');
    const chunk = (delta: any = {}, reason: any = null, usage?: any) => ({
      choices: [{ index: 0, delta, finish_reason: reason }],
      ...(usage ? { usage } : {}),
    });
    if (this.protocol === 'claude') {
      if (v.type === 'message_start') {
        this.input = v.message?.usage?.input_tokens ?? 0;
        this.output = v.message?.usage?.output_tokens ?? 0;
        return [];
      }
      if (
        v.type === 'content_block_start' &&
        v.content_block?.type === 'tool_use'
      ) {
        if (this.tool) return fail('parallel_tools_not_supported');
        this.tool = true;
        this.toolIndex = v.index;
        return [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: v.content_block.id,
                type: 'function',
                function: { name: v.content_block.name, arguments: '' },
              },
            ],
          }),
        ];
      }
      if (v.type === 'content_block_delta') {
        if (v.delta?.type === 'text_delta')
          return [chunk({ content: v.delta.text })];
        if (v.delta?.type === 'input_json_delta') {
          if (v.index !== this.toolIndex) return fail('invalid_tool_call');
          return [
            chunk({
              tool_calls: [
                { index: 0, function: { arguments: v.delta.partial_json } },
              ],
            }),
          ];
        }
      }
      if (v.type === 'message_delta') {
        this.output = v.usage?.output_tokens ?? this.output;
        const reason = v.delta?.stop_reason;
        if (reason) {
          this.stopped = true;
          return [
            chunk(
              {},
              reason === 'tool_use'
                ? 'tool_calls'
                : reason === 'end_turn' || reason === 'stop_sequence'
                  ? 'stop'
                  : 'length',
              { prompt_tokens: this.input, completion_tokens: this.output },
            ),
          ];
        }
      }
      if (v.type === 'message_stop') {
        if (!this.stopped) return fail('model_stream_interrupted');
        return ['[DONE]'];
      }
      return [];
    }
    if (v.promptFeedback?.blockReason) return fail('model_content_blocked');
    const result: any[] = [];
    for (const c of v.candidates ?? []) {
      if (c.index !== undefined && c.index !== 0)
        return fail('parallel_candidates_unsupported');
      for (const p of c.content?.parts ?? []) {
        if (p.thought) continue;
        if (p.functionCall) {
          if (p.thoughtSignature)
            return fail('protocol_tool_signature_unsupported');
          if (this.tool) return fail('parallel_tools_not_supported');
          this.tool = true;
          result.push(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'echo_google_' + ++this.serial,
                  type: 'function',
                  function: {
                    name: p.functionCall.name,
                    arguments: JSON.stringify(p.functionCall.args ?? {}),
                  },
                },
              ],
            }),
          );
        } else if (typeof p.text === 'string')
          result.push(chunk({ content: p.text }));
      }
      if (c.finishReason) {
        this.stopped = true;
        result.push(
          chunk(
            {},
            c.finishReason === 'STOP'
              ? this.tool
                ? 'tool_calls'
                : 'stop'
              : 'length',
          ),
        );
      }
    }
    if (v.usageMetadata)
      result.push({
        choices: [],
        usage: {
          prompt_tokens: v.usageMetadata.promptTokenCount,
          completion_tokens: v.usageMetadata.candidatesTokenCount ?? 0,
        },
      });
    return result;
  }
  end() {
    if (['gemini', 'vertex'].includes(this.protocol) && this.stopped)
      return ['[DONE]'];
    return [];
  }
}
