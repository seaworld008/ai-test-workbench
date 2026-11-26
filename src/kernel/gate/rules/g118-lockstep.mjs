// @ts-check
import { compileGlob } from '../../../core/glob.mjs';
import { isCoveredByWaiver } from '../policy-waivers.mjs';

/**
 * @typedef {import('./governance-rules.mjs').GateFinding} GateFinding
 * @typedef {import('./governance-rules.mjs').RuleEvalCtx} RuleEvalCtx
 * @typedef {import('../../../core/config-schema.mjs').LockstepRuleConfig} LockstepRuleConfig
 */

/**
 * Evaluates cross-directory / cross-stack lockstep synchronization rules (`AITEST-G118`, `WU-E`).
 * Zero-overhead fast path: returns `[]` immediately when `lockstepRules` is absent or empty.
 *
 * @param {{
 *   lockstepRules?: LockstepRuleConfig[];
 *   repoChangedFiles?: string[];
 *   activeWaivers?: Array<Record<string, any>>;
 *   canWaive?: (key: string) => boolean;
 * }} params
 * @returns {GateFinding[]}
 */
export function evaluateLockstepRules(params) {
  const lockstepRules = Array.isArray(params?.lockstepRules) ? params.lockstepRules : [];
  if (lockstepRules.length === 0) return [];

  const changed = Array.isArray(params?.repoChangedFiles)
    ? params.repoChangedFiles.map((p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean)
    : [];
  if (changed.length === 0) return [];

  const activeWaivers = Array.isArray(params?.activeWaivers) ? params.activeWaivers : [];
  const canWaiveFn = typeof params?.canWaive === 'function' ? params.canWaive : () => false;

  /** @type {GateFinding[]} */
  const findings = [];

  for (const rule of lockstepRules) {
    if (!rule || !rule.id || !Array.isArray(rule.whenModified) || !Array.isArray(rule.requireModified)) {
      continue;
    }
    const whenRes = rule.whenModified.map((g) => compileGlob(g));
    const requireRes = rule.requireModified.map((g) => compileGlob(g));

    const triggerFiles = changed.filter((f) => whenRes.some((re) => re.test(f)));
    if (triggerFiles.length === 0) continue;

    const pairedFiles = changed.filter((f) => requireRes.some((re) => re.test(f)));
    if (pairedFiles.length > 0) continue;

    const allowWaiver = rule.allowWaiver !== false;
    if (allowWaiver) {
      const waivedByCtx = canWaiveFn(rule.id) || canWaiveFn('AITEST-G118') || canWaiveFn('lockstep-sync');
      const waivedByList =
        Boolean(isCoveredByWaiver({ file: triggerFiles[0], title: rule.id }, activeWaivers, 'diff')) ||
        Boolean(isCoveredByWaiver({ file: triggerFiles[0], title: 'AITEST-G118' }, activeWaivers, 'diff')) ||
        Boolean(isCoveredByWaiver({ file: rule.id, title: 'AITEST-G118' }, activeWaivers, 'diff'));
      if (waivedByCtx || waivedByList) continue;
    }

    const previewTriggers = triggerFiles.slice(0, 3).join(', ') + (triggerFiles.length > 3 ? ` (+${triggerFiles.length - 3} more)` : '');
    findings.push({
      code: 'AITEST-G118',
      severity: 'error',
      file: triggerFiles[0],
      message: `${triggerFiles[0]}: lockstep rule "${rule.id}" violated — modified [${previewTriggers}] without paired changes matching [${rule.requireModified.join(', ')}]${allowWaiver ? ' (or an approved diff waiver)' : ' (waivers disallowed)'}.`,
      evidence: {
        ruleId: rule.id,
        triggerFiles,
        whenModified: rule.whenModified,
        requireModified: rule.requireModified,
        allowWaiver,
      },
    });
  }

  return findings;
}

/**
 * AITEST-G118 (`WU-E`, v6.4.0): Cross-directory / cross-stack lockstep synchronization gate.
 * Opt-in via governance-locked `aitest.config.json#lockstepRules` (zero overhead & 0.0% FPR when unconfigured).
 */
export const ruleG118 = {
  code: 'AITEST-G118',
  name: 'require-lockstep-paired-changes',
  description: 'Requires paired cross-directory or cross-stack changes whenever configured lockstepRules trigger globs are modified.',
  waiverKey: 'lockstep-sync',
  defaultEnabled: true,
  /** @param {RuleEvalCtx & { lockstepRules?: LockstepRuleConfig[], repoChangedFiles?: string[], activeWaivers?: Array<Record<string, any>> }} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    if (!ctx || !Array.isArray(ctx.lockstepRules) || ctx.lockstepRules.length === 0) return [];
    return evaluateLockstepRules({
      lockstepRules: ctx.lockstepRules,
      repoChangedFiles: ctx.repoChangedFiles,
      activeWaivers: ctx.activeWaivers,
      canWaive: ctx.canWaive,
    });
  },
};
