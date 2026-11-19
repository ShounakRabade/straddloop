'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, ButtonLink, hard } from '@/components/ui';
import { cloudEnabled, cloudProblem, supabase } from '@/lib/supabase';
import { useSession } from '@/lib/useSession';

type Mode = 'signin' | 'signup';
const friendly = (msg: string) => {
  if (/invalid login/i.test(msg)) return 'That email and password do not match an account. Check them, or use the sign-in link instead.';
  if (/already registered/i.test(msg)) return 'An account with that email already exists. Sign in instead.';
  if (/at least/i.test(msg)) return 'Use a password of at least 8 characters.';
  if (/failed to fetch|network|load failed/i.test(msg)) return 'Could not reach the account service. Check your connection and try again. If it keeps failing, the Supabase address in the deployment settings may be wrong.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  return msg;
};

export function Auth() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [next, setNext] = useState('/notebook');

  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get('next');
    if (n && n.startsWith('/') && !n.startsWith('//')) setNext(n);
  }, []);

  if (!cloudEnabled || (ready && !supabase())) {
    return (
      <div className="wrap auth stack" style={{ '--gap': '18px' } as React.CSSProperties}>
        <h1>Accounts are not switched on yet.</h1>
        <p className="muted">Straddloop is keeping your runs in this browser. Everything else works the same.</p>
        <p className="notice">{!cloudProblem || cloudProblem === 'not set'
          ? 'To switch accounts on, add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to the deployment and redeploy.'
          : `The Supabase settings need a fix: ${cloudProblem} Correct it in the deployment's environment variables and redeploy.`}</p>
        <div><ButtonLink href="/lab" variant="primary" arrow>Open the lab</ButtonLink></div>
      </div>
    );
  }

  if (ready && session) {
    return (
      <div className="wrap auth stack" style={{ '--gap': '18px' } as React.CSSProperties}>
        <h1>You are signed in.</h1>
        <p className="muted">{session.user.email}. Runs you save go to your account.</p>
        <div className="row">
          <ButtonLink href={next} variant="primary" arrow>Continue</ButtonLink>
          <Button onClick={async () => { await supabase()!.auth.signOut(); router.refresh(); }}>Sign out</Button>
        </div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = supabase()!;
    setBusy(true); setError(null); setInfo(null);
    const redirect = `${window.location.origin}${next}`;
    const res = mode === 'signin'
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
    setBusy(false);
    if (res.error) { setError(friendly(res.error.message)); return; }
    if (res.data.session) router.push(next);
    else setInfo(`Check ${email} for a confirmation link. Open it on this device to finish.`);
  }

  async function magic() {
    if (!email) { setError('Enter your email first, then ask for the link.'); return; }
    setBusy(true); setError(null); setInfo(null);
    const { error: err } = await supabase()!.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${next}` } });
    setBusy(false);
    if (err) setError(friendly(err.message)); else setInfo(`A sign-in link is on its way to ${email}.`);
  }

  return (
    <div className="wrap auth">
      <h1>{mode === 'signin' ? 'Sign in.' : 'Create an account.'}</h1>
      <p className="muted" style={{ marginBottom: 24 }}>An account keeps your notebook across devices. The lab works without one.</p>
      <form className="sheet" {...hard} onSubmit={submit} noValidate>
        <div className="seg" role="radiogroup" aria-label="Sign in or create an account">
          {(['signin', 'signup'] as Mode[]).map((m) => (
            <label key={m}><input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setError(null); setInfo(null); }} /><span>{m === 'signin' ? 'Sign in' : 'Create account'}</span></label>
          ))}
        </div>
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="pw-help" />
          {mode === 'signup' && <p className="help" id="pw-help">At least 8 characters.</p>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {info && <p className="notice" role="status">{info}</p>}
        <Button type="submit" variant="primary" disabled={busy || !email || password.length < 8}>{busy ? 'One moment' : mode === 'signin' ? 'Sign in' : 'Create account'}</Button>
        <p className="small muted">Forgot the password, or would rather not use one? <button type="button" className="link" onClick={magic} disabled={busy}>Email me a sign-in link</button></p>
      </form>
    </div>
  );
}
