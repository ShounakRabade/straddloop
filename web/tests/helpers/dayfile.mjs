// Builds format-v1 day files (src/straddloop/data/dayfiles.py) for tests, so tests run the real decoder
// (public/engine/dayfile.js) instead of a hand-made session shape.
const N = 375, T0 = 555, PX = 100;
const toInt = (v) => (v == null ? null : Math.round(v * PX));
function delta(a) { const out = []; let prev = 0; for (const v of a) { if (v == null) out.push(null); else { out.push(v - prev); prev = v; } } return out; }
const rel = (a, b, sign) => a.map((x, i) => (x == null || b[i] == null ? null : sign * (x - b[i])));
function enc(b) {
  const o = b.o.map(toInt), h = b.h.map(toInt), l = b.l.map(toInt), c = b.c.map(toInt);
  return { o: delta(o), h: rel(h, o, 1), l: rel(o, l, 1), c: rel(c, o, 1) };
}
/** A flat bar series of length N. `at(t)` may return a number (o=h=l=c) or {o,h,l,c} or null (missing). */
export function bars(at) {
  const out = { o: [], h: [], l: [], c: [] };
  for (let i = 0; i < N; i++) {
    const v = at(T0 + i);
    if (v == null) { out.o.push(null); out.h.push(null); out.l.push(null); out.c.push(null); continue; }
    const b = typeof v === 'number' ? { o: v, h: v, l: v, c: v } : v;
    out.o.push(b.o); out.h.push(b.h); out.l.push(b.l); out.c.push(b.c);
  }
  return out;
}
/** series: [{ cp, off, strike, px: (t) => price | bar | null }] */
export function dayDoc({ date, expiry, lot = 75, flag = 'WEEK', index, vix, series }) {
  return {
    v: 1, underlying: 'NIFTY', expiry_flag: flag, date, expiry, expiry_source: 'test', lot_size: lot, lot_source: 'test',
    t0: T0, n: N, px_scale: PX, index: index ? enc(index) : null, vix: vix ? enc(vix) : null, spot: delta(Array(N).fill(null)),
    series: series.map((s) => {
      const b = bars(s.px);
      const k = b.o.map((v) => (v == null ? null : s.strike));
      return { cp: s.cp, off: s.off, k: delta(k), ...enc(b), v: delta(Array(N).fill(null)), oi: delta(Array(N).fill(null)), iv: delta(Array(N).fill(null)) };
    }),
  };
}
export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
