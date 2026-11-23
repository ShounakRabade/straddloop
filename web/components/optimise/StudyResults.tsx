'use client';
/**
 * A finished study: the three answers (each with its held-out test, reported and never used to choose), the checks
 * on the choice, and the ranked table of every configuration on training, validation and in-sample figures only.
 */
import { Fragment, useMemo, useState } from 'react';
import type { Opened, Optimiser } from '@/lib/optimiser/useOptimiser';
import type { StudyConfig, Summary } from '@/lib/optimiser/store';
import { ANSWER_LABEL, WINDOW_LABEL, avgOf, axesOfStudy, csvOf, filterRows, rowsOf, sortRows, valueText, type Answer, type Row, type SortKey, type WindowKey } from '@/lib/optimiser/rows';
import type { Value } from '@/lib/optimiser/space';
import { inr, shortDate, tone } from '@/lib/format';
import { LinePlot, type Band } from '@/components/lab/Plot';
import { OBJECTIVES } from '@/lib/researchSpace';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const money = (v: unknown) => (fin(v) ? inr(v, { sign: true }) : '—');
const pc = (v: unknown, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : '—');
const nm = (v: unknown, d = 2) => (fin(v) ? v.toFixed(d) : '—');
const share = (v: number | null) => (v == null ? 'not measured' : `${Math.round(v * 100)}%`);
const n0 = (x: number) => x.toLocaleString('en-IN');
const Money = ({ v }: { v: unknown }) => <span className={fin(v) ? tone(v) : ''}>{money(v)}</span>;

const COMPONENT: [string, string][] = [
  ['folds', 'Walk-forward test blocks that made money'], ['thirds', 'In-sample thirds that made money'], ['regimes', 'Low, mid and high volatility sessions that made money'],
  ['validation', 'Validation window made money'], ['neighbours', 'Settings one step either side that made money'], ['slippage', 'In-sample net kept at doubled slippage'],
];
type CurveState = { status: 'loading' } | { status: 'done'; pts: { d: string; v: number }[] } | { status: 'error'; msg: string };

