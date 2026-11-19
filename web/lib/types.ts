export type StrategySlug = 'straddle' | 'orb' | 'fourleg';
export type Focus = 'index' | 'stocks' | 'exploring';
export type Params = Record<string, string | number | boolean>;

export interface RunResult {
  strategy: StrategySlug;
  unit: 'day' | 'trade' | 'month';
  policy?: 'A' | 'B';
  sessions: number;
  traded: number;
  net: number;
  gross: number;
  costs: number;
  avg: number;
  ci: [number, number];
  t: number;
  winRate: number;
  maxDD: number;
  worst: number;
  best: number;
  profitFactor: number | null;
  exits: Record<string, number>;
  curve: { d: string; v: number; p: number }[];
  extra: [string, string | number][];
  /** Present when the run used real day files instead of the synthetic model. */
  data?: { source: 'dhan'; from: string; to: string; days: number; lot_sizes: number[]; lot_source: string; expiry_source: string; flags: string[] };
}

export interface ReplayLeg { side: string; strike: number; kind: string; entry_t: number; entry_px: number; exit_t: number | null; exit_px: number | null; exit_reason: string | null; stop: number | null; net: number }
export interface Replay {
  strategy: 'straddle' | 'orb'; date: string; status: string; reason: string | null; net?: number; gross?: number; costs?: number;
  exit_reason?: string; expiry?: string; lot_size?: number; qty?: number; flags: string[];
  or_high: number | null; or_low: number | null; decision_t?: number | null;
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  mtm: { t: number; v: number }[]; legs: ReplayLeg[]; events: { t: number; kind: string; text: string }[];
}

export interface RunSummary {
  net: number; traded: number; winRate: number; avg: number; ci: [number, number]; maxDD: number; costs: number;
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
