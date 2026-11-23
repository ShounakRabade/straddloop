/**
 * A finished study as rows for the ranked table and the CSV. Only training, validation and in-sample (the two
 * together) figures are here: the held-out test, and the full period that contains it, are left out so nobody can
 * sort or filter on them. They are shown for the three answers only.
 */
import { axesFor, labStrategy, plannedIndices, spaceOf, type AxisDef, type Value } from './space.ts';
import type { CandRecord, StudyRecord, Summary } from './store.ts';

export type WindowKey = 'is' | 'train' | 'validation';
export const WINDOW_LABEL: Record<WindowKey, string> = { is: 'In-sample (training + validation)', train: 'Training', validation: 'Validation' };
export type Answer = 'leader' | 'best_oos' | 'robust';
export const ANSWER_LABEL: Record<Answer, string> = { leader: 'In-sample leader', best_oos: 'Best out-of-sample', robust: 'Most robust' };

export interface Row {
  id: number;
  /** position by training score, the order the study chose from (1 = leader); null when not eligible */
  rank: number | null;
  values: Value[] | null;
  w: Record<WindowKey, Summary>;
  score: { train: number | null; validation: number | null; in_sample: number | null };
  robust: number | null;
  answers: Answer[];
}

/** The table's rows: every configuration the search measured, with its scores; refusals counted by reason. */
export function rowsOf(study: StudyRecord, cands: CandRecord[]): { rows: Row[]; refused: { reason: string; n: number }[]; failed: number; extra: number } {
  const res = study.result;
  if (!res) return { rows: [], refused: [], failed: 0, extra: 0 };
  const byKey = new Map(cands.map((c) => [c.key, c]));
  const order: number[] = res.cand_order;
  const posOf = new Map(order.map((id, k) => [id, k]));
  const rankOf = new Map<number, number>();
  let r = 0;
  for (const id of res.ranking as number[]) if (res.scores.train[posOf.get(id)!] != null) rankOf.set(id, ++r);
  const robustOf = new Map<number, number | null>((res.finalists as { idx: number; robust: { score: number | null } }[]).map((f) => [f.idx, f.robust.score]));
  const answersOf = (id: number) => (['leader', 'best_oos', 'robust'] as Answer[]).filter((a) => res[a] === id);
  const rows: Row[] = order.map((id, k) => {
    const sm = byKey.get(`g${id}`)!.summary!;
    return {
      id, rank: rankOf.get(id) ?? null, values: id === 0 ? null : byKey.get(`g${id}`)!.values,
      w: { is: sm.is, train: sm.train, validation: sm.validation },
      score: { train: res.scores.train[k], validation: res.scores.validation[k], in_sample: res.scores.in_sample[k] },
      robust: robustOf.get(id) ?? null, answers: answersOf(id),
    };
  });
  // refusals and failures of the search itself (not of the extra robustness runs)
  const cfg = study.config;
  const search = new Set([0, ...plannedIndices(spaceOf(cfg.picks), cfg).indices.map((i) => i + 1)]);
  const reasons = new Map<string, number>();
  let failed = 0, extra = 0;
  for (const c of cands) {
    if (c.kind === 'stress' || !search.has(c.idx)) { if (c.summary) extra++; continue; }
    if (c.refused) reasons.set(c.refused, (reasons.get(c.refused) ?? 0) + 1);
    else if (c.error) failed++;
  }
  return { rows, refused: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n), failed, extra };
}

export type SortKey = 'rank' | 'net' | 'ret_pct' | 'win_rate' | 'traded' | 'avg' | 'max_dd' | 'pf' | 'sharpe' | 'calmar' | 'streak_win' | 'streak_loss' | 'robust' | `p${number}`;
export const avgOf = (s: Summary) => (s.traded ? s.net / s.traded : null);
function sortVal(r: Row, k: SortKey, w: WindowKey): Value | null {
  if (k === 'rank') return r.rank == null ? null : -r.rank; // best first
  if (k === 'robust') return r.robust;
  if (k === 'avg') return avgOf(r.w[w]);
  if (k.startsWith('p')) { const i = Number(k.slice(1)); return r.values ? r.values[i] : null; }
  const v = r.w[w][k];
  return v == null || !Number.isFinite(v) ? null : v;
}
/** Sorted rows: descending by default (larger first), missing values last, ties by configuration number. */
export function sortRows(rows: Row[], k: SortKey, w: WindowKey, asc = false): Row[] {
  const dir = asc ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = sortVal(a, k, w), y = sortVal(b, k, w);
    if (x == null && y == null) return a.id - b.id;
    if (x == null) return 1;
    if (y == null) return -1;
    if (x < y) return -dir;
    if (x > y) return dir;
    return a.id - b.id;
  });
}
export interface Filter { minTraded: number; positiveValidation: boolean; answersOnly: boolean }
export const filterRows = (rows: Row[], f: Filter, w: WindowKey) => rows.filter((r) => r.w[w].traded >= f.minTraded
  && (!f.positiveValidation || r.w.validation.net > 0) && (!f.answersOnly || r.answers.length > 0 || r.robust != null));

/** A searched value as text: a choice's label, a time as typed, a number with its unit. */
export function valueText(a: AxisDef | undefined, v: Value): string {
  if (a?.kind === 'choice') return a.options?.find((o) => o.value === v)?.label ?? String(v);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return String(v);
}
export function axesOfStudy(study: StudyRecord): (AxisDef | undefined)[] {
  const s = labStrategy(study.config.slug);
  const defs = s ? axesFor(s, study.config.base) : [];
  return study.config.picks.map((p) => defs.find((d) => d.key === p.key));
}

const WIN_COLS: [string, (s: Summary) => unknown][] = [
  ['net', (s) => s.net], ['return_pct', (s) => s.ret_pct], ['win_rate_pct', (s) => s.win_rate], ['traded_days', (s) => s.traded],
  ['avg_per_traded_day', (s) => avgOf(s)], ['max_drawdown', (s) => s.max_dd], ['profit_factor', (s) => s.pf], ['sharpe', (s) => s.sharpe],
  ['recovery_factor', (s) => s.calmar], ['longest_win_streak', (s) => s.streak_win], ['longest_loss_streak', (s) => s.streak_loss],
];
const cell = (v: unknown) => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV of the ranked table: training, validation and in-sample only. The held-out test is not in it. */
export function csvOf(study: StudyRecord, rows: Row[]): string {
  const axes = axesOfStudy(study);
  const keys = study.config.picks.map((p) => p.key);
  const head = ['rank_by_training', 'config', ...keys, ...(['train', 'validation', 'in_sample'] as const).flatMap((w) => WIN_COLS.map(([c]) => `${w}_${c}`)),
    'score_train', 'score_validation', 'score_in_sample', 'robustness_score', 'answer'];
  const body = rows.map((r) => [
    r.rank, r.id === 0 ? 'your settings' : `#${r.id}`,
    ...keys.map((k, i) => (r.values ? valueText(axes[i], r.values[i]) : valueText(axes[i], study.config.base[k] as Value))),
    ...(['train', 'validation', 'is'] as const).flatMap((w) => WIN_COLS.map(([, g]) => g(r.w[w]))),
    r.score.train, r.score.validation, r.score.in_sample, r.robust, r.answers.map((a) => ANSWER_LABEL[a]).join('; '),
  ].map(cell).join(','));
  return [head.join(','), ...body].join('\n');
}
