/* Lab worker: runs the Straddloop engines off the main thread.
 * Messages: { id, params } runs on synthetic data; { id, params, days } runs on real day files,
 * where `days` lists { path, buf? }. Day files are decoded once and kept here, so changing a
 * setting does not download or unpack anything again. { id, replay: date } returns one day's detail. */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/ledger.js', '/engine/legs.js', '/engine/compute.js', '/engine/dayfile.js', '/engine/analytics.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine, self.StraddloopLedger, self.StraddloopLegs);
const D = self.StraddloopDayFile;
const A = self.StraddloopAnalytics;
let lastData = null;          // result.data of the latest run (null = synthetic)
const cancelled = new Set();  // research request ids the page has cancelled
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

/**
 * Research on the latest run: { id, research: { kind: 'analyse' | 'check' | 'optimise', axes, options, extra } }.
 * Long studies post { id, progress } and yield between engine runs, so a new Lab run or a cancel
 * ({ cancelResearch: id }) is handled while they work. The study runs on a snapshot of the latest run's
 * sessions and settings; it never changes them.
 */
async function research(id, req) {
  const snap = compute.lastRun();
  if (!snap) throw new Error('Run a backtest first: research reads the latest run.');
  const synthetic = !lastData;
  const info = req.extra || {};
  const data = synthetic ? { synthetic: true } : {
    assumed_lot: !/bhavcopy|set in the lab/i.test(String(lastData.lot_source || '')), assumed_expiry: !/bhavcopy/i.test(String(lastData.expiry_source || '')),
    partial: info.partial || 0, note: info.dataNote || null };
  const view = Object.assign(A.fromRun(snap), { strategy: snap.strategy, source: synthetic ? 'synthetic' : 'dhan', sessions: snap.sessions, data, meta: info.meta || null });
  const runner = (p) => A.fromRun(compute.evaluate(p, snap.sessions));
  const hooks = { progress: (pr) => self.postMessage({ id, progress: pr }), cancelled: () => cancelled.has(id), yieldFn: () => new Promise((r) => setTimeout(r, 0)) };
  const options = Object.assign({ capital: view.capital }, req.options || {});
  let check = null, study = null;
  if (req.kind === 'check') check = await A.runCheck({ base: snap.params, axes: req.axes || [], days: view.days, options }, runner, hooks);
  if (req.kind === 'optimise') study = await A.runOptimisation({ base: snap.params, axes: req.axes || [], options }, runner, hooks);
  const out = A.analyseRun(view, { check, study, regimeMode: info.regimeMode, mcPaths: options.mcPaths });
  if (study) { delete study.selected_days; delete study.original_days; }
  return Object.assign(out, { check, study, params: snap.params, data_key: snap.params && JSON.stringify([snap.params.data_from, snap.params.data_to, snap.sessions.length]) });
}

/**
 * Rolling windows over the sessions of the latest real run: { id, rolling: { params, days, windows } }, where days
 * are the run's DayRefs (already decoded here) and windows [{ from, to }]. Each window is its own backtest through
 * compute.evaluate, which leaves the latest run, its replay and its exports untouched. Posts { id, progress }
 * between windows; { cancelResearch: id } stops it before the next one.
 */
async function rolling(id, req) {
  const sessions = await sessionsFor(req.days, req.params);
  const runner = (p, from, to) => {
    const sub = sessions.filter((s) => s.date >= from && s.date <= to);
    return sub.length ? A.fromRun(compute.evaluate(p, sub)) : null;
  };
  const hooks = { progress: (pr) => self.postMessage({ id, progress: pr }), cancelled: () => cancelled.has(id), yieldFn: () => new Promise((r) => setTimeout(r, 0)) };
  return A.runRolling({ params: req.params, windows: req.windows || [], options: { capital: Number(req.params.capital) || 500000 } }, runner, hooks);
}

self.onmessage = async (ev) => {
  const { id, params, days, replay, exportKind, inspect } = ev.data;
  if (ev.data.cancelResearch != null) { cancelled.add(ev.data.cancelResearch); return; }
  if (ev.data.rolling) {
    try { self.postMessage({ id, ok: true, rolling: await rolling(id, ev.data.rolling) }); }
    catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
    finally { cancelled.delete(id); }
    return;
  }
  if (ev.data.research) {
    try { self.postMessage({ id, ok: true, research: await research(id, ev.data.research) }); }
    catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
    finally { cancelled.delete(id); }
    return;
  }
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
      lastData = result.data;
    } else {
      result = compute.run(params);
      lastData = null;
    }
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    // a gated leg-engine spec carries its gates (docs/ENGINE_INTERFACES.md §1), so the Lab can show each one
    self.postMessage({ id, ok: false, error: String((err && err.message) || err), gates: (err && err.gates) || null });
  }
};
