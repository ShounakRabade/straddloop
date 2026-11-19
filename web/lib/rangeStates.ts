/** Per-day data state for a date range, shown in the Lab. Pure: no network, no React. */

export type DayState = 'validated' | 'partial' | 'failed' | 'downloading' | 'holiday' | 'missing';

export interface StoredDay { trade_date: string; quality: string }
export interface StatusRow { trade_date: string; status: DayState; reason: string | null }

export interface RangeSummary {
  counts: Record<DayState, number>;
  /** Days with a file the Lab can download (validated or partial). */
  local: number;
  /** Failed or partial days with the reason the pipeline recorded. */
  problems: { date: string; state: DayState; reason: string }[];
  /** Weekdays with no stored file and no recorded status: nothing has been fetched for them. */
  missingDates: string[];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * `statuses` (from the ingestion ledger, uploaded by the pipeline) wins when present. A day that has a
 * file but no status row (uploaded before statuses existed) counts as validated only if its quality is
 * "complete", otherwise partial. A weekday with neither is `missing`; weekends are not counted.
 */
export function summarizeRange(from: string, to: string, stored: StoredDay[], statuses: StatusRow[]): RangeSummary {
  const files = new Map(stored.map((d) => [d.trade_date, d]));
  const st = new Map(statuses.map((s) => [s.trade_date, s]));
  const counts: Record<DayState, number> = { validated: 0, partial: 0, failed: 0, downloading: 0, holiday: 0, missing: 0 };
  const problems: RangeSummary['problems'] = [];
  const missingDates: string[] = [];
  if (!from || !to || from > to) return { counts, local: 0, problems, missingDates };
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    const key = ymd(d);
    const wk = d.getUTCDay();
    const s = st.get(key), f = files.get(key);
    if ((wk === 0 || wk === 6) && !s && !f) continue;
    let state: DayState;
    if (s) state = s.status;
    else if (f) state = f.quality === 'complete' ? 'validated' : 'partial';
    else state = 'missing';
    // A status row without a file cannot be run: say so instead of calling it available.
    if ((state === 'validated' || state === 'partial') && !f) state = 'missing';
    counts[state]++;
    if (state === 'missing') missingDates.push(key);
    if (state === 'failed' || state === 'partial') {
      problems.push({ date: key, state, reason: s?.reason || (f ? `file quality: ${f.quality}` : '') });
    }
  }
  return { counts, local: counts.validated + counts.partial, problems, missingDates };
}
