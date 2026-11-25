// @ts-check
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/** @type {import('./shared.mjs').ToolRegistryEntry[]} */
export const STATEFUL_TOOLS = [
  {
    name: 'aitest_heal',
    category: 'stateful',
    title: 'Stateful A/B/C/D Heal Governance State Machine (begin | attempt | conclude | discard)',
    description:
      'Use when repairing failing Class-A specs or filing Class-C product defects under governance. Executes T1-signed state transitions: begin (locks non-A tests), attempt (AST-guarded <=3 retries per appCodeTreeHash), conclude (closes/files defect ticket), or discard.',
    annotations: {
      title: 'Manage Governed A/B/C/D Heal Session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['begin', 'attempt', 'conclude', 'discard'],
          description: 'Heal state machine transition: begin | attempt | conclude | discard',
        },
        target: { type: 'string', description: 'Target repository or QA directory' },
        testId: { type: 'string', description: 'Optional testId or title substring (for action="begin")' },
        results: { type: 'string', description: 'Optional results.json path (for action="begin")' },
        sessionId: { type: 'string', description: 'Heal session ID (required for action="attempt", "conclude", or "discard")' },
        skipRun: { type: 'boolean', description: 'Validate semantic gates without running Playwright (for action="attempt")' },
        outcome: {
          type: 'string',
          enum: ['verified', 'reported', 'escalated', 'clarification-needed'],
          description: 'Final session outcome (for action="conclude")',
        },
        summary: { type: 'string', description: 'Optional summary note (for action="conclude" or "discard")' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
        ...ASYNC_JOB_PROPS,
      },
      required: ['action', 'target'],
      additionalProperties: false,
    },
    dataProps: {
      session: { type: 'object' },
      sessionId: { type: 'string' },
      state: { type: 'string' },
      attemptsUsed: { type: 'integer' },
      outcome: { type: 'string' },
      defectTicketPath: { type: ['string', 'null'] },
    },
    validateExtra: (args) => {
      if ((args.action === 'attempt' || args.action === 'conclude' || args.action === 'discard') && !args.sessionId) {
        return [`Missing required property "sessionId" for aitest_heal(action="${args.action}").`];
      }
      return [];
    },
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const action = String(args.action || 'begin');
      const a = ['heal', action, '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      if (action === 'begin') {
        pushOpt(a, '--test-id', args.testId);
        pushOpt(a, '--results', args.results);
      } else if (action === 'attempt') {
        pushOpt(a, '--session-id', args.sessionId);
        pushBool(a, '--skip-run', args.skipRun);
      } else if (action === 'conclude') {
        pushOpt(a, '--session-id', args.sessionId);
        pushOpt(a, '--outcome', args.outcome);
        pushOpt(a, '--summary', args.summary);
      } else if (action === 'discard') {
        pushOpt(a, '--session-id', args.sessionId);
        pushOpt(a, '--summary', args.summary);
      }
      return a;
    },
    nextActions: (ok, args) => {
      if (args.action === 'begin') {
        return [
          'If categoryCode=="A", edit only the semantic locator and call aitest_heal(action="attempt"); otherwise call aitest_heal(action="conclude").',
        ];
      }
      if (args.action === 'attempt') {
        return ok
          ? ['Call aitest_heal(action="conclude", outcome="verified") to close the repair session.']
          : ['Inspect semantic gate violations or remainingAttempts; escalate via aitest_heal(action="conclude") if exhausted.'];
      }
      return ['Attach any generated reports/defects/*.md ticket to your issue tracker.'];
    },
  },
  {
    name: 'aitest_job',
    category: 'stateful',
    title: 'Inspect, Await, or Cancel Async Background MCP Jobs (status | result | cancel)',
    description:
      'Use when managing backgrounded async MCP jobs owned by this session: action="status" polls progress, action="result" awaits/retrieves final structured output, and action="cancel" terminates the job and its OS process tree.',
    annotations: {
      title: 'Control Async Background Jobs',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'result', 'cancel'],
          description: 'Job control action: status | result | cancel',
        },
        jobId: { type: 'string', description: 'Background job ID returned by an async tool call' },
        waitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 60000,
          description: 'Optional milliseconds to wait before returning (for action="result")',
        },
      },
      required: ['action', 'jobId'],
      additionalProperties: false,
    },
    dataProps: {
      jobId: { type: 'string' },
      status: { type: 'string' },
      cancelled: { type: 'boolean' },
      data: { type: 'object' },
    },
    inMemory: true,
    isReadOnly: (args) => args.action !== 'cancel',
    execute: async (args, { jobManager, sessionId }) => {
      const action = String(args.action);
      if (action === 'status') {
        const status = jobManager.getPublicStatus(args.jobId, sessionId);
        if (!status) {
          return { ok: false, exitCode: 1, summary: `Unknown jobId "${args.jobId}"`, data: { jobId: args.jobId }, nextActions: [] };
        }
        return {
          ok: true,
          exitCode: 0,
          summary: `Job ${status.jobId} is ${status.status}`,
          data: status,
          nextActions:
            status.status === 'running'
              ? [`Call aitest_job(action="result", jobId="${status.jobId}", waitMs=5000) or aitest_job(action="cancel", jobId="${status.jobId}").`]
              : [`Call aitest_job(action="result", jobId="${status.jobId}") to read full output.`],
        };
      }

      if (action === 'result') {
        const waited = await jobManager.waitForResult(args.jobId, Number(args.waitMs || 0), sessionId);
        if (!waited) {
          return { ok: false, exitCode: 1, summary: `Unknown jobId "${args.jobId}"`, data: { jobId: args.jobId }, nextActions: [] };
        }
        const stillRunning = waited.status === 'running';
        const jobOk = stillRunning || waited.status === 'succeeded';
        return {
          ok: jobOk,
          exitCode: stillRunning ? 0 : waited.exitCode ?? 1,
          summary: stillRunning
            ? `Job ${waited.jobId} is still running (${waited.lastMessage})`
            : `Job ${waited.jobId} finished with status=${waited.status} (exitCode=${waited.exitCode})`,
          data: waited,
          nextActions: stillRunning ? [`Poll aitest_job(action="result", jobId="${waited.jobId}", waitMs=5000) again.`] : [],
        };
      }

      if (action === 'cancel') {
        const cancelRes = await jobManager.cancelByJobIdAndWait(args.jobId, sessionId);
        if (!cancelRes.found) {
          return { ok: false, exitCode: 1, summary: `Unknown jobId "${args.jobId}"`, data: cancelRes, nextActions: [] };
        }
        return {
          ok: true,
          exitCode: 0,
          summary: cancelRes.cancelled
            ? `Cancelled job ${args.jobId} and terminated process tree`
            : `Job ${args.jobId} already ${cancelRes.status}`,
          data: cancelRes,
          nextActions: [],
        };
      }

      return { ok: false, exitCode: 1, summary: `Unsupported job action "${action}"`, data: { action }, nextActions: [] };
    },
    nextActions: () => [],
  },
];

