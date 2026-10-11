import { inflateSync, crc32 } from 'node:zlib';
import { Value } from '@sinclair/typebox/value';
import { CharacterData, LoreInput } from '../../../../contracts/src/index.js';
import { AppError } from '../../security.js';
import { validateLore } from '../lorebooks/index.js';
const JSON_LIMIT = 5 * 1024 * 1024,
  PNG_LIMIT = 10 * 1024 * 1024;
const bad = (message: string): never => {
  throw new AppError(400, 'invalid_import', message);
};
function json(bytes: Buffer) {
  if (bytes.length > JSON_LIMIT)
    throw new AppError(413, 'import_too_large', 'Decoded JSON exceeds 5 MiB');
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return bad('JSON object required');
    return value;
  } catch (e) {
    if (e instanceof AppError) throw e;
    return bad('Invalid UTF-8 JSON');
  }
}
function decode64(text: string) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    )
  )
    return bad('Invalid base64 metadata');
  return Buffer.from(text, 'base64');
}
export function parsePNG(bytes: Buffer) {
  if (bytes.length > PNG_LIMIT)
    throw new AppError(413, 'import_too_large', 'PNG exceeds 10 MiB');
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return bad('Invalid PNG signature');
  const cards = new Map<string, any>();
  let offset = 8,
    count = 0,
    ended = false;
  while (offset < bytes.length) {
    if (++count > 10000 || offset + 12 > bytes.length)
      return bad('Truncated PNG');
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > PNG_LIMIT || offset + 12 + length > bytes.length)
      return bad('Invalid PNG chunk size');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      return bad('PNG checksum mismatch');
    if (
      count === 1 &&
      (type !== 'IHDR' ||
        length !== 13 ||
        data.readUInt32BE(0) === 0 ||
        data.readUInt32BE(4) === 0 ||
        data.readUInt32BE(0) > 8192 ||
        data.readUInt32BE(4) > 8192)
    )
      return bad('Invalid PNG header or oversized image');
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const nul = data.indexOf(0);
      if (nul < 1 || nul > 79) return bad('Invalid PNG text chunk');
      const key = data.toString('ascii', 0, nul);
      if (['chara', 'ccv3'].includes(key)) {
        if (cards.has(key)) return bad('Duplicate card metadata');
        let payload = data.subarray(nul + 1);
        try {
          if (type === 'zTXt') {
            if (payload[0] !== 0) return bad('Unsupported text compression');
            payload = inflateSync(payload.subarray(1), {
              maxOutputLength: JSON_LIMIT,
            });
          }
          if (type === 'iTXt') {
            const compressed = payload[0],
              method = payload[1];
            if (![0, 1].includes(compressed!) || method !== 0)
              return bad('Invalid international text');
            let start = 2;
            for (let i = 0; i < 2; i++) {
              const end = payload.indexOf(0, start);
              if (end < 0) return bad('Invalid international text');
              start = end + 1;
            }
            payload = payload.subarray(start);
            if (compressed)
              payload = inflateSync(payload, { maxOutputLength: JSON_LIMIT });
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
          return bad('Invalid or oversized compressed metadata');
        }
        cards.set(key, json(decode64(payload.toString('ascii'))));
      }
    }
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length)
        return bad('Invalid PNG end');
      ended = true;
      break;
    }
  }
  if (!ended || !cards.size)
    return bad('PNG does not contain a complete character card');
  return {
    raw: cards.get('ccv3') ?? cards.get('chara'),
    both: cards.has('ccv3') && cards.has('chara'),
  };
}
export interface ImportPlan {
  format: string;
  character: any | null;
  entries: any[];
  warnings: string[];
  errors: string[];
  mapping: string[];
}
export function parseImport(bytes: Buffer, format: 'json' | 'png'): ImportPlan {
  if (bytes.length > (format === 'png' ? PNG_LIMIT : JSON_LIMIT))
    throw new AppError(413, 'import_too_large', 'Import exceeds size limit');
  const parsed =
    format === 'png' ? parsePNG(bytes) : { raw: json(bytes), both: false };
  const raw = parsed.raw;
  const plan: ImportPlan = {
    format,
    character: null,
    entries: [],
    warnings: [],
    errors: [],
    mapping: [],
  };
  if (parsed.both)
    plan.warnings.push('PNG 同时有 chara/ccv3；采用 ccv3，原始 PNG 完整保留。');
  const unsupported = (obj: any, allowed: string[], path: string) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const key of Object.keys(obj))
      if (!allowed.includes(key))
        plan.warnings.push(`${path}.${key}：保留原始字段，不执行。`);
  };
  let book: any;
  if (raw.spec) {
    if (!['chara_card_v2', 'chara_card_v3'].includes(raw.spec))
      return bad('Only chara_card_v2 and chara_card_v3 are supported');
    if (raw.spec_version !== (raw.spec === 'chara_card_v2' ? '2.0' : '3.0'))
      return bad('Card spec_version does not match spec');
    const d = raw.data;
    if (!d || typeof d !== 'object' || Array.isArray(d))
      return bad('Card data is missing');
    const character = {
      name: d.name,
      description: d.description ?? '',
      personality: d.personality ?? '',
      voice: '',
      scenario: d.scenario ?? '',
      example: d.mes_example ?? '',
      greeting: d.first_mes ?? '',
      alternate_greetings: d.alternate_greetings ?? [],
      prompt_suggestions: {
        system_prompt: d.system_prompt ?? '',
        post_history_instructions: d.post_history_instructions ?? '',
        enabled: false,
      },
    };
    if (!Value.Check(CharacterData, character))
      plan.errors.push('角色公共字段类型或长度超限，必须修复后重新预览。');
    else plan.character = character;
    unsupported(raw, ['spec', 'spec_version', 'data'], 'card');
    unsupported(
      d,
      [
        'name',
        'description',
        'personality',
        'scenario',
        'mes_example',
        'first_mes',
        'alternate_greetings',
        'character_book',
        'system_prompt',
        'post_history_instructions',
      ],
      'data',
    );
    book = d.character_book;
    plan.mapping.push(
      'name/description/personality/scenario → 角色模板；mes_example → 示例；first_mes/alternate_greetings → 开场白候选。',
    );
    plan.warnings.push(
      '角色提示建议默认关闭，需明确启用；宏、脚本、插件或远程资源不执行。示例与开场白不会自动成为消息或记忆。',
    );
  } else book = raw;
  if (book !== undefined) {
    if (
      !book ||
      typeof book !== 'object' ||
      Array.isArray(book) ||
      !book.entries ||
      typeof book.entries !== 'object'
    )
      return bad('Expected a world book with entries');
    unsupported(book, ['entries', 'name'], 'book');
    const entries = Array.isArray(book.entries)
      ? book.entries
      : Object.values(book.entries);
    if (entries.length > 2000)
      throw new AppError(413, 'too_many_entries', 'At most 2000 lore entries');
    for (let i = 0; i < entries.length; i++) {
      const d = entries[i];
      const path = `entries[${i}]`;
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        plan.errors.push(`${path}：必须是对象。`);
        continue;
      }
      const ext = d.extensions ?? {};
      const keys = d.key ?? d.keys ?? [];
      if (
        !Array.isArray(keys) ||
        keys.some((k: any) => typeof k !== 'string')
      ) {
        plan.errors.push(`${path}.keys：需要字符串数组。`);
        continue;
      }
      const regex = keys.some((k: string) => k.startsWith('/'));
      const mappedKeys = keys.map((k: string) => {
        if (!regex) return k;
        if (!k.startsWith('/')) return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const end = k.lastIndexOf('/');
        const flags = k.slice(end + 1);
        if (end <= 0 || !/^(i|u|iu|ui)?$/.test(flags)) {
          plan.errors.push(`${path}.key：仅支持 /RE2/ 和 i/u 标志。`);
          return k;
        }
        return flags.includes('i')
          ? `(?i:${k.slice(1, end)})`
          : k.slice(1, end);
      });
      const position = d.position ?? ext.position ?? 0;
      const slot: Record<string, string> = {
        '0': 'before_character',
        '1': 'after_character',
        '4': 'history_depth',
        before_char: 'before_character',
        after_char: 'after_character',
      };
      if (!slot[String(position)])
        plan.warnings.push(
          `${path}.position=${position}：不支持此位置，条目停用。`,
        );
      const entry = {
        name: d.comment || d.name || `导入条目 ${i + 1}`,
        content: d.content,
        enabled: (d.enabled ?? !d.disable) && !!slot[String(position)],
        constant: d.constant ?? false,
        keys: mappedKeys,
        case_sensitive: d.caseSensitive ?? d.case_sensitive ?? false,
        scan_depth: d.scanDepth ?? ext.scan_depth ?? 8,
        priority: d.order ?? d.insertion_order ?? 0,
        insertion_slot: slot[String(position)] ?? 'before_history',
        injection_depth: d.depth ?? ext.depth ?? 0,
        audience_actor_ids: [],
        match_mode: regex ? 'regex' : 'keywords',
        sticky_turns: d.sticky ?? ext.sticky ?? 0,
        cooldown_turns: d.cooldown ?? ext.cooldown ?? 0,
        delay_turns: d.delay ?? ext.delay ?? 0,
      };
      if (!Value.Check(LoreInput, entry)) {
        plan.errors.push(`${path}：字段类型、长度或范围无效。`);
        continue;
      }
      try {
        validateLore(entry);
      } catch {
        plan.errors.push(`${path}.key：不是有效的 RE2 表达式。`);
        continue;
      }
      unsupported(
        d,
        [
          'uid',
          'id',
          'key',
          'keys',
          'content',
          'comment',
          'name',
          'enabled',
          'disable',
          'constant',
          'caseSensitive',
          'case_sensitive',
          'scanDepth',
          'order',
          'insertion_order',
          'position',
          'depth',
          'sticky',
          'cooldown',
          'delay',
          'extensions',
        ],
        path,
      );
      unsupported(
        ext,
        ['position', 'scan_depth', 'depth', 'sticky', 'cooldown', 'delay'],
        `${path}.extensions`,
      );
      if (
        d.selective ||
        d.selectiveLogic ||
        d.useProbability ||
        (d.probability !== undefined && d.probability !== 100) ||
        d.keysecondary?.length ||
        d.secondary_keys?.length ||
        d.vectorized ||
        ext.vectorized
      ) {
        entry.enabled = false;
        plan.warnings.push(
          `${path}：含二级关键词、组合、概率或向量触发，停用以避免扩大触发。`,
        );
      }
      plan.entries.push(entry);
    }
    plan.mapping.push(
      'key(s)/content/constant/disable/enabled → 基础规则；order/insertion_order → 数值越大越优先；position 0/1/4 → 角色前/后/历史深度。',
    );
    plan.mapping.push(
      'sticky/cooldown/delay 按房间内当前角色成功回复计数；与第三方按消息计数存在差异；未注入的条目也提交规则状态。',
    );
    plan.warnings.push(
      '不执行递归激活、概率、二级组合、扩展脚本；原始文件可下载保留未知扩展。',
    );
  }
  return plan;
}
export function decodeImport(body: any) {
  const bytes = decode64(body.data_base64);
  return { bytes, plan: parseImport(bytes, body.format) };
}
