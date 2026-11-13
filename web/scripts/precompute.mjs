// Rebuilds lib/precomputed.json: the default synthetic runs shown on the marketing and strategy pages.
// Deterministic (seeded). Run with `npm run precompute` after changing an engine.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const E = require('../public/engine/engine.js');
const F = require('../public/engine/fourleg_engine.js');
const compute = require('../public/engine/compute.js')(E, F);
const round = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const thin = (r, n = 120) => {
  const step = Math.max(1, Math.ceil(r.curve.length / n));
  return { ...r, curve: r.curve.filter((_, i) => i % step === 0 || i === r.curve.length - 1) };
};
const out = {
  generated: 'synthetic model, seed 1, dates in 2099',
  straddle: thin(compute.run({ strategy: 'straddle' })),
  straddleNoReentry: (({ net, winRate }) => ({ net, winRate }))(compute.run({ strategy: 'straddle', reentry_enabled: false })),
  orb: thin(compute.run({ strategy: 'orb' })),
  fourleg: thin(compute.run({ strategy: 'fourleg', policy: 'A' })),
  fourlegB: (({ net, winRate, extra }) => ({ net, winRate, extra }))(compute.run({ strategy: 'fourleg', policy: 'B' })),
  scenarios: compute.scenarios(),
};
writeFileSync(new URL('../lib/precomputed.json', import.meta.url), JSON.stringify(out, round));
for (const k of ['straddle', 'orb', 'fourleg']) console.log(k, Math.round(out[k].net), out[k].traded, out[k].winRate.toFixed(1), out[k].ci.map(Math.round), out[k].curve.length);
console.log(out.scenarios.map(s => `${s.key}: ${s.straddle ? Math.round(s.straddle.net) : 'no entry'} / ${s.orb ? Math.round(s.orb.net) : 'no trade'}`).join('\n'));
