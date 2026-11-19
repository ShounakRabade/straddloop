'use client';

/** Last-resort screen if the root layout itself fails. Self-contained: no shared styles or fonts. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-IN">
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f6f3ea', color: '#14151f', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ fontSize: 32, lineHeight: 1.1, margin: '0 0 12px' }}>Straddloop could not start.</h1>
          <p style={{ margin: '0 0 20px', lineHeight: 1.5 }}>Reload the page. If this keeps happening, the deployment settings need a look.</p>
          <button onClick={reset} style={{ font: 'inherit', fontWeight: 700, padding: '12px 20px', border: '2px solid #14151f', borderRadius: 6, background: '#2743c9', color: '#fff', cursor: 'pointer' }}>Reload</button>
          <p style={{ marginTop: 20, fontFamily: 'ui-monospace, monospace', fontSize: 13, opacity: 0.7 }}>{error.message}</p>
        </div>
      </body>
    </html>
  );
}
