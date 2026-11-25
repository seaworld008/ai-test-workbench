// @ts-check
import { parseArgs } from 'node:util';
import { CLI_COMMANDS, CLI_COMMAND_NAMES } from './cli/commands.mjs';
import { validateCliOptionValues } from './cli/opts.mjs';
import { detectLang, t } from './core/i18n.mjs';
import { EXIT_CODES, buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';

export { CLI_COMMANDS, CLI_COMMAND_NAMES };

/** @param {string} a @param {string} b */
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

/** @param {string} unknownToken @param {string[]} candidates @param {string} [prefix] */
function suggestClosest(unknownToken, candidates, prefix = '') {
  const bare = String(unknownToken || '').replace(/^-+/, '').split('=')[0];
  if (!bare) return null;
  let best = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(bare, candidate);
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = `${prefix}${candidate}`;
    }
  }
  return best;
}

/** @param {'zh' | 'en'} lang */
function printHelp(lang) {
  console.log(`\n${t(lang, 'appTitle')}\n`);
  console.log(`${t(lang, 'usageHeader')}:`);
  console.log(`  npx ai-test-workbench@${WORKBENCH_VERSION} <command> [options]`);
  console.log('  aitw <command> [options]                  # after global install');
  console.log('  node tools/aitest.mjs <command> [options] # local repository checkout\n');
  console.log(`${t(lang, 'commandsHeader')}:`);
  for (const cmd of CLI_COMMAND_NAMES) {
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
  console.log('  -V, --version           Print workbench version');
  console.log('  -h, --help              Show help (or `<command> --help` for per-command flags)\n');
}

/** @param {string} cmd @param {(typeof CLI_COMMANDS)[string]} spec @param {'zh' | 'en'} lang */
function printCommandHelp(cmd, spec, lang) {
  const summary = t(lang, 'helpSummary')[cmd] || '';
  const deprecatedSet = new Set(Object.keys(spec.deprecatedAliases || {}));
  const flags = Object.entries(spec.options)
    .filter(([flag]) => !deprecatedSet.has(flag))
    .map(([flag, def]) => (def.type === 'string' ? `--${flag} <value>` : `--${flag}`));
  console.log(`\n${cmd} — ${summary}`);
  console.log(`Usage: aitw ${cmd} [options]`);
  console.log(`Allowed options:\n  ${flags.join('\n  ')}\n`);
}

/**
 * Extracts the subcommand token and pre-command `--lang` without rejecting command-specific flags.
 * @param {string[]} argv
 */
function locateSubcommand(argv) {
  let langHint;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--') break;
    if (tok === '-h' || tok === '--help') {
      return { cmd: null, cmdIndex: -1, helpRequested: true, versionRequested: false, langHint };
    }
    if (tok === '-V' || tok === '--version') {
      return { cmd: null, cmdIndex: -1, helpRequested: false, versionRequested: true, langHint };
    }
    if (tok === '--lang' && i + 1 < argv.length) {
      langHint = argv[i + 1];
      i += 1;
      continue;
    }
    if (tok.startsWith('--lang=')) {
      langHint = tok.slice('--lang='.length);
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    return { cmd: tok, cmdIndex: i, helpRequested: false, versionRequested: false, langHint };
  }
  return { cmd: null, cmdIndex: -1, helpRequested: false, versionRequested: false, langHint };
}

/**
 * Emits a standardized exit-64 usage envelope (for CLI `--json` & `AITEST_RESULT_FILE`) and stderr notice.
 * @param {string} tool
 * @param {string} message
 * @param {boolean} asJson
 * @param {string[]} [recoverySteps]
 * @returns {number}
 */
function failUsage(tool, message, asJson, recoverySteps = ['Run "aitw --help" to see valid commands and flags.']) {
  const envelope = buildCommandResult({
    tool,
    outcome: 'usage',
    ok: false,
    exitCode: EXIT_CODES.USAGE,
    summary: message,
    recoverable: true,
    blockerKind: 'USAGE_ERROR',
    recoverySteps,
    data: { error: message },
    nextRecommendedActions: recoverySteps,
  });
  if (!asJson) {
    console.error(message);
  }
  return emitCommandResult(envelope, { asJson, compatSpreadData: false });
}

export async function runCli(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const located = locateSubcommand(argv);
  const preLang = detectLang(located.langHint);

  if (located.versionRequested) {
    const verEnv = buildCommandResult({
      tool: 'version',
      outcome: 'pass',
      ok: true,
      exitCode: EXIT_CODES.PASS,
      summary: `ai-test-workbench ${WORKBENCH_VERSION}`,
      data: { name: 'ai-test-workbench', version: WORKBENCH_VERSION },
    });
    if (!asJson) {
      console.log(WORKBENCH_VERSION);
    }
    return emitCommandResult(verEnv, { asJson });
  }

  if (located.helpRequested || !located.cmd) {
    if (!located.helpRequested && argv.some((tok) => tok !== '--json')) {
      return failUsage('cli', `[CLI Option Error] Unknown option '${argv[0]}'. Run --help for usage.`, asJson);
    }
    if (asJson) {
      return emitCommandResult(
        buildCommandResult({
          tool: 'help',
          outcome: 'pass',
          ok: true,
          exitCode: EXIT_CODES.PASS,
          summary: `ai-test-workbench v${WORKBENCH_VERSION} CLI commands`,
          data: { version: WORKBENCH_VERSION, commands: CLI_COMMAND_NAMES },
        }),
        { asJson: true }
      );
    }
    printHelp(preLang);
    return 0;
  }

  const cmd = located.cmd;
  const spec = CLI_COMMANDS[cmd];
  if (!spec) {
    const hint = suggestClosest(cmd, CLI_COMMAND_NAMES);
    const msg = `${t(preLang, 'unknownCmd', cmd)}${hint ? ` Did you mean "${hint}"?` : ''}`;
    return failUsage(cmd, msg, asJson, hint ? [`Try "aitw ${hint} --help".`] : undefined);
  }

  const cmdArgv = [...argv.slice(0, located.cmdIndex), ...argv.slice(located.cmdIndex + 1)];

  let parsed;
  try {
    parsed = parseArgs({
      args: cmdArgv,
      allowPositionals: true,
      strict: true,
      options: spec.options,
    });
  } catch (err) {
    const rawMsg = err instanceof Error && err.message ? err.message : String(err);
    const unkMatch = /Unknown option '([^']+)'/.exec(rawMsg);
    const allowedFlags = Object.keys(spec.options).filter((k) => !(spec.deprecatedAliases && k in spec.deprecatedAliases));
    const hint = unkMatch ? suggestClosest(unkMatch[1], allowedFlags, '--') : null;
    const msg = unkMatch
      ? `[CLI Option Error] ${rawMsg} for command "${cmd}".${hint ? ` Did you mean "${hint}"?` : ''} Run "aitw ${cmd} --help" for allowed flags.`
      : `[CLI Option Error] ${rawMsg}`;
    return failUsage(cmd, msg, asJson, [`Run "aitw ${cmd} --help" for allowed flags.`]);
  }

  const v = parsed.values;
  const lang = detectLang(typeof v.lang === 'string' ? v.lang : located.langHint);

  if (v.help) {
    if (v.json) {
      return emitCommandResult(
        buildCommandResult({ tool: cmd, outcome: 'pass', ok: true, exitCode: EXIT_CODES.PASS, summary: `Help for "${cmd}"`, data: { command: cmd, options: Object.keys(spec.options) } }),
        { asJson: true }
      );
    }
    printCommandHelp(cmd, spec, lang);
    return 0;
  }

  const valErr = validateCliOptionValues(cmd, v);
  if (valErr) return failUsage(cmd, valErr, Boolean(v.json), [`Run "aitw ${cmd} --help" for valid options.`]);

  if (spec.requireTarget && !v.target) {
    const msg = lang === 'zh' ? `命令 "${cmd}" 缺少必填参数 --target <path>` : `Command "${cmd}" missing mandatory --target <path>`;
    return failUsage(cmd, msg, Boolean(v.json), [`Pass --target <repo-or-qa-path> to "aitw ${cmd}".`]);
  }

  if (spec.deprecatedAliases) {
    for (const [oldFlag, meta] of Object.entries(spec.deprecatedAliases)) {
      if (v[oldFlag] !== undefined) {
        console.error(
          `[DEPRECATED] CLI flag "--${oldFlag}" on "${cmd}" is deprecated since v${meta.deprecatedSince} and will be removed in v${meta.removeIn}; use "--${meta.replacement}" instead.`
        );
      }
    }
  }

  try {
    return await spec.run(v, parsed.positionals, lang);
  } catch (err) {
    const msg = err instanceof Error && err.message ? err.message : String(err);
    if (!v.json) console.error(`[Error] ${msg}`);
    return emitCommandResult(
      buildCommandResult({
        tool: cmd,
        outcome: 'fail',
        ok: false,
        exitCode: EXIT_CODES.FAIL,
        summary: msg,
        data: { error: msg },
      }),
      { asJson: Boolean(v.json), compatSpreadData: false }
    );
  }
}
