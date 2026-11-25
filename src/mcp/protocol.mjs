// @ts-check
import { detectLang } from '../core/i18n.mjs';
import { exitCodeToOutcome, stripVTControlCharacters } from '../core/outcome.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from '../core/version.mjs';
import { defaultJobManager } from '../jobs.mjs';
import { getMcpToolDefinitions, resolveToolCall, validateToolArguments } from './registry.mjs';
import {
  buildPromptMessages,
  getMcpPromptDefinitions,
  getMcpResourceDefinitions,
  getMcpResourceTemplates,
  readMcpResource,
} from './resources.mjs';
import {
  getEffectiveAllowedRoots,
  parseWorkspaceRoots,
  validateToolPathArgs,
} from './security.mjs';
import { deriveDynamicNextActions, summarizeToolResult } from './summarize.mjs';

export const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const BATCH_CAPABLE_MCP_VERSIONS = new Set(['2025-03-26', '2024-11-05']);
const STRUCTURED_CAPABLE_MCP_VERSIONS = new Set(['2025-11-25', '2025-06-18']);

export const MCP_SERVER_INFO = {
  name: 'ai-test-workbench',
  version: WORKBENCH_VERSION,
};

const VALID_LOG_LEVELS = new Set([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
]);

const MAX_TEXT_ENVELOPE_BYTES = 4096;

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
function buildBoundedTextPayload(structuredContent) {
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
function wrapEnvelope(toolName, ok, exitCode, summary, data, nextActions, options = {}) {
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

/**
 * Executes a registered MCP tool (or deprecated v5 alias) with strict JSON Schema validation,
 * workspace boundary enforcement, declarative in-memory `execute` hooks, and Job Runner dispatch.
 *
 * @param {string} name
 * @param {Record<string, any>} [rawArgs]
 * @param {Record<string, any>} [ctx]
 * @param {Record<string, any>} [meta]
 * @returns {Promise<{ unknownTool: true } | { unknownTool: false, result: Record<string, any> }>}
 */
async function executeMcpTool(name, rawArgs = {}, ctx = {}, meta = {}) {
  const resolved = resolveToolCall(name, rawArgs);
  if (!resolved.found || !resolved.toolEntry) {
    return { unknownTool: true };
  }

  const { toolEntry, effectiveArgs: args, deprecation } = resolved;
  const protocolVersion = ctx.protocolVersion || SUPPORTED_MCP_VERSIONS[0];
  const sessionId = ctx.sessionId || 'default';
  const jobManager = ctx.jobManager || defaultJobManager;
  const target = args.target || ctx.defaultTarget || null;
  const lang = detectLang(args.lang || ctx.defaultLang);

  // 1. Validate arguments against declared inputSchema + cross-field rules (`M-08`)
  const schemaCheck = validateToolArguments(toolEntry, args, ctx.defaultTarget || null);
  if (!schemaCheck.ok) {
    return wrapEnvelope(
      name,
      false,
      2,
      `[Schema Validation Failed] ${schemaCheck.errors.slice(0, 3).join('; ')}`,
      { validationErrors: schemaCheck.errors },
      ['Fix invalid or unknown tool parameters to match inputSchema.'],
      { protocolVersion, deprecation }
    );
  }

  // 2. Enforce strict workspace root intersection & path parameter boundaries (`M-02`, `M-03`)
  const skipBoundary = Boolean(toolEntry.inMemory || toolEntry.skipWorkspaceBoundary?.(args));
  if (!skipBoundary) {
    const allowedRoots = getEffectiveAllowedRoots(ctx);
    const pathCheck = validateToolPathArgs(args, target, allowedRoots);
    if (!pathCheck.ok) {
      return wrapEnvelope(
        name,
        false,
        2,
        pathCheck.error || '[Workspace Boundary Blocked]',
        { blockedTarget: pathCheck.blockedPath || target, allowedRoots },
        ['Pass target/repo/output paths strictly inside an authorized workspace root.'],
        { protocolVersion, deprecation }
      );
    }
  }

  // 3. Declarative in-memory tool execution hook (e.g. aitest_job, aitest_mcp_hub presets)
  if (typeof toolEntry.execute === 'function') {
    const outcome = await toolEntry.execute(args, { jobManager, sessionId, target, lang, protocolVersion });
    if (outcome !== null) {
      return wrapEnvelope(
        name,
        outcome.ok,
        outcome.exitCode,
        outcome.summary,
        outcome.data,
        outcome.nextActions ?? toolEntry.nextActions(outcome.ok, args),
        { target, resourceSuffix: toolEntry.resourceSuffix, protocolVersion, deprecation }
      );
    }
  }

  if (!toolEntry.buildCliArgs) {
    return { unknownTool: true };
  }

  const cliArgs = toolEntry.buildCliArgs(args, target, lang);
  const readOnly = toolEntry.isReadOnly ? toolEntry.isReadOnly(args) : false;

  // Per-request notifier (`M-06`): never mutate shared ctx.sendNotification!
  const notifyFn = typeof meta?.onNotification === 'function' ? meta.onNotification : ctx.sendNotification;
  const progressToken = meta?.progressToken;
  const onProgress =
    progressToken !== undefined && typeof notifyFn === 'function'
      ? (/** @type {{ progress: number, message: string }} */ info) => {
          notifyFn({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: info.progress,
              message: info.message,
            },
          });
        }
      : null;

  const execRes = await jobManager.executeOrBackground({
    toolName: name,
    cliArgs,
    workspaceLockKey: readOnly ? null : target,
    requestId: meta?.requestId ?? null,
    sessionId,
    syncBudgetMs: args.syncBudgetMs,
    forceAsync: Boolean(args.async),
    timeoutMs: toolEntry.getTimeoutMs ? toolEntry.getTimeoutMs(args) : undefined,
    onProgress,
  });

  if (execRes.backgrounded) {
    const js = execRes.job;
    return wrapEnvelope(
      name,
      true,
      0,
      `${name} moved to background job ${js.jobId} (status=running)`,
      { async: true, ...js },
      [
        `Call aitest_job(action="status", jobId="${js.jobId}") or aitest_job(action="result", jobId="${js.jobId}", waitMs=10000) to retrieve results.`,
      ],
      { target, resourceSuffix: toolEntry.resourceSuffix, protocolVersion, deprecation }
    );
  }

  const completed = execRes.job;
  const rawEnvelope = completed.parsedData;
  const isV2Envelope =
    rawEnvelope &&
    typeof rawEnvelope === 'object' &&
    rawEnvelope.schemaVersion === 2 &&
    rawEnvelope.data &&
    typeof rawEnvelope.data === 'object';

  const exitCode = isV2Envelope && typeof rawEnvelope.exitCode === 'number' ? rawEnvelope.exitCode : completed.exitCode ?? 1;
  const ok = exitCode === 0;
  const data = isV2Envelope
    ? { ...rawEnvelope.data }
    : rawEnvelope && typeof rawEnvelope === 'object'
      ? { ...rawEnvelope }
      : completed.stdout
        ? { output: completed.stdout.slice(0, 4000) }
        : {};
  if (!ok && completed.stderr && !data.stderr) {
    data.stderr = completed.stderr.slice(0, 1500);
  }

  const summaryCandidate =
    isV2Envelope && typeof rawEnvelope.summary === 'string' && rawEnvelope.summary.trim()
      ? rawEnvelope.summary
      : summarizeToolResult(name, data, ok, exitCode);

  const dynamicNextActions =
    isV2Envelope && Array.isArray(rawEnvelope.nextRecommendedActions) && rawEnvelope.nextRecommendedActions.length > 0
      ? rawEnvelope.nextRecommendedActions
      : deriveDynamicNextActions(name, ok, exitCode, isV2Envelope ? rawEnvelope : data, args, toolEntry);

  return wrapEnvelope(name, ok, exitCode, summaryCandidate, data, dynamicNextActions, {
    target,
    resourceSuffix: toolEntry.resourceSuffix,
    protocolVersion,
    outcome: isV2Envelope ? rawEnvelope.outcome : undefined,
    recoverable: isV2Envelope ? rawEnvelope.recoverable : undefined,
    blockerKind: isV2Envelope ? rawEnvelope.blockerKind : undefined,
    recoverySteps: isV2Envelope ? rawEnvelope.recoverySteps : undefined,
    deprecation,
  });
}

/**
 * Handles a single JSON-RPC 2.0 MCP message (2024-11-05 .. 2025-11-25) with full error boundary (`M-04`).
 * Never throws unhandled exceptions that could crash the MCP server process!
 *
 * @param {any} msg
 * @param {Record<string, any>} [ctx]
 * @param {{ onNotification?: (frame: any) => void }} [requestMeta]
 */
export async function handleMcpJsonRpcMessage(msg, ctx = {}, requestMeta = {}) {
  try {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return rpcError(msg?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
    }

    const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id') || msg.id === undefined;
    const method = msg.method;

    if (typeof method !== 'string') {
      return rpcError(msg.id ?? null, -32600, 'Missing method');
    }

    const sessionId = ctx.sessionId || 'default';

    if (method === 'notifications/cancelled') {
      const reqId = msg.params?.requestId;
      if (reqId !== undefined && reqId !== null) {
        const jm = ctx.jobManager || defaultJobManager;
        void jm.cancelByRequestId(reqId, sessionId);
      }
      return null;
    }

    if (method === 'notifications/roots/list_changed' || method.startsWith('notifications/')) {
      return null;
    }

    if (isNotification && method !== 'initialize') {
      return null;
    }

    switch (method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_MCP_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_MCP_VERSIONS[0];
        if (ctx) {
          ctx.protocolVersion = protocolVersion;
          ctx.initialized = true;
          if (Array.isArray(msg.params?.roots)) {
            ctx.clientRoots = parseWorkspaceRoots(msg.params.roots.map((/** @type {any} */ r) => r?.uri || r).filter(Boolean));
          }
        }
        return rpcResult(msg.id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: MCP_SERVER_INFO,
          instructions:
            'Prefer aitest_verify_change for one-call fail-closed verification, and aitest_heal(action="begin"|"attempt"|"conclude") for governed triage. Local runs are T0/T1 pre-checks; CI-attested T2 verdicts are required for trustworthy merge green. Never target production, modify protected governance files, or weaken assertions.',
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'logging/setLevel': {
        const level = msg.params?.level;
        if (!VALID_LOG_LEVELS.has(level)) {
          return rpcError(msg.id, -32602, `Invalid logging level "${level}"`);
        }
        if (ctx) ctx.logLevel = level;
        return rpcResult(msg.id, {});
      }
      case 'tools/list':
        return rpcResult(msg.id, { tools: getMcpToolDefinitions(ctx.protocolVersion || SUPPORTED_MCP_VERSIONS[0]) });
      case 'tools/call': {
        const toolName = msg.params?.name;
        if (!toolName || typeof toolName !== 'string') {
          return rpcError(msg.id, -32602, 'Missing or invalid params.name');
        }
        const execOut = await executeMcpTool(toolName, msg.params?.arguments || {}, ctx, {
          requestId: msg.id,
          progressToken: msg.params?._meta?.progressToken,
          onNotification: requestMeta?.onNotification,
        });
        if (execOut.unknownTool) {
          return rpcError(msg.id, -32602, `Unknown tool: ${toolName}`);
        }
        return rpcResult(msg.id, execOut.result);
      }
      case 'resources/list':
        return rpcResult(msg.id, { resources: getMcpResourceDefinitions(ctx.defaultTarget) });
      case 'resources/templates/list':
        return rpcResult(msg.id, { resourceTemplates: getMcpResourceTemplates() });
      case 'resources/read': {
        const uri = msg.params?.uri;
        if (!uri || typeof uri !== 'string') return rpcError(msg.id, -32602, 'Missing params.uri');
        const data = readMcpResource(uri, ctx);
        if (data?.invalidUri) {
          return rpcError(msg.id, -32602, data.error || `Invalid resource URI: ${uri}`);
        }
        if (data?.blockedByBoundary) {
          return rpcError(msg.id, -32602, `Resource target outside allowed workspace roots: ${uri}`);
        }
        if (!data) return rpcError(msg.id, -32002, `Resource not found: ${uri}`);
        return rpcResult(msg.id, data);
      }
      case 'prompts/list':
        return rpcResult(msg.id, { prompts: getMcpPromptDefinitions() });
      case 'prompts/get': {
        const promptName = msg.params?.name;
        if (!promptName || typeof promptName !== 'string') return rpcError(msg.id, -32602, 'Missing params.name');
        const prompt = buildPromptMessages(promptName, msg.params?.arguments || {});
        if (!prompt) return rpcError(msg.id, -32602, `Prompt not found: ${promptName}`);
        return rpcResult(msg.id, prompt);
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof URIError) {
      return rpcError(msg?.id ?? null, -32602, `Invalid URI encoding: ${err.message}`);
    }
    return rpcError(
      msg?.id ?? null,
      -32603,
      `Internal MCP error: ${err instanceof Error && err.message ? err.message : String(err)}`
    );
  }
}
