// Records the golden results (tests/helpers/golden.mts) before an engine refactor:
//   node --experimental-strip-types scripts/golden.mts
//   DAYFILES=../data/dayfiles/NIFTY/WEEK node --experimental-strip-types scripts/golden.mts   (also records real data)
// Re-record only when a change is MEANT to move results, and say why in the commit.
import { writeFileSync } from 'node:fs';
import { fingerprints, realFingerprints } from '../tests/helpers/golden.mts';

const syn = fingerprints();
writeFileSync(new URL('../tests/golden.json', import.meta.url), JSON.stringify(syn, null, 1) + '\n');
console.log('synthetic:', Object.keys(syn).length, 'cases');
for (const [k, v] of Object.entries(syn)) console.log(' ', k.padEnd(32), JSON.stringify(v).slice(0, 110));
if (process.env.DAYFILES) {
  const real = realFingerprints(process.env.DAYFILES);
  writeFileSync(new URL('../tests/golden.real.json', import.meta.url), JSON.stringify(real, null, 1) + '\n');
  console.log('real:', real.sessions, 'sessions', real.from, '→', real.to);
  for (const [k, v] of Object.entries(real)) console.log(' ', k.padEnd(32), JSON.stringify(v).slice(0, 110));
}
