/**
 * Unified tri-state verification outcome across all gates and verifiers.
 * - `pass`: all required evidence verified green
 * - `fail`: deterministic verification failure or test/gate red
 * - `blocked`: missing prerequisites, untrusted/tampered artifacts, fail-closed security block, or unavailable compilers
 */
export type GateOutcome = 'pass' | 'fail' | 'blocked';

export type CommandOutcome = GateOutcome | 'usage';

export type ExitCode = 0 | 1 | 2 | 64;

export interface CommandResult<T = Record<string, unknown>> {
  schemaVersion: number;
  ok: boolean;
  exitCode: ExitCode;
  outcome: CommandOutcome;
  tool: string;
  summary: string;
  recoverable: boolean;
  blockerKind: string | null;
  recoverySteps: string[];
  data: T;
  nextRecommendedActions: string[];
}
