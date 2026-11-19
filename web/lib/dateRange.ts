/**
 * The one date-range object for the Lab (docs/ENGINE_INTERFACES.md §5).
 *
 * Calendar, availability counts, the files the run downloads, the progress count, the result header and the
 * report all read the same `DateRange`, so "N days will run" and "N days ran" can never disagree.
 * Pure: no React, no network. Built from the market_days inventory and (when present) market_day_status.
 */

export type Series = 'WEEK' | 'MONTH';
export type DayState = 'validated' | 'partial' | 'failed' | 'downloading' | 'missing' | 'holiday' | 'weekend';
export type Preset = 'last_7' | 'last_30' | 'last_90' | '6m' | '1y' | '2y' | '3y' | 'max';

/** One stored day file (a row of public.market_days, or a file picked from this computer). */
export interface InventoryDay {
  trade_date: string;
  path: string;
  quality: string;              // 'complete' | 'gaps:N' | 'empty' | 'local'
  index_bars?: number | null;
  expiry?: string | null;
  lot_size?: number | null;
  sha256?: string | null;
}
/** One row of public.market_day_status (ingestion ledger state, uploaded by the pipeline). */
export interface StatusRow { trade_date: string; status: 'validated' | 'partial' | 'failed' | 'downloading' | 'holiday'; reason: string | null }

export interface DayEntry {
  date: string;
  weekday: number;              // 0 = Monday … 6 = Sunday
  state: DayState;
  reason: string | null;
  holiday: { name: string; source: 'pipeline' | 'nse_list_unverified' } | null;
  file: { path: string; quality: string; index_bars: number | null; expiry: string | null; lot_size: number | null; sha256: string | null } | null;
  is_expiry: boolean;
}

export interface DateRange {
  request: { from: string; to: string };
  dataset: { source: 'dhan' | 'local'; underlying: string; series: Series; interval: '1m' };
  bounds: { floor: string; earliest: string | null; latest_validated: string | null; latest_any: string | null };
  effective: { from: string; to: string } | null;
  days: DayEntry[];
  counts: Record<DayState, number> & { calendar: number; weekdays: number; runnable: number };
  runnable: string[];
  /** Day files to download, in date order (one per runnable date). */
  files: { date: string; path: string }[];
  messages: { level: 'error' | 'note'; text: string }[];
  /** Stable fingerprint of dataset + runnable dates + file checksums/qualities. */
  key: string;
}

/** Research history starts here (product decision); the cost table itself starts 2020-07-01. */
export const FLOOR = '2023-01-01';

