import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { ButtonLink, SyntheticNote, hard } from '@/components/ui';
import { Reveal } from '@/components/Reveal';
import { EquityChart, PayoffChart, PathChart, figure } from '@/components/charts';
import { STRATEGIES } from '@/lib/strategies';
import { inr, pct, tone } from '@/lib/format';
import pre from '@/lib/precomputed.json';
import type { RunResult } from '@/lib/types';

const runs = pre as unknown as Record<'straddle' | 'orb' | 'fourleg', RunResult>;
const facts = ['No real market data', 'Dates in 2099', 'Not investment advice', 'Every cost charged', 'Python and browser agree fill for fill', '90 rule tests', 'No live orders'];

export default function Home() {
  const hero = runs.straddle;
  return (
    <Shell>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <span className="pill pill--marker">Customized option trading strategies</span>
            <h1 className="display">Test the rule before the rule <span className="mark">tests you.</span></h1>
            <p className="lede">
              Straddloop turns three option strategies for NIFTY, BANK NIFTY and four large-cap stocks into exact rules, simulates every
              fill, charges every cost, and shows you what is left.
            </p>
            <div className="hero-actions">
              <ButtonLink href="/start" variant="primary" size="lg" arrow>Run your first backtest</ButtonLink>
              <ButtonLink href="#strategies" size="lg">Read the three rule sets</ButtonLink>
            </div>
            <p className="small muted">About a minute. No account needed.</p>
          </div>

          <div className="blotter sheet" {...hard}>
            <span className="stamp" aria-hidden="true">Synthetic · 2099</span>
            <div className="blotter-head">
              <span className="label">01 · Short straddle · default rules</span>
              <span className="label">{hero.sessions} sessions</span>
            </div>
            <div style={{ padding: '14px 12px 4px' }}>
              <EquityChart id="hero" points={hero.curve} label={`Synthetic equity curve of the short straddle over ${hero.sessions} sessions, ending at ${inr(hero.net)}.`} />
            </div>
            <div className="blotter-foot">
              <div><span className="label">Net</span><span className={`mono ${tone(hero.net)}`}>{figure(hero.net)}</span></div>
              <div><span className="label">Days won</span><span className="mono">{pct(hero.winRate, 0)}</span></div>
              <div><span className="label">Costs</span><span className="mono">{inr(hero.costs)}</span></div>
            </div>
          </div>
        </div>
      </section>

      <div className="ticker" aria-label="Ground rules">
        <div className="ticker-track">
          {[0, 1].map((k) => (
            <ul key={k} aria-hidden={k === 1}>{facts.map((f) => <li key={f}>{f}</li>)}</ul>
          ))}
        </div>
      </div>

      <section className="section" id="strategies">
        <div className="wrap">
          <Reveal className="section-head">
            <p className="label">The rule sets</p>
            <h2>Three strategies. Each one written down until nothing is left to guess.</h2>
            <p className="lede">Won 71% of days and still lost money: that is the short straddle on synthetic data. The figures below are the default rules, after costs.</p>
          </Reveal>
          <div className="cards-3">
            {STRATEGIES.map((s, i) => {
              const r = runs[s.slug];
              return (
                <Reveal key={s.slug} delay={i * 90}>
                  <Link href={`/strategies/${s.slug}`} className="strat-card sheet" {...hard}>
                    <div className="strat-card-top"><span className="num">{s.number}</span><span className="pill">{s.stance}</span></div>
                    <div className="strat-card-body">
                      <p className="label">{s.market}</p>
                      <h3>{s.name}</h3>
                      <p className="muted" style={{ fontSize: '0.9688rem' }}>{s.oneLine}</p>
                    </div>
                    <div className="strat-card-chart"><PayoffChart shape={s.payoff} compactView id={`card-${s.slug}`} /></div>
                    <div className="strat-card-foot">
                      <div><p className="label">Synthetic net</p><p className={`fig ${tone(r.net)}`}>{figure(r.net)}</p></div>
                      <span className="go">Rules <span className="arrow" aria-hidden="true">→</span></span>
                    </div>
                  </Link>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section band">
        <div className="wrap">
          <Reveal className="section-head">
            <p className="label">The loop</p>
            <h2>A rule goes in. A number you can argue with comes out.</h2>
          </Reveal>
          <Reveal>
            <ol className="loop" {...hard}>
              <li><span className="n">1</span><h3>Write the rule</h3><p className="muted small">“Around 9:45” becomes “the candle that closes at 09:50”. Every ambiguity gets a named default.</p></li>
              <li><span className="n">2</span><h3>Simulate each fill</h3><p className="muted small">Entries, stops, re-entries and exits happen bar by bar, using only what was known at that minute.</p></li>
              <li><span className="n">3</span><h3>Charge every cost</h3><p className="muted small">Brokerage, STT, exchange, SEBI and stamp charges, GST and slippage come off every trade.</p></li>
              <li><span className="n">4</span><h3>Read the interval</h3><p className="muted small">The average comes with its 95% range. If the range includes zero, the result could be luck.</p></li>
            </ol>
            <p className="loop-back">
              <svg viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M27 17a10 10 0 1 1-3.200-7.300M24.500 4v6h-6" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Then change one rule and go round again.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="section" aria-labelledby="scn-h">
        <div className="wrap">
          <Reveal className="section-head">
            <p className="label">Stress days</p>
            <h2 id="scn-h">Ten days built to break a rule.</h2>
            <p className="lede">Each card is one synthetic session with a known shape, run through both intraday strategies. The line is the index from open to close.</p>
          </Reveal>
        </div>
        <ul className="scroller" tabIndex={0} aria-label="Ten stress scenarios, scroll sideways">
          {pre.scenarios.map((sc) => (
            <li key={sc.key} className="scn sheet" {...hard}>
              <div className="scn-path"><PathChart values={sc.path} id={sc.key} /></div>
              <div className="scn-body"><h3>{sc.label}</h3></div>
              <dl>
                <div><dt>Short straddle</dt><dd className={sc.straddle ? tone(sc.straddle.net) : ''}>{sc.straddle ? figure(sc.straddle.net) : 'No entry'}</dd></div>
                <div><dt>Breakout</dt><dd className={sc.orb ? tone(sc.orb.net) : ''}>{sc.orb ? figure(sc.orb.net) : 'No trade'}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section className="section band">
        <div className="wrap truth">
          <Reveal className="stack" >
            <p className="label">What this cannot tell you</p>
            <h2 style={{ marginTop: 12 }}>Every number here is synthetic. On it, all three default rule sets <span className="mark">lose money.</span></h2>
            <p className="lede" style={{ marginTop: 20 }}>That is the tool doing its job. It is cheaper to find a weak rule in a simulator than in a trading account.</p>
            <div style={{ marginTop: 28 }}><SyntheticNote /></div>
          </Reveal>
          <Reveal delay={120}>
            <ul className="truth-list">
              <li><span className="n">A</span><div><h3>No NSE data is involved</h3><p className="muted">Prices come from a Black-Scholes model on simulated paths. Change its assumptions and the sign of a result can change.</p></div></li>
              <li><span className="n">B</span><div><h3>It is not advice</h3><p className="muted">Nothing here recommends a trade. Straddloop cannot place an order, and options can lose more than the premium involved.</p></div></li>
              <li><span className="n">C</span><div><h3>Real data is the next step</h3><p className="muted">Each strategy page lists the experiments to run first once historical data is imported into the Python engine.</p></div></li>
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="section cta">
        <div className="wrap">
          <h2 style={{ maxWidth: '18ch' }}>Pick a strategy. See its first 120 days.</h2>
          <p className="lede">Four short steps, then the lab is yours: move a stop, flip re-entry off, change the market, and watch what the rule does.</p>
          <ButtonLink href="/start" variant="marker" size="lg" arrow>Start</ButtonLink>
        </div>
      </section>
    </Shell>
  );
}
