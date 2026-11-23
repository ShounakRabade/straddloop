/* Day-file decoder: turns one Straddloop day file (format v1, written by `straddloop supabase-upload`
 * or `straddloop export-days`, see src/straddloop/data/dayfiles.py) into the session shape the engines
 * read: { date, symbol, source, bar_minutes, times, und, expiries: [{ expiry, lot_size, contracts }] }.
 *
 * Dhan's rolling series are labelled by distance from ATM (ATM-10..ATM+10) and report the actual
 * strike on every bar. The engines key contracts by actual strike, so each bar is filed under
 * "CE:<strike>" / "PE:<strike>". A fixed strike therefore has prices only while it was within ATM+-10.
 *
 * A minute with no price is an empty slot in its array (it reads as undefined), never a stored null: an array of
 * numbers with gaps keeps its numbers unboxed (8 bytes each), while a single null makes every number a separate
 * heap object (about 2.5x the memory). Engines test prices with `== null`, which is true for both.
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
      if (o[i] == null || b.h[i] == null || b.l[i] == null || b.c[i] == null) continue; // left empty: no price this minute
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
      const sp = undelta(doc.spot);
      und = { o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n) };
      for (let i = 0; i < n; i++) if (sp[i] != null) { const v = sp[i] / scale; und.o[i] = v; und.h[i] = v; und.l[i] = v; und.c[i] = v; }
      flags.push('index_from_spot');
    }
    const contracts = {};
    const blank = () => new Array(n); // empty slots until a price arrives (see the note at the top)
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
      vix: doc.vix ? ohlc(doc.vix, scale) : null,
      expiries: [{ expiry: doc.expiry, lot_size: lot, contracts, series: doc.expiry_flag || 'WEEK' }],
      meta: { expiry_flag: doc.expiry_flag, expiry_source: doc.expiry_source, lot_source: opts.lotSize > 0 ? 'set in the Lab' : doc.lot_source,
        file_lot_size: doc.lot_size, flags },
    };
  }

  async function gunzipJSON(buf) {
    return (await unpack(buf, null)).doc;
  }

  const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');
  /**
   * Unpacks a day file and, when its sha256 is known (market_days.sha256: the hash of the JSON before gzip), checks
   * it: a file that does not match is refused, never decoded. { doc, checked } — checked is false only when no hash
   * was given or this browser has no Web Crypto (an insecure http:// page).
   */
  async function unpack(buf, sha256) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack day files (no DecompressionStream).');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    const raw = await new Response(stream).arrayBuffer();
    const subtle = typeof crypto !== 'undefined' && crypto.subtle;
    let checked = false;
    if (sha256 && subtle) {
      const got = hex(await subtle.digest('SHA-256', raw));
      if (got !== String(sha256).toLowerCase()) {
        const e = new Error(`a day file does not match its checksum (expected ${String(sha256).slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
        e.code = 'CHECKSUM';
        throw e;
      }
      checked = true;
    }
    return { doc: JSON.parse(new TextDecoder().decode(raw)), checked };
  }

  /**
   * One session per date: day files of the same date from different expiry series (WEEK, MONTH) become one session
   * with one expiry entry per series, so a strategy can hold legs in both. The index comes from the first file.
   * The inputs are never changed (a worker keeps decoded sessions and reuses them): a merged date is a new object.
   */
  function mergeSessions(list) {
    const byDate = new Map(), copies = new Set();
    for (const s of list) {
      let have = byDate.get(s.date);
      if (!have) { byDate.set(s.date, s); continue; }
      if (!copies.has(have)) {
        have = Object.assign({}, have, { expiries: have.expiries.slice(), meta: Object.assign({}, have.meta, { flags: have.meta.flags.slice() }) });
        copies.add(have); byDate.set(s.date, have);
      }
      for (const ex of s.expiries) if (!have.expiries.some(e => e.series === ex.series)) have.expiries.push(ex);
      for (const f of s.meta.flags) if (!have.meta.flags.includes(f)) have.meta.flags.push(f);
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  return { undelta, toSession, gunzipJSON, unpack, mergeSessions };
});
