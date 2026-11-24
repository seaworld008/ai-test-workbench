// @ts-check
import { parseArgs } from 'node:util';
import { runUpdateAgents } from './agents.mjs';
import { runAuditCommand } from './audit.mjs';
import { runAuthLoginCommand } from './auth-login.mjs';
import { runMapCommand } from './codemap.mjs';
import { runDiagnoseCommand } from './diagnose.mjs';
import { runDoctor } from './doctor.mjs';
import { runExploreCommand } from './explore.mjs';
import { runFlakyCommand } from './flaky.mjs';
import { runGovernanceCommand } from './governance.mjs';
import { runHealCommand } from './heal.mjs';
import { detectLang, t } from './i18n.mjs';
import { runImpactCommand } from './impact.mjs';
import { runInit } from './init.mjs';
import { runMcpCommand } from './mcp-hub.mjs';
import { runMcpServeCommand } from './mcp-server.mjs';
import { runPerfCommand } from './perf.mjs';
import { runReportCommand } from './report.mjs';
import { runSuiteCommand } from './runner.mjs';
import { runSkillInstallCommand } from './skill-install.mjs';
import { runTraceMatrixCommand } from './traceability.mjs';
import { runAttestCommand } from './trust.mjs';
import { runUpgradeCommand } from './upgrade.mjs';
import { runVerifyChangeCommand } from './verdict.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';

