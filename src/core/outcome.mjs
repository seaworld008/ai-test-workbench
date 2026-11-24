// @ts-check
/**
 * @import { CommandResult, ExitCode, GateOutcome } from '../types/outcome.d.ts'
 */

/**
 * Maps a tri-state verification outcome to its canonical process exit code.
 * - `pass`    -> `0`
 * - `fail`    -> `1`
 * - `blocked` -> `2` (fail-closed security / missing prerequisite / untrusted state)
 * @param {GateOutcome | 'skipped' | string | null | undefined} outcome
 * @returns {ExitCode}
 */
export function outcomeToExitCode(outcome) {
  if (outcome === 'blocked') return 2;
  if (outcome === 'pass') return 0;
  return 1;
}

/**
 * Combines multiple gate statuses using the fail-closed outcome lattice:
 * any `'blocked'` dominates -> `'blocked'`; else any `'fail'` -> `'fail'`; else `'pass'`.
 * @param {ReadonlyArray<GateOutcome | 'skipped' | null | undefined>} statuses
 * @param {boolean} [hasErrors]
 * @returns {GateOutcome}
 */
export function mergeOutcomes(statuses, hasErrors = false) {
  if (statuses.some((s) => s === 'blocked')) return 'blocked';
  if (hasErrors || statuses.some((s) => s === 'fail')) return 'fail';
  return 'pass';
}

/**
 * Returns whether the given environment dictionary indicates a CI execution environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isCiEnvironment(env = process.env) {
  return (
    env.CI === 'true' ||
    env.CI === '1' ||
    env.GITHUB_ACTIONS === 'true' ||
    env.GITLAB_CI === 'true' ||
    env.BUILDKITE === 'true'
  );
}

/**
 * Constructs a standardized CLI/MCP command result envelope.
 * @template T
 * @param {{
 *   tool: string;
 *   outcome?: GateOutcome;
 *   ok?: boolean;
 *   exitCode?: ExitCode;
 *   summary: string;
 *   data: T;
 *   nextRecommendedActions?: string[];
 * }} input
 * @returns {CommandResult<T>}
 */
export function buildCommandResult(input) {
  const outcome = input.outcome;
  const exitCode =
    input.exitCode !== undefined
      ? input.exitCode
      : outcome !== undefined
        ? outcomeToExitCode(outcome)
        : input.ok
          ? 0
          : 1;
  const ok = input.ok !== undefined ? input.ok : exitCode === 0;
  return {
    ok,
    exitCode,
    ...(outcome ? { outcome } : {}),
    tool: input.tool,
    summary: input.summary,
    data: input.data,
    nextRecommendedActions: input.nextRecommendedActions || [],
  };
}
