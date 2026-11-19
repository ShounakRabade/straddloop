/** Types for the research analytics computed in the Lab worker (public/engine/analytics.js, docs/ANALYTICS.md). */
import type { Params } from './types';

export type Num = number | null;

export interface Perf {
  sessions: number; traded: number; excluded: number; from: string | null; to: string | null;
  net: number; gross: number; costs: number; mean: Num; sd: Num; ci: [number, number] | null; t: Num;
  per_session: Num; win_rate: Num; pf: Num; pf_note: string | null; avg_win: Num; avg_loss: Num; payoff: Num;
  best: Num; worst: Num; max_dd: number; max_dd_pct: number; dd_from: string | null; dd_to: string | null;
  sharpe: Num; sortino: Num; calmar: Num; util_avg: Num; util_peak: Num; peak_margin: Num; rom: Num; ret_pct: number; cagr: Num;
  idle_pct: Num; costs_pct_gross_profit: Num; exits: Record<string, { n: number; net: number }>;
  sample: { key: 'none' | 'thin' | 'moderate' | 'good' | 'large'; label: string; min_next: number | null };
}

export interface RegimeRow { label: string; p: Perf; share_net: Num; enough: boolean }
export interface RegimeDim {
  key: string; label: string; timing: 'ex-ante' | 'ex-post'; basis: string; rows: RegimeRow[];
  consistency: { judged: number; positive: number; share: number; best: string; worst: string; cis_overlap: boolean | null } | null;
}
export interface Regimes {
  total: Perf; dims: RegimeDim[]; min_traded: number; mode: 'fixed' | 'percentile';
  unavailable: { key: string; label: string; why: string }[]; notes: string[];
}

export type ModelOut = { status: 'not_run'; reason: string } | ({ status: 'ok'; method: string } & Record<string, unknown>);

export interface Mc {
  status: 'ok' | 'not_run'; reason?: string; n: number; paths: number; method: string; block: number; actual_total: number; actual_dd: number;
  total: { p5: number; p25: number; p50: number; p75: number; p95: number }; p_loss: number;
  dd: { p50: number; p95: number; p99: number }; shuffle_dd: { p50: number; p95: number };
  dd_exceed: { pct: number; prob: number }[]; hist: { lo: number; hi: number; counts: number[] }; sample: Perf['sample'];
}

export interface StressRow { key: string; label: string; p: Perf; inert?: boolean }
export interface Stress { rows: StressRow[]; break_even_slip: Num; break_even_note: string | null; base_slip: number; slip_inert?: boolean }
export interface SensRow { value: string | number | boolean; step: number; p: Perf; score?: number }
export interface Sens { key: string; label: string; base_value?: unknown; rows: SensRow[]; retention: Num; positive_neighbours: number; neighbours: number; cliff?: Num }

export interface Check { whole: Perf; thirds: Perf[]; sensitivity: Sens[]; stress: Stress; monte_carlo: Mc; runs: number; ms: number }

export interface StudyRow {
  idx: number; rank: number; params: Params; changed: { key: string; from: unknown; to: unknown }[];
  score_train: number; score_val: number; train: Perf; validation: Perf; eligible: boolean; test?: Perf; full?: Perf;
}
export interface Fold { train: [string, string]; test: [string, string]; chosen: number | null; reason?: string; is?: Perf; oos?: Perf; orig_oos?: Perf }
export interface Study {
  objective: string; objective_label: string; method: 'grid' | 'random'; space_size: number; configs_tested: number; runs_total: number; budget: number; min_trades: number;
  sessions: number; split: { train: [string, string, number]; validation: [string, string, number]; test: [string | null, string | null, number] };
  selection_rule: string; top: StudyRow[]; selected: StudyRow & { test: Perf; full: Perf }; original: StudyRow & { test: Perf; full: Perf };
  distribution: { net: number; dd: number; train: number }[];
  walk_forward: { mode: string; train_sessions: number; test_sessions: number; folds: Fold[]; oos: Perf; original_oos: Perf; wfe: Num; distinct_choices: number; churn: Num; status: string; reason: string | null };
  pbo: { status: 'ok' | 'not_run'; reason?: string; pbo?: number; combinations?: number; blocks?: number; configs?: number };
  dsr: { sr: number; T: number; trials: number; sr0: number; psr: number; dsr: number } | null;
  rank_corr_train_val: Num; sensitivity: Sens[]; stress: { original: Stress; selected: Stress }; monte_carlo: { selected: Mc; original: Mc }; ms: number;
}

export interface Component { key: string; label: string; group: string; weight: number; score: Num; value: unknown; formula: string; note: string | null }
export interface Robustness {
  components: Component[]; raw: Num; cap: number; score: Num; coverage: number; verdict: { key: string; label: string; why: string }; formula: string;
  statistical: { grade: string; why: string }; backtest: { grade: string; score: Num; why: string };
  data_quality: { grade: string; score: Num; why: string }; model_uncertainty: { grade: string; items: string[] };
}
export interface Diagnostic { id: string; label: string; value: Num; status: 'ok' | 'watch' | 'warn' | 'n/a'; text: string }
export interface Assistant {
  engine: 'templates'; model: null; cost_inr: 0;
  sections: { title: string; sentences: { text: string; refs: string[] }[] }[];
  facts: { id: string; label: string; value: unknown; text: string }[];
}

export interface Research {
  version: string; strategy: string; source: 'synthetic' | 'dhan'; perf: Perf; regimes: Regimes | null;
  models: { kmeans: ModelOut; hmm: ModelOut; vol_forecast: ModelOut; entry_filter: ModelOut; trees: ModelOut };
  cluster_regimes: RegimeDim | null; hmm_regimes: RegimeDim | null; monte_carlo: Mc; robustness: Robustness;
  diagnostics: { overfitting: Diagnostic[]; concentration: Diagnostic[]; fragility: Diagnostic[] }; assistant: Assistant;
  check: Check | null; study: Study | null; params: Params; data_key: string;
}

export interface Axis { key: string; label: string; values: (string | number | boolean)[] }
export interface ResearchRequest {
  kind: 'analyse' | 'check' | 'optimise';
  axes?: Axis[];
  options?: Record<string, unknown>;
  extra?: { meta?: { oneLine?: string; changed?: string[] }; regimeMode?: 'fixed' | 'percentile'; partial?: number; dataNote?: string };
}
export interface ResearchProgress { done: number; total: number; stage: string }

/** What the optimisation lab can search per strategy. Mirrors PARAM_SPACE in analytics.js (the worker is the source of truth for runs). */
export interface SpaceParam { key: string; label: string; kind: 'range' | 'choice'; min?: number; max?: number; step?: number; unit?: string; options?: (string | number | boolean)[]; sweep?: number[]; engine?: boolean }
