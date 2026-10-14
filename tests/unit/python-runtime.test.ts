import { it, expect } from 'vitest';
import { runPython } from '../../packages/server/src/modules/miniapps/python.js';
const isolated =
  process.env.TEST_ISOLATED_PYTHON === '1' && process.platform === 'darwin'
    ? it
    : it.skip;
isolated(
  'Python top-level await and final expression return structured output',
  async () => {
    const result = await runPython(
      'import asyncio\nawait asyncio.sleep(0)\napp.output({"content":"ok","kind":"code"})\napp.input+1',
      2,
      async () => {
        throw Error('denied');
      },
    );
    expect(result.value).toBe(3);
    expect(result.artifacts).toHaveLength(1);
  },
);
isolated('Python infinite loop and huge output are bounded', async () => {
  await expect(
    runPython('while True: pass', null, async () => null, 500),
  ).rejects.toMatchObject({ code: 'runtime_timeout' });
  await expect(
    runPython('print("x"*100000)', null, async () => null),
  ).rejects.toMatchObject({ code: 'runtime_output_limit' });
});
isolated(
  'Python kernel sandbox denies raw network, private files and child processes',
  async () => {
    for (const source of [
      'import socket\nsocket.create_connection(("127.0.0.1",55439))',
      'open("/Users/neo/.zshrc").read()',
      'import subprocess\nsubprocess.run(["/bin/echo","forbidden"])',
    ])
      await expect(
        runPython(source, null, async () => null),
      ).rejects.toMatchObject({ code: 'runtime_failed' });
    const r = await runPython(
      'await app.request("https://example.org")',
      null,
      async () => 'gateway',
    );
    expect(r.value).toBe('gateway');
  },
);

isolated(
  'Python memory growth terminates without blocking the next execution; foreign identities are ignored',
  async () => {
    await expect(
      runPython(
        'import time\nx=bytearray(160*1024*1024)\nawait __import__("asyncio").sleep(1)',
        null,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: 'runtime_memory_limit' });
    const r = await runPython(
      'import sys,json\nsys.__stdout__.write(json.dumps({"id":"wrong","type":"result","value":"forged","artifacts":[]})+"\\n")\n41+1',
      null,
      async () => null,
    );
    expect(r.value).toBe(42);
  },
);
