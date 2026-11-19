const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹ with Indian grouping. Signed values always carry + or − so colour is never the only cue. */
export function inr(value: number, opts: { sign?: boolean } = {}): string {
  const v = Math.round(value);
  const body = `₹${inrFmt.format(Math.abs(v))}`;
  if (v < 0) return `−\u2060${body}`;
  return opts.sign && v > 0 ? `+\u2060${body}` : body;
}

export const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`;
export const tone = (v: number) => (v > 0 ? 'gain' : v < 0 ? 'loss' : 'flat');

export function exitLabel(key: string): string {
  const map: Record<string, string> = {
    target: 'Profit target', eod: 'End of day', time_exit: 'End of day', structural: 'Reversal level',
    scheduled: 'Scheduled exit', max_loss: 'Max loss', stop: 'Stops', loss_limit: 'Loss limit', expiry: 'Expiry',
  };
  return map[key] ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const inrFmt2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹ with paise, for charges and per-trade figures where rounding to the rupee would hide a reconciliation gap. */
export function inr2(value: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (value == null || !isFinite(value)) return '—';
  const body = `₹${inrFmt2.format(Math.abs(value))}`;
  if (value < -0.004) return `−\u2060${body}`;
  return opts.sign && value > 0.004 ? `+\u2060${body}` : body;
}
export const pct2 = (v: number | null | undefined, digits = 2) => (v == null || !isFinite(v) ? '—' : `${v.toFixed(digits)}%`);
export const num2 = (v: number | null | undefined, digits = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(digits));
