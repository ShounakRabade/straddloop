/**
 * Runs an optimisation study: plan the configurations, measure them on a pool of optimiser workers, store every
 * measurement as it arrives, then choose the three answers from the in-sample windows (public/engine/study.js).
 *
 * Order never matters: each configuration is measured on its own, and every ranking sorts by score and then by
 * configuration number, so the same study gives the same answers however the workers interleave. A cancel stops the
 * pool before its next configuration; what was measured is kept, and the study resumes from there.
 */
import Study from '../../public/engine/study.js';
import { axesFor, indexOf, labStrategy, paramsFor, plannedIndices, positionsAt, refusal, runParamsFor, spaceOf, valuesAt, type Value } from './space.ts';
import type { CandRecord, Store, StudyConfig, StudyRecord, Summary } from './store.ts';
import type { Params } from '../types';

export interface InitReq {
  days: { path: string; buf: ArrayBuffer }[] | null;
  synthetic: { days: number; seed: number; iv: number } | null;
  lotSize: number;
  plan: { split: StudyConfig['split']; folds: number; wfMode: StudyConfig['wfMode'] };
  capital: number;
  /** identifies the data; a pool already holding it keeps its decoded sessions instead of decoding them again */
  key?: string;
}
export type Item = { idx: number; summary?: Summary; error?: string };
export interface Pool {
  readonly size: number;
  init(req: InitReq): Promise<{ plan: Record<string, any>; n: number }>;
  /** Measures a batch on a free worker; onItem as each finishes. Resolves when the batch ends or is cancelled. */
  evaluate(batch: { idx: number; params: Params }[], onItem: (it: Item) => void): Promise<{ cancelled: boolean }>;
  cancel(): void;
  detail(params: Params): Promise<{ date: string; net: number; traded: boolean; status: string }[]>;
  close(): void;
}
export interface Progress {
  stage: 'loading' | 'searching' | 'robustness' | 'analysing' | 'done' | 'cancelled' | 'error';
  done: number; total: number; refused: number; failed: number;
  /** configurations a second, once at least 10 have finished in this stage (never guessed before) */
  rate: number | null; etaMs: number | null;
  message?: string;
}

const keyOf = (kind: 'grid' | 'stress', id: number) => `${kind === 'grid' ? 'g' : 's'}${id}`;
/** Doubled slippage, at least half a point more, for the stress run. */
export const stressSlip = (slip: number) => Math.max(slip * 2, slip + 0.5);

