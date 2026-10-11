import { RE2 } from 're2-wasm';
import { AppError } from '../../security.js';
import type { DB } from '../../db/index.js';
export interface Activation {
  turn: number;
  sticky_until: number;
  cooldown_until: number;
  pending_since: number | null;
}
export const emptyActivation = (): Activation => ({
  turn: 0,
  sticky_until: 0,
  cooldown_until: 0,
  pending_since: null,
});
export function validateLore(data: any) {
  if (data.match_mode === 'regex')
    for (const key of data.keys) {
      try {
        new RE2(key, data.case_sensitive ? 'u' : 'iu');
      } catch {
        throw new AppError(
          400,
          'invalid_regex',
          'Use valid RE2 expressions without lookaround or backreferences',
        );
      }
    }
}
// One successful actor reply advances one turn, scoped to room/actor/entry revision.
// Delays require consecutive triggers; sticky includes the triggering turn. Cooldown starts after sticky ends.
export function evaluateLore(
  data: any,
  scan: string,
  previous = emptyActivation(),
) {
  validateLore(data);
  const next = { ...previous, turn: previous.turn + 1 };
  const matched =
    data.constant ||
    data.keys.some((key: string) =>
      data.match_mode === 'regex'
        ? new RE2(key, data.case_sensitive ? 'u' : 'iu').test(scan)
        : (data.case_sensitive ? scan : scan.toLocaleLowerCase('und')).includes(
            data.case_sensitive ? key : key.toLocaleLowerCase('und'),
          ),
    );
  let active = false,
    reason = 'not_triggered';
  if (!data.enabled) {
    next.pending_since = null;
    reason = 'disabled';
  } else if (next.turn <= previous.sticky_until) {
    active = true;
    reason = 'sticky';
  } else if (next.turn <= previous.cooldown_until) {
    next.pending_since = null;
    reason = 'cooldown';
  } else if (matched) {
    next.pending_since ??= next.turn;
    if (next.turn - next.pending_since >= (data.delay_turns ?? 0)) {
      active = true;
      reason = 'triggered';
      next.pending_since = null;
      next.sticky_until = next.turn + Math.max(1, data.sticky_turns ?? 0) - 1;
      next.cooldown_until = next.sticky_until + (data.cooldown_turns ?? 0);
    } else reason = 'delay';
  } else next.pending_since = null;
  return { active, reason, next };
}
export async function commitLore(db: DB, message: any, manifest: any) {
  if (!message.actor_id) return;
  const states = manifest.lore_states ?? [];
  const inserted = await db.query(
    'INSERT INTO lore_commits(message_id,room_id,actor_id,states) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',
    [message.id, message.room_id, message.actor_id, JSON.stringify(states)],
  );
  if (!inserted.rowCount) return;
  for (const s of states)
    await db.query(
      `INSERT INTO lore_activations(room_id,actor_id,entry_id,revision,turn,sticky_until,cooldown_until,pending_since) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(room_id,actor_id,entry_id) DO UPDATE SET revision=$4,turn=$5,sticky_until=$6,cooldown_until=$7,pending_since=$8`,
      [
        message.room_id,
        message.actor_id,
        s.id,
        s.revision,
        s.next.turn,
        s.next.sticky_until,
        s.next.cooldown_until,
        s.next.pending_since,
      ],
    );
}
export async function rebuildLore(db: DB, room: string) {
  await db.query('DELETE FROM lore_activations WHERE room_id=$1', [room]);
  const rows = (
    await db.query(
      `SELECT c.*,m.sequence FROM lore_commits c JOIN messages m ON m.id=c.message_id WHERE c.room_id=$1 AND m.status='completed' ORDER BY m.sequence`,
      [room],
    )
  ).rows;
  for (const row of rows)
    for (const s of row.states)
      await db.query(
        `INSERT INTO lore_activations(room_id,actor_id,entry_id,revision,turn,sticky_until,cooldown_until,pending_since) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(room_id,actor_id,entry_id) DO UPDATE SET revision=$4,turn=$5,sticky_until=$6,cooldown_until=$7,pending_since=$8`,
        [
          room,
          row.actor_id,
          s.id,
          s.revision,
          s.next.turn,
          s.next.sticky_until,
          s.next.cooldown_until,
          s.next.pending_since,
        ],
      );
}
