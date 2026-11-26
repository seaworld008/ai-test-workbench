// @ts-check
import fs from 'node:fs';
import { redactSecrets } from '../core/redact.mjs';
import { sanitizeProxyUrlEnvValue } from '../jobs/workspace-lock.mjs';

const PLAYWRIGHT_ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'WINDIR',
  'windir',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'TZ',
  'NODE_ENV',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'REQUIRE_TEST_TARGET',
  'DEBUG',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
]);

const PLAYWRIGHT_ENV_ALLOWLIST_PREFIXES = ['PLAYWRIGHT_', 'PW_', 'TEST_', 'E2E_', 'FAIL_ON_'];
const PLAYWRIGHT_ENV_ALLOWLIST_AITEST = new Set(['AITEST_ACTIVE_SUITE', 'AITEST_RUN_ID', 'AITEST_LANG', 'AITEST_DISABLE_WEBSERVER']);
const PW_SENSITIVE_KEY_RE =
  /^(?:AITEST_HMAC_KEY|AITEST_MCP_|ACTIONS_ID_TOKEN_|ACTIONS_RUNTIME_TOKEN$|DATABASE_URL$)|(?:^|_)(?:SECRET|TOKEN|API_KEY|PASSWORD|PASSWD|PRIVATE_KEY)(?:$|_)/i;
const PW_PROXY_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);

/**
 * Builds a strict allowlisted environment for Playwright & target app processes,
 * stripping `AITEST_HMAC_KEY*`, MCP tokens, cloud credentials, DB URLs, and CI OIDC tokens (`WU-01`, v6.2.1).
 * @param {Record<string, string | undefined>} [baseEnv]
 * @param {Record<string, string | undefined>} [extraEnv]
 * @returns {Record<string, string>}
 */
export function buildPlaywrightChildEnv(baseEnv = process.env, extraEnv = {}) {
  /** @type {Record<string, string>} */
  const clean = {};
  const combined = { ...baseEnv, ...extraEnv };
  for (const [k, v] of Object.entries(combined)) {
    if (v === undefined) continue;
    if (!k.startsWith('E2E_') && PW_SENSITIVE_KEY_RE.test(k)) {
      continue;
    }
    const allowed =
      PLAYWRIGHT_ENV_ALLOWLIST_EXACT.has(k) ||
      PLAYWRIGHT_ENV_ALLOWLIST_AITEST.has(k) ||
      PLAYWRIGHT_ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p));
    if (allowed) {
      clean[k] = PW_PROXY_KEYS.has(k) ? sanitizeProxyUrlEnvValue(String(v)) : String(v);
    }
  }
  return clean;
}

/**
 * @param {string} suite
 * @param {{ hasBaseUrl?: boolean }} [options]
 * @returns {string[]}
 */
export function buildSuitePlaywrightArgs(suite, options = {}) {
  const s = (suite || 'smoke').toLowerCase();
  const args = [];

  switch (s) {
    case 'smoke':
      args.push('--project=smoke');
      break;
    case 'e2e':
      args.push('--project=e2e');
      break;
    case 'api':
      args.push('--project=api');
      break;
    case 'seed':
      args.push('--project=seed');
      break;
    case 'a11y':
      args.push('--project=smoke');
      if (options.hasBaseUrl) args.push('--project=e2e');
      args.push('--grep=@a11y');
      break;
    case 'critical':
      args.push('--project=smoke');
      if (options.hasBaseUrl) {
        args.push('--project=e2e', '--project=api');
      }
      args.push('--grep=@critical|@smoke');
      break;
    case 'all':
      args.push('--project=smoke', '--project=e2e', '--project=api');
      break;
    default:
      throw new Error(`Unknown suite "${suite}". Valid suites: smoke, e2e, api, a11y, critical, seed, impact, all.`);
  }

  return args;
}

/**
 * Resolves explicit `--files` / `--line` CLI targets for rapid single-file inner loop (`WU-04`).
 * @param {string | string[] | undefined} files
 * @param {number | string | undefined} line
 * @returns {string[]}
 */
export function resolveExplicitFileTargets(files, line) {
  const explicitFiles = Array.isArray(files)
    ? files.map((s) => String(s).trim()).filter(Boolean)
    : typeof files === 'string' && files.trim()
      ? files.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  const lineNum = Number.isInteger(Number(line)) && Number(line) > 0 ? Number(line) : null;
  if (explicitFiles.length === 0) return [];
  return lineNum && explicitFiles.length === 1 ? [`${explicitFiles[0]}:${lineNum}`] : explicitFiles;
}

/**
 * Extracts redacted failure summaries + inline ARIA error-context + semantic locator hints
 * from finalized Run Ledger tests.
 * @param {Array<Record<string, any>>} tests
 */
export function extractRunnerFailedSpecs(tests) {
  return (tests || [])
    .filter((t) => t.status === 'unexpected' || t.status === 'flaky')
    .slice(0, 15)
    .map((t) => {
      let errorContextAria = null;
      const ariaAtt = (t.attachments || []).find(
        (/** @type {any} */ a) =>
          (a?.name === 'error-context' || String(a?.path || '').endsWith('.md')) && a?.path && fs.existsSync(a.path)
      );
      if (ariaAtt?.path) {
        try {
          errorContextAria = redactSecrets(fs.readFileSync(ariaAtt.path, 'utf8')).slice(0, 1800);
        } catch {
          errorContextAria = null;
        }
      }
      const errMsg = t.errorSnippet ? redactSecrets(t.errorSnippet) : null;
      /** @type {string[]} */
      const locatorSuggestions = [];
      if (errorContextAria) {
        for (const m of errorContextAria.matchAll(/\b(button|link|heading|textbox|checkbox|radio|combobox|tab|menuitem)\s+"([^"]{1,60})"/gi)) {
          const role = m[1].toLowerCase();
          const label = m[2].replace(/'/g, "\\'");
          const suggestion = `page.getByRole('${role}', { name: '${label}' })`;
          if (!locatorSuggestions.includes(suggestion)) locatorSuggestions.push(suggestion);
          if (locatorSuggestions.length >= 5) break;
        }
      }
      if (locatorSuggestions.length === 0 && errMsg && /locator|strict mode|getBy/i.test(errMsg)) {
        locatorSuggestions.push('Inspect errorContextAria and bind a unique semantic locator (getByRole / getByLabel / getByTestId).');
      }
      return {
        testId: t.testId,
        file: t.file,
        line: t.line,
        title: redactSecrets(t.title),
        status: t.status,
        error: errMsg,
        ...(errorContextAria ? { errorContextAria } : {}),
        ...(locatorSuggestions.length > 0 ? { locatorSuggestions } : {}),
      };
    });
}
