'use client';
import { supabase } from './supabase';
import type { Profile, RunResult, RunSummary, SavedRun, StrategySlug, Params } from './types';

const RUNS_KEY = 'straddloop.runs.v1';
const PROFILE_KEY = 'straddloop.profile.v1';
const emptyProfile: Profile = { focus: null, first_strategy: null, acknowledged_at: null };

function read<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep going in memory */ }
}

export function summarise(r: RunResult): RunSummary {
  const step = Math.max(1, Math.ceil(r.curve.length / 40));
  return {
    net: r.net, traded: r.traded, winRate: r.winRate, avg: r.avg, ci: r.ci, maxDD: r.maxDD, costs: r.costs, unit: r.unit,
    spark: r.curve.filter((_, i) => i % step === 0 || i === r.curve.length - 1).map((p) => Math.round(p.v)),
  };
}

async function userId(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.user.id ?? null;
  } catch { return null; }
}

export function getLocalProfile(): Profile { return read<Profile>(PROFILE_KEY, emptyProfile); }

export async function saveProfile(patch: Partial<Profile>): Promise<Profile> {
  const next = { ...getLocalProfile(), ...patch };
  write(PROFILE_KEY, next);
  const uid = await userId();
  if (uid) { try { await supabase()!.from('profiles').upsert({ id: uid, ...next, updated_at: new Date().toISOString() }); } catch { /* the local copy is enough */ } }
  return next;
}

export async function listRuns(): Promise<SavedRun[]> {
  const local = read<SavedRun[]>(RUNS_KEY, []).map((r) => ({ ...r, local: true }));
  const uid = await userId();
  if (!uid) return local;
  const { data, error } = await supabase()!.from('runs').select('id,strategy,params,summary,note,created_at').order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return [...local, ...((data ?? []) as SavedRun[])];
}

export async function saveRun(strategy: StrategySlug, params: Params, result: RunResult, note = ''): Promise<{ where: 'cloud' | 'browser' }> {
  const row = { strategy, params, summary: summarise(result), note };
  const uid = await userId();
  if (uid) {
    const { error } = await supabase()!.from('runs').insert(row);
    if (error) throw new Error(error.message);
    return { where: 'cloud' };
  }
  const runs = read<SavedRun[]>(RUNS_KEY, []);
  runs.unshift({ ...row, id: `local-${Date.now().toString(36)}`, created_at: new Date().toISOString() });
  write(RUNS_KEY, runs.slice(0, 100));
  return { where: 'browser' };
}

export async function deleteRun(run: SavedRun): Promise<void> {
  if (run.local || run.id.startsWith('local-')) {
    write(RUNS_KEY, read<SavedRun[]>(RUNS_KEY, []).filter((r) => r.id !== run.id));
    return;
  }
  const { error } = await supabase()!.from('runs').delete().eq('id', run.id);
  if (error) throw new Error(error.message);
}

/** After sign-in: move runs kept in this browser into the account, and push the onboarding answers. */
export async function syncLocalToCloud(): Promise<number> {
  const uid = await userId();
  if (!uid) return 0;
  const sb = supabase()!;
  const profile = getLocalProfile();
  if (profile.acknowledged_at) await sb.from('profiles').upsert({ id: uid, ...profile, updated_at: new Date().toISOString() });
  const runs = read<SavedRun[]>(RUNS_KEY, []);
  if (!runs.length) return 0;
  const { error } = await sb.from('runs').insert(runs.map(({ strategy, params, summary, note, created_at }) => ({ strategy, params, summary, note, created_at })));
  if (error) return 0;
  write(RUNS_KEY, []);
  return runs.length;
}
