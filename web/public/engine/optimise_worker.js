/* Optimiser worker: measures configurations for a study, so the Lab's own worker stays free for backtests.
 * Loads the same engine files as the Lab worker; every configuration runs through compute.evaluate (the same rules,
 * charges, slippage and ledger as a Lab run; lean for the leg engine) and is measured on the study's windows
 * (study.js summarise). Its day records are dropped once measured.
 *
 * Messages (each answered with the same id):
 *   { id, init: { days: [{ path, buf }] | null, synthetic: { days, seed, iv } | null, lotSize, plan: options, capital, reuse? } }
 *       -> { id, ok, plan, n }     decodes the sessions once (reuse: keep the ones already decoded) and fixes the windows
 *   { id, evaluate: [{ idx, params }] }
 *       -> { id, item: { idx, summary } | { idx, error } } for each configuration as it finishes, then { id, ok, done }
 *   { id, detail: { params } }  -> { id, ok, days: [{ date, net, traded, status }] }   (curves for the page)
 *   { cancel: true }            stops an evaluate batch before its next configuration
 */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/ledger.js', '/engine/legs.js', '/engine/compute.js', '/engine/dayfile.js', '/engine/analytics.js', '/engine/study.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine, self.StraddloopLedger, self.StraddloopLegs);
const D = self.StraddloopDayFile, A = self.StraddloopAnalytics, S = self.StraddloopStudy, E = self.StraddleEngine;

let sessions = null, plan = null, regimes = null, capital = 500000, cancelled = false;
const pause = () => new Promise((r) => setTimeout(r, 0));

async function init(req) {
  if (req.reuse && sessions) {
    // the same data again (a new study after a speed check): keep the decoded sessions, fix the new windows
  } else if (req.days) {
    // one file at a time: unpacked, checked against its sha256 when known, decoded, and its JSON dropped
    const list = [];
    for (const d of req.days) {
      let got;
      try { got = await D.unpack(d.buf, d.sha256 || null); }
      catch (err) { err.message = `Day file ${d.path}: ${err.message}. The study did not start.`; err.path = d.path; throw err; }
      list.push(D.toSession(got.doc, { lotSize: Number(req.lotSize) || 0 }));
    }
    sessions = D.mergeSessions(list);
  } else if (req.synthetic) {
    const sy = req.synthetic;
    sessions = E.syntheticCalendar(Number(sy.days) || 120, { iv: Number(sy.iv) || 13 }, Number(sy.seed) || 1);
  } else {
    // never a silent stand-in for missing data
    throw new Error('internal: the optimiser worker was given no sessions to study (no day files and no synthetic settings).');
  }
  if (!sessions.length) throw new Error('No sessions to study.');
  capital = Number(req.capital) || 500000;
  plan = S.studyPlan(sessions.map((s) => s.date), req.plan || {});
  regimes = S.volRegimes(sessions, plan.isEnd);
  return { plan, n: sessions.length };
}

function measure(params) {
  const days = A.fromRun(compute.evaluate(params, sessions)).days;
  return S.summarise(days, plan, regimes, { capital });
}

self.onmessage = async (ev) => {
  const m = ev.data, id = m.id;
  if (m.cancel) { cancelled = true; return; }
  try {
    if (m.init) { self.postMessage(Object.assign({ id, ok: true }, await init(m.init))); return; }
    if (!sessions) throw new Error('The optimiser worker has no sessions yet.');
    if (m.evaluate) {
      cancelled = false;
      for (const c of m.evaluate) {
        if (cancelled) break;
        let item;
        try { item = { idx: c.idx, summary: measure(c.params) }; }
        catch (err) { item = { idx: c.idx, error: String((err && err.message) || err) }; }
        self.postMessage({ id, item });
        await pause(); // lets a cancel message in between configurations
      }
      self.postMessage({ id, ok: true, done: true, cancelled });
      return;
    }
    if (m.detail) {
      const days = A.fromRun(compute.evaluate(m.detail.params, sessions)).days;
      self.postMessage({ id, ok: true, days: days.map((d) => ({ date: d.date, net: d.traded ? d.net : 0, traded: !!d.traded, status: d.status })) });
      return;
    }
    throw new Error('unknown request');
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
