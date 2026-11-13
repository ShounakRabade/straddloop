'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, SyntheticNote, hard } from '@/components/ui';
import { ParamFields } from '@/components/ParamFields';
import { Curve, Exits, Kpis, verdict } from '@/components/ResultView';
import { STRATEGIES, bySlug, describeParams } from '@/lib/strategies';
import { useLab } from '@/lib/useLab';
import { saveRun } from '@/lib/store';
import { inr } from '@/lib/format';
import type { Params, StrategySlug } from '@/lib/types';

const OPEN_KEY = 'straddloop.open';

export function LabClient() {
  const [slug, setSlug] = useState<StrategySlug>('straddle');
  const [params, setParams] = useState<Params>(STRATEGIES[0].defaults);
  const [booted, setBooted] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<{ state: 'idle' | 'saving' | 'done' | 'error'; msg?: string }>({ state: 'idle' });
  const lab = useLab();
  const strategy = bySlug(slug)!;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start from a notebook run, a ?s= link, or the default.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(OPEN_KEY);
      if (raw) {
        sessionStorage.removeItem(OPEN_KEY);
        const p = JSON.parse(raw) as Params, s = bySlug(String(p.strategy));
        if (s) { setSlug(s.slug); setParams({ ...s.defaults, ...p }); setBooted(true); return; }
      }
    } catch { /* fall through to the default */ }
    const s = bySlug(new URLSearchParams(window.location.search).get('s') ?? '');
    if (s) { setSlug(s.slug); setParams(s.defaults); }
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => lab.run(params), 220);
    setSaved({ state: 'idle' });
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, booted]);

  const pick = (next: StrategySlug) => { setSlug(next); setParams(bySlug(next)!.defaults); setNote(''); };
  const changed = useMemo(() => describeParams(strategy, params), [strategy, params]);
  const r = lab.result && lab.result.strategy === slug ? lab.result : null;
  const busy = lab.status === 'running' || !booted;
  const v = r ? verdict(r) : null;
  const sampleText = slug === 'fourleg' ? `${params.months} months, four stocks` : `${params.days} sessions, seed ${params.seed}`;

  async function keep() {
    if (!r) return;
    setSaved({ state: 'saving' });
    try {
      const { where } = await saveRun(slug, params, r, note.trim());
      setSaved({ state: 'done', msg: where === 'cloud' ? 'Saved to your account.' : 'Saved in this browser.' });
    } catch (e) {
      setSaved({ state: 'error', msg: `Could not save: ${(e as Error).message}. Your settings are still here, so you can try again.` });
    }
  }

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
            <button type="button" className="link small" onClick={() => setParams(strategy.defaults)} disabled={!changed.length} style={{ opacity: changed.length ? 1 : 0.4 }}>Reset to defaults</button>
          </div>
          <div className="ctl-body">
            <ParamFields idPrefix={slug} fields={strategy.fields} params={params} onChange={(k, val) => setParams((p) => ({ ...p, [k]: val }))} />
            <hr />
            <p className="small muted">Full rule text: <Link className="link" href={`/strategies/${slug}`}>{strategy.short} rules</Link></p>
          </div>
        </form>

        <div className="lab-out" data-busy={busy} aria-live="polite">
          <SyntheticNote>Synthetic model, dates in 2099. This shows how the rule reacts to a setting. It is not evidence about NIFTY or any stock, and not investment advice.</SyntheticNote>

          {lab.status === 'error' && (
            <div className="sheet sheet-pad stack" {...hard}>
              <h2 className="h3">The simulation stopped</h2>
              <p className="error">{lab.error}</p>
              <p className="muted">Reset the settings and it will run again.</p>
              <div><Button onClick={() => setParams(strategy.defaults)}>Reset to defaults</Button></div>
            </div>
          )}

          {!r && lab.status !== 'error' && (
            <div className="sheet skeleton" {...hard}>
              <div><span className="status" data-state="running"><i />Simulating</span><p className="muted small" style={{ marginTop: 8 }}>Building {sampleText} and replaying every fill.</p></div>
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
                  <p className="small muted" style={{ marginTop: 4 }}>{changed.length ? `Changed from the defaults: ${changed.join(' · ')}` : 'These are the default rules.'}</p>
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
