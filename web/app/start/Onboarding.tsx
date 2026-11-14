'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, ButtonLink, Logo, hard } from '@/components/ui';
import { PayoffChart } from '@/components/charts';
import { Curve, Kpis, verdict } from '@/components/ResultView';
import { STRATEGIES, bySlug } from '@/lib/strategies';
import { useLab } from '@/lib/useLab';
import { getLocalProfile, saveProfile, saveRun } from '@/lib/store';
import { cloudEnabled } from '@/lib/supabase';
import { useSession } from '@/lib/useSession';
import type { Focus, StrategySlug } from '@/lib/types';

const STEPS = ['You', 'Strategy', 'Ground rules', 'First run'];
const FOCUS: { value: Focus; title: string; body: string; suggests: StrategySlug }[] = [
  { value: 'index', title: 'Index options, intraday', body: 'NIFTY or BANK NIFTY, in and out the same day.', suggests: 'straddle' },
  { value: 'stocks', title: 'Stock options, monthly', body: 'Positions in large caps held for days or weeks.', suggests: 'fourleg' },
  { value: 'exploring', title: 'Still deciding', body: 'I want to see how a rule gets tested before I pick one.', suggests: 'orb' },
];
const RULES = [
  { key: 'synthetic', title: 'The data is synthetic', body: 'Every result comes from a model with dates in 2099. No NSE prices are used, so a result says how a rule behaves under assumptions, not what the market did.' },
  { key: 'advice', title: 'This is not investment advice', body: 'Straddloop does not recommend trades and cannot place orders. Options can lose more than the premium involved.' },
  { key: 'costs', title: 'Results are after costs', body: 'Brokerage, taxes, exchange charges and slippage are already taken out of every figure you will see.' },
];

