import { describe, it, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  evaluateLore,
  validateLore,
} from '../../packages/server/src/modules/lorebooks/index.js';
import {
  parseImport,
  parsePNG,
} from '../../packages/server/src/modules/imports/parse.js';
import { validateCandidates } from '../../packages/server/src/modules/memory/repository.js';
import {
  rankMemories,
  terms,
} from '../../packages/server/src/modules/memory/retrieval.js';
const rule = {
  enabled: true,
  constant: false,
  keys: ['北塔'],
  case_sensitive: false,
  match_mode: 'keywords',
  sticky_turns: 2,
  cooldown_turns: 2,
  delay_turns: 1,
};
export const card = (name = '林舟') => ({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name,
    description: '领航员',
    personality: '谨慎',
    scenario: '星港',
    first_mes: '你好',
    mes_example: '出发',
    alternate_greetings: ['欢迎'],
    extensions: { script: 'fetch("https://evil.invalid")' },
  },
});
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([head, payload, crc]);
}
export function png(entries: [string, any][]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...entries.map(([name, value]) =>
      chunk(
        'tEXt',
        Buffer.from(
          name + '\0' + Buffer.from(JSON.stringify(value)).toString('base64'),
        ),
      ),
    ),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
describe('P3 deterministic rules and bounded imports', () => {
  it('decodes compressed card text with independent expansion limits', () => {
    const base = png([]);
    const encoded = Buffer.from(JSON.stringify(card())).toString('base64');
    const ztxt = chunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('chara\0\0'),
        deflateSync(Buffer.from(encoded)),
      ]),
    );
    expect(
      parseImport(
        Buffer.concat([base.subarray(0, 33), ztxt, base.subarray(33)]),
        'png',
      ).character.name,
    ).toBe('林舟');
    const bomb = chunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('chara\0\0'),
        deflateSync(Buffer.alloc(6 * 1024 * 1024, 65)),
      ]),
    );
    expect(() =>
      parsePNG(Buffer.concat([base.subarray(0, 33), bomb, base.subarray(33)])),
    ).toThrow();
  });

  it('maps the checked-in public-field fixtures deterministically', () => {
    const card = parseImport(
      readFileSync('tests/fixtures/cards/linzhou-v2.json'),
      'json',
    );
    expect(card.character.name).toBe('林舟');
    expect(card.entries[0]).toMatchObject({
      keys: ['北塔'],
      priority: 30,
      sticky_turns: 2,
      cooldown_turns: 1,
    });
    expect(card.errors).toEqual([]);
    const book = parseImport(
      readFileSync('tests/fixtures/lorebooks/starport.json'),
      'json',
    );
    expect(book.entries[0]).toMatchObject({
      name: '灯塔',
      insertion_slot: 'history_depth',
      injection_depth: 2,
      priority: 50,
    });
  });

  it('advances delay/sticky/cooldown only through committed state and keeps retries stable', () => {
    const a = evaluateLore(rule, '北塔');
    expect(a.reason).toBe('delay');
    expect(evaluateLore(rule, '北塔')).toEqual(a);
    const b = evaluateLore(rule, '北塔', a.next);
    expect(b.active).toBe(true);
    const c = evaluateLore(rule, '无', b.next);
    expect(c.reason).toBe('sticky');
    const d = evaluateLore(rule, '北塔', c.next);
    expect(d.reason).toBe('cooldown');
    const e = evaluateLore(rule, '北塔', d.next);
    expect(e.reason).toBe('cooldown');
    expect(evaluateLore(rule, '北塔', e.next).reason).toBe('delay');
    expect(
      evaluateLore({ ...rule, enabled: false }, '北塔', b.next).active,
    ).toBe(false);
  });
  it('uses bounded RE2 matching and rejects backreferences and lookaround', () => {
    expect(
      evaluateLore(
        { ...rule, match_mode: 'regex', keys: ['^(a+)+$'], delay_turns: 0 },
        'a'.repeat(50000) + '!',
      ).active,
    ).toBe(false);
    expect(
      evaluateLore(
        { ...rule, match_mode: 'regex', keys: ['北[塔楼]'], delay_turns: 0 },
        '去北楼',
      ).active,
    ).toBe(true);
    for (const key of ['(a)\\1', '(?=a)', '['])
      expect(() =>
        validateLore({ ...rule, match_mode: 'regex', keys: [key] }),
      ).toThrow();
  });
  it('maps v2/v3 and mixed world-book rules, preserves unsupported behavior in reports', () => {
    const raw = card();
    const p = parseImport(Buffer.from(JSON.stringify(raw)), 'json');
    expect(p.character.name).toBe('林舟');
    expect(p.character.alternate_greetings).toEqual(['欢迎']);
    expect(p.warnings.join()).toContain('extensions');
    const b = parseImport(
      Buffer.from(
        JSON.stringify({
          entries: {
            0: {
              key: ['/北[塔楼]/', '灯'],
              content: '塔有灯',
              order: 20,
              position: 4,
              depth: 3,
              sticky: 2,
            },
            1: { key: ['北'], content: '其他槽位', position: 7 },
            2: {
              key: ['北'],
              content: '二级',
              keysecondary: ['秘密'],
              selective: true,
            },
          },
        }),
      ),
      'json',
    );
    expect(b.errors).toEqual([]);
    expect(b.entries[0]).toMatchObject({
      priority: 20,
      match_mode: 'regex',
      insertion_slot: 'history_depth',
      injection_depth: 3,
      sticky_turns: 2,
    });
    expect(b.entries.slice(1).every((e) => !e.enabled)).toBe(true);
    expect(
      parseImport(
        Buffer.from(
          JSON.stringify({
            entries: [{ content: 'x', key: [], scanDepth: -1 }],
          }),
        ),
        'json',
      ).errors.length,
    ).toBe(1);
  });
  it('prefers ccv3 over chara, rejects damaged, duplicate and oversized PNG/JSON', () => {
    const v3 = { ...card('夏棠'), spec: 'chara_card_v3', spec_version: '3.0' };
    const image = png([
      ['chara', card()],
      ['ccv3', v3],
    ]);
    expect(parseImport(image, 'png').character.name).toBe('夏棠');
    const damaged = Buffer.from(image);
    damaged[30] = damaged[30]! ^ 1;
    expect(() => parsePNG(damaged)).toThrow();
    expect(() => parsePNG(image.subarray(0, -1))).toThrow();
    expect(() =>
      parsePNG(
        png([
          ['chara', card()],
          ['chara', card()],
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseImport(Buffer.alloc(5 * 1024 * 1024 + 1), 'json'),
    ).toThrow();
    expect(() =>
      parseImport(Buffer.from('{"spec":"unknown"}'), 'json'),
    ).toThrow();
  });
  it('rejects fabricated sources, paraphrased claims, invalid schemas and topics', () => {
    const sources = [{ id: 's', content: '明晚九点去北塔' }];
    const candidate = {
      content: '明晚九点去北塔',
      topic: '北塔',
      kind: 'agreement',
      source_ids: ['s'],
    };
    expect(
      validateCandidates({ candidates: [candidate] }, sources),
    ).toHaveLength(1);
    for (const patch of [
      { source_ids: ['missing'] },
      { content: '今夜去南塔' },
      { topic: '南塔' },
      { kind: 'confirmed' },
      { confidence: 1 },
    ])
      expect(() =>
        validateCandidates(
          { candidates: [{ ...candidate, ...patch }] },
          sources,
        ),
      ).toThrow();
  });
  it('uses Chinese n-grams, filters unrelated candidates and ranks exact recall', () => {
    expect(terms('蓝色风铃')).toEqual(['蓝色', '色风', '风铃']);
    const rows = ['蓝色风铃是暗号', '白塔是车站', '偏好清茶'].map(
      (content, i) => ({
        id: String(i),
        content,
        terms: terms(content),
        valid_from: '2026-01-01',
      }),
    );
    expect(rankMemories(rows, '暗号是什么')[0]?.id).toBe('0');
    expect(rankMemories(rows, '不存在的木船')).toEqual([]);
  });
});
