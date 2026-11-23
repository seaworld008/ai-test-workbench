import { parseArgs } from 'node:util';
import { runUpdateAgents } from './agents.mjs';
import { runAuditCommand } from './audit.mjs';
import { runAuthLoginCommand } from './auth-login.mjs';
import { runDiagnoseCommand } from './diagnose.mjs';
import { runDoctor } from './doctor.mjs';
import { detectLang, t } from './i18n.mjs';
import { runImpactCommand } from './impact.mjs';
import { runInit } from './init.mjs';
import { runReportCommand } from './report.mjs';
import { runSuiteCommand } from './runner.mjs';
import { runSkillInstallCommand } from './skill-install.mjs';

function printHelp(lang) {
  const commands = [
    'doctor',
    'init',
    'auth-login',
    'run',
    'impact',
    'audit',
    'diagnose',
    'report',
    'update-agents',
    'skill-install',
  ];

  console.log(`\n${t(lang, 'appTitle')}\n`);
  console.log(`${t(lang, 'usageHeader')}:`);
  console.log('  npx ai-test-workbench <command> [options]');
  console.log('  node tools/aitest.mjs <command> [options]\n');
  console.log(`${t(lang, 'commandsHeader')}:`);
  for (const cmd of commands) {
    console.log(`  ${cmd.padEnd(16)} ${t(lang, 'helpSummary')[cmd]}`);
  }
  console.log(`\n${t(lang, 'optionsHeader')}:`);
  console.log('  --target <path>       Target business repository or QA directory');
  console.log('  --name <slug>         Project name for package.json / lockfile during init');
  console.log('  --qa-dir <dir>        QA subdirectory name inside target repo (default: qa)');
  console.log('  --preset <name>       Template preset during init: generic (default) | demo-campus');
  console.log('  --suite <name>        Suite for run: smoke | e2e | api | a11y | critical | seed | impact | all');
  console.log('  --base-url <url>      Override TEST_BASE_URL for run or auth-login (still verified against allowlist)');
  console.log('  --account <user>      Optional phone/username to pre-fill in auth-login');
  console.log('  --login-path <path>   Optional login route path for auth-login (default: /)');
  console.log('  --timeout <sec>       Timeout seconds for interactive auth-login (default: 600)');
  console.log('  --allow-mutation      Enable @mutation tests for this run (isolated test env only)');
  console.log('  --workers <n>         Override Playwright worker count');
  console.log('  --retries <n>         Override Playwright retry count');
  console.log('  --loop <loops>        Agent loops: codex | claude | vscode | opencode | copilot | none');
  console.log('  --audit               Run 3-layer quality gate immediately after "run"');
  console.log('  --check-specs         Run tsc --noEmit + ESLint (with regex fallback) during "audit"');
  console.log('  --require-e2e         Fail "audit" if 0 online E2E specs executed');
  console.log('  --diff-base <ref>     Run Healer diff guard against <ref> during "audit"');
  console.log('  --base <ref>          Git base ref for "impact" (default: HEAD~1)');
  console.log('  --bridge-root         Opt-in: write root .mcp.json pointing to qa/ run-test-mcp-server');
  console.log('  --skip-install        Skip npm dependency install during "init"');
  console.log('  --skip-browser        Skip Chromium install check during "init"');
  console.log('  --dry-run             Preview planned file operations without writing to disk');
  console.log('  --force               Force update on agent/skill conflicts');
  console.log('  --json                Output machine-readable JSON');
  console.log('  --lang <zh|en>        Override CLI output language');
  console.log('  -h, --help            Show help\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        lang: { type: 'string' },
        target: { type: 'string' },
        name: { type: 'string' },
        'qa-dir': { type: 'string' },
        preset: { type: 'string' },
        suite: { type: 'string' },
        'base-url': { type: 'string' },
        account: { type: 'string' },
        'login-path': { type: 'string' },
        timeout: { type: 'string' },
        workers: { type: 'string' },
        retries: { type: 'string' },
        loop: { type: 'string' },
        grep: { type: 'string' },
        base: { type: 'string' },
        files: { type: 'string' },
        results: { type: 'string' },
        waivers: { type: 'string' },
        output: { type: 'string' },
        'diff-base': { type: 'string' },
        'max-flaky': { type: 'string' },
        'max-skipped': { type: 'string' },
        client: { type: 'string' },
        'allow-mutation': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-install': { type: 'boolean' },
        'skip-browser': { type: 'boolean' },
        'bridge-root': { type: 'boolean' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
        audit: { type: 'boolean' },
        'check-specs': { type: 'boolean' },
        'require-e2e': { type: 'boolean' },
        'static-only': { type: 'boolean' },
        'last-failed': { type: 'boolean' },
        'fail-on-flaky': { type: 'boolean' },
        headed: { type: 'boolean' },
        ui: { type: 'boolean' },
        debug: { type: 'boolean' },
      },
    });
  } catch (err) {
    console.error(err.message);
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
      case 'auth-login':
        return await runAuthLoginCommand({
          ...common,
          baseUrl: v['base-url'],
          account: v.account,
          loginPath: v['login-path'],
          timeout: v.timeout ? Number(v.timeout) : undefined,
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
