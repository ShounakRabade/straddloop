// The optimiser pool without browser workers: the same engine files and study code, run in-process (Node tests).
import { createRequire } from 'node:module';
import type { InitReq, Item, Pool } from '../../lib/optimiser/controller.ts';
import { freshCompute } from './golden.mts';
const require = createRequire(import.meta.url);
const A = require('../../public/engine/analytics.js');
const S = require('../../public/engine/study.js');
const E = require('../../public/engine/engine.js');

/** sessions: real sessions to study (the browser pool decodes day files instead); null = the synthetic calendar.
 *  onEach: called before each configuration (tests use it to cancel part-way). */
export function localPool(sessions: any[] | null = null, onEach?: (n: number) => void): Pool & { evaluated: number } {
  const compute = freshCompute();
  let ss: any[] = [], plan: any = null, regimes: any = null, capital = 500000, cancelled = false;
  const pool = {
    size: 1, evaluated: 0,
    async init(req: InitReq) {
      ss = sessions ?? E.syntheticCalendar(req.synthetic!.days, { iv: req.synthetic!.iv }, req.synthetic!.seed);
      capital = req.capital;
      plan = S.studyPlan(ss.map((s) => s.date), req.plan);
      regimes = S.volRegimes(ss, plan.isEnd);
      return { plan, n: ss.length };
    },
    async evaluate(batch: { idx: number; params: any }[], onItem: (it: Item) => void) {
      cancelled = false;
      for (const c of batch) {
        onEach?.(pool.evaluated);
        if (cancelled) break;
        try { onItem({ idx: c.idx, summary: S.summarise(A.fromRun(compute.evaluate(c.params, ss)).days, plan, regimes, { capital }) }); }
        catch (e) { onItem({ idx: c.idx, error: (e as Error).message }); }
        pool.evaluated++;
        await Promise.resolve();
      }
      return { cancelled };
    },
    cancel() { cancelled = true; },
    async detail(params: any) { return A.fromRun(compute.evaluate(params, ss)).days.map((d: any) => ({ date: d.date, net: d.traded ? d.net : 0, traded: !!d.traded, status: d.status })); },
    close() {},
  };
  return pool;
}
