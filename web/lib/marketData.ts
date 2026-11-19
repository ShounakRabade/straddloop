'use client';
import { supabase } from './supabase';
import { boundsOf, type InventoryDay, type StatusRow } from './dateRange';

/** One row of public.market_days: a day file in the private `market-data` bucket. */
export interface MarketDay extends InventoryDay {
  trade_date: string;
  path: string;
  series: number;
  index_bars: number;
  expiry: string | null;
  lot_size: number | null;
  quality: string;
  bytes: number;
  sha256: string | null;
}

export type ExpiryFlag = 'WEEK' | 'MONTH';

export type Availability =
  | { state: 'off'; why: string }          // no Supabase settings, or not signed in, or not a reader
  | { state: 'empty' }                      // signed in and allowed, nothing uploaded yet
  | { state: 'ready'; days: MarketDay[] };

const COLS = 'trade_date,path,series,index_bars,expiry,lot_size,quality,bytes,sha256';

/** Every uploaded day for one series. Row-level security returns nothing to accounts not in data_readers. */
export async function availability(underlying: string, flag: ExpiryFlag): Promise<Availability> {
  const sb = supabase();
  if (!sb) return { state: 'off', why: 'cloud' };
  const { data: auth } = await sb.auth.getSession();
  if (!auth.session) return { state: 'off', why: 'signin' };
  const { data: reader, error: rerr } = await sb.from('data_readers').select('user_id').maybeSingle();
  if (rerr) return { state: 'off', why: `Supabase: ${rerr.message}` };
  if (!reader) return { state: 'off', why: 'reader' };
  const days: MarketDay[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('market_days').select(COLS).eq('underlying', underlying).eq('expiry_flag', flag)
      .order('trade_date').range(from, from + 999);
    if (error) return { state: 'off', why: `Supabase: ${error.message}` };
    days.push(...(data as MarketDay[]));
    if (!data || data.length < 1000) break;
  }
  return days.length ? { state: 'ready', days } : { state: 'empty' };
}

/**
 * Ingestion statuses uploaded by `straddloop supabase-upload` (table market_day_status). Returns [] when the
 * table does not exist yet or cannot be read: the Lab then falls back to what the day files themselves say.
 */
export async function statuses(underlying: string, flag: ExpiryFlag): Promise<StatusRow[]> {
  const sb = supabase();
  if (!sb) return [];
  const out: StatusRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('market_day_status').select('trade_date,status,reason')
      .eq('underlying', underlying).eq('expiry_flag', flag).order('trade_date').range(from, from + 999);
    if (error || !data) return [];
    out.push(...(data as StatusRow[]));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Earliest stored day, latest validated day and latest stored day of any usable quality for one series, read
 * from the database (never hardcoded). Uses the same rules as the Lab's DateRange, so the calendar's last
 * selectable day is exactly the last day a run can use.
 */
export async function datasetBounds(underlying: string, flag: ExpiryFlag): Promise<{ earliest: string | null; latest_validated: string | null; latest_any: string | null; days: number } | null> {
  const [a, st] = await Promise.all([availability(underlying, flag), statuses(underlying, flag)]);
  if (a.state !== 'ready') return null;
  return { ...boundsOf(a.days, st), days: a.days.length };
}

/** Downloads day files, a few at a time. Calls onProgress after each one. */
export async function download(paths: string[], onProgress: (done: number) => void): Promise<{ path: string; buf: ArrayBuffer }[]> {
  const sb = supabase();
  if (!sb) throw new Error('Supabase is not configured on this site.');
  const out: { path: string; buf: ArrayBuffer }[] = [];
  let next = 0, done = 0;
  async function lane() {
    while (next < paths.length) {
      const path = paths[next++];
      const { data, error } = await sb!.storage.from('market-data').download(path);
      if (error || !data) throw new Error(`Could not download ${path}: ${error?.message ?? 'no data'}`);
      out.push({ path, buf: await data.arrayBuffer() });
      onProgress(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, lane));
  return out;
}

/** Day files picked from this computer (written by `straddloop export-days`). Keyed by file name. */
export async function readLocal(files: FileList): Promise<{ path: string; date: string; buf: ArrayBuffer }[]> {
  const out = [];
  for (const f of Array.from(files)) {
    const m = f.name.match(/(\d{4}-\d{2}-\d{2})\.json\.gz$/);
    if (!m) continue;
    out.push({ path: `local/${f.name}`, date: m[1], buf: await f.arrayBuffer() });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