const CLI_OPTION_DEFS = {
  help: { type: /** @type {'boolean'} */ ('boolean'), short: 'h' },
  lang: { type: /** @type {'string'} */ ('string') },
  target: { type: /** @type {'string'} */ ('string') },
  name: { type: /** @type {'string'} */ ('string') },
  'qa-dir': { type: /** @type {'string'} */ ('string') },
  scope: { type: /** @type {'string'} */ ('string') },
  preset: { type: /** @type {'string'} */ ('string') },
  suite: { type: /** @type {'string'} */ ('string') },
  'base-url': { type: /** @type {'string'} */ ('string') },
  'entry-path': { type: /** @type {'string'} */ ('string') },
  'max-pages': { type: /** @type {'string'} */ ('string') },
  repo: { type: /** @type {'string'} */ ('string') },
  profile: { type: /** @type {'string'} */ ('string') },
  servers: { type: /** @type {'string'} */ ('string') },
  action: { type: /** @type {'string'} */ ('string') },
  transport: { type: /** @type {'string'} */ ('string') },
  port: { type: /** @type {'string'} */ ('string') },
  host: { type: /** @type {'string'} */ ('string') },
  'auth-token': { type: /** @type {'string'} */ ('string') },
  'workspace-root': { type: /** @type {'string'} */ ('string') },
  routes: { type: /** @type {'string'} */ ('string') },
  endpoint: { type: /** @type {'string'} */ ('string') },
  concurrency: { type: /** @type {'string'} */ ('string') },
  iterations: { type: /** @type {'string'} */ ('string') },
  samples: { type: /** @type {'string'} */ ('string') },
  mode: { type: /** @type {'string'} */ ('string') },
  'no-sync-impact': { type: /** @type {'boolean'} */ ('boolean') },
  'enforce-budget': { type: /** @type {'boolean'} */ ('boolean') },
  throttle: { type: /** @type {'boolean'} */ ('boolean') },
  'check-regression': { type: /** @type {'boolean'} */ ('boolean') },
  account: { type: /** @type {'string'} */ ('string') },
  'login-path': { type: /** @type {'string'} */ ('string') },
  timeout: { type: /** @type {'string'} */ ('string') },
  'budget-ms': { type: /** @type {'string'} */ ('string') },
  workers: { type: /** @type {'string'} */ ('string') },
  retries: { type: /** @type {'string'} */ ('string') },
  loop: { type: /** @type {'string'} */ ('string') },
  grep: { type: /** @type {'string'} */ ('string') },
  base: { type: /** @type {'string'} */ ('string') },
  files: { type: /** @type {'string'} */ ('string') },
  results: { type: /** @type {'string'} */ ('string') },
  waivers: { type: /** @type {'string'} */ ('string') },
  output: { type: /** @type {'string'} */ ('string') },
  'diff-base': { type: /** @type {'string'} */ ('string') },
  'max-flaky': { type: /** @type {'string'} */ ('string') },
  'max-skipped': { type: /** @type {'string'} */ ('string') },
  client: { type: /** @type {'string'} */ ('string') },
  by: { type: /** @type {'string'} */ ('string') },
  reason: { type: /** @type {'string'} */ ('string') },
  'test-id': { type: /** @type {'string'} */ ('string') },
  'session-id': { type: /** @type {'string'} */ ('string') },
  outcome: { type: /** @type {'string'} */ ('string') },
  summary: { type: /** @type {'string'} */ ('string') },
  verbosity: { type: /** @type {'string'} */ ('string') },
  lock: { type: /** @type {'boolean'} */ ('boolean') },
  'sync-quarantine': { type: /** @type {'boolean'} */ ('boolean') },
  'skip-run': { type: /** @type {'boolean'} */ ('boolean') },
  'allow-unbound-results': { type: /** @type {'boolean'} */ ('boolean') },
  'allow-non-git': { type: /** @type {'boolean'} */ ('boolean') },
  'require-mac': { type: /** @type {'boolean'} */ ('boolean') },
  file: { type: /** @type {'string'} */ ('string') },
  bundle: { type: /** @type {'string'} */ ('string') },
  'expect-repo': { type: /** @type {'string'} */ ('string') },
  'expect-workflow': { type: /** @type {'string'} */ ('string') },
  'expect-ref': { type: /** @type {'string'} */ ('string') },
  'trusted-root-cert': { type: /** @type {'string'} */ ('string') },
  'cdp-url': { type: /** @type {'string'} */ ('string') },
  'max-portals': { type: /** @type {'string'} */ ('string') },
  'max-tabs': { type: /** @type {'string'} */ ('string') },
  'max-dialogs': { type: /** @type {'string'} */ ('string') },
  'no-explore-tabs': { type: /** @type {'boolean'} */ ('boolean') },
  'no-explore-dialogs': { type: /** @type {'boolean'} */ ('boolean') },
  'no-explore-portals': { type: /** @type {'boolean'} */ ('boolean') },
  'allow-mutation': { type: /** @type {'boolean'} */ ('boolean') },
  'dry-run': { type: /** @type {'boolean'} */ ('boolean') },
  'skip-install': { type: /** @type {'boolean'} */ ('boolean') },
  'skip-browser': { type: /** @type {'boolean'} */ ('boolean') },
  'bridge-root': { type: /** @type {'boolean'} */ ('boolean') },
  force: { type: /** @type {'boolean'} */ ('boolean') },
  json: { type: /** @type {'boolean'} */ ('boolean') },
  audit: { type: /** @type {'boolean'} */ ('boolean') },
  'check-specs': { type: /** @type {'boolean'} */ ('boolean') },
  'require-e2e': { type: /** @type {'boolean'} */ ('boolean') },
  'static-only': { type: /** @type {'boolean'} */ ('boolean') },
  'last-failed': { type: /** @type {'boolean'} */ ('boolean') },
  'fail-on-flaky': { type: /** @type {'boolean'} */ ('boolean') },
  headed: { type: /** @type {'boolean'} */ ('boolean') },
  ui: { type: /** @type {'boolean'} */ ('boolean') },
  debug: { type: /** @type {'boolean'} */ ('boolean') },
};

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function suggestClosestFlag(unknownArg) {
  const bare = String(unknownArg || '').replace(/^-+/, '').split('=')[0];
  if (!bare) return null;
  let best = null;
  let bestDist = Infinity;
  for (const candidate of Object.keys(CLI_OPTION_DEFS)) {
    const dist = levenshtein(bare, candidate);
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = `--${candidate}`;
    }
  }
  return best;
}

