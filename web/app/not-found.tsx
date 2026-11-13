import { Shell } from '@/components/Shell';
import { ButtonLink } from '@/components/ui';

export default function NotFound() {
  return (
    <Shell>
      <div className="wrap section stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <p className="label">404</p>
        <h1 className="h2">No trade on this page.</h1>
        <p className="lede">The address does not match anything on Straddloop. The three strategies are on the home page.</p>
        <ButtonLink href="/" variant="primary" arrow>Back to the strategies</ButtonLink>
      </div>
    </Shell>
  );
}
