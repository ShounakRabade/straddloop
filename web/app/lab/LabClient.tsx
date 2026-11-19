'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, SyntheticNote, hard } from '@/components/ui';
import { ParamFields } from '@/components/ParamFields';
import { Curve, Exits, Kpis, verdict } from '@/components/ResultView';
import { ReplayPanel } from '@/components/Replay';
import { ReportPanel } from '@/components/Report';
import { ResearchPanel } from '@/components/research/ResearchPanel';
import { ENGINE_ONLY_KEYS, PARAM_SPACE, choiceLabel } from '@/lib/researchSpace';
import { checkRange } from '@/lib/range';
import { STRATEGIES, SYNTHETIC_KEYS, bySlug, describeParams } from '@/lib/strategies';
import { useLab, type DayRef } from '@/lib/useLab';
import { saveRun } from '@/lib/store';
import { availability, download, readLocal, statuses, type Availability, type ExpiryFlag } from '@/lib/marketData';
import { summarizeRange, type StatusRow } from '@/lib/rangeStates';
import { inr, shortDate } from '@/lib/format';
import type { Params, StrategySlug } from '@/lib/types';

const OPEN_KEY = 'straddloop.open';
const SOURCE_KEY = 'straddloop.source';
type Source = 'synthetic' | 'real';
type LocalDay = { path: string; date: string; buf?: ArrayBuffer };

function RealNote({ r, slip }: { r: { from: string; to: string; days: number; lot_sizes: number[]; lot_source: string; flags: string[] } | undefined; slip: number }) {
  return (
    <div className="callout callout--real" role="note">
      <span className="tag">Real data</span>
      <p>
        {r ? <>NIFTY 1-minute option candles from Dhan, {shortDate(r.from)} to {shortDate(r.to)} ({r.days} days). </> : <>NIFTY 1-minute option candles from Dhan. </>}
        <strong>Fills are taken from candle prices plus {slip}% slippage, so they are optimistic:</strong> there is no bid/ask history, and a real order could fill worse, especially on stops.
        {' '}Expiry dates are assumed (nearest weekly or monthly expiry weekday) and lot size {r ? r.lot_sizes.join('/') : ''} is {r && r.lot_source.startsWith('set') ? 'set by you' : 'assumed'} until checked against NSE bhavcopy.
        {r && r.flags.includes('index_from_spot') ? ' Some days have no index candles, so the opening range uses Dhan’s spot (close only).' : ''}
        {' '}Not investment advice.
      </p>
    </div>
  );
}

