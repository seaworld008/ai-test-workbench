// @ts-check
import { detectLang } from '../i18n.mjs';
import { defaultJobManager } from '../jobs.mjs';
import { MCP_PILLARS, MCP_PRESETS, MCP_PROFILES } from '../mcp-hub.mjs';
import { WORKBENCH_VERSION } from '../version.mjs';
import { TOOL_BY_NAME, getMcpToolDefinitions, validateToolArguments } from './registry.mjs';
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

export function rpcError(id, code, message, data) {
  /** @type {Record<string, any>} */
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Builds a bounded JSON text block (<= 4KB) that preserves actionable `data` fields for text-only
 * MCP clients while remaining token-efficient (`M-10`, `M-11`).
 */
function buildBoundedTextPayload(structuredContent) {
  const fullJson = JSON.stringify(structuredContent);
  if (fullJson.length <= MAX_TEXT_ENVELOPE_BYTES) {
    return fullJson;
  }

  // Keep top-level envelope + compact summary of key `data` fields
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

function wrapEnvelope(toolName, ok, exitCode, summary, data, nextActions, options = {}) {
  const { target = null, resourceSuffix = null, protocolVersion = '2025-11-25' } = options;
  const structuredContent = {
    ok,
    exitCode,
    tool: toolName,
    summary: String(summary || '').slice(0, 300),
    data: data || {},
    nextRecommendedActions: nextActions || [],
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
  // Always attach structuredContent for modern MCP versions (and default 2025-11-25)
  if (supportsStructured || protocolVersion === '2025-03-26') {
    result.structuredContent = structuredContent;
  }

  return {
    unknownTool: false,
    result,
  };
}

/**
 * Executes a registered MCP tool with strict JSON Schema validation, workspace boundary checks,
 * session-scoped job management, and per-request progress notification routing (`M-01..M-15`).
 *
 * @param {string} name
 * @param {Record<string, any>} [rawArgs]
 * @param {Record<string, any>} [ctx]
 * @param {Record<string, any>} [meta]
 */
async function executeMcpTool(name, rawArgs = {}, ctx = {}, meta = {}) {
  const toolEntry = TOOL_BY_NAME.get(name);
  if (!toolEntry) {
    return { unknownTool: true };
  }

  /** @type {Record<string, any>} */
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const protocolVersion = ctx.protocolVersion || SUPPORTED_MCP_VERSIONS[0];
  const sessionId = ctx.sessionId || 'default';
  const jobManager = ctx.jobManager || defaultJobManager;
  const target = args.target || ctx.defaultTarget || null;
  const lang = detectLang(args.lang || ctx.defaultLang);

  // 1. Validate arguments against declared inputSchema (`M-08`)
  const schemaCheck = validateToolArguments(toolEntry, args, ctx.defaultTarget || null);
  if (!schemaCheck.ok) {
    return wrapEnvelope(
      name,
      false,
      2,
      `[Schema Validation Failed] ${schemaCheck.errors.slice(0, 3).join('; ')}`,
      { validationErrors: schemaCheck.errors },
      ['Fix invalid or unknown tool parameters to match inputSchema.'],
      { protocolVersion }
    );
  }

  // 2. Enforce strict workspace root intersection & path parameter boundaries (`M-02`, `M-03`)
  if (!toolEntry.inMemory && !(name === 'aitest_mcp_hub' && args.action === 'presets')) {
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
        { protocolVersion }
      );
    }
  }

  // 3. Fast in-memory session-isolated Job control tools (`M-05`)
  if (name === 'aitest_job_status') {
    const status = jobManager.getPublicStatus(args.jobId, sessionId);
    if (!status) {
      return wrapEnvelope(name, false, 1, `Unknown jobId "${args.jobId}"`, { jobId: args.jobId }, [], { protocolVersion });
    }
    return wrapEnvelope(
      name,
      true,
      0,
      `Job ${status.jobId} is ${status.status}`,
      status,
      status.status === 'running'
        ? [`Call aitest_job_result(jobId="${status.jobId}", waitMs=5000) or aitest_job_cancel.`]
        : [`Call aitest_job_result(jobId="${status.jobId}") to read full output.`],
      { protocolVersion }
    );
  }

  if (name === 'aitest_job_result') {
    const waited = await jobManager.waitForResult(args.jobId, Number(args.waitMs || 0), sessionId);
    if (!waited) {
      return wrapEnvelope(name, false, 1, `Unknown jobId "${args.jobId}"`, { jobId: args.jobId }, [], { protocolVersion });
    }
    const stillRunning = waited.status === 'running';
    const jobOk = stillRunning || waited.status === 'succeeded';
    return wrapEnvelope(
      name,
      jobOk,
      stillRunning ? 0 : waited.exitCode ?? 1,
      stillRunning
        ? `Job ${waited.jobId} is still running (${waited.lastMessage})`
        : `Job ${waited.jobId} finished with status=${waited.status} (exitCode=${waited.exitCode})`,
      waited,
      stillRunning ? [`Poll aitest_job_result(jobId="${waited.jobId}", waitMs=5000) again.`] : [],
      { protocolVersion }
    );
  }

  if (name === 'aitest_job_cancel') {
    const cancelRes = jobManager.cancelByJobId(args.jobId, sessionId);
    if (!cancelRes.found) {
      return wrapEnvelope(name, false, 1, `Unknown jobId "${args.jobId}"`, cancelRes, [], { protocolVersion });
    }
    return wrapEnvelope(
      name,
      true,
      0,
      cancelRes.cancelled ? `Cancelled job ${args.jobId} and terminated process tree` : `Job ${args.jobId} already ${cancelRes.status}`,
      cancelRes,
      [],
      { protocolVersion }
    );
  }

  // 4. Fast in-memory MCP presets lookup
  if (name === 'aitest_mcp_hub' && args.action === 'presets') {
    const data = {
      pillars: MCP_PILLARS,
      profiles: MCP_PROFILES,
      presets: Object.fromEntries(
        Object.entries(MCP_PRESETS).map(([k, v]) => [
          k,
          {
            pillar: v.pillar,
            riskLevel: v.riskLevel,
            pinnedVersion: v.pinnedVersion,
            readonly: v.readonly,
            command: v.command,
            args: v.args,
            description: v.description,
          },
        ])
      ),
    };
    return wrapEnvelope(name, true, 0, 'Listed 7-pillar pinned MCP presets', data, toolEntry.nextActions(true, args), {
      protocolVersion,
    });
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
      ? (info) => {
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
        `Call aitest_job_status(jobId="${js.jobId}") or aitest_job_result(jobId="${js.jobId}", waitMs=10000) to retrieve results.`,
      ],
      { target, resourceSuffix: toolEntry.resourceSuffix, protocolVersion }
    );
  }

  const completed = execRes.job;
  const exitCode = completed.exitCode ?? 1;
  const ok = exitCode === 0;
  const data =
    completed.parsedData && typeof completed.parsedData === 'object'
      ? { ...completed.parsedData }
      : completed.stdout
        ? { output: completed.stdout.slice(0, 4000) }
        : {};
  // Omit stderr on success (`M-11`)
  if (!ok && completed.stderr) {
    data.stderr = completed.stderr.slice(0, 1500);
  }

  const summaryCandidate =
    data.verdict
      ? `Verdict=${String(data.verdict).toUpperCase()} (${data.trustTier || 'T0'}, runId=${data.runId || 'none'}, scope=${data.acceptanceScope})`
      : data.error ||
        (completed.stderr || completed.stdout || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('{') && !l.startsWith('}') && !l.startsWith('"')) ||
        (ok ? `${name} succeeded (exitCode=0)` : `${name} failed (exitCode=${exitCode})`);

  return wrapEnvelope(name, ok, exitCode, summaryCandidate, data, toolEntry.nextActions(ok, args), {
    target,
    resourceSuffix: toolEntry.resourceSuffix,
    protocolVersion,
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

    // Per JSON-RPC 2.0 spec: notifications omit `id` (`!('id' in msg)` or `msg.id === undefined`).
    // Explicit `id: null` is NOT a notification (`M-15`).
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
        jm.cancelByRequestId(reqId, sessionId);
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
          // Client roots can ONLY narrow server roots via intersection in security.mjs (`M-02`)!
          if (Array.isArray(msg.params?.roots)) {
            ctx.clientRoots = parseWorkspaceRoots(msg.params.roots.map((r) => r?.uri || r).filter(Boolean));
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
            'Prefer aitest_verify_change for one-call fail-closed verification, and aitest_heal_begin -> aitest_heal_attempt -> aitest_heal_conclude for governed triage. Local runs are T0/T1 pre-checks; CI-attested T2 verdicts are required for trustworthy merge green. Never target production, modify protected governance files, or weaken assertions.',
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
    return rpcError(msg?.id ?? null, -32603, `Internal MCP error: ${err?.message || String(err)}`);
  }
}
