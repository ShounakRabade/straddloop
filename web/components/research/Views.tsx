'use client';
import { useState } from 'react';
import type { Check, Diagnostic, ModelOut, Mc, RegimeDim, Research, Stress, Sens } from '@/lib/research';
import { choiceLabel } from '@/lib/researchSpace';
import { Bar, Histogram, Money, PERF_HEAD, PerfCells, SampleTag, Scroll, Status, money, nm, pc } from './bits';

// ------------------------------------------------------------------ Reading (assistant)
export function Reading({ a }: { a: Research }) {
  const facts = a.assistant.facts;
  const num = new Map(facts.map((f, i) => [f.id, i + 1]));
  const [open, setOpen] = useState(false);
  return (
    <div className="stack rs-reading" style={{ ['--gap' as string]: '18px' }}>
      {a.assistant.sections.map((s) => (
        <section key={s.title} className="stack" style={{ ['--gap' as string]: '6px' }}>
          <h3 className="rep-h">{s.title}</h3>
          <ul className="rs-sentences">
            {s.sentences.map((x, i) => (
              <li key={i}>{x.text}{x.refs.length > 0 && <sup className="rs-refs">{x.refs.map((r) => num.get(r)).filter(Boolean).map((n) => <a key={n} href={`#fact-${n}`}>{n}</a>)}</sup>}</li>
            ))}
          </ul>
        </section>
      ))}
      <details className="rs-sources" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="small">Sources: the {facts.length} computed figures this reading uses</summary>
        <ol className="small">
          {facts.map((f, i) => <li key={f.id} id={`fact-${i + 1}`}><span className="muted">{f.label}:</span> <span className="mono">{f.text}</span></li>)}
        </ol>
      </details>
      <p className="small muted">Written from templates over this run’s computed results. No language model is used, nothing is sent anywhere, and it costs nothing to run. A sentence with no number is a fixed explanation of method.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Regimes
function RegimeTable({ d, minTraded }: { d: RegimeDim; minTraded: number }) {
  return (
    <Scroll label={`${d.label} by regime`}>
      <table className="ptable legs rs-table">
        <thead><tr><th>Regime</th><th className="r">Sessions</th><th className="r">Traded</th><th className="r">Net</th><th className="r">Avg day</th><th className="r">95% range</th><th className="r">Win</th><th className="r">PF</th><th className="r">Max DD</th><th className="r">Util. avg</th><th className="r">Share</th></tr></thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.label} data-thin={r.enough ? undefined : ''}>
              <th scope="row">{r.label}{!r.enough && r.p.traded > 0 && <span className="rs-thin" title={`Fewer than ${minTraded} traded days: too few to rely on`}> few</span>}</th>
              <td className="r">{r.p.sessions}</td><td className="r">{r.p.traded}</td>
              <td className="r"><Money v={r.p.net} /></td><td className="r"><Money v={r.p.mean} /></td>
              <td className="r">{r.p.ci ? `${money(r.p.ci[0])} to ${money(r.p.ci[1])}` : '—'}</td>
              <td className="r">{pc(r.p.win_rate, 0)}</td><td className="r">{r.p.pf == null ? (r.p.pf_note === 'no losing day' ? '∞' : '—') : nm(r.p.pf)}</td>
              <td className="r"><Money v={r.p.max_dd} /></td><td className="r">{pc(r.p.util_avg, 0)}</td><td className="r">{pc(r.share_net, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

export function Regimes({ a, mode, setMode }: { a: Research; mode: 'fixed' | 'percentile'; setMode: (m: 'fixed' | 'percentile') => void }) {
  const R = a.regimes;
  const [key, setKey] = useState('vol');
  if (!R) return <p className="muted small">No index candles were available to classify sessions.</p>;
  const dims = R.dims.concat(a.cluster_regimes ? [a.cluster_regimes] : [], a.hmm_regimes ? [a.hmm_regimes] : []);
  const d = dims.find((x) => x.key === key) ?? dims[0];
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <div className="rs-row">
        <div className="seg" role="radiogroup" aria-label="Regime dimension">
          {dims.map((x) => <label key={x.key}><input type="radio" name="rdim" checked={x.key === d.key} onChange={() => setKey(x.key)} /><span>{x.label.replace(/ \(.*\)$/, '')}</span></label>)}
        </div>
      </div>
      <p className="small"><span className="rs-when" data-t={d.timing}>{d.timing === 'ex-ante' ? 'Known before entry' : 'Known only after the close'}</span> {d.basis}.{d.timing === 'ex-post' ? ' It explains results; it cannot be used as an entry filter.' : ''}</p>
      <RegimeTable d={d} minTraded={R.min_traded} />
      {d.consistency
        ? <p className="small">Best: <b>{d.consistency.best}</b>. Worst: <b>{d.consistency.worst}</b>. {d.consistency.positive} of {d.consistency.judged} regimes with at least {R.min_traded} traded days had a positive average day{d.consistency.cis_overlap ? '; the best and worst 95% ranges overlap, so the difference may be noise' : d.consistency.cis_overlap === false ? '; the best and worst 95% ranges do not overlap' : ''}.</p>
        : <p className="small muted">Fewer than two regimes have {R.min_traded} or more traded days, so nothing can be said about which conditions favour the strategy.</p>}
      <div className="rs-row small">
        <span className="muted">Thresholds:</span>
        <div className="seg" role="radiogroup" aria-label="Threshold mode">
          <label><input type="radio" name="rmode" checked={mode === 'fixed'} onChange={() => setMode('fixed')} /><span>Fixed</span></label>
          <label><input type="radio" name="rmode" checked={mode === 'percentile'} onChange={() => setMode('percentile')} /><span>Percentile of earlier sessions</span></label>
        </div>
      </div>
      {R.notes.map((n) => <p key={n} className="small muted">{n}</p>)}
      <div className="rs-note small">
        <b>Not available, so not used:</b>
        <ul>{R.unavailable.map((u) => <li key={u.key}>{u.label}: {u.why}</li>)}</ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Robustness
export function RobustnessView({ a }: { a: Research }) {
  const r = a.robustness;
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <div className="rs-score">
        <div className="rs-score-n" data-v={r.verdict.key}><span className="mono">{r.score ?? '—'}</span><span className="small muted">of 100</span></div>
        <div className="stack" style={{ ['--gap' as string]: '4px' }}>
          <p><b className="rs-verdict" data-v={r.verdict.key}>{r.verdict.label}</b> · <SampleTag p={a.perf} /></p>
          <p className="small">{r.verdict.why}</p>
          <p className="small muted">{r.formula}{r.raw != null && r.score != null && r.raw > r.score ? ` Before the cap it was ${r.raw}.` : ''}</p>
        </div>
      </div>
      <div className="rs-four">
        <div><span className="label">Statistical confidence</span><b>{r.statistical.grade}</b><p className="small muted">{r.statistical.why}</p></div>
        <div><span className="label">Backtest robustness</span><b>{r.backtest.grade}{r.backtest.score != null ? ` · ${r.backtest.score}` : ''}</b><p className="small muted">{r.backtest.why}</p></div>
        <div><span className="label">Data quality</span><b>{r.data_quality.grade}</b><p className="small muted">{r.data_quality.why}</p></div>
        <div><span className="label">Model uncertainty</span><b>{r.model_uncertainty.grade}</b><ul className="small muted">{r.model_uncertainty.items.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      <Scroll label="Robustness components">
        <table className="ptable legs rs-table">
          <thead><tr><th>Component</th><th className="r">Score</th><th aria-hidden="true" /><th className="r">Weight</th><th>How it is scored</th></tr></thead>
          <tbody>
            {r.components.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}{c.note && <div className="rs-sub">{c.note}</div>}</th>
                <td className="r">{c.score ?? 'n/a'}</td><td><Bar value={c.score} /></td><td className="r">{c.weight}</td>
                <td className="rs-formula">{c.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      <McView mc={a.study ? a.study.monte_carlo.selected : a.check ? a.check.monte_carlo : a.monte_carlo} capital={null} title={a.study ? 'Monte Carlo, selected settings' : 'Monte Carlo, these settings'} />
      {a.check && <CheckView c={a.check} />}
    </div>
  );
}

export function McView({ mc, title }: { mc: Mc; capital: number | null; title: string }) {
  if (mc.status !== 'ok') return <p className="small muted">{title}: {mc.reason}.</p>;
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">{title} <SampleTag p={{ traded: mc.n, sample: mc.sample }} /></h3>
      <Histogram counts={mc.hist.counts} lo={mc.hist.lo} hi={mc.hist.hi} mark={mc.actual_total} label={`${mc.paths.toLocaleString('en-IN')} resampled totals; line = actual`} />
      <table className="ptable rep"><tbody>
        <tr><th scope="row">Total P&amp;L, 5th to 95th percentile</th><td className="num">{money(mc.total.p5)} to {money(mc.total.p95)}</td><td className="rep-note">median {money(mc.total.p50)}; actual {money(mc.actual_total)}</td></tr>
        <tr><th scope="row">Chance the total is a loss</th><td className="num">{pc(100 * mc.p_loss, 0)}</td><td className="rep-note">{mc.method === 'block' ? `circular blocks of ${mc.block} days, so losing streaks stay together` : 'days drawn independently'}</td></tr>
        <tr><th scope="row">Drawdown, 95th percentile</th><td className="num">{money(mc.dd.p95)}</td><td className="rep-note">median {money(mc.dd.p50)}; actual {money(mc.actual_dd)}; same days reshuffled: {money(mc.shuffle_dd.p95)}</td></tr>
        {mc.dd_exceed.map((x) => <tr key={x.pct}><th scope="row">Drawdown deeper than {x.pct}% of capital</th><td className="num">{pc(100 * x.prob, 0)}</td><td className="rep-note">of paths</td></tr>)}
      </tbody></table>
    </div>
  );
}

function StressView({ s, title }: { s: Stress; title: string }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">{title}</h3>
      <Scroll label={title}>
        <table className="ptable legs rs-table">
          <thead><tr><th>Scenario</th>{PERF_HEAD}</tr></thead>
          <tbody>{s.rows.map((r) => <tr key={r.key} data-thin={r.inert ? '' : undefined}><th scope="row">{r.label}{r.inert && <span className="rs-sub">no effect on this data (quoted bid/ask)</span>}</th><PerfCells p={r.p} /></tr>)}</tbody>
        </table>
      </Scroll>
      <p className="small">{s.break_even_slip != null ? <>Breaks even at about <b>{s.break_even_slip.toFixed(2)}%</b> slippage per fill (run at {s.base_slip}%).</> : <>Break-even slippage: {s.break_even_note}.</>}{s.slip_inert ? '' : ' Real data has no bid/ask, so treat the run’s own slippage as optimistic.'}</p>
    </div>
  );
}

function SensView({ sens, base }: { sens: Sens[]; base: 'is' | 'whole' }) {
  if (!sens.length) return null;
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <h3 className="rep-h">Parameter sensitivity {base === 'is' ? '(training + validation)' : '(whole range)'}</h3>
      <Scroll label="Parameter sensitivity">
        <table className="ptable legs rs-table">
          <thead><tr><th>Setting</th><th>Value</th>{PERF_HEAD}</tr></thead>
          <tbody>
            {sens.flatMap((s) => [
              <tr key={s.key} className="rs-group"><th colSpan={8}>{s.label} · keeps {s.retention == null ? 'n/a' : pc(100 * s.retention, 0)} of the score one step away · {s.positive_neighbours} of {s.neighbours} neighbours profitable</th></tr>,
              ...s.rows.map((r) => <tr key={`${s.key}-${String(r.value)}`} data-base={r.step === 0 ? '' : undefined}><td /><td>{choiceLabel(r.value)}{r.step === 0 ? ' (chosen)' : ''}</td><PerfCells p={r.p} /></tr>),
            ])}
          </tbody>
        </table>
      </Scroll>
    </div>
  );
}

export function CheckView({ c }: { c: Check }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h3 className="rep-h">Across periods (chronological thirds)</h3>
        <Scroll label="Thirds">
          <table className="ptable legs rs-table">
            <thead><tr><th>Period</th>{PERF_HEAD}</tr></thead>
            <tbody>{c.thirds.map((p, i) => <tr key={i}><th scope="row">{p.from ?? '—'} to {p.to ?? '—'}</th><PerfCells p={p} /></tr>)}</tbody>
          </table>
        </Scroll>
        <p className="small muted">Not a true out-of-sample test: the settings may have been tuned on these same days. Use the optimisation lab’s walk-forward for that.</p>
      </div>
      <SensView sens={c.sensitivity} base="whole" />
      <StressView s={c.stress} title="Transaction-cost stress" />
      <p className="small muted">{c.runs} backtests in {(c.ms / 1000).toFixed(1)} s.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Diagnostics and models
export function Diagnostics({ a }: { a: Research }) {
  const groups: [string, Diagnostic[]][] = [['Overfitting', a.diagnostics.overfitting], ['Concentration', a.diagnostics.concentration], ['Fragility', a.diagnostics.fragility]];
  const val = (d: Diagnostic) => (d.value == null ? '' : ['configs'].includes(d.id) ? String(d.value) : ['payoff', 'tail', 'wfe', 'rank_corr'].includes(d.id) ? nm(d.value) : d.id === 'break_even_slip' ? pc(d.value, 2) : pc(d.value, 0));
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      {groups.map(([g, rows]) => (
        <div key={g} className="stack" style={{ ['--gap' as string]: '6px' }}>
          <h3 className="rep-h">{g}</h3>
          <table className="ptable rep rs-diag"><tbody>
            {rows.map((d) => <tr key={d.id}><th scope="row">{d.label}</th><td className="num">{val(d)} <Status s={d.status} /></td><td className="rep-note">{d.text}</td></tr>)}
          </tbody></table>
        </div>
      ))}
      <Models a={a} />
    </div>
  );
}

function ModelLine({ name, m, render }: { name: string; m: ModelOut; render: (m: Record<string, unknown>) => string }) {
  return <tr><th scope="row">{name}</th><td className="rep-note">{m.status === 'ok' ? `${render(m as Record<string, unknown>)} Method: ${m.method}.` : `Not run: ${m.reason}.`}</td></tr>;
}
function Models({ a }: { a: Research }) {
  const M = a.models;
  const f2 = (x: unknown) => (typeof x === 'number' ? x.toFixed(2) : '—');
  return (
    <div className="stack" style={{ ['--gap' as string]: '6px' }}>
      <h3 className="rep-h">Chronological models</h3>
      <p className="small muted">Fitted on the earlier part of the range and judged only on later sessions. Each says whether it beats a simple baseline. None is used to predict profits.</p>
      <table className="ptable rep rs-diag"><tbody>
        <ModelLine name="Volatility clusters (k-means)" m={M.kmeans} render={(m) => `${(m.centroids as unknown[]).length} clusters, trained to ${m.train_to}; see the Regimes tab.`} />
        <ModelLine name="Volatility states (HMM)" m={M.hmm} render={(m) => { const s = m.states as { label: string; rv_pct: number; stay_prob: number }[]; return `${s.map((x) => `${x.label} around ${x.rv_pct.toFixed(1)}% vol, stays ${(100 * x.stay_prob).toFixed(0)}% of days`).join('; ')}.`; }} />
        <ModelLine name="Next-day volatility forecast" m={M.vol_forecast} render={(m) => `Error ${f2(m.rmse_model)} vs ${f2(m.rmse_naive)} for “same as yesterday” and ${f2(m.rmse_mean)} for the average (log vol, ${m.test_sessions} later sessions): ${m.beats_naive ? 'beats' : 'does not beat'} yesterday, ${m.beats_mean ? 'beats' : 'does not beat'} the average.`} />
        <ModelLine name="Entry filter from facts known before entry" m={M.entry_filter} render={(m) => `On ${m.test_days} later traded days: accuracy ${(100 * (m.accuracy as number)).toFixed(0)}% vs ${(100 * (m.accuracy_base as number)).toFixed(0)}% always guessing the majority; Brier ${f2(m.brier)} vs ${f2(m.brier_base)}; AUC ${f2(m.auc)}. ${m.beats_base ? 'Slightly better than the base rate.' : 'No better than the base rate.'}`} />
        <ModelLine name="Random forest, gradient boosting" m={M.trees} render={() => ''} />
      </tbody></table>
    </div>
  );
}
