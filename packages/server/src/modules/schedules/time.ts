import { AppError } from '../../security.js';
const formatters = new Map<string, Intl.DateTimeFormat>();
export function zoned(t: number, timezone: string) {
  try {
    let f = formatters.get(timezone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      if (formatters.size >= 64)
        formatters.delete(formatters.keys().next().value!);
      formatters.set(timezone, f);
    }
    const p = f.formatToParts(t);
    const get = (s: string) => p.find((x) => x.type === s)!.value;
    return {
      date: get('year') + '-' + get('month') + '-' + get('day'),
      time: get('hour') + ':' + get('minute'),
    };
  } catch {
    throw new AppError(400, 'invalid_timezone', 'Use an IANA time zone');
  }
}
// Scan a bounded UTC window: repeated wall times select first; skipped times roll forward.
export function dailyInstant(
  date: string,
  time: string,
  timezone: string,
): number {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    throw new AppError(400, 'invalid_schedule', 'Invalid local date/time');
  const center = Date.parse(date + 'T12:00:00Z');
  for (let t = center - 36 * 3600000; t <= center + 36 * 3600000; t += 60000) {
    const p = zoned(t, timezone);
    if (p.date === date && p.time >= time) return t;
  }
  throw new AppError(400, 'invalid_schedule', 'Local date unavailable');
}
const addDay = (d: string, n: number) =>
  new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000)
    .toISOString()
    .slice(0, 10);
export function dueSlot(
  s: any,
  now: number,
): { at: number; slot: string; next: number; missed: boolean } | null {
  const first = new Date(s.next_at).getTime();
  if (first > now) return null;
  if (s.rule === 'once')
    return {
      at: first,
      slot: new Date(first).toISOString(),
      next: first,
      missed: now - first > 60000,
    };
  if (s.rule === 'interval') {
    const step = s.interval_seconds * 1000;
    const at = first + Math.floor((now - first) / step) * step;
    return {
      at,
      slot: new Date(at).toISOString(),
      next: at + step,
      missed: s.catch_up === 'skip' && now - at > 60000,
    };
  }
  const today = zoned(now, s.timezone).date;
  let date = today;
  let at = dailyInstant(date, s.at, s.timezone);
  if (at > now) {
    date = addDay(today, -1);
    at = dailyInstant(date, s.at, s.timezone);
  }
  if (at < first) return null;
  return {
    at,
    slot: date,
    next: dailyInstant(addDay(date, 1), s.at, s.timezone),
    missed: s.catch_up === 'skip' && now - at > 60000,
  };
}
export function firstTime(p: any, now = Date.now()) {
  zoned(now, p.timezone);
  if (p.rule === 'daily') {
    const d = zoned(now, p.timezone).date;
    const t = dailyInstant(d, p.at, p.timezone);
    return new Date(t > now ? t : dailyInstant(addDay(d, 1), p.at, p.timezone));
  }
  const t = Date.parse(p.at);
  if (
    !Number.isFinite(t) ||
    !Number.isSafeInteger(p.interval_seconds) ||
    p.interval_seconds < 60
  )
    throw new AppError(400, 'invalid_schedule', 'Invalid schedule');
  return new Date(t);
}
