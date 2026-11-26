// @ts-check
import { runAuditCommand } from '../audit.mjs';
import { runDiagnoseCommand } from '../diagnose.mjs';
import { runFlakyCommand } from '../flaky.mjs';
import { runGovernanceCommand } from '../governance.mjs';
import { runHealCommand } from '../heal.mjs';
import { runImpactCommand } from '../impact.mjs';
import { runPerfCommand } from '../perf.mjs';
import { runReportCommand } from '../report.mjs';
import { runSuiteCommand } from '../runner.mjs';
import { runTraceMatrixCommand } from '../traceability.mjs';
import { runAttestCommand } from '../trust.mjs';
import { runVerifyChangeCommand } from '../verdict.mjs';

import { PARITY_CLI_COMMANDS } from './commands-parity.mjs';
import { WORKSPACE_CLI_COMMANDS } from './commands-workspace.mjs';
import { BOOL, STR, TARGET_OPTS, makeCommon } from './opts.mjs';

/**
 * Per-command declarative CLI registry (`v6.2`).
 * Each command declares ONLY the flags it actually consumes so unrelated flags fail fast (exit 64).
 * @type {Record<string, {
 *   options: Record<string, { type: 'string' | 'boolean', short?: string }>,
 *   requireTarget?: boolean,
 *   deprecatedAliases?: Record<string, { replacement: string, deprecatedSince: string, removeIn: string }>,
 *   run: (v: Record<string, any>, positionals: string[], lang: 'zh' | 'en', tokens?: Array<Record<string, any>>) => Promise<number>,
 * }>}
 */
