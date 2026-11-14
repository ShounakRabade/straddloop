'use client';
import { useEffect } from 'react';
import { Button, ButtonLink } from '@/components/ui';

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main id="main" className="wrap section stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <p className="label">Something broke</p>
      <h1 className="h2">This page stopped before it finished.</h1>
      <p className="lede">Nothing you saved is lost. Try the page again; if it stops a second time, the home page still works.</p>
      <div className="row">
        <Button variant="primary" onClick={reset}>Try again</Button>
        <ButtonLink href="/">Go to the home page</ButtonLink>
      </div>
      <p className="small muted mono">{error.message}</p>
    </main>
  );
}
