// Hand-made sessions in the engine's shape (what dayfile.js produces), for tests whose expected values are worked
// out by hand. Prices are functions of the minute t (555 = 09:15): a number (o=h=l=c), a bar {o,h,l,c}, or null.
export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function arr(fn) {
  const o = [], h = [], l = [], c = [];
  for (let t = 555; t < 930; t++) {
    const v = fn(t);
    if (v == null) { o.push(null); h.push(null); l.push(null); c.push(null); continue; }
    const b = typeof v === 'number' ? { o: v, h: v, l: v, c: v } : v;
    o.push(b.o); h.push(b.h); l.push(b.l); c.push(b.c);
  }
  return { o, h, l, c };
}
/** expiries: [{ expiry, series?, lot?, contracts: { 'CE:25000': fn, ... } }] */
export function session(date, index, expiries, source = 'dhan') {
  const times = []; for (let t = 555; t < 930; t++) times.push(t);
  return {
    date, symbol: 'NIFTY', source, bar_minutes: 1, times, und: arr(typeof index === 'number' ? () => index : index),
    expiries: expiries.map((e) => ({ expiry: e.expiry, series: e.series || 'WEEK', lot_size: e.lot || 75,
      contracts: Object.fromEntries(Object.entries(e.contracts).map(([k, fn]) => [k, arr(typeof fn === 'number' ? () => fn : fn)])) })),
    meta: { expiry_source: 'test', lot_source: 'test', flags: [] },
  };
}
/** A strike ladder 24,500..25,500 (step 50) where every contract is flat at `px(right, strike)` unless overridden. */
export function ladder(px, over = {}) {
  const out = {};
  for (let k = 24500; k <= 25500; k += 50) for (const r of ['CE', 'PE']) out[`${r}:${k}`] = over[`${r}:${k}`] ?? px(r, k);
  return out;
}
/** Statutory charges at the 1 Oct 2024 rates, written out independently of ledger.js. */
export function charges(action, px, qty, brokerage = 20) {
  const t = px * qty, ex = t * 0.03503 / 100, sebi = t * 0.0001 / 100, stt = action === 'SELL' ? t * 0.1 / 100 : 0, stamp = action === 'BUY' ? t * 0.003 / 100 : 0;
  return brokerage + ex + sebi + stt + stamp + 0.18 * (brokerage + ex + sebi);
}
