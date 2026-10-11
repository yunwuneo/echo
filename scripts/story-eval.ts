import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  stories,
  storyPrompt,
  rubric,
  corpusVersion,
  Budget,
  grade,
} from '../tests/evals/stories.js';
import { streamModel } from '../packages/server/src/modules/llm/index.js';
import { loadConfig } from '../packages/server/src/config.js';
import { encrypt } from '../packages/server/src/security.js';

const args = process.argv.slice(2);
await mkdir('.local', { recursive: true });
if (args[0] === '--grade') {
  const report = JSON.parse(await readFile(args[1]!, 'utf8')),
    ratings = JSON.parse(await readFile(args[2]!, 'utf8'));
  const result = grade(report, ratings);
  await writeFile(
    args[1]! + '.grades.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'passed') process.exitCode = 1;
} else if (!args.length) {
  const hashes = [];
  for (const s of stories) {
    if (s.turns.length < 3 || !s.expected)
      throw new Error('Missing multiround story or scoring reference');
    for (let i = 0; i < s.turns.length; i++)
      hashes.push(
        storyPrompt(s, i, Array(i).fill('离线占位，不作质量评分。')).manifest
          .prompt_hash,
      );
  }
  const report = {
    mode: 'offline_compile_only',
    corpus_version: corpusVersion,
    corpus_sha256: createHash('sha256')
      .update(JSON.stringify(stories))
      .digest('hex'),
    stories: stories.length,
    compiled_turns: hashes.length,
    compiler_version: 2,
    model_calls: 0,
    quality_status: 'not_evaluated',
    rubric,
    prompt_hashes: hashes,
  };
  await writeFile(
    '.local/p6-story-offline.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      stories: stories.length,
      compiled_turns: hashes.length,
      model_calls: 0,
      quality_status: report.quality_status,
    }) + '\n',
  );
} else {
  if (args[0] !== '--live' || args.length !== 2)
    throw new Error(
      'Usage: story-eval.ts [--live config.json | --grade report.json ratings.json]',
    );
  const input = JSON.parse(await readFile(resolve(args[1]!), 'utf8'));
  if (
    !Array.isArray(input.providers) ||
    input.providers.length < 2 ||
    input.providers.length > 4
  )
    throw new Error('Select two to four explicit model configurations');
  const names = new Set<string>();
  for (const p of input.providers) {
    const u = new URL(p.base_url);
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(p.name) ||
      names.has(p.name) ||
      !p.model ||
      !process.env[p.api_key_env] ||
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error(
        'Invalid explicit HTTPS model configuration or missing key environment variable',
      );
    names.add(p.name);
  }
  const budget = new Budget(input.budget);
  const config = loadConfig({
    DATABASE_URL: 'postgresql://unused/unused',
    MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://synthetic.invalid',
  });
  const output = resolve('.local', `p6-models-${randomUUID()}.json`);
  const report: any = {
    mode: 'live',
    started_at: new Date().toISOString(),
    corpus_version: corpusVersion,
    corpus_sha256: createHash('sha256')
      .update(JSON.stringify(stories))
      .digest('hex'),
    compiler_version: 2,
    parameters: {
      stream: true,
      max_tokens: 512,
      temperature: 'omitted_provider_default',
    },
    providers: input.providers.map(({ name, base_url, model }: any) => ({
      name,
      base_url,
      model,
    })),
    rubric,
    quality_status: 'awaiting_human_ratings',
    budget: input.budget,
    reserved: {},
    results: [],
  };
  const save = async () => {
    report.reserved = {
      requests: budget.requests,
      input_tokens: budget.input,
      output_tokens: budget.output,
    };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  try {
    for (const p of input.providers)
      for (const story of stories)
        for (let repeat = 1; repeat <= 3; repeat++) {
          const result: any = {
            provider: p.name,
            story: story.id,
            repeat,
            expected: story.expected,
            turns: [],
          };
          report.results.push(result);
          const replies: string[] = [];
          for (let turn = 0; turn < story.turns.length; turn++) {
            const compiled = storyPrompt(story, turn, replies);
            budget.reserve(compiled.manifest.estimated_input_tokens, 512);
            const record: any = {
              input: story.turns[turn],
              prompt_hash: compiled.manifest.prompt_hash,
              state: 'reserved',
            };
            result.turns.push(record);
            await save(); // Reserve before sending; unknown outcomes remain charged and are never retried.
            const t = performance.now();
            let first: number | undefined;
            try {
              const response = await streamModel(
                {
                  run: { owner_id: 'synthetic-evaluation' } as any,
                  provider: {
                    id: p.name,
                    base_url: p.base_url,
                    model: p.model,
                    max_output_tokens: 512,
                    credential: encrypt(
                      process.env[p.api_key_env]!,
                      config,
                      `synthetic-evaluation:${p.name}`,
                    ),
                  } as any,
                  messages: compiled.messages,
                },
                config,
                AbortSignal.timeout(60000),
                async () => {
                  first ??= performance.now() - t;
                },
              );
              Object.assign(record, {
                state: 'completed',
                content: response.content,
                usage: response.usage,
                first_token_ms: first,
                completed_ms: performance.now() - t,
              });
              replies.push(response.content);
            } catch {
              record.state = 'failed_or_unknown';
              record.error = 'model_request_failed';
              throw new Error('Model request failed; no automatic retry');
            }
            await save();
          }
        }
    report.finished_at = new Date().toISOString();
  } catch (e) {
    report.stopped_reason = String(e);
    process.exitCode = 1;
  } finally {
    await save();
    process.stdout.write(
      `Evaluation evidence: ${output}\nHuman scoring is required.\n`,
    );
  }
}
