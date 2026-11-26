// @ts-check
import { exitCodeToOutcome, stripVTControlCharacters } from '../core/outcome.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { summarizeToolResult } from './summarize.mjs';

export const MAX_TEXT_ENVELOPE_BYTES = 4096;
export const STRUCTURED_CAPABLE_MCP_VERSIONS = new Set(['2025-11-25', '2025-06-18']);

/** @param {string | number | null} id @param {number} code @param {string} message @param {unknown} [data] */
export function rpcError(id, code, message, data) {
  /** @type {Record<string, any>} */
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

/** @param {string | number | null} id @param {unknown} result */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Builds a bounded JSON text block (<= 4KB) that preserves actionable `data` fields for text-only
 * MCP clients while remaining token-efficient (`M-10`, `M-11`).
 * @param {{ ok: boolean, exitCode: number, tool: string, summary: string, data: Record<string, any>, nextRecommendedActions: string[] }} structuredContent
 */
export function buildBoundedTextPayload(structuredContent) {
  const fullJson = JSON.stringify(structuredContent);
  if (fullJson.length <= MAX_TEXT_ENVELOPE_BYTES) {
    return fullJson;
  }

  const rawData = structuredContent.data || {};
  /** @type {Record<string, any>} */
  const compactData = {};
  for (const key of [
    'verdict',
    'trustTier',
    'outcome',
    'runId',
    'jobId',
    'status',
    'sessionId',
    'session',
    'acceptanceScope',
    'counts',
    'gates',
    'failureCount',
    'error',
    'budgetPassed',
    'mode',
    'async',
    '_deprecation',
  ]) {
    if (rawData[key] !== undefined) compactData[key] = rawData[key];
  }
  if (Array.isArray(rawData.errors) && rawData.errors.length > 0) {
    compactData.errors = rawData.errors.slice(0, 5);
  }
  if (Array.isArray(rawData.gateErrors) && rawData.gateErrors.length > 0) {
    compactData.gateErrors = rawData.gateErrors.slice(0, 5);
  }
  compactData._truncated = true;

  const trimmed = JSON.stringify({
    ok: structuredContent.ok,
    exitCode: structuredContent.exitCode,
    tool: structuredContent.tool,
    summary: structuredContent.summary,
    data: compactData,
    nextRecommendedActions: structuredContent.nextRecommendedActions,
  });
  return trimmed.slice(0, MAX_TEXT_ENVELOPE_BYTES);
}

/**
 * @param {string} toolName @param {boolean} ok @param {number} exitCode @param {string} summary
 * @param {Record<string, any>} data @param {string[]} nextActions
 * @param {{
 *   target?: string | null,
 *   resourceSuffix?: string | null,
 *   protocolVersion?: string,
 *   outcome?: string,
 *   recoverable?: boolean,
 *   blockerKind?: string | null,
 *   recoverySteps?: string[],
 *   deprecation?: { deprecatedTool: string, replacement: string, deprecatedSince: string, removeIn: string } | null
 * }} [options]
 * @returns {{ unknownTool: false, result: Record<string, any> }}
 */
export function wrapEnvelope(toolName, ok, exitCode, summary, data, nextActions, options = {}) {
  const { target = null, resourceSuffix = null, protocolVersion = '2025-11-25', deprecation = null } = options;
  const finalData = data && typeof data === 'object' ? { ...data } : {};
  let finalSummary = stripVTControlCharacters(summary || '').trim() || summarizeToolResult(toolName, finalData, ok, exitCode);
  const finalNextActions = Array.isArray(nextActions) ? [...nextActions] : [];

  if (deprecation) {
    finalData._deprecation = deprecation;
    finalSummary = `[DEPRECATED ${deprecation.deprecatedTool} -> ${deprecation.replacement}] ${finalSummary}`;
    finalNextActions.push(
      `Migrate from deprecated "${deprecation.deprecatedTool}" to "${deprecation.replacement}" before v${deprecation.removeIn}.`
    );
  }

  const outcome = options.outcome || exitCodeToOutcome(/** @type {any} */ (exitCode));
  const structuredContent = {
    schemaVersion: SCHEMA_VERSIONS.resultEnvelope,
    ok,
    exitCode,
    outcome,
    tool: toolName,
    summary: finalSummary.slice(0, 300),
    recoverable: options.recoverable ?? (!ok && outcome !== 'pass'),
    blockerKind: options.blockerKind ?? (exitCode === 2 ? 'PREREQUISITE_OR_GATE_BLOCK' : null),
    recoverySteps: Array.isArray(options.recoverySteps) ? options.recoverySteps : [],
    data: finalData,
    nextRecommendedActions: finalNextActions,
  };

  /** @type {Array<Record<string, any>>} */
  const contentItems = [
    {
      type: 'text',
      text: buildBoundedTextPayload(structuredContent),
    },
  ];

  const supportsStructured = STRUCTURED_CAPABLE_MCP_VERSIONS.has(protocolVersion);
  if (supportsStructured && target && resourceSuffix) {
    const encoded = encodeURIComponent(String(target));
    contentItems.push({
      type: 'resource_link',
      uri: `aitest://project/${encoded}/${resourceSuffix}`,
      name: `${toolName} detailed artifact`,
      mimeType: 'text/markdown',
    });
  }

  /** @type {Record<string, any>} */
  const result = {
    content: contentItems,
    isError: !ok,
  };
  if (supportsStructured || protocolVersion === '2025-03-26') {
    result.structuredContent = structuredContent;
  }

  return {
    unknownTool: false,
    result,
  };
}
