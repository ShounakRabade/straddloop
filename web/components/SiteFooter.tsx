import Link from 'next/link';
import { Logo } from './ui';
import { STRATEGIES } from '@/lib/strategies';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="cols">
          <div className="stack">
            <Logo />
            <p className="small muted" style={{ maxWidth: '38ch' }}>Customized option trading strategies, written as rules and tested after costs.</p>
          </div>
          <div>
            <p className="label">Strategies</p>
            <ul>{STRATEGIES.map((s) => <li key={s.slug}><Link href={`/strategies/${s.slug}`}>{s.short}</Link></li>)}</ul>
          </div>
          <div>
            <p className="label">Work</p>
            <ul>
              <li><Link href="/start">First backtest</Link></li>
              <li><Link href="/lab">Lab</Link></li>
              <li><Link href="/notebook">Notebook</Link></li>
              <li><a href="https://github.com/ShounakRabade/straddloop">Source on GitHub</a></li>
            </ul>
          </div>
        </div>
        <p className="legal small muted">
          Straddloop is a research tool. Every result on this site comes from a labelled synthetic model with dates in 2099; no historical
          NSE data is used. Nothing here is investment advice or a recommendation to trade. Options trading can lose more than the premium
          involved. Straddloop does not place orders.
        </p>
      </div>
    </footer>
  );
}
