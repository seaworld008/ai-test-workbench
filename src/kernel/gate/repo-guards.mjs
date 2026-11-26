// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { getFileAtGitRef, listChangedFilesUnderDir } from './git-utils.mjs';
import { isCoveredByWaiver } from './policy.mjs';
import { evaluateProductProjectRules } from './project-rules.mjs';
import { evaluateProductFileAst } from './rules/g117-dieselgate.mjs';
import { evaluateLockstepRules } from './rules/g118-lockstep.mjs';
import { formatFinding, isRuleEnabled } from './rules/index.mjs';

/**
 * Evaluates repository-wide Layer 3 diff guards outside `qa/`:
 * 1. `AITEST-G117` (Product-Side Dieselgate branching)
 * 2. `AITEST-G118` (Cross-directory / cross-stack lockstep synchronization)
 * 3. Governance-locked declarative product rules from `qa/support/project-rules.json`
 *
 * Extracted from `changeset.mjs` to keep every gate module cleanly under 435 LOC.
 *
 * @param {{
 *   gitRoot: string;
 *   realQaDir: string;
 *   qaDir: string;
 *   diffBase: string;
 *   cfg: Record<string, any>;
 *   activeWaivers: Array<Record<string, any>>;
 *   productRuleSpecs?: import('./project-rules.mjs').CompiledProjectRuleSpec[];
 *   tsCompiler?: any;
 * }} params
 * @returns {{ findings: Array<Record<string, any>>, violations: string[], repoChangedFiles: string[] }}
 */
export function runRepoLevelDiffGuards(params) {
  const { gitRoot, realQaDir, qaDir, diffBase, cfg, activeWaivers, productRuleSpecs = [] } = params;
  const rulesConfig = cfg.rules || {};
  const g117Enabled = isRuleEnabled('AITEST-G117', rulesConfig);
  const lockstepRules = Array.isArray(cfg.lockstepRules) ? cfg.lockstepRules : [];
  const g118Enabled = lockstepRules.length > 0 && isRuleEnabled('AITEST-G118', rulesConfig);
  const activeProductRules = productRuleSpecs.filter(
    (s) => s.scope !== 'specs' && isRuleEnabled(s.code, rulesConfig, true)
  );

  if (!g117Enabled && !g118Enabled && activeProductRules.length === 0) {
    return { findings: [], violations: [], repoChangedFiles: [] };
  }

  const repoChanged = listChangedFilesUnderDir(gitRoot, diffBase, gitRoot);
  if (!repoChanged.ok) {
    return { findings: [], violations: [], repoChangedFiles: [] };
  }

  const repoItems = [
    ...repoChanged.changed.map((c) => ({ rel: c.path, status: c.status, oldRel: c.oldPath || c.path })),
    ...repoChanged.untracked.map((p) => ({ rel: p, status: 'U', oldRel: null })),
  ];
  const repoChangedFiles = [...new Set(repoItems.map((i) => i.rel.replace(/\\/g, '/')))];

  /** @type {Array<Record<string, any>>} */
  const findings = [];
  /** @type {string[]} */
  const violations = [];

  if (g118Enabled) {
    const lockFindings = evaluateLockstepRules({
      lockstepRules,
      repoChangedFiles,
      activeWaivers,
    });
    for (const f of lockFindings) {
      findings.push(f);
      violations.push(formatFinding(f));
    }
  }

  if (g117Enabled || activeProductRules.length > 0) {
    for (const item of repoItems) {
      const normRel = item.rel.replace(/\\/g, '/');
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(normRel)) continue;
      const absProd = path.join(gitRoot, item.rel);
      const relFromQa = path.relative(realQaDir, absProd).replace(/\\/g, '/');
      if (!relFromQa.startsWith('..')) continue;
      if (
        /^(?:qa|test|tests|bench|scripts|reports|knowledge|\.aitest|node_modules)\//i.test(normRel) ||
        /\/(?:qa|test|tests|bench|reports|knowledge|\.aitest|node_modules)\//i.test(normRel)
      ) {
        continue;
      }
      if (/\.(?:spec|test)\.[jt]sx?$/i.test(normRel)) continue;

      const baseProd =
        item.oldRel && item.status !== 'A' && item.status !== 'U'
          ? getFileAtGitRef(gitRoot, diffBase, item.oldRel) || ''
          : '';
      const headProd =
        fs.existsSync(absProd) && fs.statSync(absProd).isFile() ? fs.readFileSync(absProd, 'utf8') : '';

      if (
        g117Enabled &&
        /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(normRel) &&
        !isCoveredByWaiver({ file: normRel, title: 'AITEST-G117' }, activeWaivers, 'diff')
      ) {
        const dgRes = evaluateProductFileAst(normRel, baseProd, headProd, {
          qaDir,
          ...('tsCompiler' in params ? { tsCompiler: params.tsCompiler } : {}),
        });
        findings.push(...dgRes.findings);
        violations.push(...dgRes.violations);
      }

      if (activeProductRules.length > 0) {
        const nonWaivedRules = activeProductRules.filter(
          (r) =>
            !isCoveredByWaiver({ file: normRel, title: r.code }, activeWaivers, 'diff') &&
            !isCoveredByWaiver({ file: normRel, title: r.id }, activeWaivers, 'diff')
        );
        if (nonWaivedRules.length > 0) {
          const projRes = evaluateProductProjectRules(normRel, baseProd, headProd, nonWaivedRules);
          findings.push(...projRes.findings);
          violations.push(...projRes.violations);
        }
      }
    }
  }

  return { findings, violations, repoChangedFiles };
}
