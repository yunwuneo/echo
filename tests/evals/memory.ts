import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  rankMemories,
  terms,
} from '../../packages/server/src/modules/memory/retrieval.js';
const corpus = JSON.parse(
  await readFile('tests/evals/chinese-memory.json', 'utf8'),
);
const memories = corpus.memories.map((m: any) => ({
  ...m,
  terms: terms(m.content + ' ' + m.topic),
}));
let positives = 0,
  hits = 0,
  negatives = 0,
  falsePositives = 0;
const misses: any[] = [];
for (const q of corpus.queries) {
  const result = rankMemories(memories, q.query);
  if (q.expected) {
    positives++;
    if (result.some((r) => r.id === q.expected)) hits++;
    else misses.push({ ...q, retrieved: result.map((r) => r.id) });
  } else {
    negatives++;
    if (result.length) falsePositives++;
  }
}
const report = {
  corpus_version: corpus.version,
  mode: 'synthetic_lexical_only',
  queries: corpus.queries.length,
  positives,
  recall_at_5: hits / positives,
  negatives,
  false_positives: falsePositives,
  misses,
  model_calls: 0,
};
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/p3-memory-eval.json',
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (hits / positives < 0.9 || falsePositives) process.exitCode = 1;
