// Engine speed on real day files: sessions per second for each engine, and a result fingerprint so a speed change
// can be checked for "same answer". Usage (from web/):
//   DAYFILES=../data/dayfiles/NIFTY/WEEK node --experimental-strip-types scripts/bench.mts [from] [to]
import { freshCompute, loadDayFiles } from '../tests/helpers/golden.mts';
import { specFromTemplate } from '../lib/legs/templates.ts';
import type { TemplateId } from '../lib/legs/types.ts';

const dir = process.env.DAYFILES;
if (!dir) { console.error('Set DAYFILES to a folder of day files (straddloop export-days).'); process.exit(1); }
const [from, to] = process.argv.slice(2);
const sessions = loadDayFiles(dir, { from, to });
console.log(`${sessions.length} sessions, ${sessions[0]?.date} to ${sessions.at(-1)?.date}`);

const cases: [string, Record<string, unknown>][] = [
  ['straddle', { strategy: 'straddle' }],
  ['orb', { strategy: 'orb' }],
  ['ema_pullback', { strategy: 'ema_pullback' }],
  ...(['short_strangle', 'iron_condor', 'long_call', 'bull_put_spread'] as TemplateId[]).map((id) => [`legs.${id}`, { strategy: 'legs', spec: specFromTemplate(id) }] as [string, Record<string, unknown>]),
];
for (const [name, p] of cases) {
  const compute = freshCompute();
  compute.run(p, sessions); // warm-up (JIT, lookup caches)
  const reps = 3, t0 = performance.now();
  let r: any;
  for (let i = 0; i < reps; i++) r = compute.run(p, sessions);
  const ms = (performance.now() - t0) / reps;
  console.log(`${name.padEnd(22)} ${ms.toFixed(0).padStart(6)} ms  ${(sessions.length / (ms / 1000)).toFixed(0).padStart(6)} sessions/s  net ${r.net.toFixed(2)}  traded ${r.traded}`);
}
