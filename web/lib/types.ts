import type { Gate, PositionRecord, StrategySpec } from './legs/types';

export type StrategySlug = 'straddle' | 'orb' | 'fourleg' | 'ema_pullback';
export type Focus = 'index' | 'stocks' | 'exploring';
export type Params = Record<string, string | number | boolean>;

export interface RunResult {
  /** 'legs' = the universal leg engine (params.strategy 'legs', params.spec = a StrategySpec). */
  strategy: StrategySlug | 'legs';
  /** What one "traded" unit is: a day (straddle), a trade (ORB), a month (four-leg), a position (leg engine). */
  unit: 'day' | 'trade' | 'month' | 'position';
  policy?: 'A' | 'B';
  sessions: number;
  traded: number;
  net: number;
  gross: number;
  costs: number;
  avg: number;
  /** 95% interval of the average (Student t). null when there are fewer than two observations. */
  ci: [number, number] | null;
  t: number;
  winRate: number;
  maxDD: number;
  worst: number;
  best: number;
  profitFactor: number | null;
  exits: Record<string, number>;
  curve: { d: string; v: number; p: number }[];
  extra: [string, string | number][];
  /** The financial ledger and report for the run (straddle and ORB). Absent for the four-leg stock model. */
  account?: Account;
  /** Present when the run used real day files instead of the synthetic model. `range_key` is the DateRange key it ran on. */
  data?: { source: 'dhan'; from: string; to: string; days: number; lot_sizes: number[]; lot_source: string; expiry_source: string; flags: string[]; range_key?: string | null };
  /** One outcome per session the engine received (straddle, ORB, legs). docs/ENGINE_INTERFACES.md §2. */
  days?: DayOutcome[];
  /** Leg engine only: every position with its legs, payoff and exit (docs/ENGINE_INTERFACES.md §2). */
  positions?: PositionRecord[];
  /** Leg engine only: data gates and warnings that applied to this run (errors never reach a result; they throw). */
  gates?: Gate[];
  /** Leg engine only: the normalised spec that ran and its hash. */
  spec?: StrategySpec;
  spec_hash?: string;
}

/** What happened on one session of a run. `days.length` always equals the number of sessions run. */
export interface DayOutcome {
  date: string;
  status: 'traded' | 'holding' | 'no_entry' | 'filtered' | 'excluded' | 'rejected';
  /** Why it did not trade, in words; null for traded days. */
  reason: string | null;
  /** Legs opened / closed that day (intraday strategies open and close the same legs). */
  opened: number;
  closed: number;
  /** That day's net realised P&L from the ledger. */
  net: number;
}

export interface ReplayLeg { side: string; strike: number; kind: string; entry_t: number; entry_px: number; exit_t: number | null; exit_px: number | null; exit_reason: string | null; stop: number | null; net: number }
export interface Replay {
  strategy: 'straddle' | 'orb' | 'ema_pullback' | 'legs'; date: string; status: string; reason: string | null; net?: number; gross?: number; costs?: number;
  exit_reason?: string; expiry?: string; lot_size?: number; qty?: number; flags: string[];
  or_high: number | null; or_low: number | null; decision_t?: number | null;
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  mtm: { t: number; v: number }[]; legs: ReplayLeg[]; events: { t: number; kind: string; text: string }[];
}

export interface RunSummary {
  net: number; traded: number; winRate: number; avg: number; ci: [number, number] | null; maxDD: number; costs: number;
  unit: RunResult['unit']; spark: number[];
}

export interface SavedRun {
  id: string;
  strategy: StrategySlug;
  params: Params;
  summary: RunSummary;
  note: string;
  created_at: string;
  local?: boolean;
}

export interface Profile {
  focus: Focus | null;
  first_strategy: StrategySlug | null;
  acknowledged_at: string | null;
}

export type Num = number | null;
export interface DailyRow {
  date: string; status: string; opening_balance: number; trades: number; rejected: number; fills: number; gross_realised: number; charges: number; net_realised: number;
  closing_balance: number; peak_margin: number; peak_deployed: number; peak_exposure: number; min_available: Num; peak_util_pct: number; intraday_low_equity: number; drawdown: number; drawdown_pct: number;
  lot_size: Num; exit_reason: string; reason: string; flags: string;
}
export interface Report {
  generated: { cost_table_version: string; engine_config_hash: string | null; data_fingerprint: string | null; account_hash: string; run_hash: string | null };
  warnings: string[];
  defs: Record<string, string>;
  range: { from: string | null; to: string | null; sessions: number; traded_days: number; excluded_days: { date: string; reason: string }[] };
  cost_rates: { id: string; effective_from: string; stt_sell_pct: number; exch_pct: number; sebi_pct: number; stamp_buy_pct: number; gst_pct: number; verified: Record<string, boolean>; source: string }[];
  capital: Record<string, Num>;
  margin: Record<string, Num | string | { kind: string; span_pct: number; exposure_pct: number; base: string; long_options: string }>;
  pnl: Record<string, Num | Record<string, number>>;
  returns: { absolute: number; pct_initial: Num; pct_peak_deployed: Num; pct_avg_deployed: Num; pct_peak_margin: Num; cagr_pct: Num; cagr_note: string | null; monthly: Record<string, number>; annual: Record<string, number> };
  performance: Record<string, Num | number[]>;
  risk: Record<string, Num | string>;
  reconciliation: { ok: boolean; checks: { name: string; a: number; b: number; ok: boolean }[] };
}
export interface Account {
  config: { initial_capital: number; margin_policy: string };
  report: Report; daily: DailyRow[];
  rejections: { date: string; time: string; leg: number; side: string; strike: number; required: number; available: number; shortfall: number; policy: string }[];
  liquidations: { date: string; time: string; leg: number; side: string; strike: number; mark_px: number }[];
  counts: { trades: number; fills: number };
}
export type LedgerRow = Record<string, string | number | boolean | null>;
export type ExportKind = 'tradebook' | 'ledger' | 'daily' | 'performance';
