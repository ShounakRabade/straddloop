/* Day-file decoder: turns one Straddloop day file (format v1, written by `straddloop supabase-upload`
 * or `straddloop export-days`, see src/straddloop/data/dayfiles.py) into the session shape the engines
 * read: { date, symbol, source, bar_minutes, times, und, expiries: [{ expiry, lot_size, contracts }] }.
 *
 * Dhan's rolling series are labelled by distance from ATM (ATM-10..ATM+10) and report the actual
 * strike on every bar. The engines key contracts by actual strike, so each bar is filed under
 * "CE:<strike>" / "PE:<strike>". A fixed strike therefore has prices only while it was within ATM+-10.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StraddloopDayFile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function undelta(a) {
    const out = new Array(a.length);
    let prev = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] == null) out[i] = null;
      else { prev += a[i]; out[i] = prev; }
    }
    return out;
  }

  function ohlc(b, scale) {
    const o = undelta(b.o), n = o.length;
    const r = { o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n) };
    for (let i = 0; i < n; i++) {
      if (o[i] == null || b.h[i] == null || b.l[i] == null || b.c[i] == null) { r.o[i] = r.h[i] = r.l[i] = r.c[i] = null; continue; }
      r.o[i] = o[i] / scale; r.h[i] = (o[i] + b.h[i]) / scale; r.l[i] = (o[i] - b.l[i]) / scale; r.c[i] = (o[i] + b.c[i]) / scale;
    }
    return r;
  }

  /** opts.lotSize overrides the file's assumed lot size. */
  function toSession(doc, opts) {
    opts = opts || {};
    if (!doc || doc.v !== 1) throw new Error('unsupported day file version ' + (doc && doc.v));
    const n = doc.n, scale = doc.px_scale, times = [];
    for (let i = 0; i < n; i++) times.push(doc.t0 + i);
    const flags = [];
    let und;
    if (doc.index) und = ohlc(doc.index, scale);
    else {
      const sp = undelta(doc.spot).map(v => (v == null ? null : v / scale));
      und = { o: sp.slice(), h: sp.slice(), l: sp.slice(), c: sp.slice() };
      flags.push('index_from_spot');
    }
    const contracts = {};
    const blank = () => new Array(n).fill(null);
    let collisions = 0;
    for (const s of doc.series) {
      const k = undelta(s.k), p = ohlc(s, scale);
      for (let i = 0; i < n; i++) {
        if (p.o[i] == null || k[i] == null) continue;
        const key = s.cp + ':' + k[i];
        let con = contracts[key];
        if (!con) con = contracts[key] = { o: blank(), h: blank(), l: blank(), c: blank() };
        if (con.o[i] != null) { collisions++; continue; }
        con.o[i] = p.o[i]; con.h[i] = p.h[i]; con.l[i] = p.l[i]; con.c[i] = p.c[i];
      }
    }
    if (collisions) flags.push('strike_collisions:' + collisions);
    const lot = opts.lotSize > 0 ? opts.lotSize : doc.lot_size;
    return {
      date: doc.date, symbol: doc.underlying, source: 'dhan', bar_minutes: 1, times, und,
      expiries: [{ expiry: doc.expiry, lot_size: lot, contracts }],
      meta: { expiry_flag: doc.expiry_flag, expiry_source: doc.expiry_source, lot_source: opts.lotSize > 0 ? 'set in the Lab' : doc.lot_source,
        file_lot_size: doc.lot_size, flags },
    };
  }

  async function gunzipJSON(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack day files (no DecompressionStream).');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  return { undelta, toSession, gunzipJSON };
});
