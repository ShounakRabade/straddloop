'use client';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { syncLocalToCloud } from './store';

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sb = supabase();
    if (!sb) { setReady(true); return; }
    sb.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = sb.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_IN') void syncLocalToCloud();
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  return { session, ready };
}
