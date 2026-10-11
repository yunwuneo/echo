import { spawnSync } from 'node:child_process';
for (const script of ['tests/evals/memory.ts', 'scripts/story-eval.ts']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
