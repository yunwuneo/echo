import { hash } from '../../security.js';
import { evaluateLore } from './index.js';
export function selectLore(
  entries: any[],
  history: any[],
  current: any,
  request: string,
  budget: number,
  loreBudget: number,
  messageClock?: number,
) {
  const selected: any[] = [],
    decisions = new Map<string, any>(),
    states = new Map<string, any>();
  const visited = new Set<string>(),
    groups = new Set<string>();
  let propagated = '';
  const random = (id: string) =>
    Number.parseInt(hash(request + ':' + id).slice(0, 12), 16) /
    0x1000000000000;
  for (let depth = 0; depth < Math.min(entries.length + 1, 128); depth++) {
    const candidates = [];
    for (const entry of entries.slice(0, 512)) {
      if (visited.has(entry.id)) continue;
      const d = entry.data;
      const scan =
        d.scan_depth === 0
          ? ''
          : [...history, current]
              .slice(-d.scan_depth)
              .map((m) => m.content)
              .join('\n');
      const input = depth === 0 ? scan : propagated;
      const e = evaluateLore(
        d,
        input,
        entry.activation ?? undefined,
        d.timing_unit === 'messages' ? messageClock : undefined,
        scan + '\n' + propagated,
      );

      const active =
        e.active &&
        !(depth === 0 && d.recursion === 'only') &&
        !(depth > 0 && d.recursion === 'direct') &&
        (d.max_recursion === undefined ||
          d.max_recursion === 0 ||
          depth <= d.max_recursion) &&
        random(entry.id) < (d.probability ?? 100) / 100;
      const tokens = Buffer.byteLength('世界书资料：' + d.content) + 16;
      states.set(entry.id, {
        id: entry.id,
        revision: entry.revision,
        next: e.next,
      });
      decisions.set(entry.id, {
        kind: 'lore',
        id: entry.id,
        revision: entry.revision,
        included: false,
        reason: !e.active
          ? e.reason
          : !active
            ? 'probability_or_recursion'
            : 'pending',
        estimated_tokens: tokens,
        requested_role: d.injection_role ?? 'system',
        effective_role: d.injection_role === 'user' ? 'user' : 'system',
        role_downgrade:
          d.injection_role === 'assistant'
            ? 'assistant_prefill_unsupported'
            : null,
      });
      if (active)
        candidates.push({
          entry,
          keywordScore: d.keyword_scoring
            ? (d.keys ?? []).filter((key: string) =>
                input.toLocaleLowerCase().includes(key.toLocaleLowerCase()),
              ).length
            : 0,
          e,
          tokens,
          weight:
            -Math.log(Math.max(random('group:' + entry.id), 1e-12)) /
            (d.weight ?? 1),
        });
    }
    candidates.sort(
      (a, b) =>
        b.entry.data.priority - a.entry.data.priority ||
        b.keywordScore - a.keywordScore ||
        (a.entry.data.exclusion_group &&
        a.entry.data.exclusion_group === b.entry.data.exclusion_group
          ? a.weight - b.weight
          : 0) ||
        a.entry.id.localeCompare(b.entry.id),
    );
    let added = false;
    for (const { entry, e, tokens } of candidates) {
      const d = entry.data;
      visited.add(entry.id);
      const reason =
        d.exclusion_group && groups.has(d.exclusion_group)
          ? 'exclusive_group'
          : tokens > budget || (!d.budget_exempt && tokens > loreBudget)
            ? 'lore_budget'
            : e.reason;
      const included = !['exclusive_group', 'lore_budget'].includes(reason);
      decisions.set(entry.id, { ...decisions.get(entry.id), included, reason });
      if (included) {
        selected.push(entry);
        budget -= tokens;
        if (!d.budget_exempt) loreBudget -= tokens;
        if (d.exclusion_group) groups.add(d.exclusion_group);
        if (d.recursion !== 'stop') {
          propagated += '\n' + d.content;
          added = true;
        }
      }
    }
    if (!added) break;
  }
  return {
    selected,
    decisions: [...decisions.values()],
    states: [...states.values()],
    remaining: budget,
    loreRemaining: loreBudget,
  };
}
