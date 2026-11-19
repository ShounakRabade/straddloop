// Day-file parity, step 1: synthetic sessions written out as Dhan-like rows. See run.sh.
const E = require(require('path').join(__dirname, '../../web/public/engine/engine.js'));
const fs = require('fs');
const days = E.syntheticCalendar(8, { iv: 13, n_strikes: 16, strike_step: 50, lot_size: 75 }, 3, '2025-10-06');
const und = [], opt = [];
for (const s of days) {
  for (const ex of s.expiries) for (const c of Object.values(ex.contracts)) { delete c.bid; delete c.ask; }
  s.times.forEach((t, i) => {
    const ts = `${s.date}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00+05:30`;
    und.push({ ts, o: s.und.o[i], h: s.und.h[i], l: s.und.l[i], c: s.und.c[i] });
    const spot = s.und.c[i];
    const ks = Object.keys(s.expiries[0].contracts).map(k => +k.split(':')[1]);
    let atm = ks[0]; for (const k of ks) if (Math.abs(k - spot) < Math.abs(atm - spot)) atm = k;
    for (const cp of ['CE', 'PE']) for (let off = -10; off <= 10; off++) {
      const k = atm + off * 50, con = s.expiries[0].contracts[cp + ':' + k];
      if (!con || con.o[i] == null) continue;
      opt.push({ ts, cp, k, off, o: con.o[i], h: con.h[i], l: con.l[i], c: con.c[i], spot });
    }
  });
}
fs.writeFileSync(process.argv[2] + '/rows.json', JSON.stringify({ und, opt }));
fs.writeFileSync(process.argv[2] + '/orig.json', JSON.stringify(days.map(s => ({ ...s, params: undefined }))));
console.log(days.map(s => s.date).join(' '), opt.length);