// NSE equity-derivatives trading holidays on weekdays, 2023–2025, from memory of NSE circulars.
// NOT verified against the official list: used only to label a weekday with NO stored file as a likely
// holiday instead of "missing". A day with a stored file is never treated as a holiday. 2026 is not entered.
export const NSE_HOLIDAYS_UNVERIFIED: Record<string, string> = {
  '2023-01-26': 'Republic Day', '2023-03-07': 'Holi', '2023-03-30': 'Ram Navami', '2023-04-04': 'Mahavir Jayanti',
  '2023-04-07': 'Good Friday', '2023-04-14': 'Ambedkar Jayanti', '2023-05-01': 'Maharashtra Day', '2023-06-28': 'Bakri Id',
  '2023-08-15': 'Independence Day', '2023-09-19': 'Ganesh Chaturthi', '2023-10-02': 'Gandhi Jayanti', '2023-10-24': 'Dussehra',
  '2023-11-14': 'Diwali Balipratipada', '2023-11-27': 'Guru Nanak Jayanti', '2023-12-25': 'Christmas',
  '2024-01-22': 'Special holiday', '2024-01-26': 'Republic Day', '2024-03-08': 'Mahashivratri', '2024-03-25': 'Holi',
  '2024-03-29': 'Good Friday', '2024-04-11': 'Id-Ul-Fitr', '2024-04-17': 'Ram Navami', '2024-05-01': 'Maharashtra Day',
  '2024-05-20': 'General election (Mumbai)', '2024-06-17': 'Bakri Id', '2024-07-17': 'Muharram', '2024-08-15': 'Independence Day',
  '2024-10-02': 'Gandhi Jayanti', '2024-11-01': 'Diwali (Laxmi Pujan)', '2024-11-15': 'Guru Nanak Jayanti',
  '2024-11-20': 'Maharashtra assembly election', '2024-12-25': 'Christmas',
  '2025-02-26': 'Mahashivratri', '2025-03-14': 'Holi', '2025-03-31': 'Id-Ul-Fitr', '2025-04-10': 'Mahavir Jayanti',
  '2025-04-14': 'Ambedkar Jayanti', '2025-04-18': 'Good Friday', '2025-05-01': 'Maharashtra Day', '2025-08-15': 'Independence Day',
  '2025-08-27': 'Ganesh Chaturthi', '2025-10-02': 'Gandhi Jayanti / Dussehra', '2025-10-21': 'Diwali (Laxmi Pujan)',
  '2025-10-22': 'Diwali Balipratipada', '2025-11-05': 'Guru Nanak Jayanti', '2025-12-25': 'Christmas',
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string) => ISO.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (s: string) => (new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7;
/** Today's date in India (IST, UTC+5:30), not the browser's UTC date. */
export const todayIST = (now: number = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);

function hash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const EMPTY_COUNTS = (): DateRange['counts'] => ({ validated: 0, partial: 0, failed: 0, downloading: 0, missing: 0, holiday: 0, weekend: 0, calendar: 0, weekdays: 0, runnable: 0 });

/** Bounds of what is stored: earliest file, latest validated file, latest file of any usable quality. */
export function boundsOf(inventory: InventoryDay[], statuses: StatusRow[] = [], floor = FLOOR): DateRange['bounds'] {
  const st = new Map(statuses.map((s) => [s.trade_date, s.status]));
  let earliest: string | null = null, latestValid: string | null = null, latestAny: string | null = null;
  for (const d of inventory) {
    if (d.quality === 'empty' || d.trade_date < floor) continue;
    if (!earliest || d.trade_date < earliest) earliest = d.trade_date;
    if (!latestAny || d.trade_date > latestAny) latestAny = d.trade_date;
    const s = st.get(d.trade_date);
    const valid = s ? s === 'validated' : d.quality === 'complete';
    if (valid && (!latestValid || d.trade_date > latestValid)) latestValid = d.trade_date;
  }
  return { floor, earliest, latest_validated: latestValid, latest_any: latestAny };
}

export interface BuildOptions {
  source?: 'dhan' | 'local';
  underlying?: string;
  series?: Series;
  floor?: string;
  today?: string;
}

/**
 * Builds the range. Rules (§5): runnable = validated + partial days with a file; a weekday without a file is a
 * holiday when the pipeline recorded one or the unverified NSE list names it, otherwise missing; weekends are
 * never missing; the request is clamped to [floor, latest stored day] and the clamp is stated.
 */
export function buildDateRange(request: { from: string; to: string }, inventory: InventoryDay[], statuses: StatusRow[] = [], opts: BuildOptions = {}): DateRange {
  const floor = opts.floor ?? FLOOR;
  const today = opts.today ?? todayIST();
  const dataset = { source: opts.source ?? 'dhan', underlying: opts.underlying ?? 'NIFTY', series: opts.series ?? 'WEEK', interval: '1m' as const };
  const bounds = boundsOf(inventory, statuses, floor);
  const out: DateRange = { request: { ...request }, dataset, bounds, effective: null, days: [], counts: EMPTY_COUNTS(), runnable: [], files: [], messages: [], key: '' };
  const err = (text: string) => out.messages.push({ level: 'error', text });
  const note = (text: string) => out.messages.push({ level: 'note', text });
  const { from, to } = request;
  const finish = () => { out.key = hash(JSON.stringify([dataset, out.files.map((f) => f.path), out.days.filter((d) => d.file).map((d) => `${d.date}:${d.file!.sha256 ?? d.file!.quality}`)])); return out; };

  if (!from || !to) { err('Choose both a start date and an end date.'); return finish(); }
  if (!isIsoDate(from)) err(`“${from}” is not a valid date.`);
  if (!isIsoDate(to)) err(`“${to}” is not a valid date.`);
  if (out.messages.length) return finish();
  if (from > to) { err('The start date is after the end date.'); return finish(); }

  const ceiling = bounds.latest_any && bounds.latest_any < today ? bounds.latest_any : today;
  let lo = from, hi = to;
  if (lo < floor) { note(`History starts on ${floor}; the start was moved there.`); lo = floor; }
  if (hi > ceiling) {
    note(bounds.latest_any ? `The latest stored day is ${bounds.latest_any}; the end was moved there.` : `The end date is after today (${today}); it was moved to today.`);
    hi = ceiling;
  }
  if (lo > hi) { err(bounds.latest_any ? `Nothing is stored after ${bounds.latest_any}. Pick dates up to that day, or load newer data.` : 'There is no data for these dates.'); return finish(); }
  out.effective = { from: lo, to: hi };

  const files = new Map(inventory.map((d) => [d.trade_date, d]));
  const st = new Map(statuses.map((s) => [s.trade_date, s]));
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    const wd = weekdayOf(d), f = files.get(d), s = st.get(d);
    const file = f && f.quality !== 'empty'
      ? { path: f.path, quality: f.quality, index_bars: f.index_bars ?? null, expiry: f.expiry ?? null, lot_size: f.lot_size ?? null, sha256: f.sha256 ?? null } : null;
    let state: DayState, reason: string | null = null, holiday: DayEntry['holiday'] = null;
    if (wd >= 5 && !file && !s) state = 'weekend';
    else if (s && !(file && s.status === 'holiday')) {
      state = s.status; reason = s.reason;
      if (s.status === 'holiday') holiday = { name: s.reason || 'no session (both feeds empty)', source: 'pipeline' };
      if ((state === 'validated' || state === 'partial') && !file) { state = 'missing'; reason = 'recorded as stored, but no day file is uploaded'; }
    } else if (file) {
      if (dataset.source === 'local') { state = 'partial'; reason = 'file from this computer; its quality was not checked'; }
      else if (f!.quality === 'complete') {
        state = 'validated';
        if (f!.index_bars != null && f!.index_bars < 375) { state = 'partial'; reason = `index has ${f!.index_bars} of 375 one-minute bars`; }
      } else { state = 'partial'; reason = `option series ${f!.quality.replace('gaps:', 'missing ')} bar${f!.quality === 'gaps:1' ? '' : 's'}`; }
      if (state === 'partial' && f!.quality.startsWith('gaps') && f!.index_bars != null && f!.index_bars < 375) reason += `; index has ${f!.index_bars} of 375 bars`;
    } else if (f && f.quality === 'empty') { state = 'failed'; reason = 'day file has no option series'; }
    else if (NSE_HOLIDAYS_UNVERIFIED[d]) { state = 'holiday'; holiday = { name: NSE_HOLIDAYS_UNVERIFIED[d], source: 'nse_list_unverified' }; reason = `${NSE_HOLIDAYS_UNVERIFIED[d]} (NSE list, unverified)`; }
    else { state = 'missing'; reason = 'not stored: not loaded yet, or a holiday this calendar does not know'; }
    const entry: DayEntry = { date: d, weekday: wd, state, reason, holiday, file, is_expiry: !!(file && file.expiry === d) };
    out.days.push(entry);
    out.counts[state]++;
    out.counts.calendar++;
    if (wd < 5) out.counts.weekdays++;
    if ((state === 'validated' || state === 'partial') && file) { out.runnable.push(d); out.files.push({ date: d, path: file.path }); }
  }
  out.counts.runnable = out.runnable.length;

  if (!out.runnable.length) err(inventory.length ? 'None of these dates have a stored day file. Load them first (command below), or pick dates that are stored.' : 'No days are stored for this series yet.');
  if (out.counts.missing) note(`${out.counts.missing} weekday${out.counts.missing === 1 ? ' has' : 's have'} no stored data and will not run (never filled in).`);
  if (out.counts.partial) note(`${out.counts.partial} partial day${out.counts.partial === 1 ? '' : 's'} will run; gaps stay gaps, and a day the rules cannot trade on its data is reported as excluded.`);
  if (out.counts.failed) note(`${out.counts.failed} day${out.counts.failed === 1 ? '' : 's'} failed validation and will not run.`);
  if (out.counts.downloading) note(`${out.counts.downloading} day${out.counts.downloading === 1 ? ' is' : 's are'} still being downloaded by the pipeline.`);
  return finish();
}