export const CLI_COMMANDS = {
  ...WORKSPACE_CLI_COMMANDS,
  ...PARITY_CLI_COMMANDS,
  perf: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      'base-url': STR,
      routes: STR,
      endpoint: STR,
      'sse-endpoint': STR,
      concurrency: STR,
      iterations: STR,
      samples: STR,
      mode: STR,
      throttle: BOOL,
      'check-regression': BOOL,
      'enforce-budget': BOOL,
    },
    run: (v, _pos, lang) =>
      runPerfCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        routes: v.routes,
        endpoint: v.endpoint,
        sseEndpoint: v['sse-endpoint'],
        concurrency: v.concurrency ? Number(v.concurrency) : undefined,
        iterations: v.iterations ? Number(v.iterations) : undefined,
        samples: v.samples ? Number(v.samples) : undefined,
        mode: v.mode,
        throttle: Boolean(v.throttle),
        checkRegression: Boolean(v['check-regression']),
        enforceBudget: Boolean(v['enforce-budget']),
      }),
  },
  run: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      suite: STR,
      'base-url': STR,
      'allow-mutation': BOOL,
      workers: STR,
      retries: STR,
      grep: STR,
      files: STR,
      line: STR,
      base: STR,
      audit: BOOL,
      'last-failed': BOOL,
      'fail-on-flaky': BOOL,
      headed: BOOL,
      ui: BOOL,
      debug: BOOL,
      verbosity: STR,
    },
    run: (v, _pos, lang) =>
      runSuiteCommand({
        ...makeCommon(v, lang),
        suite: v.suite,
        baseUrl: v['base-url'],
        allowMutation: Boolean(v['allow-mutation']),
        workers: v.workers !== undefined ? Number(v.workers) : undefined,
        retries: v.retries !== undefined ? Number(v.retries) : undefined,
        grep: v.grep,
        files: v.files,
        line: v.line !== undefined ? Number(v.line) : undefined,
        base: v.base,
        audit: Boolean(v.audit),
        lastFailed: Boolean(v['last-failed']),
        failOnFlaky: Boolean(v['fail-on-flaky']),
        headed: Boolean(v.headed),
        ui: Boolean(v.ui),
        debug: Boolean(v.debug),
        verbosity: v.verbosity,
      }),
  },
  impact: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      base: STR,
      files: STR,
    },
    run: (v, _pos, lang) =>
      runImpactCommand({
        ...makeCommon(v, lang),
        base: v.base,
        files: v.files,
      }),
  },
  audit: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      results: STR,
      waivers: STR,
      'expected-run-id': STR,
      'check-specs': BOOL,
      'require-e2e': BOOL,
      'static-only': BOOL,
      'allow-unbound-results': BOOL,
      'require-compilers': BOOL,
      'diff-base': STR,
      'max-flaky': STR,
      'max-skipped': STR,
    },
    run: (v, _pos, lang) =>
      runAuditCommand({
        ...makeCommon(v, lang),
        results: v.results,
        waivers: v.waivers,
        expectedRunId: v['expected-run-id'],
        checkSpecs: Boolean(v['check-specs']),
        requireE2e: Boolean(v['require-e2e']),
        staticOnly: Boolean(v['static-only']),
        allowUnboundResults: Boolean(v['allow-unbound-results']),
        requireCompilers: v['require-compilers'] ? true : undefined,
        diffBase: v['diff-base'],
        maxFlaky: v['max-flaky'] !== undefined ? Number(v['max-flaky']) : undefined,
        maxSkipped: v['max-skipped'] !== undefined ? Number(v['max-skipped']) : undefined,
      }),
  },
  diagnose: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      results: STR,
      output: STR,
    },
    run: (v, _pos, lang) =>
      runDiagnoseCommand({
        ...makeCommon(v, lang),
        results: v.results,
        output: v.output,
      }),
  },
  'verify-change': {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'base-url': STR,
      'baseline-url': STR,
      corpus: STR,
      'privacy-mode': STR,
      'strict-byte-escape': BOOL,
      base: STR,
      mode: STR,
      suite: STR,
      'allow-mutation': BOOL,
      'allow-offline-smoke': BOOL,
      'budget-ms': STR,
      'allow-non-git': BOOL,
    },
    run: (v, _pos, lang) =>
      runVerifyChangeCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        baselineUrl: v['baseline-url'],
        corpus: v.corpus,
        privacyMode: v['privacy-mode'],
        strictByteEscape: Boolean(v['strict-byte-escape']),
        base: v.base,
        mode: v.mode || v.suite,
        suite: v.suite,
        allowMutation: v['allow-mutation'] ? true : undefined,
        allowOfflineSmoke: Boolean(v['allow-offline-smoke']),
        budgetMs: v['budget-ms'] ? Number(v['budget-ms']) : undefined,
        allowNonGit: Boolean(v['allow-non-git']),
      }),
  },
  attest: {
    options: {
      ...TARGET_OPTS,
      action: STR,
      file: STR,
      bundle: STR,
      'expect-repo': STR,
      'expect-workflow': STR,
      'expect-ref': STR,
      'expect-git-sha': STR,
      'expect-tree-digest': STR,
      'trusted-root-cert': STR,
      'trusted-root-sha256': STR,
      'require-mac': BOOL,
    },
    run: (v, pos, lang) =>
      runAttestCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'verify',
        file: v.file,
        bundle: v.bundle,
        expectRepo: v['expect-repo'],
        expectWorkflow: v['expect-workflow'],
        expectRef: v['expect-ref'],
        expectGitSha: v['expect-git-sha'],
        expectTreeDigest: v['expect-tree-digest'],
        trustedRootCert: v['trusted-root-cert'],
        trustedRootSha256: v['trusted-root-sha256'],
        requireMac: Boolean(v['require-mac']),
      }),
  },
  heal: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      action: STR,
      'test-id': STR,
      'session-id': STR,
      outcome: STR,
      summary: STR,
      results: STR,
      'skip-run': BOOL,
    },
    run: async (v, pos, lang) =>
      (await runHealCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'begin',
        testId: v['test-id'],
        sessionId: v['session-id'],
        outcome: v.outcome,
        summary: v.summary,
        results: v.results,
        skipRun: Boolean(v['skip-run']),
      })) ?? 1,
  },
  flaky: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'sync-quarantine': BOOL,
    },
    run: (v, _pos, lang) =>
      runFlakyCommand({
        ...makeCommon(v, lang),
        syncQuarantine: Boolean(v['sync-quarantine']),
      }),
  },
  'trace-matrix': {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
    },
    run: (v, _pos, lang) => runTraceMatrixCommand(makeCommon(v, lang)),
  },
  governance: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      action: STR,
      by: STR,
      approver: STR,
      reason: STR,
      yes: BOOL,
    },
    deprecatedAliases: {
      approver: { replacement: 'by', deprecatedSince: '6.0.0', removeIn: '7.0.0' },
    },
    run: (v, pos, lang) =>
      runGovernanceCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'verify',
        by: v.by || v.approver,
        reason: v.reason,
        yes: Boolean(v.yes),
      }),
  },
  report: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      view: STR,
      'sync-quarantine': BOOL,
      'dry-run': BOOL,
    },
    run: (v, _pos, lang) =>
      runReportCommand({
        ...makeCommon(v, lang),
        view: v.view,
        syncQuarantine: Boolean(v['sync-quarantine']),
      }),
  },
};

export const CLI_COMMAND_NAMES = Object.keys(CLI_COMMANDS);
