/* Lab worker: runs the Straddloop engines off the main thread.
 * Messages: { id, params } runs on synthetic data; { id, params, days } runs on real day files, where `days` lists
 * { path, buf?, sha256? }. A day file is unpacked, checked against its sha256 (when the page knows it) and decoded once;
 * the decoded session is kept here (not the file), so changing a setting does not download or unpack anything again.
 * At most MAX_SESSIONS are kept: after a run, the least recently used ones beyond that are dropped and listed in the
 * answer (`evicted`), so the page sends them again when they are next needed.
 * While a run works it posts { id, progress: { phase: 'decode' | 'simulate' | 'ledger', done?, total? } }.
 * A run cannot be interrupted from inside (the engines are synchronous): the page cancels by ending this worker.
 * { id, replay: date } returns one day's detail of the latest run. */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/ledger.js', '/engine/legs.js', '/engine/compute.js', '/engine/dayfile.js', '/engine/analytics.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine, self.StraddloopLedger, self.StraddloopLegs);
const D = self.StraddloopDayFile;
const A = self.StraddloopAnalytics;
let lastData = null;          // result.data of the latest run (null = synthetic)
const cancelled = new Set();  // research request ids the page has cancelled
const MAX_SESSIONS = 600;     // about 0.65 MB each decoded (real data)
const held = new Map();       // `${path}|${lot}` -> { p: Promise<session>, used, checked } (set synchronously, so overlapping runs share it)
let clock = 0;

const keyOf = (path, lot) => `${path}|${lot}`;
/** The decoded sessions of `days`, decoding the ones that came with their file. onDecoded(done, total) per new file. */
async function sessionsFor(days, params, onDecoded) {
  const lot = Number(params.lot_size) || 0;
  const fresh = days.filter((d) => d.buf);
  let done = 0;
  for (const d of fresh) {
    const entry = { used: 0, checked: false, p: null };
    entry.p = D.unpack(d.buf, d.sha256 || null).then(({ doc, checked }) => {
      entry.checked = checked;
      const s = D.toSession(doc, { lotSize: lot });
      done++; if (onDecoded) onDecoded(done, fresh.length);
      return s;
    }, (err) => { held.delete(keyOf(d.path, lot)); err.path = d.path; err.message = `Day file ${d.path}: ${err.message}. Nothing was run.`; throw err; });
    held.set(keyOf(d.path, lot), entry);
  }
  const missing = days.filter((d) => !held.has(keyOf(d.path, lot))).map((d) => d.path);
  if (missing.length) {
    const e = new Error(`${missing.length} day file${missing.length === 1 ? ' is' : 's are'} no longer loaded in the engine (first: ${missing[0]}). Press Run again to send ${missing.length === 1 ? 'it' : 'them'}.`);
    e.code = 'MISSING'; e.paths = missing; throw e;
  }
  const stamp = ++clock, out = [];
  let checked = 0;
  for (const d of days) {
    const entry = held.get(keyOf(d.path, lot));
    entry.used = stamp;
    out.push(await entry.p);
    if (entry.checked) checked++;
  }
  return { sessions: D.mergeSessions(out), checked, keys: new Set(days.map((d) => keyOf(d.path, lot))) };
}
/** Drops the least recently used sessions beyond MAX_SESSIONS (never those of the run just made). Returns their keys. */
function evict(keep) {
  if (held.size <= MAX_SESSIONS) return [];
  const order = [...held.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used);
  const out = [];
  while (held.size > MAX_SESSIONS && order.length) { const [k] = order.shift(); held.delete(k); out.push(k); }
  return out;
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
  const { sessions } = await sessionsFor(req.days, req.params);
  const runner = (p, from, to) => {
    const sub = sessions.filter((s) => s.date >= from && s.date <= to);
    return sub.length ? A.fromRun(compute.evaluate(p, sub)) : null;
  };
  const hooks = { progress: (pr) => self.postMessage({ id, progress: pr }), cancelled: () => cancelled.has(id), yieldFn: () => new Promise((r) => setTimeout(r, 0)) };
  return A.runRolling({ params: req.params, windows: req.windows || [], options: { capital: Number(req.params.capital) || 500000 } }, runner, hooks);
}

/** Progress of one run, at most every 80 ms (and always the first and last step). */
function progressFor(id) {
  let last = 0;
  return (phase, done, total) => {
    const now = Date.now();
    if (done != null && done > 0 && done < total && now - last < 80) return;
    last = now;
    self.postMessage({ id, progress: done == null ? { phase } : { phase, done, total } });
  };
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
    const report = progressFor(id);
    const hooks = { tick: (i, n) => report('simulate', i, n), phase: (p) => report(p) };
    let result, evicted = [];
    if (days) {
      const got = await sessionsFor(days, params, (done, total) => report('decode', done, total));
      const sessions = got.sessions;
      if (!sessions.length) throw new Error('No trading days in the chosen range.');
      result = compute.run(params, sessions, hooks);
      const lots = [...new Set(sessions.map(s => s.expiries[0].lot_size))];
      const flags = new Set();
      sessions.forEach(s => s.meta.flags.forEach(f => flags.add(f.split(':')[0])));
      result.data = { source: 'dhan', from: sessions[0].date, to: sessions[sessions.length - 1].date, days: sessions.length,
        lot_sizes: lots, lot_source: sessions[0].meta.lot_source, expiry_source: sessions[0].meta.expiry_source, flags: [...flags],
        range_key: params.range_key || null, checksums: { checked: got.checked, files: days.length } };
      // The run must cover exactly the days the DateRange said would run (docs/ENGINE_INTERFACES.md §2).
      if (result.days && result.days.length !== sessions.length) throw new Error(`internal: ${sessions.length} days loaded but ${result.days.length} day outcomes`);
      lastData = result.data;
      evicted = evict(got.keys);
    } else {
      // never a silent stand-in: a run that asked for real dates must bring its day files
      if (params.data_from || params.range_key) throw new Error('internal: a real-data run arrived without its day files; nothing was run.');
      result = compute.run(params, undefined, hooks);
      lastData = null;
    }
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0, evicted });
  } catch (err) {
    // a gated leg-engine spec carries its gates (docs/ENGINE_INTERFACES.md §1), so the Lab can show each one
    self.postMessage({ id, ok: false, error: String((err && err.message) || err), gates: (err && err.gates) || null,
      code: (err && err.code) || null, paths: (err && (err.paths || (err.path ? [err.path] : null))) || null });
  }
};
