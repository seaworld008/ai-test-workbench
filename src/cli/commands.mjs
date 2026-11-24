// @ts-check
import { runUpdateAgents } from '../agents.mjs';
import { runAuditCommand } from '../audit.mjs';
import { runAuthLoginCommand } from '../auth-login.mjs';
import { runMapCommand } from '../codemap.mjs';
import { runDiagnoseCommand } from '../diagnose.mjs';
import { runDoctor } from '../doctor.mjs';
import { runExploreCommand } from '../explore.mjs';
import { runFlakyCommand } from '../flaky.mjs';
import { runGovernanceCommand } from '../governance.mjs';
import { runHealCommand } from '../heal.mjs';
import { runImpactCommand } from '../impact.mjs';
import { runInit } from '../init.mjs';
import { runMcpCommand } from '../mcp-hub.mjs';
import { runMcpServeCommand } from '../mcp-server.mjs';
import { runPerfCommand } from '../perf.mjs';
import { runReportCommand } from '../report.mjs';
import { runSuiteCommand } from '../runner.mjs';
import { runSkillInstallCommand } from '../skill-install.mjs';
import { runTraceMatrixCommand } from '../traceability.mjs';
import { runAttestCommand } from '../trust.mjs';
import { runUpgradeCommand } from '../upgrade.mjs';
import { runVerifyChangeCommand } from '../verdict.mjs';

const STR = /** @type {const} */ ({ type: 'string' });
const BOOL = /** @type {const} */ ({ type: 'boolean' });

const BASE_OPTS = {
  help: { type: /** @type {'boolean'} */ ('boolean'), short: 'h' },
  lang: STR,
  json: BOOL,
};

const TARGET_OPTS = {
  ...BASE_OPTS,
  target: STR,
  'qa-dir': STR,
};

const WORKSPACE_MUTATION_OPTS = {
  ...TARGET_OPTS,
  'dry-run': BOOL,
  force: BOOL,
};

function makeCommon(v, lang) {
  return {
    lang,
    target: typeof v.target === 'string' ? v.target : undefined,
    qaDir: typeof v['qa-dir'] === 'string' ? v['qa-dir'] : undefined,
    dryRun: Boolean(v['dry-run']),
    force: Boolean(v.force),
    json: Boolean(v.json),
  };
}

/**
 * Per-command declarative CLI registry (`v6.0`).
 * Each command declares ONLY the flags it actually consumes so unrelated flags fail fast (exit 1).
 * @type {Record<string, {
 *   options: Record<string, { type: 'string' | 'boolean', short?: string }>,
 *   deprecatedAliases?: Record<string, { replacement: string, deprecatedSince: string, removeIn: string }>,
 *   run: (v: Record<string, any>, positionals: string[], lang: 'zh' | 'en') => Promise<number>,
 * }>}
 */
