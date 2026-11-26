import { ruleG102, ruleG103, ruleG104, ruleG115 } from './assertion-rules.mjs';
import { ruleG105, ruleG106, ruleG107, ruleG108, ruleG109, ruleG110 } from './control-flow-rules.mjs';
import { ruleG116 } from './g116-status-literal.mjs';
import { ruleG117 } from './g117-dieselgate.mjs';
import { ruleG101, ruleG113 } from './governance-rules.mjs';
import { ruleG111, ruleG112, ruleG114 } from './locator-and-oracle-rules.mjs';

/**
 * Canonical registry of all 17 pluggable anti-fake-green gate rules (`AITEST-G101` .. `AITEST-G117`).
 */
export const ALL_GATE_RULES = Object.freeze([
  ruleG101,
  ruleG102,
  ruleG103,
  ruleG104,
  ruleG105,
  ruleG106,
  ruleG107,
  ruleG108,
  ruleG109,
  ruleG110,
  ruleG111,
  ruleG112,
  ruleG113,
  ruleG114,
  ruleG115,
  ruleG116,
  ruleG117,
]);

/** @type {Map<string, (typeof ALL_GATE_RULES)[number]>} */
const RULES_BY_CODE = new Map(ALL_GATE_RULES.map((r) => [r.code, r]));

/**
 * Looks up a gate rule definition by its code (`AITEST-G101`..`AITEST-G117`).
 * @param {string} code
 */
export function getGateRuleByCode(code) {
  return RULES_BY_CODE.get(code) || null;
}

/**
 * Resolves whether a given rule code is enabled under `aitest.config.json#rules`.
 * Note: `aitest.config.json` itself is protected by `.aitest/governance.lock`, so only
 * human-approved governance configs may disable a rule.
 * @param {string} code
 * @param {Record<string, boolean | { enabled?: boolean, severity?: 'error' | 'off' }> | undefined} rulesConfig
 * @param {boolean} [fallbackDefaultEnabled]
 */
export function isRuleEnabled(code, rulesConfig, fallbackDefaultEnabled = true) {
  const rule = RULES_BY_CODE.get(code);
  const defaultOn = rule ? rule.defaultEnabled !== false : fallbackDefaultEnabled;
  if (!rulesConfig || !(code in rulesConfig)) return defaultOn;
  const entry = rulesConfig[code];
  if (typeof entry === 'boolean') return entry;
  if (entry && typeof entry === 'object') {
    if (entry.severity === 'off') return false;
    if (typeof entry.enabled === 'boolean') return entry.enabled;
  }
  return defaultOn;
}

/**
 * Formats a structured `GateFinding` into the canonical `[Healer Diff Guard][AITEST-Gxxx] ...` diagnostic string.
 * @param {{ code: string, message: string, rawFormatted?: string }} finding
 */
export function formatFinding(finding) {
  if (finding.rawFormatted) return finding.rawFormatted;
  return `[Healer Diff Guard][${finding.code}] ${finding.message}`;
}

/**
 * Executes all enabled pluggable gate rules (plus optional programmatic `ctx.extraRules`)
 * over a base/head comparison context, returning both structured `findings` and deduplicated `violations` strings.
 * @param {Record<string, any>} ctx
 */
export function evaluateDiffRules(ctx) {
  const rulesConfig = ctx.rulesConfig || {};
  const findings = [];
  const seenKeys = new Set();
  /** @type {Set<string>} */
  const priorFindingCodes = new Set();
  const extraRules = Array.isArray(ctx.extraRules)
    ? ctx.extraRules.filter((/** @type {any} */ r) => r && typeof r.code === 'string' && typeof r.evaluate === 'function')
    : [];
  const activeRules = extraRules.length > 0 ? [...ALL_GATE_RULES, ...extraRules] : ALL_GATE_RULES;

  for (const rule of activeRules) {
    if (!isRuleEnabled(rule.code, rulesConfig, rule.defaultEnabled !== false)) continue;
    const emitted = rule.evaluate({ ...ctx, priorFindingCodes }) || [];
    for (const f of emitted) {
      const formatted = formatFinding(f);
      if (seenKeys.has(formatted)) continue;
      seenKeys.add(formatted);
      priorFindingCodes.add(f.code);
      findings.push(f);
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    violations: findings.map(formatFinding),
  };
}
