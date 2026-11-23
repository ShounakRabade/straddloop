// Types for the parts of legs.js the Lab page imports directly (spec checks as you edit). The worker runs the same
// file for backtests, so the page and the run apply one set of rules. Contract: docs/ENGINE_INTERFACES.md §1.
import type { DatasetCaps, Gate, StrategySpec } from '../../lib/legs/types';

declare const Legs: {
  validate(spec: unknown, caps?: DatasetCaps): { ok: boolean; errors: Gate[]; warnings: Gate[]; spec: StrategySpec };
  normalize(spec: unknown): StrategySpec;
  LEG_LEVELS: string[];
  POS_LEVELS: string[];
  MAX_ENTRIES: number;
};
export = Legs;
