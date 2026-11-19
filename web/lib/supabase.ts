import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const clean = (v: string | undefined) => (v ?? '').trim().replace(/^['"`]+|['"`]+$/g, '').trim();
const looksLikeKey = (v: string) => /^(eyJ|sb_)/.test(v);

/**
 * Reads the two Supabase settings and repairs the common paste mistakes (missing https://, quotes,
 * a trailing path, the dashboard link, the two values swapped). Anything it cannot repair turns
 * accounts off instead of taking the site down.
 */
function resolve(): { url: string; key: string; problem: string | null } {
  let url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  let key = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) || clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  if (!url && !key) return { url, key, problem: 'not set' };
  if (looksLikeKey(url) && key && !looksLikeKey(key)) [url, key] = [key, url];
  if (!url || url.includes('YOUR-PROJECT')) return { url, key, problem: 'NEXT_PUBLIC_SUPABASE_URL is missing.' };
  if (!key || key.includes('YOUR-ANON')) return { url, key, problem: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.' };
  const dash = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) url = `https://${dash[1]}.supabase.co`;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('.')) throw new Error('no host');
    url = u.origin;
  } catch {
    return { url, key, problem: 'NEXT_PUBLIC_SUPABASE_URL is not a web address. It should look like https://abcd1234.supabase.co' };
  }
  if (/^https?:\/\//i.test(key) || /\s/.test(key)) return { url, key, problem: 'NEXT_PUBLIC_SUPABASE_ANON_KEY does not look like a key. Use the anon or publishable key from Supabase.' };
  return { url, key, problem: null };
}

const settings = resolve();
let failed: string | null = null;
let client: SupabaseClient | null = null;

/** Why accounts are off, or null when Supabase is configured. 'not set' means no keys at all. */
export const cloudProblem = settings.problem;
/** True when the deployment has usable Supabase settings. Without them the site runs in browser-only mode. */
export const cloudEnabled = settings.problem === null;

export function supabase(): SupabaseClient | null {
  if (!cloudEnabled || failed || typeof window === 'undefined') return null;
  if (!client) {
    try {
      client = createClient(settings.url, settings.key, { auth: { persistSession: true, detectSessionInUrl: true } });
    } catch (e) {
      failed = (e as Error).message;
      console.warn(`Straddloop: Supabase is switched off for this visit (${failed}). Runs are kept in this browser.`);
      return null;
    }
  }
  return client;
}
