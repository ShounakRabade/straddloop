'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, ButtonLink, hard } from '@/components/ui';
import { Sparkline } from '@/components/charts';
import { bySlug, describeParams } from '@/lib/strategies';
import { deleteRun, listRuns } from '@/lib/store';
import { cloudEnabled } from '@/lib/supabase';
import { useSession } from '@/lib/useSession';
import { inr, pct, shortDate, tone } from '@/lib/format';
import type { SavedRun } from '@/lib/types';

export function Notebook() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [runs, setRuns] = useState<SavedRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listRuns().then(setRuns).catch((e: Error) => { setError(e.message); setRuns([]); });
  }, []);
  useEffect(() => { if (ready) load(); }, [ready, session, load]);

  function open(run: SavedRun) {
    sessionStorage.setItem('straddloop.open', JSON.stringify({ ...run.params, strategy: run.strategy }));
    router.push('/lab');
  }
  async function remove(run: SavedRun) {
    try { await deleteRun(run); setRuns((rs) => (rs ?? []).filter((r) => r.id !== run.id)); }
    catch (e) { setError(`That run was not deleted: ${(e as Error).message}`); }
    setConfirm(null);
  }

  return (
    <div className="wrap">
      <div className="lab-head">
        <p className="label">Notebook</p>
        <h1>Runs you kept.</h1>
        <p className="muted">
          {session ? `Signed in as ${session.user.email}. Runs are stored in your account.`
            : cloudEnabled ? <>Runs are stored in this browser. <Link className="link" href="/login?next=/notebook">Sign in</Link> to keep them across devices.</>
              : 'Runs are stored in this browser only.'}
        </p>
      </div>

      <div style={{ paddingBottom: 'var(--section)' }} className="stack" aria-live="polite">
        {error && <p className="notice error" role="alert">{error} <button className="link" onClick={load}>Try again</button></p>}
        {runs === null && <div className="sheet skeleton" {...hard}><span className="status" data-state="running"><i />Opening the notebook</span></div>}
        {runs && runs.length === 0 && !error && (
          <div className="sheet empty" {...hard}>
            <h2>Nothing kept yet.</h2>
            <p className="prose">When a run in the lab tells you something, save it with a one-line note. It will appear here with its settings, its result and a small equity curve, ready to reopen.</p>
            <div className="row">
              <ButtonLink href="/lab" variant="primary" arrow>Open the lab</ButtonLink>
              <ButtonLink href="/start">Take the four-step start</ButtonLink>
            </div>
          </div>
        )}
        {runs && runs.length > 0 && (
          <ul className="runs">
            {runs.map((run) => {
              const s = bySlug(run.strategy);
              if (!s) return null;
              const changed = describeParams(s, run.params), m = run.summary;
              return (
                <li key={run.id} className="sheet run" {...hard}>
                  <div>
                    <p className="label">{s.number} · {shortDate(run.created_at)}{run.local && session ? ' · this browser' : ''}</p>
                    <h3 style={{ marginTop: 6 }}>{s.name}</h3>
                    {run.note && <p style={{ marginTop: 6 }}>{run.note}</p>}
                    <div className="chips">
                      {changed.length ? changed.map((c) => <span className="pill" key={c}>{c}</span>) : <span className="pill">Default rules</span>}
                    </div>
                  </div>
                  <div className="spark"><Sparkline values={m.spark} label={`Equity curve ending at ${inr(m.net)}`} /></div>
                  <div>
                    <p className={`fig ${tone(m.net)}`}>{inr(m.net, { sign: true })}</p>
                    <p className="small muted" style={{ textAlign: 'right' }}>won {pct(m.winRate, 0)} of {m.traded}</p>
                  </div>
                  <div className="run-actions">
                    <Button size="sm" onClick={() => open(run)} arrow>Reopen in the lab</Button>
                    {confirm === run.id
                      ? <><span className="small">Delete this run for good?</span><Button size="sm" onClick={() => remove(run)}>Delete</Button><button className="link small" onClick={() => setConfirm(null)}>Keep it</button></>
                      : <button className="link small" onClick={() => setConfirm(run.id)}>Delete</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
