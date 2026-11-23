// Golden results: a fingerprint of what every engine produces for fixed inputs, so a refactor can prove it changed
// nothing. `fingerprints()` runs Strategy 01 (and variants), ORB, EMA pullback, the four-leg model and every
// runnable builder template on the seeded synthetic model; `realFingerprints()` does the same on local day files.
// Recorded by `node --experimental-strip-types scripts/golden.mts`; checked by tests/golden.test.mts.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { TEMPLATES, specFromTemplate } from '../../lib/legs/templates.ts';

const require = createRequire(import.meta.url);
const L = require('../../public/engine/ledger.js');
const E = require('../../public/engine/engine.js');
const F = require('../../public/engine/fourleg_engine.js');
const G = require('../../public/engine/legs.js');
const D = require('../../public/engine/dayfile.js');

export const freshCompute = () => require('../../public/engine/compute.js')(E, F, L, G);

const r6 = (x: unknown) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 1e6) / 1e6 : x ?? null);

/** Everything that would move if a fill, a charge or a day outcome moved. */
export function fingerprint(compute: ReturnType<typeof freshCompute>, r: Record<string, any>) {
  const out: Record<string, unknown> = {
    net: r6(r.net), gross: r6(r.gross), costs: r6(r.costs), traded: r.traded, winRate: r6(r.winRate), maxDD: r6(r.maxDD),
    days: r.days ? r.days.length : null,
  };
  if (r.account) {
    out.run_hash = r.account.report.generated.run_hash;
    out.daily_hash = L.hashStr(JSON.stringify(r.account.daily));
    out.tradebook_hash = L.hashStr(compute.exportCsv('tradebook') || '');
    out.outcomes_hash = L.hashStr(JSON.stringify(r.days));
  }
  if (r.positions) out.positions = r.positions.length;
  return out;
}

/** The builder templates that can run on nearest-expiry data (calendars and diagonals need the next expiry). */
export const RUNNABLE_TEMPLATES = TEMPLATES.filter((t) => t.needs === 'nearest expiry').map((t) => t.id);

function cases() {
  return [
    ['straddle.defaults', { strategy: 'straddle' }],
    ['straddle.variant', { strategy: 'straddle', reentry_enabled: false, sl_pct: 50, target_per_lot: 1500, entry_condition: 'body', strike_offset: 1, lots: 2 }],
    ['straddle.seed7', { strategy: 'straddle', seed: 7, iv: 16 }],
    ['orb.defaults', { strategy: 'orb' }],
    ['orb.variant', { strategy: 'orb', target_points: 45, breakout_def: 'close', stop_buffer: 10 }],
    ['ema_pullback.defaults', { strategy: 'ema_pullback' }],
    ['fourleg.A', { strategy: 'fourleg', policy: 'A' }],
    ['fourleg.B', { strategy: 'fourleg', policy: 'B' }],
    ...RUNNABLE_TEMPLATES.map((id) => [`legs.${id}`, { strategy: 'legs', days: 60, spec: specFromTemplate(id) }] as const),
  ] as [string, Record<string, unknown>][];
}

/** One compute instance for every case (it memoises the synthetic calendars), so this is fast enough for npm test.
 *  Sharing is itself a check: an engine that mutated the shared sessions would change a later case's result. */
export function fingerprints() {
  const out: Record<string, unknown> = {};
  const compute = freshCompute();
  for (const [name, p] of cases()) {
    try { out[name] = fingerprint(compute, compute.run(p)); }
    catch (e) { out[name] = { error: String((e as Error).message) }; }
  }
  return out;
}

/** Sessions from a folder of day files (`straddloop export-days`, named YYYY-MM-DD.json.gz), in date order,
 *  optionally only those dated from..to (inclusive). */
export function loadDayFiles(dir: string, opts: { lotSize?: number; from?: string; to?: string } = {}) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json.gz'))
    .filter((f) => (!opts.from || f.slice(0, 10) >= opts.from) && (!opts.to || f.slice(0, 10) <= opts.to)).sort();
  return D.mergeSessions(files.map((f) => D.toSession(JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8')), { lotSize: opts.lotSize ?? 0 })));
}

/** The real-data golden range: the day files exported with
 *  `straddloop export-days --underlying NIFTY --expiry WEEK --start 2026-04-01 --end 2026-07-30`. */
export const REAL_RANGE = { from: '2026-04-01', to: '2026-07-30' };

export function realFingerprints(dir: string, range = REAL_RANGE) {
  const sessions = loadDayFiles(dir, range);
  const out: Record<string, unknown> = { sessions: sessions.length, from: sessions[0]?.date, to: sessions[sessions.length - 1]?.date };
  const real = [
    ['straddle.defaults', { strategy: 'straddle' }],
    ['straddle.variant', { strategy: 'straddle', reentry_enabled: false, sl_pct: 50, target_per_lot: 1500 }],
    ['orb.defaults', { strategy: 'orb' }],
    ['ema_pullback.defaults', { strategy: 'ema_pullback' }],
    ['legs.short_strangle', { strategy: 'legs', spec: specFromTemplate('short_strangle') }],
    ['legs.iron_condor', { strategy: 'legs', spec: specFromTemplate('iron_condor') }],
  ] as [string, Record<string, unknown>][];
  for (const [name, p] of real) {
    const compute = freshCompute();
    try { out[name] = fingerprint(compute, compute.run(p, sessions)); }
    catch (e) { out[name] = { error: String((e as Error).message) }; }
  }
  return out;
}
