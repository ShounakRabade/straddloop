import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when the deployment has Supabase keys. Without them the site runs in browser-only mode. */
export const cloudEnabled = Boolean(url && key && !url.includes('YOUR-PROJECT'));

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient | null {
  if (!cloudEnabled || typeof window === 'undefined') return null;
  if (!client) client = createClient(url!, key!, { auth: { persistSession: true, detectSessionInUrl: true } });
  return client;
}
