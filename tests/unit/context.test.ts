import { describe, it, expect } from 'vitest';
import {
  compilePrompt,
  selectSpeakers,
  type CompileInput,
} from '../../packages/server/src/modules/context/index.js';
const input: CompileInput = {
  world: {
    id: 'world',
    revision: 2,
    description: '合成星港',
    persona: { name: '船长', description: '虚构身份' },
  },
  actor: {
    id: 'actor-a',
    revision: 1,
    template_id: 'template',
    template_revision: 1,
    name: '阿岚',
    data: { description: '谨慎的领航员' },
  },
  state: { revision: 1, data: { location: '舰桥' } },
  lore: [
    {
      id: 'lore-a',
      revision: 2,
      data: {
        enabled: true,
        constant: false,
        keys: ['星港'],
        content: '星港禁止明火',
        case_sensitive: false,
        scan_depth: 8,
        priority: 1,
        insertion_slot: 'before_history',
        injection_depth: 0,
      },
    },
  ],
  history: [{ id: 'old', role: 'user', content: '旧消息' }],
  current: { id: 'current', content: '星港几点开放？' },
  contextWindow: 4096,
  outputTokens: 1024,
  model: 'synthetic-model',
};
describe('P2 prompt compiler', () => {
  it('keeps imported prompt suggestions out until explicitly enabled and budgets enabled suggestions as core', () => {
    const withSuggestion = (enabled: boolean): CompileInput => ({
      ...input,
      actor: {
        ...input.actor!,
        data: {
          ...input.actor!.data,
          prompt_suggestions: {
            enabled,
            system_prompt: '只用航海术语',
            post_history_instructions: '以问候结束',
          },
        },
      },
    });
    const disabled = compilePrompt(withSuggestion(false));
    expect(JSON.stringify(disabled.messages)).not.toContain('只用航海术语');
    expect(disabled.messages).toEqual(compilePrompt(input).messages);
    const enabled = compilePrompt(withSuggestion(true));
    expect(enabled.messages[0]!.content).toContain('不授予现实工具权限');
    expect(JSON.stringify(enabled.messages)).toContain('只用航海术语');
    expect(enabled.messages.at(-2)!.content).toContain('以问候结束');
    const huge = withSuggestion(true);
    (huge.actor!.data.prompt_suggestions as any).system_prompt = '建议'.repeat(
      5000,
    );
    expect(() => compilePrompt(huge)).toThrow(/Core persona/);
  });
  it('rebuilds a deterministic Chinese prompt and content-free manifest', () => {
    const a = compilePrompt(input),
      b = compilePrompt(structuredClone(input));
    expect(a).toEqual(b);
    expect(a).toMatchSnapshot();
    expect(JSON.stringify(a.manifest)).not.toContain('禁止明火');
    const other = compilePrompt({
      ...input,
      actor: {
        ...input.actor!,
        name: '北辰',
        data: { description: '热情的医生' },
      },
    });
    expect(other.messages).not.toEqual(a.messages);
  });
  it('fails on oversized core persona instead of silently truncating it', () => {
    expect(() =>
      compilePrompt({
        ...input,
        actor: { ...input.actor!, data: { description: '中文'.repeat(10000) } },
      }),
    ).toThrow('Core persona');
  });
  it('explains lore and old history cuts while preserving current input', () => {
    const result = compilePrompt({
      ...input,
      contextWindow: 2048,
      outputTokens: 1024,
      history: [{ id: 'old', role: 'user', content: '过去'.repeat(2000) }],
      lore: [
        {
          ...input.lore[0]!,
          data: { ...input.lore[0]!.data, content: '巨大设定'.repeat(2000) },
        },
      ],
    });
    expect(result.manifest.decisions.map((x) => x.reason)).toEqual([
      'lore_budget',
      'history_budget',
    ]);
    expect(result.messages.at(-1)?.content).toBe(input.current.content);
    expect(result.manifest.estimated_input_tokens + 1024).toBeLessThanOrEqual(
      2048,
    );
  });
  it('uses only supplied visible messages for keyword activation and supports stable slots', () => {
    const inactive = compilePrompt({
      ...input,
      current: { id: 'new', content: 'Hello' },
      history: [],
    });
    expect(inactive.manifest.decisions[0]?.reason).toBe('not_triggered');
    for (const slot of [
      'before_character',
      'after_character',
      'before_history',
      'history_depth',
    ]) {
      const r = compilePrompt({
        ...input,
        lore: [
          {
            ...input.lore[0]!,
            data: { ...input.lore[0]!.data, insertion_slot: slot },
          },
        ],
      });
      expect(r.messages[0]?.content).toContain('不授予现实工具权限');
      expect(r.messages.at(-1)?.content).toBe(input.current.content);
    }
  });
  it('replays selection seed, honors explicit address, cooldown and participation', () => {
    const members = [
      { id: 'a', participation: 100, last_order: '8' },
      { id: 'b', participation: 20, last_order: '0' },
      { id: 'c', participation: 0, last_order: '0' },
    ];
    expect(selectSpeakers(members, [], 3, 'seed')).toEqual(['b', 'a']);
    expect(selectSpeakers([...members].reverse(), [], 3, 'seed')).toEqual([
      'b',
      'a',
    ]);
    expect(selectSpeakers(members, ['c', 'a'], 1, 'seed')).toEqual(['c']);
  });
});
