import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { ButtonLink, SyntheticNote, hard } from '@/components/ui';
import { EquityChart, PayoffChart, figure } from '@/components/charts';
import { STRATEGIES, bySlug } from '@/lib/strategies';
import { inr, pct, tone } from '@/lib/format';
import pre from '@/lib/precomputed.json';
import type { RunResult } from '@/lib/types';

const runs = pre as unknown as Record<string, RunResult>;
type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() { return STRATEGIES.map((s) => ({ slug: s.slug })); }
export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const s = bySlug((await params).slug);
  return s ? { title: s.name, description: s.oneLine } : {};
}

export default async function StrategyPage({ params }: Props) {
  const s = bySlug((await params).slug);
  if (!s) notFound();
  const r = runs[s.slug];
  const idx = STRATEGIES.indexOf(s), others = STRATEGIES.filter((_, i) => i !== idx);
  const unit = r.unit === 'day' ? 'traded day' : r.unit;
  return (
    <Shell>
      <header className="page-head">
        <div className="wrap">
          <p className="crumbs label"><Link href="/#strategies">Strategies</Link><span aria-hidden="true">/</span><span>{s.number}</span></p>
          <h1>{s.name}</h1>
          <p className="lede">{s.oneLine}</p>
          <div className="row">
            <span className="pill pill--ink">{s.stance}</span><span className="pill">{s.market}</span><span className="pill">{s.cadence}</span>
          </div>
        </div>
      </header>

      <div className="wrap doc">
        <article className="doc-main">
          <h2>The rules, in order</h2>
          <ol className="steps">
            {s.steps.map((st) => (
              <li key={st.title}>
                <div>
                  <h3>{st.title}</h3>
                  <p>{st.body}</p>
                  {st.points && <ul>{st.points.map((p) => <li key={p}>{p}</li>)}</ul>}
                </div>
              </li>
            ))}
          </ol>

          <h2>Where it breaks</h2>
          <p className="prose muted" style={{ marginBottom: 24 }}>These follow from the rules themselves. They hold whatever the data says.</p>
          <div className="weak">
            {s.weaknesses.map((w) => <div key={w.title}><h3>{w.title}</h3><p className="muted" style={{ fontSize: '0.9688rem' }}>{w.body}</p></div>)}
          </div>

          <h2>What the synthetic run showed</h2>
          <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
            <p className="prose">{s.synthetic}</p>
            <div className="kpis">
              <div className="kpi kpi--lead"><span className="label">Net after costs</span><span className={`v ${tone(r.net)}`}>{figure(r.net)}</span></div>
              <div className="kpi"><span className="label">Average {unit}</span><span className={`v ${tone(r.avg)}`}>{figure(r.avg)}</span><span className="s">95% range {inr(r.ci[0])} to {inr(r.ci[1], { sign: true })}</span></div>
              <div className="kpi"><span className="label">Won</span><span className="v">{pct(r.winRate)}</span><span className="s">of {r.traded} {r.unit}s</span></div>
              <div className="kpi"><span className="label">Deepest drawdown</span><span className="v loss">{inr(r.maxDD)}</span></div>
            </div>
            <div className="sheet sheet--flat" style={{ padding: '16px 14px 6px' }}>
              <EquityChart id={`s-${s.slug}`} points={r.curve} draw={false} label={`Synthetic cumulative net profit and loss for ${s.name}, ending at ${inr(r.net)}.`} />
            </div>
            <SyntheticNote />
          </div>

          <h2>Test first on real data</h2>
          <ul className="checklist">{s.experiments.map((e) => <li key={e}>{e}</li>)}</ul>

          <h2>Change a rule and rerun it</h2>
          <p className="prose muted" style={{ marginBottom: 24 }}>The lab runs the same engine in your browser. Move one setting and see what it does to the result.</p>
          <ButtonLink href={`/lab?s=${s.slug}`} variant="primary" size="lg" arrow>Open {s.short.toLowerCase()} in the lab</ButtonLink>

          <h2>The other two</h2>
          <div className="next-prev">
            {others.map((o) => (
              <Link key={o.slug} href={`/strategies/${o.slug}`} className="sheet sheet-pad strat-card" style={{ gap: 6 }} {...hard}>
                <span className="label">{o.number} · {o.stance}</span>
                <h3 style={{ marginTop: 6 }}>{o.name}</h3>
                <span className="go" style={{ marginTop: 10 }}>Read the rules <span className="arrow" aria-hidden="true">→</span></span>
              </Link>
            ))}
          </div>
        </article>

        <aside className="doc-aside" aria-label="Summary">
          <div className="sheet" {...hard}>
            <div className="strat-card-top"><span className="label">Payoff at expiry</span><span className="num mono small">{s.number}</span></div>
            <div style={{ padding: '16px 16px 18px' }}><PayoffChart shape={s.payoff} id={`aside-${s.slug}`} /></div>
          </div>
          <div className="sheet" {...hard}>
            <div className="strat-card-top"><span className="label">Default parameters</span></div>
            <table className="ptable"><tbody>{s.params.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody></table>
          </div>
        </aside>
      </div>
    </Shell>
  );
}
