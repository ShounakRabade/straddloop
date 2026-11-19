/**
 * Per-session outcomes for the Lab: `RunResult.days` (ENGINE_INTERFACES §2), or for the four-leg model (which
 * has no day outcomes) nothing. Labels only; nothing is computed here.
 */
import type { DayOutcome, RunResult } from './types';

export const outcomesOf = (r: RunResult): DayOutcome[] => r.days ?? [];

export const OUTCOME_LABEL: Record<DayOutcome['status'], string> = {
  traded: 'Traded', holding: 'Holding', no_entry: 'No entry', filtered: 'Filtered', excluded: 'Excluded (data)', rejected: 'Rejected (margin)',
};
export const outcomeLabel = (s: string) => OUTCOME_LABEL[s as DayOutcome['status']] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
