'use client';
import type { ReactNode } from 'react';
import { inr, tone } from '@/lib/format';
import type { Num, Perf } from '@/lib/research';

export const money = (v: Num | undefined, sign = true) => (v == null || !isFinite(v) ? '—' : inr(v, { sign }));
export const pc = (v: Num | undefined, d = 1) => (v == null || !isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
export const nm = (v: Num | undefined, d = 2) => (v == null || !isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
export const Money = ({ v, sign = true }: { v: Num | undefined; sign?: boolean }) => <span className={v == null ? '' : tone(v)}>{money(v, sign)}</span>;

/** Sample-size badge: the first thing next to any figure computed from few observations. */
export function SampleTag({ p }: { p: Pick<Perf, 'traded' | 'sample'> }) {
  return <span className="rs-sample" data-k={p.sample.key} title={p.sample.min_next ? `Readings start to mean something at ${p.sample.min_next} traded days.` : undefined}>{p.traded} traded · {p.sample.label.toLowerCase()}</span>;
}

export function Status({ s }: { s: 'ok' | 'watch' | 'warn' | 'n/a' }) {
  const label = { ok: 'OK', watch: 'Watch', warn: 'Warning', 'n/a': 'Not measured' }[s];
  return <span className="rs-status" data-s={s}>{label}</span>;
}

export function Bar({ value, max = 100 }: { value: Num; max?: number }) {
  if (value == null) return <span className="rs-bar" data-empty aria-hidden="true" />;
  return <span className="rs-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, (100 * value) / max))}%` }} /></span>;
}

export function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rs-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

/** One-line statistics of a window, used in the comparison tables. */
export function PerfCells({ p }: { p: Perf | undefined }) {
  if (!p) return <><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></>;
  return (
    <>
      <td className="r"><Money v={p.net} /></td>
      <td className="r">{p.traded}/{p.sessions}</td>
      <td className="r">{pc(p.win_rate, 0)}</td>
      <td className="r">{p.pf == null ? (p.pf_note ? '∞' : '—') : nm(p.pf)}</td>
      <td className="r">{nm(p.sharpe)}</td>
      <td className="r"><Money v={p.max_dd} /></td>
    </>
  );
}
export const PERF_HEAD = <><th className="r">Net</th><th className="r">Traded</th><th className="r">Win</th><th className="r">PF</th><th className="r">Sharpe</th><th className="r">Max DD</th></>;

/** Small histogram for Monte Carlo totals and the spread of tested configurations. */
export function Histogram({ counts, lo, hi, mark, label }: { counts: number[]; lo: number; hi: number; mark?: number | null; label: string }) {
  const max = Math.max(1, ...counts), w = 100 / counts.length;
  const mx = mark == null || hi <= lo ? null : Math.max(0, Math.min(100, (100 * (mark - lo)) / (hi - lo)));
  const zero = hi > lo && lo < 0 && hi > 0 ? (100 * -lo) / (hi - lo) : null;
  return (
    <figure className="rs-hist">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={label}>
        {counts.map((c, i) => <rect key={i} x={i * w + 0.3} width={w - 0.6} y={40 - (38 * c) / max} height={(38 * c) / max} data-neg={lo + (i + 0.5) * ((hi - lo) / counts.length) < 0 ? '' : undefined} />)}
        {zero != null && <line x1={zero} x2={zero} y1="0" y2="40" className="zero" />}
        {mx != null && <line x1={mx} x2={mx} y1="0" y2="40" className="hmark" />}
      </svg>
      <figcaption className="small muted"><span>{money(lo)}</span><span>{label}</span><span>{money(hi)}</span></figcaption>
    </figure>
  );
}