function printHelp(lang) {
  const commands = [
    'doctor',
    'init',
    'auth-login',
    'explore',
    'map',
    'mcp',
    'mcp-serve',
    'perf',
    'run',
    'impact',
    'audit',
    'diagnose',
    'verify-change',
    'heal',
    'flaky',
    'trace-matrix',
    'governance',
    'attest',
    'report',
    'update-agents',
    'skill-install',
  ];

  console.log(`\n${t(lang, 'appTitle')}\n`);
  console.log(`${t(lang, 'usageHeader')}:`);
  console.log(`  npx ai-test-workbench@${WORKBENCH_VERSION} <command> [options]`);
  console.log('  aitw <command> [options]                  # after global install');
  console.log('  node tools/aitest.mjs <command> [options] # local repository checkout\n');
  console.log(`${t(lang, 'commandsHeader')}:`);
  for (const cmd of commands) {
    console.log(`  ${cmd.padEnd(16)} ${t(lang, 'helpSummary')[cmd] || ''}`);
  }
  console.log(`\n${t(lang, 'optionsHeader')}:`);
  console.log('  --target <path>         Target business repository or QA directory');
  console.log('  --suite <name>          Suite for run: smoke | e2e | api | a11y | critical | seed | impact | all');
  console.log('  --base-url <url>        Override TEST_BASE_URL (allowlisted non-production only)');
  console.log('  --workspace-root <csv>  Allowed workspace root boundary for MCP server');
  console.log('  --diff-base <ref>       Run Semantic AST Diff Guard against <ref> during audit');
  console.log('  --by <human>            Human reviewer attribution for "governance approve"');
  console.log('  --reason <text>         Approval reason for "governance approve"');
  console.log('  --json                  Output machine-readable JSON');
  console.log('  --lang <zh|en>          Override output language');
  console.log('  -h, --help              Show help\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: CLI_OPTION_DEFS,
    });
  } catch (err) {
    const rawMsg = String(err?.message || err);
    const unkMatch = /Unknown option '([^']+)'/.exec(rawMsg);
    if (unkMatch) {
      const hint = suggestClosestFlag(unkMatch[1]);
      console.error(`[CLI Option Error] ${rawMsg}${hint ? ` Did you mean "${hint}"?` : ''}`);
    } else {
      console.error(`[CLI Option Error] ${rawMsg}`);
    }
    return 1;
  }

  const v = parsed.values;
  const lang = detectLang(v.lang);
  const cmd = parsed.positionals[0];

  if (v.help || !cmd) {
    printHelp(lang);
    return 0;
  }

  const common = {
    lang,
    target: v.target,
    qaDir: v['qa-dir'],
    dryRun: Boolean(v['dry-run']),
    force: Boolean(v.force),
    json: Boolean(v.json),
  };

  try {
    switch (cmd) {
      case 'doctor':
        return await runDoctor(common);
      case 'init':
        return await runInit({
          ...common,
          name: v.name,
          preset: v.preset,
          loop: v.loop,
          skipInstall: Boolean(v['skip-install']),
          skipBrowser: Boolean(v['skip-browser']),
          bridgeRoot: Boolean(v['bridge-root']),
        });
      case 'upgrade':
        return await runUpgradeCommand({
          lang,
          target: typeof v.target === 'string' ? v.target : undefined,
          qaDir: typeof v['qa-dir'] === 'string' ? v['qa-dir'] : undefined,
          dryRun: Boolean(v['dry-run']),
          force: Boolean(v.force),
          json: Boolean(v.json),
          scope: typeof v.scope === 'string' ? v.scope : undefined,
        });
      case 'auth-login':
        return await runAuthLoginCommand({
          ...common,
          baseUrl: v['base-url'],
          account: v.account,
          loginPath: v['login-path'],
          cdpUrl: v['cdp-url'],
          timeout: v.timeout ? Number(v.timeout) : undefined,
        });
      case 'explore':
        return await runExploreCommand({
          ...common,
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
        });
      case 'map':
        return await runMapCommand({
          ...common,
          repo: v.repo,
          noSyncImpact: Boolean(v['no-sync-impact']),
        });
      case 'mcp':
        return await runMcpCommand({
          ...common,
          action: v.action || parsed.positionals[1] || 'presets',
          profile: v.profile,
          servers: v.servers,
          lock: Boolean(v.lock),
          transport: v.transport,
          port: v.port !== undefined ? Number(v.port) : undefined,
          host: v.host,
          authToken: v['auth-token'],
          workspaceRoots: v['workspace-root'],
        });
      case 'mcp-serve':
        return await runMcpServeCommand({
          ...common,
          transport: v.transport,
          port: v.port !== undefined ? Number(v.port) : undefined,
          host: v.host,
          authToken: v['auth-token'],
          workspaceRoots: v['workspace-root'],
        });
      case 'perf':
        return await runPerfCommand({
          ...common,
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
        });
      case 'run':
        return await runSuiteCommand({
          ...common,
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
        });
      case 'impact':
        return await runImpactCommand({
          ...common,
          base: v.base,
          files: v.files,
        });
      case 'audit':
        return await runAuditCommand({
          ...common,
          results: v.results,
          waivers: v.waivers,
          checkSpecs: Boolean(v['check-specs']),
          requireE2e: Boolean(v['require-e2e']),
          staticOnly: Boolean(v['static-only']),
          allowUnboundResults: Boolean(v['allow-unbound-results']),
          diffBase: v['diff-base'],
          maxFlaky: v['max-flaky'] !== undefined ? Number(v['max-flaky']) : undefined,
          maxSkipped: v['max-skipped'] !== undefined ? Number(v['max-skipped']) : undefined,
        });
      case 'diagnose':
        return await runDiagnoseCommand({
          ...common,
          results: v.results,
          output: v.output,
        });
      case 'verify-change':
        return await runVerifyChangeCommand({
          ...common,
          baseUrl: v['base-url'],
          base: v.base,
          mode: v.mode || v.suite,
          suite: v.suite,
          budgetMs: v['budget-ms'] ? Number(v['budget-ms']) : undefined,
          allowNonGit: Boolean(v['allow-non-git']),
        });
      case 'attest':
        return await runAttestCommand({
          ...common,
          action: v.action || parsed.positionals[1] || 'verify',
          file: v.file,
          bundle: v.bundle,
          expectRepo: v['expect-repo'],
          expectWorkflow: v['expect-workflow'],
          expectRef: v['expect-ref'],
          trustedRootCert: v['trusted-root-cert'],
          requireMac: Boolean(v['require-mac']),
        });
      case 'heal':
        return await runHealCommand({
          ...common,
          action: v.action || parsed.positionals[1] || 'begin',
          testId: v['test-id'],
          sessionId: v['session-id'],
          outcome: v.outcome,
          summary: v.summary,
          results: v.results,
          skipRun: Boolean(v['skip-run']),
        });
      case 'flaky':
        return await runFlakyCommand({
          ...common,
          syncQuarantine: Boolean(v['sync-quarantine']),
        });
      case 'trace-matrix':
        return await runTraceMatrixCommand(common);
      case 'governance':
        return await runGovernanceCommand({
          ...common,
          action: v.action || parsed.positionals[1] || 'verify',
          by: v.by,
          reason: v.reason,
        });
      case 'report':
        return await runReportCommand(common);
      case 'update-agents':
        return await runUpdateAgents({
          ...common,
          loop: v.loop,
        });
      case 'skill-install':
        return await runSkillInstallCommand({
          ...common,
          client: v.client,
        });
      default:
        console.error(t(lang, 'unknownCmd', cmd));
        return 1;
    }
  } catch (err) {
    console.error(`[Error] ${err.message}`);
    return 1;
  }
}