export function LabClient() {
  const [slug, setSlug] = useState<StrategySlug>('straddle');
  const [params, setParams] = useState<Params>(STRATEGIES[0].defaults);
  const [booted, setBooted] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<{ state: 'idle' | 'saving' | 'done' | 'error'; msg?: string }>({ state: 'idle' });
  const [source, setSource] = useState<Source>('synthetic');
  const [flag, setFlag] = useState<ExpiryFlag>('WEEK');
  const [avail, setAvail] = useState<Availability | null>(null);
  const [dayStatus, setDayStatus] = useState<StatusRow[]>([]);
  const [local, setLocal] = useState<LocalDay[] | null>(null);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [beforeLoad, setBeforeLoad] = useState<Params | null>(null);  // the person's settings before they loaded a study's selection
  const lab = useLab();
  const strategy = bySlug(slug)!;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(new Set<string>());  // day files already handed to the worker
  const realOk = slug !== 'fourleg';
  const real = source === 'real' && realOk;

  // Start from a notebook run, a ?s= link, or the default.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(OPEN_KEY);
      if (raw) {
        sessionStorage.removeItem(OPEN_KEY);
        const p = JSON.parse(raw) as Params, s = bySlug(String(p.strategy));
        if (s) {
          setSlug(s.slug); setParams({ ...s.defaults, ...p });
          if (p.data_from) { setSource('real'); setRange({ from: String(p.data_from), to: String(p.data_to ?? '') }); if (p.data_flag === 'MONTH') setFlag('MONTH'); }
          setBooted(true); return;
        }
      }
    } catch { /* fall through to the default */ }
    const q = new URLSearchParams(window.location.search);
    const s = bySlug(q.get('s') ?? '');
    if (s) { setSlug(s.slug); setParams(s.defaults); }
    try { if (q.get('data') === 'real' || localStorage.getItem(SOURCE_KEY) === 'real') setSource('real'); } catch { /* storage blocked */ }
    setBooted(true);
  }, []);

  // What real data exists for the chosen series.
  useEffect(() => {
    if (!real || local) return;
    let live = true;
    setAvail(null); setDataErr(null); setDayStatus([]);
    statuses('NIFTY', flag).then((r) => live && setDayStatus(r)).catch(() => undefined);
    availability('NIFTY', flag).then((a) => {
      if (!live) return;
      setAvail(a);
      if (a.state === 'ready') {
        const last = a.days[a.days.length - 1].trade_date, first = a.days[0].trade_date;
        setRange((r) => (r.from && r.to ? r : { from: a.days[Math.max(0, a.days.length - 60)].trade_date || first, to: last }));
      }
    }).catch((e) => live && setAvail({ state: 'off', why: `Supabase: ${(e as Error).message}` }));
    return () => { live = false; };
  }, [real, flag, local]);

  // Which stored days exist for the chosen dates, and whether the dates themselves make sense.
  const check = useMemo(() => {
    if (!real) return null;
    const stored = local ? local.map((d) => ({ trade_date: d.date, quality: 'complete' }))
      : avail?.state === 'ready' ? avail.days.map((d) => ({ trade_date: d.trade_date, quality: d.quality })) : null;
    if (!stored && !(range.from && range.to)) return null;
    return checkRange(range.from, range.to, stored ?? []);
  }, [real, local, avail, range]);

  const chosen = useMemo((): { path: string; date: string }[] => {
    if (!real || !check || check.errors.length) return [];
    const inSet = new Set(check.stored);
    if (local) return local.filter((d) => inSet.has(d.date));
    if (avail?.state === 'ready') return avail.days.filter((d) => inSet.has(d.trade_date) && d.quality !== 'empty').map((d) => ({ path: d.path, date: d.trade_date }));
    return [];
  }, [real, local, avail, check]);

  const runReal = useCallback(async (p: Params) => {
    if (!chosen.length) return;
    setDataErr(null);
    const missing = chosen.filter((d) => !sent.current.has(d.path));
    let fresh: { path: string; buf: ArrayBuffer }[] = [];
    try {
      if (local) fresh = missing.map((d) => ({ path: d.path, buf: (local.find((x) => x.path === d.path)!.buf as ArrayBuffer).slice(0) }));
      else if (missing.length) {
        setLoading({ done: 0, total: missing.length });
        fresh = await download(missing.map((d) => d.path), (done) => setLoading({ done, total: missing.length }));
      }
    } catch (e) {
      setLoading(null);
      setDataErr((e as Error).message);
      return;
    }
    setLoading(null);
    fresh.forEach((f) => sent.current.add(f.path));
    const bufs = new Map(fresh.map((f) => [f.path, f.buf]));
    const days: DayRef[] = chosen.map((d) => ({ path: d.path, buf: bufs.get(d.path) }));
    lab.run({ ...p, data_from: chosen[0].date, data_to: chosen[chosen.length - 1].date, data_flag: flag }, days);
  }, [chosen, local, lab, flag]);

  useEffect(() => {
    if (!booted) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (real) runReal(params); else lab.run(params); }, real ? 300 : 220);
    setSaved({ state: 'idle' });
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, booted, real, chosen]);

  const pick = (next: StrategySlug) => { setSlug(next); setParams(bySlug(next)!.defaults); setNote(''); setBeforeLoad(null); };
  /** Only ever called by the person pressing "Load" in the optimisation lab. */
  const loadFromStudy = (changes: Record<string, unknown>) => { setBeforeLoad(params); setParams((p) => ({ ...p, ...(changes as Params) })); };
  const engineSet = ENGINE_ONLY_KEYS.filter((k) => params[k] !== undefined);
  const spaceLabel = (k: string) => [...PARAM_SPACE.straddle, ...PARAM_SPACE.orb].find((x) => x.key === k)?.label ?? k;
  const pickSource = (s: Source) => { setSource(s); try { localStorage.setItem(SOURCE_KEY, s); } catch { /* ignore */ } };
  const fields = useMemo(() => (real ? strategy.fields.filter((f) => !SYNTHETIC_KEYS.includes(f.key)) : strategy.fields), [real, strategy]);
  const changed = useMemo(() => describeParams({ ...strategy, fields }, params), [strategy, fields, params]);
  const r0 = lab.result && lab.result.strategy === slug ? lab.result : null;
  const r = r0 && (real ? !!r0.data && chosen.length > 0 : !r0.data) ? r0 : null;  // never show an old result under a range that cannot run
  const busy = lab.status === 'running' || !booted || !!loading;
  const v = r ? verdict(r) : null;
  const sampleText = real ? (r?.data ? `${r.data.days} real days` : 'real days')
    : slug === 'fourleg' ? `${params.months} months, four stocks` : `${params.days} sessions, seed ${params.seed}`;
  const span = avail?.state === 'ready' ? { min: avail.days[0].trade_date, max: avail.days[avail.days.length - 1].trade_date }
    : local?.length ? { min: local[0].date, max: local[local.length - 1].date } : null;
  const summary = useMemo(
    () => summarizeRange(range.from, range.to, avail?.state === 'ready' ? avail.days : [], dayStatus),
    [range, avail, dayStatus]);
  const fileLot = avail?.state === 'ready' ? avail.days.find((d) => d.trade_date >= range.from)?.lot_size ?? null : null;

  async function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    const got = await readLocal(files);
    if (!got.length) { setDataErr('None of those files look like day files (NIFTY/WEEK/2025-10-06.json.gz). Make them with: straddloop export-days'); return; }
    setLocal(got);
    setRange({ from: got[0].date, to: got[got.length - 1].date });
  }

  async function keep() {
    if (!r) return;
    setSaved({ state: 'saving' });
    try {
      const p = real ? { ...params, data_from: r.data!.from, data_to: r.data!.to, data_flag: flag } : params;
      const { where } = await saveRun(slug, p, r, note.trim());
      setSaved({ state: 'done', msg: where === 'cloud' ? 'Saved to your account.' : 'Saved in this browser.' });
    } catch (e) {
      setSaved({ state: 'error', msg: `Could not save: ${(e as Error).message}. Your settings are still here, so you can try again.` });
    }
  }

  const offMessage = (why: string) => {
    if (why === 'cloud') return <>Supabase is not set up on this site, so real data cannot be fetched.</>;
    if (why === 'signin') return <><Link className="link" href="/login">Sign in</Link> to use the real data. It is private to your account.</>;
    if (why === 'reader') return <>This account is not on the data readers list. Add it in Supabase (table <code>data_readers</code>).</>;
    return <>{why}</>;
  };

  return (
    <div className="wrap">
      <div className="lab-head">
        <p className="label">Lab</p>
        <h1>Change one rule. Read what moves.</h1>
        <div className="tabs" role="tablist" aria-label="Strategy">
          {STRATEGIES.map((s) => (
            <button key={s.slug} role="tab" aria-selected={s.slug === slug} className="tab" onClick={() => pick(s.slug)} {...(s.slug === slug ? hard : {})}>
              <span className="num">{s.number}</span>{s.short}
            </button>
          ))}
        </div>
      </div>

      <div className="lab">
        <form className="lab-controls sheet" {...hard} onSubmit={(e) => e.preventDefault()} aria-label={`${strategy.short} settings`}>
          <div className="ctl-head">
            <span className="label">Settings</span>
            <button type="button" className="link small" onClick={() => { setParams(strategy.defaults); setBeforeLoad(null); }} disabled={!changed.length && !engineSet.length} style={{ opacity: changed.length || engineSet.length ? 1 : 0.4 }}>Reset to defaults</button>
          </div>
          <div className="ctl-body">
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend className="flabel" style={{ padding: 0, fontWeight: 650, fontSize: '0.9375rem', marginBottom: 6 }}>Data</legend>
              <div className="seg">
                <label><input type="radio" name="source" checked={!real} onChange={() => pickSource('synthetic')} /><span>Synthetic model</span></label>
                <label><input type="radio" name="source" checked={real} disabled={!realOk} onChange={() => pickSource('real')} /><span>Real NIFTY (Dhan)</span></label>
              </div>
              <p className="help">{realOk ? 'Real data runs the same engine on stored 1-minute NIFTY option candles.' : 'Real data covers NIFTY index options only, so the four-leg stock strategy stays synthetic.'}</p>
            </fieldset>

            {real && (
              <div className="data-box stack" style={{ ['--gap' as string]: '12px' }}>
                {!local && (
                  <div className="seg" role="radiogroup" aria-label="Expiry series">
                    <label><input type="radio" name="flag" checked={flag === 'WEEK'} onChange={() => setFlag('WEEK')} /><span>Weekly expiry</span></label>
                    <label><input type="radio" name="flag" checked={flag === 'MONTH'} onChange={() => setFlag('MONTH')} /><span>Monthly</span></label>
                  </div>
                )}
                {!local && !avail && <p className="small muted">Checking which days are stored.</p>}
                {!local && avail?.state === 'off' && <p className="small">{offMessage(avail.why)}</p>}
                {!local && avail?.state === 'empty' && <p className="small">No {flag === 'WEEK' ? 'weekly' : 'monthly'} days uploaded yet. Run <code>straddloop supabase-upload</code> on your computer.</p>}
                {span && (
                  <>
                    <div className="dates">
                      <label className="field"><span className="flabel small">From</span>
                        <input className="input input--sm" type="date" value={range.from} onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))} /></label>
                      <label className="field"><span className="flabel small">To</span>
                        <input className="input input--sm" type="date" value={range.to} onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))} /></label>
                    </div>
                    {check && check.errors.map((e) => <p key={e} className="error small" role="alert">{e}</p>)}
                    <p className="help">{chosen.length} trading day{chosen.length === 1 ? '' : 's'} will run · stored {shortDate(span.min)} to {shortDate(span.max)}{local ? ' · from files on this computer' : ''}</p>
                    {loading && <p className="small"><span className="status" data-state="running"><i />Downloading {loading.done} of {loading.total}</span></p>}
                    {local && check && !check.errors.length && (
                      <div className="range-status" aria-live="polite">
                        <div><b>{check.counts.stored}</b> stored locally · <b>{check.counts.validated}</b> validated · <b>{check.counts.notStored}</b> not stored</div>
                        {check.notes.map((m) => <div key={m} className="muted">{m}</div>)}
                      </div>
                    )}
                    {!local && range.from && range.to && (
                      <div className="small stack" style={{ ['--gap' as string]: '4px' }} aria-label="Data availability for this range">
                        <p>
                          <strong>{summary.counts.validated}</strong> validated
                          {summary.counts.partial > 0 && <> · <strong>{summary.counts.partial}</strong> partial</>}
                          {summary.counts.failed > 0 && <> · <strong>{summary.counts.failed}</strong> failed</>}
                          {summary.counts.downloading > 0 && <> · <strong>{summary.counts.downloading}</strong> downloading</>}
                          {' '}· <strong>{summary.counts.missing}</strong> not stored · {summary.counts.holiday} holiday{summary.counts.holiday === 1 ? '' : 's'}
                        </p>
                        {summary.problems.slice(0, 5).map((p) => (
                          <p key={p.date} className="muted">{shortDate(p.date)}: {p.state}{p.reason ? `, ${p.reason}` : ''}</p>
                        ))}
                        {summary.problems.length > 5 && <p className="muted">and {summary.problems.length - 5} more</p>}
                        {summary.counts.partial > 0 && <p className="muted">Partial days are included in the run; their gaps stay gaps, nothing is filled in.</p>}
                      </div>
                    )}
                    {!local && range.from && range.to && (summary.counts.missing > 0 || summary.counts.failed > 0 || range.from < span.min || range.to > span.max) && (
                      <div className="small stack" style={{ ['--gap' as string]: '6px' }}>
                        <p>Some of these dates are not stored yet. Run this on your computer, then come back and rerun:</p>
                        <code className="cmd">{`straddloop load --expiry ${flag} --start ${range.from} --end ${range.to}`}</code>
                        <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(`straddloop load --expiry ${flag} --start ${range.from} --end ${range.to}`).catch(() => undefined)}>Copy the command</button>
                      </div>
                    )}
                    <label className="field">
                      <span className="flabel small" style={{ display: 'flex', justifyContent: 'space-between' }}><span>Lot size</span><span className="muted">{Number(params.lot_size) > 0 ? 'set by you' : `assumed ${fileLot ?? ''}`}</span></span>
                      <input className="input input--sm" type="number" min={0} step={1} placeholder={`Use the stored size${fileLot ? ` (${fileLot})` : ''}`}
                        value={Number(params.lot_size) > 0 ? Number(params.lot_size) : ''} onChange={(e) => setParams((p) => ({ ...p, lot_size: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                    </label>
                  </>
                )}
                {loading && !check && <p className="small"><span className="status" data-state="running"><i />Downloading {loading.done} of {loading.total} days</span></p>}
                {dataErr && <p className="error small" role="alert">{dataErr}</p>}
                <div className="small">
                  {local
                    ? <button type="button" className="link" onClick={() => { setLocal(null); sent.current.clear(); setRange({ from: '', to: '' }); }}>Use Supabase data instead</button>
                    : <label className="link" style={{ cursor: 'pointer' }}>Load day files from this computer<input type="file" accept=".gz" multiple className="sr" onChange={(e) => pickFiles(e.target.files)} /></label>}
                </div>
              </div>
            )}
            <hr />
            <ParamFields idPrefix={slug} fields={fields} params={params} onChange={(k, val) => setParams((p) => ({ ...p, [k]: val }))} />
            {(engineSet.length > 0 || beforeLoad) && (
              <div className="rs-note small stack" style={{ ['--gap' as string]: '6px' }} role="status">
                {engineSet.length > 0 && <p>Also set, with no field above: {engineSet.map((k) => `${spaceLabel(k)} ${choiceLabel(params[k])}`).join(' · ')}.{' '}
                  <button type="button" className="link" onClick={() => setParams((p) => { const q = { ...p }; engineSet.forEach((k) => delete q[k]); return q; })}>Clear these</button></p>}
                {beforeLoad && <p>Loaded from the optimisation lab.{' '}<button type="button" className="link" onClick={() => { setParams(beforeLoad); setBeforeLoad(null); }}>Put my settings back</button></p>}
              </div>
            )}
            <hr />
            <p className="small muted">Full rule text: <Link className="link" href={`/strategies/${slug}`}>{strategy.short} rules</Link></p>
          </div>
        </form>

        <div className="lab-out" data-busy={busy} aria-live="polite">
          {real ? <RealNote r={r?.data} slip={Number(params.slip_pct ?? 0.5)} />
            : <SyntheticNote>Synthetic model, dates in 2099. This shows how the rule reacts to a setting. It is not evidence about NIFTY or any stock, and not investment advice.</SyntheticNote>}

          {lab.status === 'error' && (
            <div className="sheet sheet-pad stack" {...hard}>
              <h2 className="h3">The simulation stopped</h2>
              <p className="error">{lab.error}</p>
              <p className="muted">{/cost schedule/i.test(lab.error ?? '') ? 'Costs are charged at the rates in force on each trade date, and the table starts on 1 Jul 2020. Choose a later start date.' : 'Reset the settings and it will run again.'}</p>
              <div><Button onClick={() => setParams(strategy.defaults)}>Reset to defaults</Button></div>
            </div>
          )}

          {real && !chosen.length && lab.status !== 'error' && (
            <div className="sheet sheet-pad stack" {...hard}>
              <h2 className="h3">No real days to run yet</h2>
              <p className="muted">{avail?.state === 'off' ? offMessage(avail.why) : 'Pick a date range with stored days, or load day files from this computer.'}</p>
              <div><Button onClick={() => pickSource('synthetic')}>Use the synthetic model instead</Button></div>
            </div>
          )}

          {!r && lab.status !== 'error' && (!real || chosen.length > 0) && (
            <div className="sheet skeleton" {...hard}>
              <div><span className="status" data-state="running"><i />{loading ? 'Downloading' : 'Simulating'}</span><p className="muted small" style={{ marginTop: 8 }}>{real ? `Loading ${chosen.length} real days and replaying every fill.` : `Building ${sampleText} and replaying every fill.`}</p></div>
            </div>
          )}

          {r && v && (
            <>
              <div className="fade-busy"><Kpis r={r} /></div>

              <div className="sheet" {...hard}>
                <div className="chart-sheet-head">
                  <span className="label">Cumulative net P&amp;L · {sampleText}</span>
                  <span className="status" data-state={busy ? 'running' : 'done'}><i />{busy ? 'Simulating' : `Done in ${(lab.ms / 1000).toFixed(1)}s`}</span>
                </div>
                <div className="chart-sheet-body fade-busy"><Curve r={r} id="lab" /></div>
              </div>

              <div className="sheet verdict fade-busy" {...hard}>
                <h2 className="h3">{v.head}</h2>
                <p className="muted" style={{ marginTop: 6 }}>{v.body}</p>
              </div>

              <div className="fade-busy"><ReportPanel r={r} lab={lab} /></div>

              <ResearchPanel r={r} lab={lab} params={params} msPerRun={Math.max(5, lab.ms)}
                meta={{ oneLine: strategy.oneLine, changed: [...changed, ...engineSet.map((k) => `${spaceLabel(k)}: ${choiceLabel(params[k])}`)] }}
                partial={real ? summary.counts.partial : 0}
                dataNote={real && r.data && span ? `Stored real data runs from ${span.min} to ${span.max}; this run used ${r.data.days} of those sessions.` : null}
                onLoad={loadFromStudy} />

              {r.strategy !== 'fourleg' && r.curve.length > 0 && <div className="fade-busy"><ReplayPanel r={r} load={lab.replay} /></div>}

              <div className="two fade-busy">
                <div className="sheet sheet--flat">
                  <div className="chart-sheet-head"><span className="label">How positions closed</span></div>
                  <Exits r={r} />
                </div>
                <div className="sheet sheet--flat">
                  <div className="chart-sheet-head"><span className="label">Detail</span></div>
                  <table className="ptable"><tbody>
                    {r.extra.map(([k, val]) => <tr key={k}><th scope="row">{k}</th><td>{typeof val === 'number' ? inr(val, { sign: val < 0 }) : val}</td></tr>)}
                  </tbody></table>
                </div>
              </div>

              <div className="sheet save" {...hard}>
                <div>
                  <h2 className="h3">Keep this run</h2>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    {real && r.data ? `Real NIFTY ${flag === 'WEEK' ? 'weekly' : 'monthly'}, ${r.data.from} to ${r.data.to}. ` : ''}
                    {changed.length ? `Changed from the defaults: ${changed.join(' · ')}` : 'These are the default rules.'}
                  </p>
                </div>
                <div className="save-row">
                  <label className="sr" htmlFor="note">Note for this run</label>
                  <input id="note" className="input" maxLength={280} placeholder="Why this run matters, in a line" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button variant="primary" onClick={keep} disabled={busy || saved.state === 'saving' || saved.state === 'done'}>{saved.state === 'saving' ? 'Saving' : saved.state === 'done' ? 'Saved' : 'Save to notebook'}</Button>
                </div>
                {saved.msg && <p className={saved.state === 'error' ? 'error' : 'small'} role="status">{saved.msg} {saved.state === 'done' && <Link className="link" href="/notebook">Open the notebook</Link>}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
