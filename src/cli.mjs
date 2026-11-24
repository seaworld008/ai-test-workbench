// @ts-check
import { parseArgs } from 'node:util';
import { CLI_COMMANDS, CLI_COMMAND_NAMES } from './cli/commands.mjs';
import { detectLang, t } from './core/i18n.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';

export { CLI_COMMANDS, CLI_COMMAND_NAMES };

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
  console.log('  -h, --help              Show help (or `<command> --help` for per-command flags)\n');
}

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
      return { cmd: null, cmdIndex: -1, helpRequested: true, langHint };
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
    return { cmd: tok, cmdIndex: i, helpRequested: false, langHint };
  }
  return { cmd: null, cmdIndex: -1, helpRequested: false, langHint };
}

export async function runCli(argv = process.argv.slice(2)) {
  const located = locateSubcommand(argv);
  const preLang = detectLang(located.langHint);

  if (located.helpRequested || !located.cmd) {
    if (!located.helpRequested && argv.length > 0) {
      // Unknown leading flag before any command (e.g. `aitw --bogus`)
      console.error(`[CLI Option Error] Unknown option '${argv[0]}'. Run --help for usage.`);
      return 1;
    }
    printHelp(preLang);
    return 0;
  }

  const cmd = located.cmd;
  const spec = CLI_COMMANDS[cmd];
  if (!spec) {
    const hint = suggestClosest(cmd, CLI_COMMAND_NAMES);
    console.error(`${t(preLang, 'unknownCmd', cmd)}${hint ? ` Did you mean "${hint}"?` : ''}`);
    return 1;
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
    const rawMsg = String(err?.message || err);
    const unkMatch = /Unknown option '([^']+)'/.exec(rawMsg);
    if (unkMatch) {
      const allowedFlags = Object.keys(spec.options).filter((k) => !(spec.deprecatedAliases && k in spec.deprecatedAliases));
      const hint = suggestClosest(unkMatch[1], allowedFlags, '--');
      console.error(
        `[CLI Option Error] ${rawMsg} for command "${cmd}".${hint ? ` Did you mean "${hint}"?` : ''} Run "aitw ${cmd} --help" for allowed flags.`
      );
    } else {
      console.error(`[CLI Option Error] ${rawMsg}`);
    }
    return 1;
  }

  const v = parsed.values;
  const lang = detectLang(typeof v.lang === 'string' ? v.lang : located.langHint);

  if (v.help) {
    printCommandHelp(cmd, spec, lang);
    return 0;
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
    console.error(`[Error] ${err?.message || String(err)}`);
    return 1;
  }
}
