'use client';
/**
 * The Legs tab: how each leg did (every booked leg from the ledger, after its own charges), and for builder
 * structures how positions won and lost and what a position was worth at expiry. Figures come from the run.
 */
import { useMemo, useState } from 'react';
import Legs from '@/public/engine/legs.js';
import { inr, shortDate, tone } from '@/lib/format';
import { toHM as fmtHM } from '@/lib/sessionTime';
import { legGroups, payoffCurve, positionSummary } from '@/lib/legPerformance';
import type { LedgerRow, RunResult } from '@/lib/types';
import { PayoffPlot } from './Plot';

const money = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : inr(v, { sign: true }));
const Money = ({ v }: { v: number | null | undefined }) => <span className={v == null ? '' : tone(v)}>{money(v)}</span>;
const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

export function LegsPanel({ r, trades }: { r: RunResult; trades: LedgerRow[] | null }) {
  const groups = useMemo(() => (trades ? legGroups(trades, r) : []), [trades, r]);
  const positions = r.positions ?? [];
  const sum = useMemo(() => positionSummary(positions), [positions]);
  const withPayoff = useMemo(() => positions.filter((p) => p.payoff && new Set(p.legs.filter((l) => l.kind === 'initial').map((l) => l.expiry)).size === 1), [positions]);
  const [pick, setPick] = useState<string | null>(null);
  const pos = withPayoff.find((p) => p.id === pick) ?? withPayoff[0] ?? null;
  const curve = useMemo(() => (pos ? payoffCurve(pos, Legs.payoffAt) : null), [pos]);
  const unit = r.strategy === 'legs' ? 'position' : r.unit === 'day' ? 'day' : 'trade';

  if (!r.account) return <div className="panel" role="tabpanel" id="panel-legs" aria-labelledby="tab-legs"><div className="plot-empty">The four-leg model has no per-leg ledger in the Lab.</div></div>;
  return (
    <div className="panel legs-panel" role="tabpanel" id="panel-legs" aria-labelledby="tab-legs">
      <section className="blk" aria-labelledby="legs-h">
        <div className="blk-h"><h2 id="legs-h">By leg</h2><span className="sec-note">{trades ? `${trades.length} booked legs` : 'Reading the ledger…'}</span></div>
        <p className="chart-cap">Every leg the ledger booked, after its own charges. Legs of one structure are meant to offset each other, so a leg that loses can belong to a {unit} that wins; read the {unit} figures for the strategy as a whole.</p>
        {trades == null ? <div className="skel" aria-label="Loading legs"><i /><i /><i /></div> : !groups.length ? <div className="plot-empty">No leg was booked in this run.</div> : (
          <div className="tscroll">
            <table className="tbl legs-tbl">
              <thead><tr><th>Leg</th><th className="r">Legs</th><th className="r">Won</th><th className="r">Net</th><th className="r">Average</th><th className="r">Best</th><th className="r">Worst</th><th className="r">Stopped</th><th className="r">Target</th><th className="r">Charges</th><th>Closed by</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td className="t"><b>{g.label}</b>{g.detail && <div className="f-meta">{g.detail}</div>}</td>
                    <td className="r">{g.legs}{g.reentries ? <div className="f-meta">{g.reentries} re-entr{g.reentries === 1 ? 'y' : 'ies'}</div> : null}</td>
                    <td className="r">{pc(g.wins, g.legs)}</td>
                    <td className="r"><Money v={g.net} /></td><td className="r"><Money v={g.avg} /></td>
                    <td className="r"><Money v={g.best} /></td><td className="r"><Money v={g.worst} /></td>
                    <td className="r">{g.stops ? `${g.stops} · ${pc(g.stops, g.legs)}` : '0'}</td>
                    <td className="r">{g.targets ? `${g.targets} · ${pc(g.targets, g.legs)}` : '0'}</td>
                    <td className="r">{inr(g.charges)}</td>
                    <td className="t">{g.exits.slice(0, 3).map((e) => `${e.label} ${e.n}`).join(' · ')}{g.exits.length > 3 ? ' · …' : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td className="t"><b>All legs</b></td><td className="r">{groups.reduce((s, g) => s + g.legs, 0)}</td><td className="r">{pc(groups.reduce((s, g) => s + g.wins, 0), groups.reduce((s, g) => s + g.legs, 0))}</td>
                <td className="r"><Money v={groups.reduce((s, g) => s + g.net, 0)} /></td><td colSpan={5} /><td className="r">{inr(groups.reduce((s, g) => s + g.charges, 0))}</td><td /></tr></tfoot>
            </table>
          </div>
        )}
      </section>

      {r.strategy === 'legs' && positions.length > 0 && (
        <section className="blk" aria-labelledby="pos-h">
          <div className="blk-h"><h2 id="pos-h">Positions</h2><span className="sec-note">as the engine filled them; the ledger agrees unless an order was cut for margin (Diagnostics)</span></div>
          <div className="figs">
            <div className="m"><span className="lbl">Positions</span><span className="m-v">{sum.n}</span><span className="m-s">{sum.carried ? `${sum.carried} held overnight` : 'all closed the day they opened'}</span></div>
            <div className="m"><span className="lbl">Won / lost</span><span className="m-v">{sum.wins} / {sum.losses}</span><span className="m-s">{pc(sum.wins, sum.n)} won</span></div>
            <div className="m"><span className="lbl">Average win</span><span className="m-v gain">{money(sum.avgWin)}</span><span className="m-s">average loss <Money v={sum.avgLoss} /></span></div>
            <div className="m"><span className="lbl">Win ÷ loss size</span><span className="m-v">{sum.payoffRatio == null ? '—' : sum.payoffRatio.toFixed(2)}</span><span className="m-s">{sum.payoffRatio == null ? 'needs both wins and losses' : 'average win ÷ average loss'}</span></div>
            <div className="m"><span className="lbl">Per position</span><span className={`m-v ${tone(sum.expectancy ?? 0)}`}>{money(sum.expectancy)}</span><span className="m-s">best {money(sum.best)} · worst {money(sum.worst)}</span></div>
          </div>
          <div className="tscroll">
            <table className="tbl">
              <thead><tr><th>Closed by</th><th className="r">Positions</th><th className="r">Share</th><th className="r">Net</th><th className="r">Average</th></tr></thead>
              <tbody>{sum.byExit.map((e) => <tr key={e.reason}><td className="t">{e.label}</td><td className="r">{e.n}</td><td className="r">{pc(e.n, sum.n)}</td><td className="r"><Money v={e.net} /></td><td className="r"><Money v={e.avg} /></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      {r.strategy === 'legs' && positions.length > 0 && (
        <section className="blk" aria-labelledby="payoff-h">
          <div className="blk-h">
            <h2 id="payoff-h">Payoff at expiry</h2>
            {withPayoff.length > 0 && (
              <label className="opt-inl">Position
                <select className="in" style={{ width: 'auto', minWidth: 0 }} value={pos?.id ?? ''} onChange={(e) => setPick(e.target.value)} aria-label="Position to draw">
                  {withPayoff.map((p) => <option key={p.id} value={p.id}>{p.id} · {shortDate(p.opened.date)} {fmtHM(p.opened.t)} · {money(p.net)}</option>)}
                </select>
              </label>
            )}
          </div>
          {!pos || !curve ? <div className="plot-empty">{positions.length ? 'These positions hold legs of more than one expiry, so there is no single expiry to draw.' : 'No position opened.'}</div> : (
            <>
              <p className="chart-cap">What {pos.id}, opened {shortDate(pos.opened.date)} at {fmtHM(pos.opened.t)}, would be worth at expiry for each index level, from the entry prices of the legs opened together, before charges. It is the shape of the structure, not what happened: {pos.id} actually closed {pos.closed ? `on ${shortDate(pos.closed.date)} at ${fmtHM(pos.closed.t)}` : 'at the end of the data'} ({pos.exit_reason.replace(/_/g, ' ')}) for <Money v={pos.net} /> after charges.</p>
              <div className="figs">
                <div className="m"><span className="lbl">Most it can make</span><span className="m-v gain">{curve.max_profit == null ? 'Unlimited' : money(curve.max_profit)}</span><span className="m-s">at expiry, before charges</span></div>
                <div className="m"><span className="lbl">Most it can lose</span><span className="m-v loss">{curve.max_loss == null ? 'Unlimited' : money(curve.max_loss)}</span><span className="m-s">{curve.max_loss == null ? 'a short option with nothing bought beyond it' : 'at expiry, before charges'}</span></div>
                <div className="m"><span className="lbl">Breakevens</span><span className="m-v m-v--wrap">{curve.breakevens.length ? curve.breakevens.map((b) => <span key={b}>{b.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>) : 'none'}</span><span className="m-s">index levels at expiry</span></div>
                <div className="m"><span className="lbl">Index at entry</span><span className="m-v">{curve.spot == null ? '—' : curve.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span><span className="m-s">the dashed line</span></div>
              </div>
              <PayoffPlot pts={curve.pts} strikes={curve.strikes} breakevens={curve.breakevens} spot={curve.spot} fmt={(v) => inr(v, { sign: true })}
                label={`Value of ${pos.id} at expiry by index level, with its strikes, breakevens and the index at entry.`} />
              <ul className="legend-row" aria-label="Legs of this position">
                {pos.legs.filter((l) => l.kind === 'initial').map((l) => <li key={l.id}><b>{l.action === 'SELL' ? 'Sell' : 'Buy'} {l.right} {l.strike}</b> × {l.qty} @ {l.entry_px.toFixed(2)}</li>)}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
