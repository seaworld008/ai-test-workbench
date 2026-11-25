// @ts-check

export const ASYNC_JOB_PROPS = {
  async: { type: 'boolean', description: 'Run asynchronously in Job Runner and return jobId immediately' },
  syncBudgetMs: {
    type: 'integer',
    minimum: 25,
    maximum: 600000,
    description: 'Milliseconds to wait before auto-backgrounding into a pollable jobId',
  },
};

export function makeOutputSchema(dataProperties = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      exitCode: { type: 'integer' },
      tool: { type: 'string' },
      summary: { type: 'string' },
      data: {
        type: 'object',
        properties: dataProperties,
        additionalProperties: true,
      },
      nextRecommendedActions: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'exitCode', 'tool', 'summary', 'data', 'nextRecommendedActions'],
    additionalProperties: true,
  };
}

/**
 * Safely appends `--flag=value` so values beginning with `-` (e.g. `grep: "-foo"`) are never
 * misinterpreted by `parseArgs({ strict: true })` as unknown CLI flags (`M-08`).
 * @param {string[]} arr
 * @param {string} flag
 * @param {unknown} val
 */
export function pushOpt(arr, flag, val) {
  if (val !== undefined && val !== null && val !== '') {
    arr.push(`${flag}=${String(val)}`);
  }
}

/**
 * @param {string[]} arr
 * @param {string} flag
 * @param {unknown} val
 */
export function pushBool(arr, flag, val) {
  if (val) arr.push(flag);
}

/**
 * @typedef {{
 *   ok: boolean,
 *   exitCode: number,
 *   summary: string,
 *   data: Record<string, any>,
 *   nextActions?: string[],
 * }} InMemoryToolOutcome
 */

/**
 * @typedef {{
 *   jobManager: any,
 *   sessionId: string,
 *   target: string | null,
 *   lang: string,
 *   protocolVersion: string,
 * }} ToolExecContext
 */

/**
 * @typedef {{
 *   name: string,
 *   category: 'discovery' | 'verification' | 'stateful',
 *   title: string,
 *   description: string,
 *   annotations: { title: string, readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean },
 *   inputSchema: Record<string, any>,
 *   dataProps: Record<string, any>,
 *   inMemory?: boolean,
 *   skipWorkspaceBoundary?: (args: Record<string, any>) => boolean,
 *   validateExtra?: (args: Record<string, any>) => string[],
 *   execute?: (args: Record<string, any>, execCtx: ToolExecContext) => Promise<InMemoryToolOutcome | null> | InMemoryToolOutcome | null,
 *   resourceSuffix?: string,
 *   isReadOnly?: (args: Record<string, any>) => boolean,
 *   buildCliArgs?: (args: Record<string, any>, target: string | null, lang: string) => string[],
 *   getTimeoutMs?: (args: Record<string, any>) => number | undefined,
 *   nextActions: (ok: boolean, args: Record<string, any>) => string[],
 * }} ToolRegistryEntry
 */

/**
 * @typedef {{
 *   deprecatedTool: string,
 *   targetTool: string,
 *   fixedAction?: string,
 *   fixedArgs?: Record<string, any>,
 *   replacement?: string,
 *   deprecatedSince: string,
 *   removeIn: string,
 * }} DeprecatedToolAliasSpec
 */
