/** Date-range checks for the Lab, kept free of React and Supabase so they can be tested on their own. */

export interface StoredDay { trade_date: string; quality: string }

/** What is known about one stored day. `complete` = the data pipeline found no missing bars; `gaps` = some bars missing; `empty` = no option series. */
export type DayState = 'validated' | 'gaps' | 'failed';
export const dayState = (q: string): DayState => (q === 'complete' ? 'validated' : q.startsWith('gaps') ? 'gaps' : q === 'empty' ? 'failed' : 'validated');

export interface RangeCheck {
  /** Blocking problems: the run cannot start until they are fixed. */
  errors: string[];
  /** Things to know, not blocking. */
  notes: string[];
  /** Days in range that are stored locally in the data store. */
  stored: string[];
  /** Weekdays in range with no stored day: an exchange holiday, or not loaded yet. The store cannot tell which. */
  notStored: string[];
  counts: { weekdays: number; stored: number; notStored: number; validated: number; gaps: number; failed: number };
  /** Parts of the request outside what is stored at all (before the first or after the last stored day). */
  outside: { before: number; after: number };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const valid = (s: string) => ISO.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDay = (s: string) => new Date(Date.parse(`${s}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const isWeekday = (s: string) => { const d = new Date(`${s}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6; };
export const MAX_RANGE_DAYS = 366 * 6;

export function checkRange(from: string, to: string, stored: StoredDay[] | null, today: string = new Date().toISOString().slice(0, 10)): RangeCheck {
  const out: RangeCheck = { errors: [], notes: [], stored: [], notStored: [], counts: { weekdays: 0, stored: 0, notStored: 0, validated: 0, gaps: 0, failed: 0 }, outside: { before: 0, after: 0 } };
  if (!from || !to) { out.errors.push('Choose both a start date and an end date.'); return out; }
  if (!valid(from)) out.errors.push(`“${from}” is not a valid date.`);
  if (!valid(to)) out.errors.push(`“${to}” is not a valid date.`);
  if (out.errors.length) return out;
  if (from > to) { out.errors.push('The start date is after the end date.'); return out; }
  if (from > today) { out.errors.push('The start date is in the future; there is no market data for it.'); return out; }
  if (to > today) out.notes.push(`The end date is after today (${today}); it was cut back to today.`);
  const end = to > today ? today : to;
  if ((Date.parse(end) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) { out.errors.push('That range is longer than six years. Pick a shorter one.'); return out; }
  const have = new Map((stored ?? []).map((d) => [d.trade_date, d.quality]));
  for (let d = from; d <= end; d = addDay(d)) {
    if (!isWeekday(d)) continue;
    out.counts.weekdays++;
    const q = have.get(d);
    if (q === undefined) { out.notStored.push(d); continue; }
    out.stored.push(d);
    const st = dayState(q);
    out.counts[st === 'validated' ? 'validated' : st === 'gaps' ? 'gaps' : 'failed']++;
  }
  out.counts.stored = out.stored.length; out.counts.notStored = out.notStored.length;
  if (stored && stored.length) {
    const first = stored[0].trade_date, last = stored[stored.length - 1].trade_date;
    out.outside.before = out.notStored.filter((d) => d < first).length;
    out.outside.after = out.notStored.filter((d) => d > last).length;
  }
  if (!out.stored.length) out.errors.push('None of these dates are stored. Load them first (command below), or pick dates that are.');
  else if (out.counts.notStored) out.notes.push(`${out.counts.notStored} weekday${out.counts.notStored === 1 ? '' : 's'} in this range have no stored data: exchange holidays, or not loaded yet. They are skipped, never filled in.`);
  if (out.counts.gaps) out.notes.push(`${out.counts.gaps} stored day${out.counts.gaps === 1 ? ' has' : 's have'} missing candles; the engine skips a day it cannot trade on complete data.`);
  if (out.counts.failed) out.notes.push(`${out.counts.failed} stored day${out.counts.failed === 1 ? ' failed' : 's failed'} validation (no option series) and will be excluded.`);
  return out;
}
