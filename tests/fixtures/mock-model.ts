import { createServer, type ServerResponse } from 'node:http';
export type Mode =
  | 'success'
  | 'partial'
  | 'malformed'
  | 'no-usage'
  | 'rate-limit'
  | 'hold'
  | 'tool'
  | 'length';
export async function mockModel() {
  let mode: Mode = 'success',
    calls = 0;
  const requests: any[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (req, res) => {
    calls++;
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const parsed = JSON.parse(body);
    if (parsed.messages?.[0]?.content?.startsWith('从资料提取')) {
      const source = JSON.parse(parsed.messages.at(-1).content).find(
        (m: any) => m.role === 'user',
      );
      const content = JSON.stringify({
        candidates: source
          ? [
              {
                content: source.content,
                topic: source.content.slice(0, 2),
                kind: 'statement',
                source_ids: [source.id],
              },
            ]
          : [],
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (mode === 'rate-limit') {
      res.writeHead(429);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    const send = (obj: unknown) =>
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (mode === 'hold') return;
    if (mode === 'malformed') {
      res.end('data: {bad}\n\n');
      return;
    }
    if (mode === 'tool') {
      send({
        choices: [
          { index: 0, delta: { tool_calls: [{ name: 'unapproved' }] } },
        ],
      });
      res.end();
      return;
    }
    send({ choices: [{ index: 0, delta: { content: '星港' } }] });
    if (mode === 'partial') {
      setTimeout(() => res.destroy(), 700);
      return;
    }
    const finish = (response: ServerResponse) => {
      send({ choices: [{ index: 0, delta: { content: '已收到。' } }] });
      send({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mode === 'length' ? 'length' : 'stop',
          },
        ],
      });
      if (mode !== 'no-usage')
        send({
          choices: [],
          usage: { prompt_tokens: 24, completion_tokens: 8 },
        });
      response.end('data: [DONE]\n\n');
    };
    setTimeout(() => finish(res), 350);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock port');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    setMode: (value: Mode) => {
      mode = value;
    },
    get calls() {
      return calls;
    },
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