export const CLI_COMMANDS = {
  doctor: {
    options: { ...TARGET_OPTS },
    run: (v, _pos, lang) => runDoctor(makeCommon(v, lang)),
  },
  init: {
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      name: STR,
      preset: STR,
      loop: STR,
      'skip-install': BOOL,
      'skip-browser': BOOL,
      'bridge-root': BOOL,
    },
    run: (v, _pos, lang) =>
      runInit({
        ...makeCommon(v, lang),
        name: v.name,
        preset: v.preset,
        loop: v.loop,
        skipInstall: Boolean(v['skip-install']),
        skipBrowser: Boolean(v['skip-browser']),
        bridgeRoot: Boolean(v['bridge-root']),
      }),
  },
  upgrade: {
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      scope: STR,
    },
    run: (v, _pos, lang) =>
      runUpgradeCommand({
        ...makeCommon(v, lang),
        scope: typeof v.scope === 'string' ? v.scope : undefined,
      }),
  },
  'auth-login': {
    options: {
      ...TARGET_OPTS,
      'base-url': STR,
      account: STR,
      'login-path': STR,
      'cdp-url': STR,
      timeout: STR,
    },
    run: (v, _pos, lang) =>
      runAuthLoginCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        account: v.account,
        loginPath: v['login-path'],
        cdpUrl: v['cdp-url'],
        timeout: v.timeout ? Number(v.timeout) : undefined,
      }),
  },
  explore: {
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      'base-url': STR,
      'entry-path': STR,
      'max-pages': STR,
      'max-portals': STR,
      'max-tabs': STR,
      'max-dialogs': STR,
      'no-explore-tabs': BOOL,
      'no-explore-dialogs': BOOL,
      'no-explore-portals': BOOL,
      'no-sync-impact': BOOL,
    },
    run: (v, _pos, lang) =>
      runExploreCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        entryPath: v['entry-path'],
        maxPages: v['max-pages'] ? Number(v['max-pages']) : undefined,
        maxPortals: v['max-portals'] ? Number(v['max-portals']) : undefined,
        maxTabsPerPage: v['max-tabs'] !== undefined ? Number(v['max-tabs']) : undefined,
        maxDialogsPerPage: v['max-dialogs'] !== undefined ? Number(v['max-dialogs']) : undefined,
        exploreTabs: !v['no-explore-tabs'],
        exploreDialogs: !v['no-explore-dialogs'],
        explorePortals: !v['no-explore-portals'],
        noSyncImpact: Boolean(v['no-sync-impact']),
      }),
  },
  map: {
    options: {
      ...TARGET_OPTS,
      force: BOOL,
      repo: STR,
      'no-sync-impact': BOOL,
    },
    run: (v, _pos, lang) =>
      runMapCommand({
        ...makeCommon(v, lang),
        repo: v.repo,
        noSyncImpact: Boolean(v['no-sync-impact']),
      }),
  },
  mcp: {
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      action: STR,
      profile: STR,
      servers: STR,
      lock: BOOL,
      transport: STR,
      port: STR,
      host: STR,
      'auth-token': STR,
      'workspace-root': STR,
    },
    run: (v, pos, lang) => {
      const action = String(v.action || pos[0] || 'presets').toLowerCase();
      if (action === 'serve') {
        return runMcpServeCommand({
          ...makeCommon(v, lang),
          transport: v.transport,
          port: v.port !== undefined ? Number(v.port) : undefined,
          host: v.host,
          authToken: v['auth-token'],
          workspaceRoots: v['workspace-root'],
        });
      }
      return runMcpCommand({
        ...makeCommon(v, lang),
        action,
        profile: v.profile,
        servers: v.servers,
        lock: Boolean(v.lock),
      });
    },
  },
  'mcp-serve': {
    options: {
      ...TARGET_OPTS,
      transport: STR,
      port: STR,
      host: STR,
      'auth-token': STR,
      'workspace-root': STR,
    },
    run: (v, _pos, lang) =>
      runMcpServeCommand({
        ...makeCommon(v, lang),
        transport: v.transport,
        port: v.port !== undefined ? Number(v.port) : undefined,
        host: v.host,
        authToken: v['auth-token'],
        workspaceRoots: v['workspace-root'],
      }),
  },
  perf: {
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      'base-url': STR,
      routes: STR,
      endpoint: STR,
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
    options: {
      ...TARGET_OPTS,
      suite: STR,
      'base-url': STR,
      'allow-mutation': BOOL,
      workers: STR,
      retries: STR,
      grep: STR,
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
    options: {
      ...TARGET_OPTS,
      'base-url': STR,
      base: STR,
      mode: STR,
      suite: STR,
      'budget-ms': STR,
      'allow-non-git': BOOL,
    },
    run: (v, _pos, lang) =>
      runVerifyChangeCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        base: v.base,
        mode: v.mode || v.suite,
        suite: v.suite,
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
      'trusted-root-cert': STR,
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
        trustedRootCert: v['trusted-root-cert'],
        requireMac: Boolean(v['require-mac']),
      }),
  },
  heal: {
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
    run: (v, pos, lang) =>
      runHealCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'begin',
        testId: v['test-id'],
        sessionId: v['session-id'],
        outcome: v.outcome,
        summary: v.summary,
        results: v.results,
        skipRun: Boolean(v['skip-run']),
      }),
  },
  flaky: {
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
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
    },
    run: (v, _pos, lang) => runTraceMatrixCommand(makeCommon(v, lang)),
  },
  governance: {
    options: {
      ...TARGET_OPTS,
      action: STR,
      by: STR,
      approver: STR,
      reason: STR,
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
      }),
  },
  report: {
    options: { ...TARGET_OPTS },
    run: (v, _pos, lang) => runReportCommand(makeCommon(v, lang)),
  },
  'update-agents': {
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      loop: STR,
    },
    run: (v, _pos, lang) =>
      runUpdateAgents({
        ...makeCommon(v, lang),
        loop: v.loop,
      }),
  },
  'skill-install': {
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      client: STR,
    },
    run: (v, _pos, lang) =>
      runSkillInstallCommand({
        ...makeCommon(v, lang),
        client: v.client,
      }),
  },
};

export const CLI_COMMAND_NAMES = Object.keys(CLI_COMMANDS);