export function newStudyId(now = Date.now()): string {
  return `st-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The parameters (Lab form) of configuration `id`: 0 is the study's own starting settings. */
export function configParams(cfg: StudyConfig, id: number): Params {
  const s = labStrategy(cfg.slug)!;
  if (id === 0) return { ...cfg.base };
  const sp = spaceOf(cfg.picks);
  return paramsFor(s, cfg.base, sp, valuesAt(sp, id - 1));
}
export function configValues(cfg: StudyConfig, id: number): Value[] | null {
  return id === 0 ? null : valuesAt(spaceOf(cfg.picks), id - 1);
}

export async function runStudy(cfg: StudyConfig, deps: {
  pool: Pool; store: Store; init: () => Promise<InitReq>; onProgress: (p: Progress) => void;
  signal: { cancelled: boolean }; now?: () => number; batch?: number; id?: string;
}, resume?: { study: StudyRecord; cands: CandRecord[] }): Promise<{ study: StudyRecord; cands: Map<string, CandRecord> }> {
  const now = deps.now ?? (() => Date.now()), t0 = now();
  const s = labStrategy(cfg.slug);
  if (!s) throw new Error(`Unknown strategy ${cfg.slug}.`);
  if (!s.optimise.ok) throw new Error(s.optimise.why);
  const sp = spaceOf(cfg.picks);
  const stamp = new Date(t0).toISOString();
  const study: StudyRecord = resume ? { ...resume.study, status: 'running', updated: stamp, error: undefined }
    : { id: deps.id ?? newStudyId(t0), created: stamp, updated: stamp, status: 'running', config: cfg, counts: { planned: 0, evaluated: 0, refused: 0, failed: 0, extra: 0 } };
  const results = new Map<string, CandRecord>((resume?.cands ?? []).map((c) => [c.key, c]));
  const progress: Progress = { stage: 'loading', done: 0, total: 0, refused: 0, failed: 0, rate: null, etaMs: null };
  const emit = () => deps.onProgress({ ...progress });
  emit();

  // the data, once per worker; a resumed study must see the same sessions
  const init = await deps.pool.init(await deps.init());
  if (resume?.study.plan && resume.study.plan.n !== init.n) throw new Error(`This study was run on ${resume.study.plan.n} sessions and the data now has ${init.n}. Start a new study.`);
  study.plan = init.plan;
  await deps.store.saveStudy(study);

  /** Measures items on the pool, storing each batch as it finishes; respects cancel. */
  const measureAll = async (items: { key: string; idx: number; kind: 'grid' | 'stress'; values: Value[] | null; params: Params }[], stage: Progress['stage']) => {
    progress.stage = stage; progress.done = 0; progress.total = items.length; progress.rate = null; progress.etaMs = null;
    emit();
    const ts = now();
    let next = 0;
    const B = Math.max(1, deps.batch ?? 6);
    const lane = async () => {
      while (next < items.length && !deps.signal.cancelled) {
        const chunk = items.slice(next, next + B); next += B;
        const refs = new Map(chunk.map((c, k) => [k, c]));
        const rows: CandRecord[] = [];
        await deps.pool.evaluate(chunk.map((c, k) => ({ idx: k, params: runParamsFor(s, c.params, cfg.series) })), (it) => {
          const c = refs.get(it.idx)!;
          const row: CandRecord = { study: study.id, key: c.key, idx: c.idx, kind: c.kind, values: c.values, ...(it.summary ? { summary: it.summary } : { error: it.error ?? 'failed' }) };
          results.set(row.key, row); rows.push(row);
          progress.done++;
          if (!it.summary) { study.counts.failed++; progress.failed++; }
          else if (stage === 'robustness') study.counts.extra = (study.counts.extra ?? 0) + 1;
          else study.counts.evaluated++;
          const el = (now() - ts) / 1000;
          if (progress.done >= 10 && el > 0) { progress.rate = progress.done / el; progress.etaMs = ((progress.total - progress.done) / progress.rate) * 1000; }
          emit();
        });
        await deps.store.putCands(rows);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, deps.pool.size) }, lane));
  };

  /** Configurations to measure: those not stored yet, with refusals recorded (and stored) instead of run. */
  const prepare = (ids: number[], kind: 'grid' | 'stress') => {
    const out: { key: string; idx: number; kind: 'grid' | 'stress'; values: Value[] | null; params: Params }[] = [];
    const refusedRows: CandRecord[] = [];
    for (const id of ids) {
      const key = keyOf(kind, id);
      if (results.has(key)) continue;
      let p = configParams(cfg, id);
      if (kind === 'stress') p = { ...p, slip_pct: stressSlip(Number(p.slip_pct ?? 0.5)) };
      const why = refusal(s, p, { real: cfg.real, series: cfg.series });
      if (why) {
        const row: CandRecord = { study: study.id, key, idx: id, kind, values: configValues(cfg, id), refused: why };
        results.set(key, row); refusedRows.push(row); study.counts.refused++; progress.refused++;
        continue;
      }
      out.push({ key, idx: id, kind, values: configValues(cfg, id), params: p });
    }
    return { out, refusedRows };
  };

  try {
    // 1. the search: your settings (0) and the planned grid points (index + 1)
    const planned = plannedIndices(sp, cfg);
    const ids = [0, ...planned.indices.map((i) => i + 1)];
    study.counts.planned = ids.length;
    const first = prepare(ids, 'grid');
    await deps.store.putCands(first.refusedRows);
    await measureAll(first.out, 'searching');
    if (deps.signal.cancelled) return await stop('cancelled');

    // 2. the answers from the in-sample windows
    progress.stage = 'analysing'; emit();
    const cands = [...results.values()].filter((c) => c.kind === 'grid' && c.summary).sort((a, b) => a.idx - b.idx).map((c) => ({ idx: c.idx, summary: c.summary! }));
    if (!cands.length) throw new Error(`None of the ${ids.length} configurations could run${study.counts.refused ? ` (${study.counts.refused} were refused before running)` : ''}.`);
    const sel = Study.selectStudy(cands, study.plan, { objective: cfg.objective, weights: cfg.weights ?? undefined, minTrades: cfg.minTrades, topK: cfg.topK });

    // 3. robustness of the finalists: one step either side on each ordered setting, and doubled slippage
    const defs = axesFor(s, cfg.base);
    const ordered = cfg.picks.map((p, i) => ({ i, ok: !!defs.find((d) => d.key === p.key)?.ordered && p.values.length > 1 })).filter((x) => x.ok).map((x) => x.i);
    const nbOf = new Map<number, number[]>();
    for (const f of sel.finalists as number[]) {
      const nb: number[] = [];
      if (f > 0) {
        const pos = positionsAt(sp, f - 1);
        for (const i of ordered) for (const d of [-1, 1]) {
          const q = pos.slice(); q[i] += d;
          if (q[i] < 0 || q[i] >= cfg.picks[i].values.length) continue;
          nb.push(indexOf(sp, q) + 1);
        }
      }
      nbOf.set(f, nb);
    }
    const extraGrid = prepare([...new Set([...nbOf.values()].flat())], 'grid');
    const extraStress = prepare(sel.finalists as number[], 'stress');
    await deps.store.putCands([...extraGrid.refusedRows, ...extraStress.refusedRows]);
    await measureAll([...extraGrid.out, ...extraStress.out], 'robustness');
    if (deps.signal.cancelled) return await stop('cancelled');

    progress.stage = 'analysing'; emit();
    const isScore = new Map(cands.map((c, k) => [c.idx, sel.scores.in_sample[k] as number]));
    const finalists = (sel.finalists as number[]).map((f) => {
      const own = results.get(keyOf('grid', f))!.summary!;
      const nbRows = nbOf.get(f)!.map((id) => results.get(keyOf('grid', id))).filter((r): r is CandRecord => !!r?.summary);
      const st = results.get(keyOf('stress', f));
      return { idx: f, is_score: isScore.get(f) ?? -Infinity, robust: Study.robustScore(own, nbRows.map((r) => r.summary!), st?.summary ?? null),
        neighbours: { planned: nbOf.get(f)!.length, measured: nbRows.length, positive: nbRows.filter((r) => r.summary!.is.net > 0).length }, stress_net: st?.summary?.is.net ?? null };
    });
    const robust = Study.mostRobust(finalists);
    const { scores, ...rest } = sel;
    study.result = {
      ...rest,
      cand_order: cands.map((c) => c.idx),
      scores: { train: scores.train.map(fin), validation: scores.validation.map(fin), in_sample: scores.in_sample.map(fin) },
      finalists: finalists.map((f) => ({ ...f, is_score: fin(f.is_score) })),
      robust: robust ? robust.idx : null,
      method: planned.method, capped: planned.capped, space_size: sp.size,
    };
    study.status = 'done';
    return await stop('done');
  } catch (e) {
    study.status = 'error'; study.error = (e as Error).message;
    await stop('error', (e as Error).message);
    throw e;
  }

  async function stop(stage: 'done' | 'cancelled' | 'error', message?: string) {
    if (stage === 'cancelled') study.status = 'cancelled';
    study.updated = new Date(now()).toISOString(); study.ms = (study.ms ?? 0) + (now() - t0);
    await deps.store.saveStudy(study);
    progress.stage = stage; progress.message = message; emit();
    return { study, cands: results };
  }
}
/** -Infinity (not eligible) does not survive JSON or IndexedDB cleanly: stored as null. */
const fin = (x: number) => (Number.isFinite(x) ? x : null);

// ------------------------------------------------------------------ the browser pool
/** Optimiser workers. Each holds its own copy of the sessions (about 1.5 MB per session), so the size is a choice. */
export class WorkerPool implements Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiting: ((w: Worker) => void)[] = [];
  private seq = 0;
  readonly size: number;
  private url: string;
  constructor(size: number, url = '/engine/optimise_worker.js') { this.size = size; this.url = url; }
  private call(w: Worker, msg: Record<string, unknown>, onItem?: (it: Item) => void): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const h = (ev: MessageEvent) => {
        if (ev.data.id !== id) return;
        if (ev.data.item) { onItem?.(ev.data.item); return; }
        w.removeEventListener('message', h);
        if (ev.data.ok) resolve(ev.data); else reject(new Error(ev.data.error ?? 'The optimiser worker stopped.'));
      };
      w.addEventListener('message', h);
      w.postMessage({ id, ...msg });
    });
  }
  private loaded: string | null = null;
  async init(req: InitReq) {
    if (req.key && this.loaded === req.key && this.workers.length) {
      // the same data: the workers keep their decoded sessions and only fix the new study's windows
      const outs = await Promise.all(this.workers.map((w) => this.call(w, { init: { ...req, days: null, synthetic: null, reuse: true } })));
      this.idle = this.workers.slice(); this.waiting = [];
      return { plan: outs[0].plan, n: outs[0].n };
    }
    this.close();
    this.workers = Array.from({ length: this.size }, () => new Worker(this.url));
    for (const w of this.workers) w.addEventListener('error', () => undefined);
    // every worker decodes its own copy (structured clone copies the buffers)
    const outs = await Promise.all(this.workers.map((w) => this.call(w, { init: req })));
    this.idle = this.workers.slice();
    this.loaded = req.key ?? null;
    return { plan: outs[0].plan, n: outs[0].n };
  }
  /** True when the pool already holds this data. */
  holds(key: string) { return this.loaded === key && this.workers.length > 0; }
  private take(): Promise<Worker> { const w = this.idle.pop(); return w ? Promise.resolve(w) : new Promise((r) => this.waiting.push(r)); }
  private give(w: Worker) { const r = this.waiting.shift(); if (r) r(w); else this.idle.push(w); }
  async evaluate(batch: { idx: number; params: Params }[], onItem: (it: Item) => void) {
    const w = await this.take();
    try { const r = await this.call(w, { evaluate: batch }, onItem); return { cancelled: !!r.cancelled }; }
    finally { this.give(w); }
  }
  cancel() { for (const w of this.workers) w.postMessage({ cancel: true }); }
  async detail(params: Params): Promise<{ date: string; net: number; traded: boolean; status: string }[]> {
    const w = await this.take();
    try { return (await this.call(w, { detail: { params } })).days; } finally { this.give(w); }
  }
  close() { for (const w of this.workers) w.terminate(); this.workers = []; this.idle = []; this.waiting = []; this.loaded = null; }
}
