import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamModel } from '../../packages/server/src/modules/llm/index.js';
import { modelPayload } from '../../packages/server/src/modules/llm/request.js';
import { loadConfig } from '../../packages/server/src/config.js';
import { encrypt } from '../../packages/server/src/security.js';
const config = loadConfig({
  DATABASE_URL: 'unused',
  MASTER_KEY: '01'.repeat(32),
  ALLOW_INSECURE_LOCAL: 'true',
});
for (const protocol of ['claude', 'gemini', 'vertex'])
  it(
    'T19 ' +
      protocol +
      ' sends actual protocol payload, validates usage and omits hidden thinking',
    async () => {
      let request: any;
      const events =
        protocol === 'claude'
          ? [
              {
                type: 'message_start',
                message: { usage: { input_tokens: 7, output_tokens: 0 } },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'thinking_delta',
                  thinking: 'private reasoning',
                },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: 'hello' },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 2 },
              },
              { type: 'message_stop' },
            ]
          : [
              {
                candidates: [
                  {
                    index: 0,
                    content: {
                      parts: [
                        { text: 'private reasoning', thought: true },
                        { text: 'hello' },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
              },
            ];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        request = {
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body),
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of events)
          res.write('data: ' + JSON.stringify(e) + '\n\n');
        res.end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const c: any = {
          run: { owner_id: 'owner' },
          provider: {
            id: 'p',
            protocol,
            base_url:
              'http://127.0.0.1:' + (server.address() as any).port + '/v1',
            model:
              protocol === 'vertex'
                ? 'projects/demo/locations/us-central1/publishers/google/models/gemini-test'
                : 'fixture',
            max_output_tokens: 100,
            credential: encrypt('synthetic-secret', config, 'owner:p'),
          },
          messages: [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: 'question' },
          ],
        };
        const output = await streamModel(
          c,
          config,
          AbortSignal.timeout(3000),
          async () => {},
        );
        expect(output).toMatchObject({
          content: 'hello',
          usage: { input: 7, output: 2 },
        });
        expect(request.body).toEqual(modelPayload(c));
        expect(JSON.stringify(output)).not.toContain('private reasoning');
        expect(request.url).toContain(
          protocol === 'claude'
            ? '/messages'
            : ':streamGenerateContent?alt=sse',
        );
        expect(
          request.headers[
            protocol === 'claude'
              ? 'x-api-key'
              : protocol === 'gemini'
                ? 'x-goog-api-key'
                : 'authorization'
          ],
        ).toContain('synthetic-secret');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
it('T19 native tool/image payloads retain function IDs and unsupported parameters fail before HTTP', () => {
  const c: any = {
    provider: { protocol: 'claude', model: 'fixture', max_output_tokens: 10 },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,YQ==' },
          },
        ],
      },
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'read', parameters: { type: 'object' } },
      },
    ],
  };
  const p: any = modelPayload(c);
  expect(p.messages[0].content[0].source.media_type).toBe('image/png');
  expect(p.messages[2].content[0].tool_use_id).toBe('c1');
  expect(p.tool_choice.disable_parallel_tool_use).toBe(true);
  expect(() =>
    modelPayload({
      ...c,
      provider: { ...c.provider, parameters: { frequency_penalty: 1 } },
    }),
  ).toThrow();
});
import { ProtocolFrames } from '../../packages/server/src/modules/llm/protocol.js';
it('T19 interrupted Claude and signed Gemini function continuations are explicit failures', () => {
  expect(() =>
    new ProtocolFrames('claude').frame({ type: 'message_stop' }),
  ).toThrow();
  expect(() =>
    new ProtocolFrames('gemini').frame({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'read', args: {} },
                thoughtSignature: 'signature',
              },
            ],
          },
        },
      ],
    }),
  ).toThrow();
});