export function Onboarding() {
  const router = useRouter();
  const { session } = useSession();
  const [step, setStep] = useState(0);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [slug, setSlug] = useState<StrategySlug | null>(null);
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [kept, setKept] = useState<'idle' | 'saving' | 'cloud' | 'browser' | 'error'>('idle');
  const heading = useRef<HTMLHeadingElement>(null);
  const lab = useLab();
  const strategy = slug ? bySlug(slug)! : null;
  const allAgreed = RULES.every((r) => agreed[r.key]);

  useEffect(() => {
    const p = getLocalProfile();
    if (p.focus) setFocus(p.focus);
    if (p.first_strategy) setSlug(p.first_strategy);
  }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);

  function next() {
    if (step === 0 && focus) { if (!slug) setSlug(FOCUS.find((f) => f.value === focus)!.suggests); void saveProfile({ focus }); }
    if (step === 1 && slug) void saveProfile({ first_strategy: slug });
    if (step === 2 && strategy) { void saveProfile({ acknowledged_at: new Date().toISOString() }); lab.run(strategy.defaults); }
    setStep((s) => Math.min(3, s + 1));
  }
  const canNext = [Boolean(focus), Boolean(slug), allAgreed][step] ?? false;
  const r = lab.result, v = r ? verdict(r) : null;

  async function keep() {
    if (!r || !strategy) return;
    setKept('saving');
    try { setKept((await saveRun(strategy.slug, strategy.defaults, r, 'My first run, default rules')).where); } catch { setKept('error'); }
  }

  return (
    <div className="ob">
      <header className="ob-top">
        <div className="wrap"><Logo /><Link href="/" className="link small">Leave setup</Link></div>
      </header>
      <main id="main" className="ob-main wrap">
        <div className="ob-inner">
          <ol className="stepper" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li key={s} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'} aria-current={i === step ? 'step' : undefined}>
                <span>{i + 1}. {s}</span>
              </li>
            ))}
          </ol>

          {step === 0 && (
            <section className="ob-step" key="s0">
              <h1 ref={heading} tabIndex={-1}>What do you trade?</h1>
              <p className="lede">This picks a sensible first strategy. You can open all three later.</p>
              <div className="ob-body choices choices--3" role="radiogroup" aria-label="What you trade">
                {FOCUS.map((f) => (
                  <label className="choice" key={f.value}>
                    <input type="radio" name="focus" checked={focus === f.value} onChange={() => { setFocus(f.value); setSlug(f.suggests); }} />
                    <span className="box" {...hard}><span className="tick" aria-hidden="true">✓</span><h3>{f.title}</h3><span className="muted small">{f.body}</span></span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="ob-step" key="s1">
              <h1 ref={heading} tabIndex={-1}>Pick the rule to test first.</h1>
              <p className="lede">We marked the one that fits your answer. Each runs on its default rules.</p>
              <div className="ob-body choices choices--3" role="radiogroup" aria-label="First strategy">
                {STRATEGIES.map((s) => (
                  <label className="choice" key={s.slug}>
                    <input type="radio" name="strategy" checked={slug === s.slug} onChange={() => setSlug(s.slug)} />
                    <span className="box" {...hard}>
                      <span className="tick" aria-hidden="true">✓</span>
                      <span className="label">{s.number} · {s.stance}</span>
                      <h3>{s.short}</h3>
                      <span className="muted small">{s.oneLine}</span>
                      <span style={{ marginTop: 8 }}><PayoffChart shape={s.payoff} compactView id={`ob-${s.slug}`} /></span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="ob-step" key="s2">
              <h1 ref={heading} tabIndex={-1}>Three things to agree on first.</h1>
              <p className="lede">Tick each one. They are the difference between research and a tip.</p>
              <div className="ob-body agree">
                {RULES.map((rule) => (
                  <label key={rule.key}>
                    <input type="checkbox" checked={Boolean(agreed[rule.key])} onChange={(e) => setAgreed((a) => ({ ...a, [rule.key]: e.target.checked }))} />
                    <span><h3>{rule.title}</h3><span className="muted" style={{ fontSize: '0.9688rem' }}>{rule.body}</span></span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {step === 3 && strategy && (
            <section className="ob-step" key="s3" aria-live="polite">
              {!r && lab.status !== 'error' && (
                <>
                  <h1 ref={heading} tabIndex={-1}>Running {strategy.short.toLowerCase()}…</h1>
                  <p className="lede">Building a synthetic market and replaying every fill. A few seconds.</p>
                  <div className="ob-body sheet skeleton" {...hard}><span className="status" data-state="running"><i />Simulating</span></div>
                </>
              )}
              {lab.status === 'error' && (
                <>
                  <h1 ref={heading} tabIndex={-1}>The simulation did not start.</h1>
                  <p className="lede">{lab.error} Try once more; if it fails again, a current version of Chrome, Safari, Firefox or Edge will run it.</p>
                  <div className="ob-actions"><Button variant="primary" onClick={() => lab.run(strategy.defaults)}>Try again</Button></div>
                </>
              )}
              {r && v && (
                <>
                  <p className="label" style={{ marginBottom: 12 }}>Your first run · {strategy.name}</p>
                  <h1 ref={heading} tabIndex={-1}>{v.head}</h1>
                  <p className="lede">{v.body}</p>
                  <div className="ob-body stack" style={{ '--gap': '20px' } as React.CSSProperties}>
                    <Kpis r={r} />
                    <div className="sheet" {...hard} style={{ padding: '16px 14px 6px' }}><Curve r={r} id="ob" /></div>
                  </div>
                  <div className="ob-actions" style={{ justifyContent: 'flex-start' }}>
                    <Button variant="primary" size="lg" arrow onClick={() => router.push(`/lab?s=${strategy.slug}`)}>Change a rule in the lab</Button>
                    {kept === 'idle' || kept === 'saving' || kept === 'error'
                      ? <Button size="lg" onClick={keep} disabled={kept === 'saving'}>{kept === 'saving' ? 'Saving' : 'Keep this run'}</Button>
                      : <ButtonLink href="/notebook" size="lg">Open the notebook</ButtonLink>}
                  </div>
                  <p className="small muted" role="status" style={{ marginTop: 14, minHeight: '1.5em' }}>
                    {kept === 'error' && <span className="error">That did not save. Try again in a moment.</span>}
                    {kept === 'cloud' && 'Saved to your account.'}
                    {kept === 'browser' && (cloudEnabled && !session
                      ? <>Saved in this browser. <Link className="link" href="/login?next=/notebook">Create an account</Link> to keep runs across devices.</>
                      : 'Saved in this browser.')}
                  </p>
                </>
              )}
            </section>
          )}

          {step < 3 && (
            <div className="ob-actions">
              {step > 0 ? <button type="button" className="link" onClick={() => setStep((s) => s - 1)}>Back</button> : <span />}
              <Button variant="primary" size="lg" arrow onClick={next} disabled={!canNext}>
                {step === 2 ? 'Agree and run the backtest' : 'Continue'}
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
