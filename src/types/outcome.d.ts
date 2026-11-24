/**
 * Unified tri-state verification outcome across all gates and verifiers.
 * - `pass`: all required evidence verified green
 * - `fail`: deterministic verification failure or test/gate red
 * - `blocked`: missing prerequisites, untrusted/tampered artifacts, fail-closed security block, or unavailable compilers
 */
export type GateOutcome = 'pass' | 'fail' | 'blocked';

export type ExitCode = 0 | 1 | 2;

export interface CommandResult<T = Record<string, unknown>> {
  ok: boolean;
  exitCode: ExitCode;
  outcome?: GateOutcome;
  tool: string;
  summary: string;
  data: T;
  nextRecommendedActions: string[];
}