export function StudyResults({ opened, opt, onLoad }: { opened: Opened; opt: Optimiser; onLoad: (cfg: StudyConfig, id: number, run: boolean) => void }) {
  const { study, cands } = opened;
  const cfg = study.config, res = study.result, plan = study.plan;
  const byKey = useMemo(() => new Map(cands.map((c) => [c.key, c])), [cands]);
  const axes = useMemo(() => axesOfStudy(study), [study]);
  const table = useMemo(() => rowsOf(study, cands), [study, cands]);
  const [win, setWin] = useState<WindowKey>('is');
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: 'rank', asc: false });
  const [filter, setFilter] = useState({ minTraded: 0, positiveValidation: false, answersOnly: false });
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<number | null>(null);
  const [cmp, setCmp] = useState<number[]>([]);
  const [curves, setCurves] = useState<Map<number, CurveState>>(new Map());
  const [shown, setShown] = useState<number[]>([]);
  const rows = useMemo(() => sortRows(filterRows(table.rows, filter, win), sort.k, win, sort.asc), [table.rows, filter, win, sort]);

  if (!res || study.status !== 'done') {
    return (
      <div className="ws-empty">
        <span className="lbl">{study.status === 'cancelled' ? 'Cancelled' : 'Not finished'}</span>
        <h2>{cfg.name}</h2>
        <p>{n0(study.counts.evaluated)} of {n0(study.counts.planned)} configurations were measured before it stopped{study.error ? `: ${study.error}` : ''}. The answers are chosen only once every configuration is measured.</p>
        <div className="run-actions"><button type="button" className="qbtn" disabled={!!opt.running} onClick={() => opt.resume(study.id)}>Resume the study</button></div>
      </div>
    );
  }

  const summaryOf = (id: number): Summary | null => byKey.get(`g${id}`)?.summary ?? null;
  const valuesOf = (id: number): Value[] => (id === 0 ? cfg.picks.map((p) => cfg.base[p.key] as Value) : byKey.get(`g${id}`)?.values ?? []);
  const paramText = (id: number) => cfg.picks.map((p, i) => ({ k: axes[i]?.label ?? p.key, v: id === 0 && cfg.base[p.key] === undefined ? 'as in the legs' : valueText(axes[i], valuesOf(id)[i]) }));
  const nameOf = (id: number) => (id === 0 ? 'Your settings' : `#${id}`);
  const K = cfg.topK, objLabel = (OBJECTIVES.find(([k]) => k === cfg.objective)?.[1] ?? String(res.objective_label)).toLowerCase();
  const finalist = (id: number) => (res.finalists as any[]).find((f) => f.idx === id);
  const why: Record<Answer, string> = {
    leader: `No configuration had the minimum ${res.min_trades.train} traded days in the training window${cfg.objective === 'cagr' ? ', or the window is shorter than the year CAGR needs' : ''}.`,
    best_oos: `None of the top ${K} by training had the minimum ${res.min_trades.validation} traded days in the validation window.`,
    robust: `No finalist met the in-sample minimum of ${res.min_trades.in_sample} traded days, so none could be scored.`,
  };
  const ANSWERS: { a: Answer; tag: string; how: string }[] = [
    { a: 'leader', tag: 'Not evidence', how: `First on the training window by ${objLabel}. It was chosen on the sessions it is judged on, so expect it to do worse on sessions it has not seen.` },
    { a: 'best_oos', tag: 'Checked on validation', how: `Best on the validation window among the top ${K} by training. Validation helped choose it; the held-out test did not.` },
    { a: 'robust', tag: 'Held up best', how: `Highest robustness score among the top ${K} by in-sample score: walk-forward, thirds, volatility regimes, validation, neighbouring settings and doubled slippage.` },
  ];

  async function draw(ids: number[]) {
    setShown(ids);
    for (const id of ids) {
      if (curves.get(id)?.status === 'done') continue;
      setCurves((m) => new Map(m).set(id, { status: 'loading' }));
      try {
        const days = await opt.curve(cfg, id);
        let c = 0;
        const pts = days.map((d) => { c += d.traded ? d.net : 0; return { d: d.date, v: Math.round(c * 100) / 100 }; });
        setCurves((m) => new Map(m).set(id, { status: 'done', pts }));
      } catch (e) { setCurves((m) => new Map(m).set(id, { status: 'error', msg: (e as Error).message })); }
    }
  }
  const bands: Band[] = plan ? [
    { from: plan.split.train[0], to: plan.split.train[1], label: 'Training', tone: 'a' },
    { from: plan.split.validation[0], to: plan.split.validation[1], label: 'Validation', tone: 'b' },
    { from: plan.split.test[0], to: plan.split.test[1], label: 'Held-out test', tone: 'c' },
  ] : [];

  const download = () => {
    const url = URL.createObjectURL(new Blob([csvOf(study, sortRows(table.rows, 'rank', 'is'))], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `straddloop-study-${cfg.slug}-${study.id}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const toggleCmp = (id: number) => setCmp((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? c : [...c, id]));
  const wf = res.walk_forward, pbo = res.pbo;
  const H = ({ k, children, r = true }: { k: SortKey; children: React.ReactNode; r?: boolean }) => (
    <th className={r ? 'r' : ''} aria-sort={sort.k === k ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="opt-sort" onClick={() => setSort((s) => ({ k, asc: s.k === k ? !s.asc : false }))}>{children}{sort.k === k ? (sort.asc ? ' ↑' : ' ↓') : ''}</button>
    </th>
  );
  const ready = shown.filter((id) => curves.get(id)?.status === 'done').slice(0, 4);
  const pending = shown.filter((id) => curves.get(id)?.status === 'loading').length;
  const failed = shown.map((id) => curves.get(id)).find((c) => c?.status === 'error') as { msg: string } | undefined;

  return (
    <div className="opt-res">
      <section className="blk" aria-labelledby="opt-ans-h">
        <div className="blk-h"><h2 id="opt-ans-h">Three answers, not one</h2><span className="sec-note">{cfg.name} · {cfg.data.label} · {cfg.data.sessions} sessions</span></div>
        <p className="chart-cap">None of these is a proven best strategy. Each is the configuration that did best on these sessions, by one rule, with these charges and fills. The held-out test is shown for these three only: it is the one stretch of history that chose nothing.</p>
        <div className="opt-answers">
          {ANSWERS.map(({ a, tag, how }) => {
            const id: number | null = res[a];
            const sm = id == null ? null : summaryOf(id);
            const f = id == null ? null : finalist(id);
            const same = id == null ? [] : ANSWERS.filter((x) => x.a !== a && res[x.a] === id && ANSWERS.findIndex((y) => y.a === x.a) < ANSWERS.findIndex((y) => y.a === a)).map((x) => ANSWER_LABEL[x.a]);
            return (
              <article key={a} className="opt-card" data-a={a} aria-labelledby={`opt-${a}-h`}>
                <div className="opt-card-h"><span className="lbl" id={`opt-${a}-h`}>{ANSWER_LABEL[a]}</span><span className="opt-tag" data-a={a}>{tag}</span></div>
                <p className="m-s">{how}</p>
                {id == null || !sm ? <p className="sec-note">{why[a]}</p> : (
                  <>
                    <h3 className="opt-card-t">{nameOf(id)}{same.length ? <span className="m-s"> · same as the {same.join(' and ').toLowerCase()}</span> : null}</h3>
                    <dl className="opt-params">{paramText(id).map((x) => <Fragment key={x.k}><dt>{x.k}</dt><dd>{x.v}</dd></Fragment>)}</dl>
                    <div className="opt-wins-wrap"><table className="tbl opt-wins">
                      <thead><tr><th /><th className="r">Training</th><th className="r">Validation</th><th className="r" data-test="">Held-out</th></tr></thead>
                      <tbody>
                        {([['Net', (w: Summary) => <Money v={w.net} />], ['Sharpe', (w: Summary) => nm(w.sharpe)], ['Traded', (w: Summary) => `${w.traded}/${w.sessions}`], ['Max DD', (w: Summary) => <Money v={w.max_dd} />]] as const).map(([l, g]) => (
                          <tr key={l}><td>{l}</td><td className="r">{g(sm.train)}</td><td className="r">{g(sm.validation)}</td><td className="r" data-test="">{g(sm.test)}</td></tr>
                        ))}
                      </tbody>
                    </table></div>
                    {a === 'robust' && f && (
                      <div className="opt-comp">
                        <div className="opt-score"><span className="lbl">Robustness</span><b className="num">{nm(f.robust.score)}</b><span className="m-s">mean of {f.robust.measured} checks, each 0 to 1</span></div>
                        <ul>{COMPONENT.map(([k, l]) => <li key={k}><span>{l}{k === 'neighbours' && f.neighbours.planned ? ` (${f.neighbours.positive} of ${f.neighbours.measured})` : ''}</span><b className="num">{share(f.robust.components[k])}</b></li>)}</ul>
                        {f.stress_net != null && <p className="m-s">In-sample net at doubled slippage: {money(f.stress_net)} (as run: {money(sm.is.net)}).</p>}
                      </div>
                    )}
                    <p className="m-s">Whole period, held-out test included: net {money(sm.full.net)} on {sm.full.traded} traded days. A backtest of this configuration on the same data gives this figure.</p>
                    <div className="run-actions">
                      <button type="button" className="qbtn" onClick={() => onLoad(cfg, id, false)}>Load into the Lab</button>
                      <button type="button" className="qbtn" onClick={() => onLoad(cfg, id, true)}>Run a backtest</button>
                      <button type="button" className="qbtn" aria-pressed={shown.length === 1 && shown[0] === id} onClick={() => draw([id])}>Curve</button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {shown.length > 0 && (
        <section className="blk" aria-labelledby="opt-curve-h">
          <div className="blk-h"><h2 id="opt-curve-h">Cumulative net, {shown.map(nameOf).join(', ')}</h2><button type="button" className="qbtn" onClick={() => setShown([])}>Close</button></div>
          <p className="chart-cap">Re-run on the study’s sessions. The shading marks the windows: training and validation chose; the held-out test did not.</p>
          {pending > 0 && <p className="sec-note" aria-live="polite">Running {pending} configuration{pending === 1 ? '' : 's'} on the study’s data…</p>}
          {failed && <p className="sec-err">{failed.msg}</p>}
          {ready.length > 0 && (
            <LinePlot points={(curves.get(ready[0]) as { pts: { d: string; v: number }[] }).pts} firstLabel={ready.length > 1 ? nameOf(ready[0]) : undefined}
              extra={ready.slice(1).map((id) => ({ points: (curves.get(id) as { pts: { d: string; v: number }[] }).pts, label: nameOf(id) }))}
              area={ready.length > 1 ? 'none' : 'signed'} bands={bands} fmt={(v) => inr(v, { sign: true })} label={`Cumulative net P&L of ${ready.map(nameOf).join(', ')}, with the training, validation and held-out test windows shaded.`} />
          )}
        </section>
      )}

      <section className="blk" aria-labelledby="opt-chk-h">
        <div className="blk-h"><h2 id="opt-chk-h">How much to trust the choice</h2></div>
        <div className="figs">
          <div className="m"><span className="lbl">Walk-forward</span>
            {wf.status !== 'not_run' ? <><span className={`m-v ${tone(wf.oos.net)}`}>{money(wf.oos.net)}</span><span className="m-s">re-chosen in each fold, scored on the next unseen block; {wf.oos.positive_folds} of {wf.oos.folds} folds made money{wf.wfe != null ? ` · efficiency ${nm(wf.wfe)}` : ''} · {wf.distinct_choices} different choice{wf.distinct_choices === 1 ? '' : 's'}</span></>
              : <><span className="m-v na">—</span><span className="m-s">{wf.reason}</span></>}</div>
          <div className="m"><span className="lbl">Overfitting (PBO)</span>
            {pbo.status === 'ok' ? <><span className="m-v">{pc(pbo.pbo * 100, 0)}</span><span className="m-s">of {pbo.combinations} in/out splits of the in-sample blocks, the in-sample best fell below the median out of sample. 50% or more: choosing this way did no better than chance.</span></>
              : <><span className="m-v na">—</span><span className="m-s">{pbo.reason}</span></>}</div>
          <div className="m"><span className="lbl">Deflated Sharpe, leader</span>
            {res.dsr.leader ? <><span className="m-v">{pc(res.dsr.leader.dsr * 100, 0)}</span><span className="m-s">chance its in-sample Sharpe beats the best of {n0(res.dsr.leader.trials)} tries of pure luck</span></> : <><span className="m-v na">—</span><span className="m-s">not enough traded days</span></>}</div>
          <div className="m"><span className="lbl">Training vs validation</span>
            {res.rank_corr_train_val != null ? <><span className="m-v">{nm(res.rank_corr_train_val)}</span><span className="m-s">rank correlation of the scores. Near 0: a good training rank says little about validation.</span></> : <><span className="m-v na">—</span><span className="m-s">fewer than 3 configurations scored on both</span></>}</div>
          <div className="m"><span className="lbl">Measured</span><span className="m-v">{n0(table.rows.length)}</span>
            <span className="m-s">{res.method === 'grid' ? 'the whole grid' : `a random sample of ${n0(res.space_size)}`} + your settings; {n0(table.extra)} robustness runs{table.failed ? `; ${table.failed} failed` : ''}{study.ms ? `; ${Math.round(study.ms / 1000)} s` : ''}</span></div>
        </div>
        {table.refused.length > 0 && <details className="opt-det"><summary>{n0(table.refused.reduce((s, r) => s + r.n, 0))} configurations refused before running</summary><ul className="opt-refused">{table.refused.map((r) => <li key={r.reason}><b className="num">{n0(r.n)}</b> {r.reason}</li>)}</ul></details>}
        {wf.folds?.length > 0 && (
          <details className="opt-det">
            <summary>Walk-forward folds ({wf.mode})</summary>
            <div className="tscroll"><table className="tbl">
              <thead><tr><th>Fold</th><th>Trained on</th><th>Tested on</th><th>Chosen</th><th className="r">Net, training</th><th className="r">Net, test block</th></tr></thead>
              <tbody>{wf.folds.map((f: any, k: number) => (
                <tr key={k}><td>{k + 1}</td><td>sessions {f.train[0] + 1}–{f.train[1]}</td><td>sessions {f.test[0] + 1}–{f.test[1]}</td>
                  <td>{f.chosen == null ? f.reason : nameOf(f.chosen)}</td><td className="r">{f.is ? <Money v={f.is.net} /> : '—'}</td><td className="r">{f.oos ? <Money v={f.oos.net} /> : '—'}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
        )}
        <p className="chart-cap">{res.selection_rule} Minimum traded days: {res.min_trades.train} in training, {res.min_trades.validation} in validation, {res.min_trades.in_sample} in-sample.{plan?.dates?.train?.[0] ? ` Training ${shortDate(plan.dates.train[0])} – ${shortDate(plan.dates.train[1])}, validation ${shortDate(plan.dates.validation[0])} – ${shortDate(plan.dates.validation[1])}, held-out test ${shortDate(plan.dates.test[0])} – ${shortDate(plan.dates.test[1])}.` : ''}</p>
      </section>

      {cmp.length > 0 && (
        <section className="blk" aria-labelledby="opt-cmp-h">
          <div className="blk-h"><h2 id="opt-cmp-h">Compare {cmp.length} of 4</h2>
            <div className="run-actions"><button type="button" className="qbtn" disabled={cmp.length < 2} onClick={() => draw(cmp)}>Draw their curves</button><button type="button" className="qbtn" onClick={() => setCmp([])}>Clear</button></div></div>
          <div className="tscroll"><table className="tbl opt-cmp">
            <thead><tr><th>Setting</th>{cmp.map((id) => <th key={id} className="r">{nameOf(id)}</th>)}</tr></thead>
            <tbody>
              {cfg.picks.map((p, i) => <tr key={p.key}><td>{axes[i]?.label ?? p.key}</td>{cmp.map((id) => <td key={id} className="r">{paramText(id)[i].v}</td>)}</tr>)}
              {(['train', 'validation'] as const).flatMap((w) => ([['Net', (s: Summary) => money(s.net)], ['Sharpe', (s: Summary) => nm(s.sharpe)], ['Traded days', (s: Summary) => String(s.traded)], ['Max drawdown', (s: Summary) => money(s.max_dd)], ['Profit factor', (s: Summary) => nm(s.pf)]] as const).map(([l, g], j) => (
                <tr key={`${w}${l}`} data-first={j === 0 || undefined}><td>{w === 'train' ? 'Training' : 'Validation'} · {l}</td>{cmp.map((id) => <td key={id} className="r">{g(summaryOf(id)![w])}</td>)}</tr>
              )))}
            </tbody>
          </table></div>
        </section>
      )}

      <section className="blk" aria-labelledby="opt-tbl-h">
        <div className="blk-h"><h2 id="opt-tbl-h">Every configuration</h2><button type="button" className="qbtn" onClick={download}>Export CSV</button></div>
        <div className="opt-tools">
          <div className="seg2" role="radiogroup" aria-label="Figures from">
            {(['is', 'train', 'validation'] as WindowKey[]).map((w) => <label key={w}><input type="radio" name="opt-win" checked={win === w} onChange={() => setWin(w)} /><span>{w === 'is' ? 'In-sample' : WINDOW_LABEL[w]}</span></label>)}
          </div>
          <label className="opt-inl">At least <input className="in opt-in" inputMode="numeric" value={filter.minTraded || ''} placeholder="0" onChange={(ev) => setFilter((f) => ({ ...f, minTraded: Math.max(0, Math.round(Number(ev.target.value) || 0)) }))} aria-label="Minimum traded days" /> traded days</label>
          <label className="opt-inl"><input type="checkbox" checked={filter.positiveValidation} onChange={(ev) => setFilter((f) => ({ ...f, positiveValidation: ev.target.checked }))} />Made money in validation</label>
          <label className="opt-inl"><input type="checkbox" checked={filter.answersOnly} onChange={(ev) => setFilter((f) => ({ ...f, answersOnly: ev.target.checked }))} />Answers and finalists only</label>
          <span className="sec-note">{n0(rows.length)} of {n0(table.rows.length)} · tick up to 4 to compare</span>
        </div>
        <p className="chart-cap">Figures from the {WINDOW_LABEL[win].toLowerCase()} window. The held-out test is not in this table or the CSV, so nothing can be sorted or filtered on it. Rank is by training {objLabel}, the order the study chose from; “traded” counts days with a trade.</p>
        <div className="tscroll">
          <table className="tbl opt-tbl">
            <thead><tr>
              <th className="x" aria-label="Compare" /><H k="rank" r={false}>Rank</H>
              {cfg.picks.map((p, i) => <H key={p.key} k={`p${i}`} r={false}><span title={axes[i]?.label}>{axes[i]?.short ?? axes[i]?.label ?? p.key}</span></H>)}
              <H k="net">Net</H><H k="ret_pct">Return</H><H k="win_rate">Win</H><H k="traded">Traded</H><H k="avg">Avg / traded day</H><H k="max_dd">Max DD</H><H k="pf">PF</H><H k="sharpe">Sharpe</H><H k="calmar">Net ÷ DD</H><H k="streak_win">Win run</H><H k="streak_loss">Loss run</H><H k="robust">Robust</H>
            </tr></thead>
            <tbody>
              {rows.slice(0, limit).map((r: Row) => {
                const s = r.w[win], isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className="click" aria-expanded={isOpen} data-answer={r.answers.length ? '' : undefined} onClick={() => setOpen(isOpen ? null : r.id)}>
                      <td className="x" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={cmp.includes(r.id)} disabled={!cmp.includes(r.id) && cmp.length >= 4} onChange={() => toggleCmp(r.id)} aria-label={`Compare ${nameOf(r.id)}`} /></td>
                      <td>{r.rank ?? '—'}{r.id === 0 ? ' · yours' : ''}{r.answers.map((a) => <span key={a} className="opt-tag" data-a={a} title={ANSWER_LABEL[a]}>{a === 'leader' ? 'IS' : a === 'best_oos' ? 'OOS' : 'R'}</span>)}</td>
                      {cfg.picks.map((p, i) => <td key={p.key}>{paramText(r.id)[i].v}</td>)}
                      <td className="r"><Money v={s.net} /></td><td className="r">{pc(s.ret_pct, 2)}</td><td className="r">{pc(s.win_rate, 0)}</td><td className="r">{s.traded}/{s.sessions}</td>
                      <td className="r"><Money v={avgOf(s)} /></td><td className="r"><Money v={s.max_dd} /></td><td className="r">{nm(s.pf)}</td><td className="r">{nm(s.sharpe)}</td><td className="r">{nm(s.calmar)}</td>
                      <td className="r">{s.streak_win}</td><td className="r">{s.streak_loss}</td><td className="r">{r.robust == null ? '' : nm(r.robust)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="opt-sub"><td colSpan={cfg.picks.length + 14}>
                        <div className="opt-subin">
                          <span>{nameOf(r.id)} · training <Money v={r.w.train.net} /> ({r.w.train.traded} traded) → validation <Money v={r.w.validation.net} /> ({r.w.validation.traded} traded)</span>
                          <div className="run-actions">
                            <button type="button" className="qbtn" onClick={() => onLoad(cfg, r.id, false)}>Load into the Lab</button>
                            <button type="button" className="qbtn" onClick={() => onLoad(cfg, r.id, true)}>Run a backtest</button>
                            <button type="button" className="qbtn" onClick={() => draw([r.id])}>Curve</button>
                          </div>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > limit && <div className="run-actions"><button type="button" className="qbtn" onClick={() => setLimit((l) => l + 100)}>Show {Math.min(100, rows.length - limit)} more</button><span className="sec-note">{n0(limit)} of {n0(rows.length)} shown</span></div>}
      </section>
    </div>
  );
}
