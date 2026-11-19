/**
 * Rolling risk series for the Lab's charts. Pure.
 *
 * The definitions are the ledger's own (public/engine/ledger.js, buildReport): daily return = the day's net
 * realised P&L / the previous closing balance (the first day uses starting capital); every session counts and
 * idle days are 0; excess = return − risk-free per day; Sharpe = mean(excess) / sample stdev × √periods.
 * Over the whole run these functions reproduce the report's Sharpe and daily standard deviation exactly
 * (tests/rolling.test.mts checks that), so a rolling window is the same statistic on fewer sessions.
 */

export interface DailyLike { date: string; net_realised: number; closing_balance: number }
export interface Acct { initial_capital: number; risk_free_pct?: number; periods_per_year?: number }

export function dailyReturns(daily: DailyLike[], acct: Acct): number[] {
  let prev = acct.initial_capital;
  return daily.map((d) => { const r = prev > 0 ? d.net_realised / prev : 0; prev = d.closing_balance; return r; });
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function stdev(xs: number[]) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = sum(xs) / n;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (n - 1));
}

export function sharpeOf(rets: number[], acct: Acct): number | null {
  const ppy = acct.periods_per_year ?? 252, rf = (acct.risk_free_pct ?? 0) / 100 / ppy;
  const ex = rets.map((r) => r - rf), sd = stdev(ex);
  return ex.length >= 2 && sd > 0 ? (sum(ex) / ex.length) / sd * Math.sqrt(ppy) : null;
}

/** Sample standard deviation of daily returns, in percent (the report's daily_return_sd_pct). */
export function dailySdPct(rets: number[], acct: Acct): number {
  const ppy = acct.periods_per_year ?? 252, rf = (acct.risk_free_pct ?? 0) / 100 / ppy;
  return 100 * stdev(rets.map((r) => r - rf));
}

export interface RollingPoint { d: string; v: number | null }

/** Sharpe over each trailing window of `n` sessions. Points before the first full window are null. */
export function rollingSharpe(daily: DailyLike[], acct: Acct, n: number): RollingPoint[] {
  const rets = dailyReturns(daily, acct);
  return daily.map((d, i) => ({ d: d.date, v: i + 1 >= n ? sharpeOf(rets.slice(i + 1 - n, i + 1), acct) : null }));
}

/** Annualised volatility (stdev of daily returns × √periods, in %) over each trailing window of `n` sessions. */
export function rollingVol(daily: DailyLike[], acct: Acct, n: number): RollingPoint[] {
  const rets = dailyReturns(daily, acct), ppy = acct.periods_per_year ?? 252;
  return daily.map((d, i) => ({ d: d.date, v: i + 1 >= n ? 100 * stdev(rets.slice(i + 1 - n, i + 1)) * Math.sqrt(ppy) : null }));
}
