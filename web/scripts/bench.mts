// Engine speed and memory on real day files: decode time, memory per decoded session, and sessions per second for
// each engine, with each run's fingerprint (run_hash) so a speed change can be checked for "same answer".
// Usage (from web/):
//   DAYFILES=../data/dayfiles/NIFTY/WEEK node --expose-gc --experimental-strip-types scripts/bench.mts [from] [to]
// Without --expose-gc the memory figure is skipped (it needs a collection before and after).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { freshCompute } from '../tests/helpers/golden.mts';
import { specFromTemplate } from '../lib/legs/templates.ts';
import type { TemplateId } from '../lib/legs/types.ts';

const require = createRequire(import.meta.url);
const D = require('../public/engine/dayfile.js');
const dir = process.env.DAYFILES;
if (!dir) { console.error('Set DAYFILES to a folder of day files (straddloop export-days).'); process.exit(1); }
const [from, to] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.json.gz') && (!from || f.slice(0, 10) >= from) && (!to || f.slice(0, 10) <= to)).sort();
const docs = files.map((f) => JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8')));
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heap0 = process.memoryUsage().heapUsed, t0 = performance.now();
const sessions = D.mergeSessions(docs.map((d: unknown) => D.toSession(d, { lotSize: 0 })));
const decodeMs = performance.now() - t0;
gc?.();
const mb = gc ? (process.memoryUsage().heapUsed - heap0) / 1e6 / sessions.length : null;
console.log(`${sessions.length} sessions, ${sessions[0]?.date} to ${sessions.at(-1)?.date}`);
console.log(`decode ${decodeMs.toFixed(0)} ms (${(decodeMs / sessions.length).toFixed(2)} ms a session)${mb != null ? ` · ${mb.toFixed(3)} MB a decoded session` : ' · memory: run with --expose-gc'}`);

const cases: [string, Record<string, unknown>][] = [
  ['straddle', { strategy: 'straddle' }],
  ['orb', { strategy: 'orb' }],
  ['ema_pullback', { strategy: 'ema_pullback' }],
  ...(['short_strangle', 'iron_condor', 'long_call', 'bull_put_spread'] as TemplateId[]).map((id) => [`legs.${id}`, { strategy: 'legs', spec: specFromTemplate(id) }] as [string, Record<string, unknown>]),
];
for (const [name, p] of cases) {
  const compute = freshCompute();
  compute.run(p, sessions); // warm-up (JIT, lookup caches)
  const reps = 3, t1 = performance.now();
  let r: any;
  for (let i = 0; i < reps; i++) r = compute.run(p, sessions);
  const ms = (performance.now() - t1) / reps;
  const hash = r.account?.report?.generated?.run_hash?.slice(0, 8) ?? '—';
  console.log(`${name.padEnd(22)} ${ms.toFixed(0).padStart(6)} ms  ${(sessions.length / (ms / 1000)).toFixed(0).padStart(6)} sessions/s  net ${r.net.toFixed(2)}  traded ${r.traded}  run ${hash}`);
}
