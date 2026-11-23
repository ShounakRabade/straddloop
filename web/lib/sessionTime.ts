/**
 * Session times for the Lab's time fields. Times are minutes since midnight IST; the NSE cash session runs 09:15 to
 * 15:30, so the stored 1-minute bars start at 09:15 and the last one at 15:29. A field has a grain: the engine's own
 * resolution for it (Strategy 01 decides on 5-minute candles, so its entry time is on the 5-minute grid; the leg
 * engine works on every minute). The picker's interval (1, 5, 15, 30 minutes) only changes how the list and the
 * steppers move; it is a multiple of the grain, so every value it offers is one the engine can use.
 */

export const OPEN = 555;   // 09:15, the first bar
export const LAST_BAR = 929; // 15:29
export const CLOSE = 930;  // 15:30
export const INTERVALS = [1, 5, 15, 30] as const;
export type Interval = (typeof INTERVALS)[number];

/** What a time means in a strategy: when it enters, the last minute a new position may open, when everything is closed. */
export type TimeRole = 'entry' | 'last_entry' | 'exit';
export const ROLE_LABEL: Record<TimeRole, string> = { entry: 'Entry', last_entry: 'Last new entry', exit: 'Square-off' };

export const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 'HH:MM' (strict) to minutes, or null. */
export function toMin(s: unknown): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/**
 * What a person typed, read generously: '9:30', '09.30', '930', '0930', '1530', '15 30', '9' (= 09:00).
 * Returns minutes or null when it is not a time at all.
 */
export function parseTyped(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  let h: number, m: number;
  const sep = /^(\d{1,2})\s*[:.\s]\s*(\d{1,2})$/.exec(s);
  if (sep) { h = +sep[1]; m = +sep[2]; }
  else if (/^\d{3,4}$/.test(s)) { h = +s.slice(0, s.length - 2); m = +s.slice(-2); }
  else if (/^\d{1,2}$/.test(s)) { h = +s; m = 0; }
  else return null;
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** The HHMM prefix a partly typed time stands for, to filter the list as someone types: '9' → '09', '1' → '1'
 *  (10:00–15:59), '93' → '093', '093' → '093', '103' → '103' (10:3x), '930' → '0930', '10:3' → '103'. */
export function digitPrefix(text: string): string {
  const d = text.replace(/\D/g, '').slice(0, 4);
  if (!d) return '';
  if (d.length === 1) return +d >= 3 ? `0${d}` : d;
  if (d.length === 2) return +d <= 23 ? d : `0${d}`;
  if (d.length === 3) return d[0] === '0' || +d.slice(0, 2) <= 23 ? d : `0${d}`;
  return d;
}

export interface TimeSpec { min: number; max: number; grain: number }

/** Why a value is not allowed for a field (null = allowed). */
export function timeProblem(m: number | null, t: TimeSpec): string | null {
  if (m == null) return 'Not a time. Type it as HH:MM, for example 09:30.';
  if (m < t.min || m > t.max) return `Between ${toHM(t.min)} and ${toHM(t.max)}.`;
  if ((m - OPEN) % t.grain !== 0) return `On the ${t.grain}-minute candle grid (for example ${toHM(snapTo(m, t))}).`;
  return null;
}

/** The nearest allowed minute: inside the bounds and on the grain (ties go later). */
export function snapTo(m: number, t: TimeSpec): number {
  const g = Math.max(1, t.grain);
  let v = OPEN + Math.round((m - OPEN) / g) * g;
  if (v < t.min) v = t.min + ((g - ((t.min - OPEN) % g)) % g);
  if (v > t.max) v = t.max - ((t.max - OPEN) % g);
  return v;
}

/** The intervals a field offers: the picker steps by multiples of the field's grain. */
export const intervalsFor = (grain: number): Interval[] => INTERVALS.filter((i) => i % grain === 0);

/** Every value the list shows at this interval: on the clock grid (09:15, 09:30 … for 15 minutes), inside the bounds,
 *  plus the current value when it sits between grid points, so it is always visible and selected. */
export function timeList(t: TimeSpec, interval: number, current?: number | null): number[] {
  const out: number[] = [];
  const step = Math.max(interval, t.grain);
  const first = Math.ceil(t.min / step) * step;
  for (let m = first; m <= t.max; m += step) if ((m - OPEN) % t.grain === 0) out.push(m);
  if (current != null && current >= t.min && current <= t.max && !out.includes(current)) { out.push(current); out.sort((a, b) => a - b); }
  return out;
}

/** One step of the stepper: to the next (dir +1) or previous (dir -1) clock-grid point of the interval, in bounds. */
export function stepTime(m: number, dir: 1 | -1, t: TimeSpec, interval: number): number {
  const step = Math.max(interval, t.grain);
  let v = dir > 0 ? Math.floor(m / step) * step + step : Math.ceil(m / step) * step - step;
  v = Math.min(t.max, Math.max(t.min, v));
  return (v - OPEN) % t.grain === 0 ? v : snapTo(v, t);
}

export interface TimedField { key: string; role: TimeRole; value: number | null }

/**
 * Order rules between a strategy's times. Errors block a run; notes do not.
 *  - an intraday position must be entered before it is squared off;
 *  - the last new entry must not come after the square-off (nothing could open);
 *  - a last new entry before the entry time only means no second position or re-entry can open (a note).
 * `intraday` false (held across sessions) drops the entry/square-off rule: the square-off is on a later day.
 */
export function sequenceProblems(fields: TimedField[], intraday = true): { key: string; level: 'error' | 'note'; text: string }[] {
  const by = (r: TimeRole) => fields.find((f) => f.role === r && f.value != null);
  const entry = by('entry'), last = by('last_entry'), exit = by('exit');
  const out: { key: string; level: 'error' | 'note'; text: string }[] = [];
  if (intraday && entry && exit && !(entry.value! < exit.value!)) out.push({ key: entry.key, level: 'error', text: `Entry ${toHM(entry.value!)} must be before the square-off at ${toHM(exit.value!)}.` });
  if (last && exit && last.value! > exit.value!) out.push({ key: last.key, level: 'error', text: `Last new entry ${toHM(last.value!)} is after the square-off at ${toHM(exit.value!)}; set it at or before ${toHM(exit.value!)}.` });
  if (entry && last && last.value! <= entry.value!) out.push({ key: last.key, level: 'note', text: `Last new entry ${toHM(last.value!)} is not after the entry at ${toHM(entry.value!)}: no second position or re-entry can open.` });
  return out;
}
