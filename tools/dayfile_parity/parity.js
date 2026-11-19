// Day-file parity, step 3: decoded day files must give the same results as the original sessions. See run.sh.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const E = require(require('path').join(__dirname, '../../web/public/engine/engine.js'));
const F = require(require('path').join(__dirname, '../../web/public/engine/fourleg_engine.js'));
const D = require(require('path').join(__dirname, '../../web/public/engine/dayfile.js'));
const C = require(require('path').join(__dirname, '../../web/public/engine/compute.js'))(E, F);
const dir = process.argv[2] + '/dayfiles/NIFTY/WEEK';
const real = fs.readdirSync(dir).sort().map(f => D.toSession(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))))));
const orig = JSON.parse(fs.readFileSync(process.argv[2] + '/orig.json'));
for (const s of orig) { s.expiries[0].expiry = real.find(r => r.date === s.date).expiries[0].expiry; }
let bad = 0;
for (const p of [{ strategy: 'straddle' }, { strategy: 'straddle', reentry_enabled: false, lots: 2 }, { strategy: 'straddle', strike_offset: 2 },
  { strategy: 'orb' }, { strategy: 'orb', strike_offset: 1, lots: 3 }, { strategy: 'orb', target_basis: 'none' }]) {
  const a = C.run(p, real), b = C.run(p, orig);
  const ok = Math.abs(a.net - b.net) < 1e-6 && a.traded === b.traded;
  if (!ok) bad++;
  console.log(JSON.stringify(p), 'real', a.net.toFixed(2), a.traded, '| orig', b.net.toFixed(2), b.traded, ok ? 'OK' : 'DIFF');
}
const rp = C.replay(real[2].date);
console.log('replay', rp && rp.date, rp && rp.legs.length, rp && rp.events.length, rp && rp.candles.length);
process.exit(bad ? 1 : 0);
