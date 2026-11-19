/** Tradebook filtering for the Lab. Pure, so it is tested without a browser. Rows are the ledger's tradebook rows. */
import type { LedgerRow } from './types';

export interface TradeFilter {
  q: string;                     // free text: matches date, strike, side, exit reason, flags
  from: string; to: string;      // trade dates, inclusive ('' = open)
  symbol: string; expiry: string; leg: string;
  side: '' | 'CE' | 'PE';
  direction: '' | 'LONG' | 'SHORT';
  outcome: '' | 'win' | 'loss';
  exit: string;
  min: string; max: string;      // net P&L bounds in rupees ('' = open)
}
export const EMPTY_FILTER: TradeFilter = { q: '', from: '', to: '', symbol: '', expiry: '', leg: '', side: '', direction: '', outcome: '', exit: '', min: '', max: '' };

const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN);

export function filterTrades(rows: LedgerRow[], f: TradeFilter): LedgerRow[] {
  const q = f.q.trim().toLowerCase();
  const lo = f.min.trim() === '' ? -Infinity : Number(f.min), hi = f.max.trim() === '' ? Infinity : Number(f.max);
  return rows.filter((r) => {
    const d = String(r.date ?? ''), net = num(r.net_pnl);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.symbol && r.symbol !== f.symbol) return false;
    if (f.expiry && r.expiry !== f.expiry) return false;
    if (f.leg && String(r.kind || r.leg) !== f.leg) return false;
    if (f.side && r.side !== f.side) return false;
    if (f.direction && r.direction !== f.direction) return false;
    if (f.outcome === 'win' && !(net > 0)) return false;
    if (f.outcome === 'loss' && !(net <= 0)) return false;
    if (f.exit && r.exit_reason !== f.exit) return false;
    if (!(net >= (Number.isNaN(lo) ? -Infinity : lo) && net <= (Number.isNaN(hi) ? Infinity : hi))) return false;
    if (q) {
      const hay = [r.date, r.strike, r.side, r.direction, r.exit_reason, r.kind, r.flags, r.expiry, r.trade_no].map((x) => String(x ?? '')).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct values of a column, sorted, for the filter menus. */
export function distinct(rows: LedgerRow[], key: string): string[] {
  return [...new Set(rows.map((r) => r[key]).filter((v) => v != null && v !== '').map(String))].sort();
}

export const activeCount = (f: TradeFilter) => Object.entries(f).filter(([, v]) => v !== '').length;

/** Minutes between two HH:MM times on the same day, or null. */
export function holdMinutes(r: LedgerRow): number | null {
  const a = String(r.entry_time ?? ''), b = String(r.exit_time ?? '');
  const m = (s: string) => { const x = s.match(/^(\d{1,2}):(\d{2})/); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const ea = m(a), eb = m(b);
  return ea == null || eb == null || eb < ea ? null : eb - ea;
}
