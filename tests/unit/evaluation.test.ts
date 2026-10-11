import { it, expect } from 'vitest';
import { Budget, grade, stories } from '../evals/stories.js';
it('reserves failed/unknown requests and never crosses any evaluation budget', () => {
  const b = new Budget({ requests: 2, input_tokens: 10, output_tokens: 4 });
  b.reserve(6, 2);
  expect(() => b.reserve(5, 2)).toThrow('budget');
  expect(b.requests).toBe(1);
  b.reserve(4, 2);
  expect(() => b.reserve(0, 0)).toThrow('budget');
  expect(b.input).toBe(10);
  expect(() => new Budget({ requests: 1 } as any)).toThrow();
  expect(() =>
    new Budget({ requests: 1, input_tokens: 1, output_tokens: 1 }).reserve(
      -1,
      0,
    ),
  ).toThrow();
  expect(
    () => new Budget({ requests: 0, input_tokens: 1, output_tokens: 1 }),
  ).toThrow();
});
it('requires complete real transcripts and human evidence; a critical failure cannot be averaged away', () => {
  const report = {
    mode: 'live',
    providers: [
      { name: 'a', model: 'a', base_url: 'https://synthetic.invalid' },
      { name: 'b', model: 'b', base_url: 'https://synthetic.invalid' },
    ],
    results: ['a', 'b'].flatMap((provider) =>
      stories.flatMap((s) =>
        [1, 2, 3].map((repeat) => ({
          provider,
          story: s.id,
          repeat,
          turns: Array(3).fill({ content: '合成评分验证文本' }),
        })),
      ),
    ),
  };
  const ratings = report.results.map((r) => ({
    key: `${r.provider}/${r.story}/${r.repeat}`,
    reviewer: 'synthetic-test',
    notes: 'synthetic evidence',
    critical_failure: false,
    voice: 4,
    behavior: 4,
    distinction: 4,
    continuity: 4,
  }));
  expect(grade(report, ratings).status).toBe('passed');
  expect(() => grade({ ...report, mode: 'offline' }, ratings)).toThrow();
  expect(() => grade(report, ratings.slice(1))).toThrow();
  ratings[0]!.critical_failure = true;
  expect(() => grade(report, ratings)).toThrow('Critical');
  ratings[0]!.critical_failure = false;
  ratings[0]!.voice = 6;
  expect(() => grade(report, ratings)).toThrow('Scores');
});
