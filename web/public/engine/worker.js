/* Lab worker: runs the Straddloop engines off the main thread. */
importScripts('/engine/engine.js', '/engine/fourleg_engine.js', '/engine/compute.js');
const compute = self.makeStraddloopCompute(self.StraddleEngine, self.FourLegEngine);
self.onmessage = (ev) => {
  const { id, params } = ev.data;
  try {
    const t0 = Date.now();
    const result = compute.run(params);
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
