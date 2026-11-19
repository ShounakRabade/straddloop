/* Lab worker: runs the Straddloop engines off the main thread.
 * Messages: { id, params } runs on synthetic data; { id, params, days } runs on real day files,
 * where `days` lists { path, buf? }. Day files are decoded once and kept here, so changing a
 * setting does not download or unpack anything again. { id, replay: date } returns one day's detail. */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/ledger.js', '/engine/legs.js', '/engine/compute.js', '/engine/dayfile.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine, self.StraddloopLedger, self.StraddloopLegs);
const D = self.StraddloopDayFile;
const docs = new Map(); // path -> Promise of the decoded day-file JSON (set synchronously, so overlapping runs share it)

async function sessionsFor(days, params) {
  for (const d of days) if (d.buf) docs.set(d.path, D.gunzipJSON(d.buf));
  const out = [];
  for (const d of days) {
    if (!docs.has(d.path)) throw new Error(`day file ${d.path} is not loaded`);
    const doc = await docs.get(d.path);
    out.push(D.toSession(doc, { lotSize: Number(params.lot_size) || 0 }));
  }
  return D.mergeSessions(out);
}

self.onmessage = async (ev) => {
  const { id, params, days, replay, exportKind, inspect } = ev.data;
  try {
    if (exportKind) { self.postMessage({ id, ok: true, csv: compute.exportCsv(exportKind) }); return; }
    if (inspect) { self.postMessage({ id, ok: true, page: compute.inspect(inspect.kind, inspect.offset, inspect.limit) }); return; }
    if (replay) { self.postMessage({ id, ok: true, replay: compute.replay(replay) }); return; }
    const t0 = Date.now();
    let result;
    if (days) {
      const sessions = await sessionsFor(days, params);
      if (!sessions.length) throw new Error('No trading days in the chosen range.');
      result = compute.run(params, sessions);
      const lots = [...new Set(sessions.map(s => s.expiries[0].lot_size))];
      const flags = new Set();
      sessions.forEach(s => s.meta.flags.forEach(f => flags.add(f.split(':')[0])));
      result.data = { source: 'dhan', from: sessions[0].date, to: sessions[sessions.length - 1].date, days: sessions.length,
        lot_sizes: lots, lot_source: sessions[0].meta.lot_source, expiry_source: sessions[0].meta.expiry_source, flags: [...flags],
        range_key: params.range_key || null };
      // The run must cover exactly the days the DateRange said would run (docs/ENGINE_INTERFACES.md §2).
      if (result.days && result.days.length !== sessions.length) throw new Error(`internal: ${sessions.length} days loaded but ${result.days.length} day outcomes`);
    } else {
      result = compute.run(params);
    }
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    // a gated leg-engine spec carries its gates (docs/ENGINE_INTERFACES.md §1), so the Lab can show each one
    self.postMessage({ id, ok: false, error: String((err && err.message) || err), gates: (err && err.gates) || null });
  }
};