/** Dates for a preset. Trading-day presets count stored runnable days backwards from the latest one. */
export function presetRange(preset: Preset, inventory: InventoryDay[], statuses: StatusRow[] = [], floor = FLOOR): { from: string; to: string } | null {
  const b = boundsOf(inventory, statuses, floor);
  const end = b.latest_any;
  if (!end || !b.earliest) return null;
  const usable = inventory.filter((d) => d.quality !== 'empty' && d.trade_date >= floor && d.trade_date <= end).map((d) => d.trade_date).sort();
  const back = (n: number) => usable[Math.max(0, usable.length - n)];
  const months = (m: number) => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - m);
    const s = addDays(d.toISOString().slice(0, 10), 1);
    return s < b.earliest! ? b.earliest! : s;
  };
  switch (preset) {
    case 'last_7': return { from: back(7), to: end };
    case 'last_30': return { from: back(30), to: end };
    case 'last_90': return { from: back(90), to: end };
    case '6m': return { from: months(6), to: end };
    case '1y': return { from: months(12), to: end };
    case '2y': return { from: months(24), to: end };
    case '3y': return { from: months(36), to: end };
    case 'max': return { from: b.earliest, to: end };
  }
}

/** The shell command that loads every missing day of the range (shown when something is not stored). */
export function loadCommand(r: DateRange): string | null {
  if (r.dataset.source !== 'dhan' || !isIsoDate(r.request.from) || !isIsoDate(r.request.to) || r.request.from > r.request.to) return null;
  const beyond = (r.bounds.latest_any != null && r.request.to > r.bounds.latest_any) || (r.bounds.earliest != null && r.request.from < r.bounds.earliest) || !r.bounds.latest_any;
  if (!(r.counts.missing || r.counts.failed || beyond)) return null;
  const start = r.request.from < r.bounds.floor ? r.bounds.floor : r.request.from;
  return `straddloop load --expiry ${r.dataset.series} --start ${start} --end ${r.request.to}`;
}