/**
 * Deprecated v5.x MCP tool aliases preserved through v6.x for backward-compatible `tools/call`
 * forwarding (removed from `tools/list`; emit `_deprecation` metadata and summary warning).
 * @type {Record<string, import('./shared.mjs').DeprecatedToolAliasSpec>}
 */
export const DEPRECATED_TOOL_ALIASES = {
  aitest_heal_begin: {
    deprecatedTool: 'aitest_heal_begin',
    targetTool: 'aitest_heal',
    fixedAction: 'begin',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_heal_attempt: {
    deprecatedTool: 'aitest_heal_attempt',
    targetTool: 'aitest_heal',
    fixedAction: 'attempt',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_heal_conclude: {
    deprecatedTool: 'aitest_heal_conclude',
    targetTool: 'aitest_heal',
    fixedAction: 'conclude',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_job_status: {
    deprecatedTool: 'aitest_job_status',
    targetTool: 'aitest_job',
    fixedAction: 'status',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_job_result: {
    deprecatedTool: 'aitest_job_result',
    targetTool: 'aitest_job',
    fixedAction: 'result',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_job_cancel: {
    deprecatedTool: 'aitest_job_cancel',
    targetTool: 'aitest_job',
    fixedAction: 'cancel',
    deprecatedSince: '6.0.0',
    removeIn: '7.0.0',
  },
  aitest_flaky_report: {
    deprecatedTool: 'aitest_flaky_report',
    targetTool: 'aitest_report',
    fixedArgs: { view: 'flaky' },
    replacement: 'aitest_report(view="flaky")',
    deprecatedSince: '6.2.0',
    removeIn: '7.0.0',
  },
  aitest_trace_matrix: {
    deprecatedTool: 'aitest_trace_matrix',
    targetTool: 'aitest_report',
    fixedArgs: { view: 'traceability' },
    replacement: 'aitest_report(view="traceability")',
    deprecatedSince: '6.2.0',
    removeIn: '7.0.0',
  },
};
