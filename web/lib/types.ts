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
