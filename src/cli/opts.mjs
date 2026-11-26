// @ts-check

export const STR = /** @type {const} */ ({ type: 'string' });
export const STR_MULTI = /** @type {const} */ ({ type: 'string', multiple: true });
export const BOOL = /** @type {const} */ ({ type: 'boolean' });

export const BASE_OPTS = {
  help: { type: /** @type {'boolean'} */ ('boolean'), short: 'h' },
  lang: STR,
  json: BOOL,
};

export const TARGET_OPTS = {
  ...BASE_OPTS,
  target: STR,
  'qa-dir': STR,
};

export const WORKSPACE_MUTATION_OPTS = {
  ...TARGET_OPTS,
  'dry-run': BOOL,
  force: BOOL,
};

/** @type {Record<string, { min: number, max?: number, int?: boolean }>} */
const NUMERIC_FLAG_BOUNDS = {
  port: { min: 0, max: 65535, int: true },
  workers: { min: 1, max: 64, int: true },
  retries: { min: 0, max: 20, int: true },
  line: { min: 1, int: true },
  'max-flaky': { min: 0, int: true },
  'max-skipped': { min: 0, int: true },
  'budget-ms': { min: 1, int: true },
  'max-pages': { min: 1, max: 500, int: true },
  'max-portals': { min: 1, max: 20, int: true },
  'max-tabs': { min: 0, max: 50, int: true },
  'max-dialogs': { min: 0, max: 50, int: true },
  concurrency: { min: 1, max: 100, int: true },
  iterations: { min: 1, max: 5000, int: true },
  samples: { min: 1, max: 50, int: true },
  timeout: { min: 1, int: true },
  'max-scan-files': { min: 100, max: 200000, int: true },
  'max-files': { min: 1, max: 200000, int: true },
  'max-latency-ratio': { min: 0.01 },
  'max-ttft-ratio': { min: 0.01 },
};

/**
 * Validates numeric CLI option strings before coercing with `Number(...)` (`P2-01`).
 * Prevents silent `NaN` / negative / fractional corruption by failing fast with exit code `64`.
 * @param {string} cmd
 * @param {Record<string, any>} values
 * @returns {string | null}
 */
export function validateCliOptionValues(cmd, values) {
  for (const [flag, rule] of Object.entries(NUMERIC_FLAG_BOUNDS)) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const text = String(raw).trim();
    const num = Number(text);
    const min = flag === 'port' && cmd === 'bootstrap' ? 1 : rule.min;
    if (!text || !Number.isFinite(num)) {
      return `[CLI Option Error] Invalid numeric value for --${flag} on "${cmd}": "${raw}" (expected finite number).`;
    }
    if (rule.int && !Number.isInteger(num)) {
      return `[CLI Option Error] Invalid integer value for --${flag} on "${cmd}": "${raw}" (expected whole integer).`;
    }
    if (num < min || (rule.max !== undefined && num > rule.max)) {
      const range = rule.max !== undefined ? `${min}..${rule.max}` : `>= ${min}`;
      return `[CLI Option Error] Value for --${flag} on "${cmd}" out of bounds (${raw}); expected ${range}.`;
    }
  }
  if (values.lang !== undefined && !['zh', 'en'].includes(String(values.lang).toLowerCase())) {
    return `[CLI Option Error] Invalid --lang "${values.lang}" on "${cmd}". Expected: zh | en.`;
  }
  if (
    cmd === 'skill-install' &&
    values.client !== undefined &&
    !['qa', 'codex', 'claude', 'agents', 'gemini', 'copilot'].includes(String(values.client).toLowerCase())
  ) {
    return `[CLI Option Error] Unsupported --client "${values.client}". Allowed: qa, codex, claude, agents, gemini, copilot.`;
  }
  if (
    (cmd === 'run' || cmd === 'verify-change') &&
    values.suite !== undefined
  ) {
    const allowedSuites =
      cmd === 'verify-change'
        ? ['auto', 'smoke', 'e2e', 'api', 'a11y', 'critical', 'seed', 'all', 'impact']
        : ['smoke', 'e2e', 'api', 'a11y', 'critical', 'seed', 'all', 'impact'];
    if (!allowedSuites.includes(String(values.suite).toLowerCase())) {
      return `[CLI Option Error] Unsupported --suite "${values.suite}" on "${cmd}". Allowed: ${allowedSuites.join(', ')}.`;
    }
  }
  return null;
}

/** @param {Record<string, any>} v @param {'zh' | 'en'} lang */
export function makeCommon(v, lang) {
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
 * Resolves paired positive/negative CLI boolean flags (`--explore-*` vs `--no-explore-*`).
 * When both flags appear on the same command line, the last flag wins; otherwise explicit
 * `--no-*` yields `false`, explicit `--*` yields `true`, and omitting both yields `defaultValue`.
 * @param {Record<string, any>} values
 * @param {string} posFlag
 * @param {string} negFlag
 * @param {boolean} [defaultValue]
 * @param {Array<{ kind?: string, name?: string }>} [tokens]
 * @returns {boolean}
 */
export function resolvePairedBooleanFlag(values, posFlag, negFlag, defaultValue = true, tokens = undefined) {
  if (Array.isArray(tokens)) {
    /** @type {boolean | undefined} */
    let resolved;
    for (const tok of tokens) {
      if (tok && tok.kind === 'option') {
        if (tok.name === posFlag) resolved = true;
        else if (tok.name === negFlag) resolved = false;
      }
    }
    if (resolved !== undefined) return resolved;
  }
  if (values[negFlag]) return false;
  if (values[posFlag]) return true;
  return defaultValue;
}
