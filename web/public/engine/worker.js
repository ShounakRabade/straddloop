/* Lab worker: runs the Straddloop engines off the main thread.
 * Messages: { id, params } runs on synthetic data; { id, params, days } runs on real day files,
 * where `days` lists { path, buf? }. Day files are decoded once and kept here, so changing a
 * setting does not download or unpack anything again. { id, replay: date } returns one day's detail. */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/compute.js', '/engine/dayfile.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine);
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
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

self.onmessage = async (ev) => {
  const { id, params, days, replay } = ev.data;
  try {
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
        lot_sizes: lots, lot_source: sessions[0].meta.lot_source, expiry_source: sessions[0].meta.expiry_source, flags: [...flags] };
    } else {
      result = compute.run(params);
    }
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
