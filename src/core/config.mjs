// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_AITEST_CONFIG,
  DEFAULT_CONFIG_PROTECTED_GLOBS,
  RESERVED_WEAK_MATCHERS,
  createDefaultAitestConfig,
  validateAitestConfigObject,
  validateReplayUpstreamHostEntry,
} from './config-schema.mjs';
import { isCiEnvironment } from './outcome.mjs';

export {
  DEFAULT_AITEST_CONFIG,
  DEFAULT_CONFIG_PROTECTED_GLOBS,
  RESERVED_WEAK_MATCHERS,
  validateAitestConfigObject,
  validateReplayUpstreamHostEntry,
};

/**
 * @typedef {import('./config-schema.mjs').NormalizedAitestConfig} NormalizedAitestConfig
 * @typedef {import('./config-schema.mjs').ParityConfig} ParityConfig
 */

/**
 * @param {string | undefined} flagLang
 * @param {Record<string, string | undefined>} env
 * @returns {'zh' | 'en'}
 */
function resolveConfigLang(flagLang, env) {
  if (flagLang) return String(flagLang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  if (env.AITEST_LANG) return env.AITEST_LANG.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || 'en';
  return String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Parses `.env` text into a plain key-value map without mutating `process.env`.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvText(content) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = cleaned.slice(0, eqIndex).trim();
    let val = cleaned.slice(eqIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Reads and strictly validates `<qaDir>/aitest.config.json`.
 * Never silently swallows malformed JSON or invalid schema: attaches `_configError` and `_configErrors`.
 * @param {string} qaDir
 * @returns {{
 *   ok: boolean;
 *   exists: boolean;
 *   configPath: string;
 *   errors: string[];
 *   config: NormalizedAitestConfig;
 * }}
 */
export function loadAndValidateAitestConfigFile(qaDir) {
  const configPath = path.join(qaDir, 'aitest.config.json');
  if (!fs.existsSync(configPath)) {
    return { ok: true, exists: false, configPath, errors: [], config: createDefaultAitestConfig() };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const msg = `Malformed JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ok: false,
      exists: true,
      configPath,
      errors: [msg],
      config: { ...createDefaultAitestConfig(), _configError: msg, _configErrors: [msg] },
    };
  }

  const validated = validateAitestConfigObject(parsed);
  if (!validated.ok) {
    const msg = validated.errors.join('; ');
    return {
      ok: false,
      exists: true,
      configPath,
      errors: validated.errors,
      config: { ...validated.config, _configError: msg, _configErrors: validated.errors },
    };
  }

  return { ok: true, exists: true, configPath, errors: [], config: validated.config };
}

/**
 * Parses a comma-separated environment variable list into trimmed non-empty strings.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function splitCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Centralized, immutable workbench configuration loader combining `<qaDir>/.env`,
 * injectable process `env`, `<qaDir>/aitest.config.json`, and explicit CLI overrides.
 * Validates environment settings (e.g., `TEST_EGRESS_MODE`) without mutating global `process.env`.
 * @param {{
 *   qaDir: string;
 *   repoDir?: string;
 *   env?: Record<string, string | undefined>;
 *   caller?: 'human-cli' | 'mcp-child' | 'ci';
 *   overrides?: { baseUrl?: string; lang?: string; allowMutation?: boolean; egressMode?: string };
 * }} params
 */
export function loadWorkbenchConfig(params) {
  const qaDir = path.resolve(params.qaDir);
  const repoDir = path.resolve(params.repoDir || path.dirname(qaDir));
  const baseEnv = params.env || process.env;

  /** @type {Record<string, string>} */
  let fileEnv = {};
  const dotEnvPath = path.join(qaDir, '.env');
  if (fs.existsSync(dotEnvPath)) {
    try {
      fileEnv = parseEnvText(fs.readFileSync(dotEnvPath, 'utf8'));
    } catch {
      fileEnv = {};
    }
  }

  /** @type {Record<string, string | undefined>} */
  const mergedEnv = { ...fileEnv, ...baseEnv };
  if (params.overrides?.baseUrl) mergedEnv.TEST_BASE_URL = params.overrides.baseUrl;
  if (params.overrides?.allowMutation !== undefined) {
    mergedEnv.TEST_ALLOW_MUTATION = params.overrides.allowMutation ? '1' : '0';
  }
  if (params.overrides?.egressMode) mergedEnv.TEST_EGRESS_MODE = params.overrides.egressMode;

  const cfgRes = loadAndValidateAitestConfigFile(qaDir);
  /** @type {string[]} */
  const errors = [...cfgRes.errors];

  const rawEgressMode = String(mergedEnv.TEST_EGRESS_MODE || 'permissive').trim().toLowerCase();
  if (rawEgressMode !== 'permissive' && rawEgressMode !== 'allowlist') {
    errors.push(
      `Invalid TEST_EGRESS_MODE="${mergedEnv.TEST_EGRESS_MODE}". Allowed values: "permissive" or "allowlist".`
    );
  }

  const egressMode = /** @type {'permissive' | 'allowlist'} */ (
    rawEgressMode === 'allowlist' ? 'allowlist' : 'permissive'
  );

  const allowMutation =
    mergedEnv.TEST_ALLOW_MUTATION === '1' || String(mergedEnv.TEST_ALLOW_MUTATION || '').toLowerCase() === 'true';

  const ci = isCiEnvironment(mergedEnv);
  const lang = resolveConfigLang(params.overrides?.lang, mergedEnv);
  const caller =
    params.caller ||
    (mergedEnv.AITEST_MCP_CHILD === '1' ? 'mcp-child' : ci ? 'ci' : 'human-cli');

  return Object.freeze({
    ok: errors.length === 0,
    errors,
    caller,
    qaDir,
    repoDir,
    ci,
    lang,
    aitestConfig: cfgRes.config,
    target: Object.freeze({
      testEnv: String(mergedEnv.TEST_ENV || 'staging').trim(),
      baseUrl: String(mergedEnv.TEST_BASE_URL || '').trim(),
      allowedHosts: splitCsv(mergedEnv.TEST_ALLOWED_HOSTS),
      allowMutation,
      egressMode,
      extraAllowedHosts: splitCsv(mergedEnv.TEST_EGRESS_EXTRA_HOSTS || mergedEnv.TEST_EGRESS_ALLOW_HOSTS),
    }),
    env: Object.freeze({ ...mergedEnv }),
  });
}
