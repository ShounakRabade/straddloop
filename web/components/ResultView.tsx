'use client';
import { CountUp } from './CountUp';
import { EquityChart } from './charts';
import { exitLabel, inr, pct, tone } from '@/lib/format';
import type { RunResult } from '@/lib/types';

export const unitWord = (r: RunResult, n = 1) => (r.unit === 'day' ? (n === 1 ? 'traded day' : 'traded days') : `${r.unit}${n === 1 ? '' : 's'}`);

/** One plain-language reading of a run: what the interval does and does not allow you to say. */
export function verdict(r: RunResult): { head: string; body: string } {
  const [lo, hi] = r.ci, range = `${inr(lo, { sign: true })} to ${inr(hi, { sign: true })}`;
  if (!r.traded) return { head: 'No trades were taken.', body: 'With these settings the entry rule never passed. Loosen a filter or lengthen the sample.' };
  if (lo > 0) return { head: 'Positive on this synthetic sample, and the range stays above zero.', body: `The average ${unitWord(r)} sits between ${range} with 95% confidence. That is a property of the model's assumptions until real data agrees. Try another market seed before believing it.` };
  if (hi < 0) return { head: 'A reliable loss on this synthetic sample.', body: `The average ${unitWord(r)} sits between ${range} with 95% confidence. The whole range is below zero, so this is not bad luck in the sample.` };
  return { head: 'This run cannot tell profit from luck.', body: `The average ${unitWord(r)} sits between ${range} with 95% confidence. The range includes zero, so a different ${r.sessions} ${r.unit === 'month' ? 'stock-months' : 'sessions'} could show the opposite sign.` };
}

export function Kpis({ r }: { r: RunResult }) {
  return (
    <div className="kpis">
      <div className="kpi kpi--lead"><span className="label">Net after costs</span><span className={`v ${tone(r.net)}`}><CountUp value={r.net} format={(v) => inr(v, { sign: true })} /></span><span className="s">Gross {inr(r.gross, { sign: true })}</span></div>
      <div className="kpi"><span className="label">Average {unitWord(r)}</span><span className={`v ${tone(r.avg)}`}><CountUp value={r.avg} format={(v) => inr(v, { sign: true })} /></span><span className="s">95% range {inr(r.ci[0], { sign: true })} to {inr(r.ci[1], { sign: true })}</span></div>
      <div className="kpi"><span className="label">Won</span><span className="v"><CountUp value={r.winRate} format={(v) => pct(v)} /></span><span className="s">of {r.traded} {unitWord(r, r.traded)}</span></div>
      <div className="kpi"><span className="label">Deepest drawdown</span><span className="v loss"><CountUp value={r.maxDD} format={(v) => inr(v)} /></span><span className="s">Worst single {r.unit} {inr(r.worst)}</span></div>
      <div className="kpi"><span className="label">Costs paid</span><span className="v"><CountUp value={r.costs} format={(v) => inr(v)} /></span><span className="s">Already inside net</span></div>
    </div>
  );
}

export function Exits({ r }: { r: RunResult }) {
  const rows = Object.entries(r.exits).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, n]) => a + n, 0) || 1;
  if (!rows.length) return <p className="muted small" style={{ padding: 18 }}>No exits to show.</p>;
  return (
    <div className="bars">
      {rows.map(([k, n]) => (
        <div className="bar" key={k}>
          <span>{exitLabel(k)}</span>
          <span className="track" aria-hidden="true"><span className="fill" style={{ display: 'block', width: `${(100 * n) / total}%` }} /></span>
          <span className="mono small">{n} · {pct((100 * n) / total, 0)}</span>
        </div>
      ))}
    </div>
  );
}

export function Curve({ r, id }: { r: RunResult; id: string }) {
  return <EquityChart key={`${r.net}-${r.curve.length}`} id={id} points={r.curve} label={`Cumulative net profit and loss across ${r.curve.length} points, ending at ${inr(r.net)}.`} />;
}
