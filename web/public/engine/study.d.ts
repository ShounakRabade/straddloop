// Types for study.js as the page imports it (lib/optimiser/controller.ts). The shapes are documented in study.js.
declare const Study: {
  VERSION: string;
  studyPlan(dates: string[], o?: Record<string, unknown>): Record<string, any>;
  summarise(days: unknown[], plan: Record<string, any>, regimes: (string | null)[] | null, o?: Record<string, unknown>): Record<string, any>;
  selectStudy(cands: { idx: number; summary: Record<string, any> }[], plan: Record<string, any>, o?: Record<string, unknown>): Record<string, any> & {
    scores: { train: number[]; validation: number[]; in_sample: number[] }; finalists: number[]; ranking: number[]; leader: number | null; best_oos: number | null;
  };
  robustScore(summary: Record<string, any>, neighbours: Record<string, any>[] | null, stressed: Record<string, any> | null): { components: Record<string, number | null>; score: number | null; measured: number };
  mostRobust<T extends { idx: number; is_score: number; robust: { score: number | null } }>(rows: T[]): T | null;
};
export = Study;
