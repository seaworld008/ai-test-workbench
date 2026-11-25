import { diffEventSnippets } from './governance-rules.mjs';

/**
 * @typedef {import('./governance-rules.mjs').GateFinding} GateFinding
 * @typedef {import('./governance-rules.mjs').RuleEvalCtx} RuleEvalCtx
 */

/**
 * Computes commit-level cross-file assertion & strength pooling metrics when `changesetContext`
 * contains multiple changed spec files (e.g. splitting a large spec into sibling spec files).
 * @param {RuleEvalCtx['changesetContext']} changesetContext
 * @param {string} currentFile
 */
function computeChangesetPoolMetrics(changesetContext, currentFile) {
  const entries = changesetContext?.entries;
  if (!Array.isArray(entries) || entries.length <= 1) return null;

  let totalBaseCount = 0;
  let totalHeadCount = 0;
  let totalBaseStrength = 0;
  let totalHeadStrength = 0;
  let totalBaseMax = 0;
  let totalHeadMax = 0;
  let siblingAddedCount = 0;
  let siblingAddedStrength = 0;
  let totalBaseCriticalTags = 0;
  let totalHeadCriticalTags = 0;
  let siblingAddedCriticalTags = 0;

  for (const e of entries) {
    if (e.isExecutableSpec === false && e.filePath !== currentFile) continue;
    const bAsserts = e.baseSum?.assertions || [];
    const hAsserts = e.headSum?.assertions || [];
    const bCount = bAsserts.length;
    const hCount = hAsserts.length;
    const bStr = bAsserts.reduce((s, a) => s + a.tier, 0);
    const hStr = hAsserts.reduce((s, a) => s + a.tier, 0);
    const bMax = bCount > 0 ? Math.max(...bAsserts.map((a) => a.tier)) : 0;
    const hMax = hCount > 0 ? Math.max(...hAsserts.map((a) => a.tier)) : 0;
    const bCrit = (e.baseSum?.criticalTags || []).length;
    const hCrit = (e.headSum?.criticalTags || []).length;

    totalBaseCount += bCount;
    totalHeadCount += hCount;
    totalBaseStrength += bStr;
    totalHeadStrength += hStr;
    totalBaseCriticalTags += bCrit;
    totalHeadCriticalTags += hCrit;
    if (bMax > totalBaseMax) totalBaseMax = bMax;
    if (hMax > totalHeadMax) totalHeadMax = hMax;

    if (e.filePath !== currentFile) {
      if (hCount > bCount) siblingAddedCount += hCount - bCount;
      if (hStr > bStr) siblingAddedStrength += hStr - bStr;
      if (hCrit > bCrit) siblingAddedCriticalTags += hCrit - bCrit;
    }
  }

  return {
    totalBaseCount,
    totalHeadCount,
    totalBaseStrength,
    totalHeadStrength,
    totalBaseMax,
    totalHeadMax,
    siblingAddedCount,
    siblingAddedStrength,
    totalBaseCriticalTags,
    totalHeadCriticalTags,
    siblingAddedCriticalTags,
  };
}

/**
 * Filters assertions to baseline-existing test blocks when `baselineTestTitles` is provided (`WU-04`).
 * @param {any[]} assertions
 * @param {Set<string> | null | undefined} baselineTestTitles
 */
function scopeAssertionsToBaseline(assertions, baselineTestTitles) {
  if (!baselineTestTitles) return assertions;
  return assertions.filter((a) => !a.testTitle || baselineTestTitles.has(a.testTitle));
}

/**
 * AITEST-G102: Net assertion deletion between base and head (with commit-level cross-file split pooling).
 */
export const ruleG102 = {
  code: 'AITEST-G102',
  name: 'no-assertion-deletion',
  description: 'Blocks net reduction in assertion count unless consolidated into an ARIA snapshot or relocated into sibling specs in the same commit.',
  waiverKey: 'assertion-deletion',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    const {
      file = '',
      baseSum,
      headSum,
      canWaive = () => false,
      changesetContext,
      isBaselineNewSpec = false,
      baselineTestTitles = null,
      exemptBranchNewRegression = false,
      exemptScaffoldRemoval = false,
    } = ctx;
    if (!baseSum || !headSum) return [];
    if (exemptScaffoldRemoval) return [];
    if (isBaselineNewSpec && exemptBranchNewRegression) return [];

    const scopeSet = exemptBranchNewRegression ? baselineTestTitles : null;
    const baseAsserts = scopeAssertionsToBaseline(baseSum.assertions, scopeSet);
    const headAsserts = scopeAssertionsToBaseline(headSum.assertions, scopeSet);

    const baseCount = baseAsserts.length;
    const rawHeadCount = headAsserts.length;
    const baseHasCount = baseAsserts.some((a) => a.matcher === 'toHaveCount');
    const implicitCredits = baseHasCount ? headAsserts.filter((a) => a.implicitCountCredit).length : 0;
    const headCount = rawHeadCount + implicitCredits;
    const baseAriaCount = baseAsserts.filter((a) => a.isAriaSnapshot).length;
    const headAriaCount = headAsserts.filter((a) => a.isAriaSnapshot).length;
    const consolidatedIntoAria = headAriaCount > baseAriaCount && baseCount - rawHeadCount <= 2;

    const pool = computeChangesetPoolMetrics(changesetContext, file);
    const relocatedToSibling =
      pool !== null && pool.siblingAddedCount > 0 && pool.totalHeadCount >= pool.totalBaseCount;

    if (
      baseCount > headCount &&
      !consolidatedIntoAria &&
      !relocatedToSibling &&
      !canWaive('assertion-deletion') &&
      !canWaive('AITEST-G102')
    ) {
      return [
        {
          code: 'AITEST-G102',
          severity: 'error',
          file,
          message: `${file}: net assertion reduction detected (base ${baseCount} -> head ${rawHeadCount}).`,
          evidence: { baseCount, headCount: rawHeadCount },
        },
      ];
    }

    // Per-REQ test-block accounting: prevent padding one block after gutting a REQ-* block
    const baseBlocks = baseSum.testBlocks || [];
    const headBlocks = headSum.testBlocks || [];
    if (!relocatedToSibling && !consolidatedIntoAria && baseBlocks.length > 1) {
      for (const bBlock of baseBlocks) {
        if (!bBlock.reqIds?.length || !bBlock.assertions?.length) continue;
        const matchingHead = headBlocks.filter(
          (/** @type {any} */ hb) =>
            hb.title === bBlock.title || (hb.reqIds || []).some((/** @type {string} */ r) => bBlock.reqIds.includes(r))
        );
        const headReqAsserts = matchingHead.reduce((/** @type {number} */ n, /** @type {any} */ hb) => n + (hb.assertions?.length || 0), 0);
        if (headReqAsserts === 0 && !canWaive('assertion-deletion') && !canWaive('AITEST-G102')) {
          return [
            {
              code: 'AITEST-G102',
              severity: 'error',
              file,
              line: bBlock.line,
              testTitle: bBlock.title,
              message: `${file}: requirement test block [${bBlock.reqIds.join(', ')}] lost all assertions or was deleted.`,
              evidence: { reqIds: bBlock.reqIds, testTitle: bBlock.title },
            },
          ];
        }
      }
    }
    return [];
  },
};

/**
 * AITEST-G103: Assertion strength lattice downgrade OR positive -> `.not` negation flip.
 */
export const ruleG103 = {
  code: 'AITEST-G103',
  name: 'no-assertion-weakening',
  description: 'Blocks weakening assertion strength on the S0-S5 lattice or flipping positive assertions into .not checks.',
  waiverKey: 'assertion-weakening',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    const {
      file = '',
      baseSum,
      headSum,
      canWaive = () => false,
      changesetContext,
      isBaselineNewSpec = false,
      baselineTestTitles = null,
      exemptBranchNewRegression = false,
      exemptScaffoldRemoval = false,
    } = ctx;
    if (!baseSum || !headSum) return [];
    if (exemptScaffoldRemoval) return [];
    if (isBaselineNewSpec && exemptBranchNewRegression) return [];

    const scopeSet = exemptBranchNewRegression ? baselineTestTitles : null;
    const baseAsserts = scopeAssertionsToBaseline(baseSum.assertions, scopeSet);
    const headAsserts = scopeAssertionsToBaseline(headSum.assertions, scopeSet);

    const baseCount = baseAsserts.length;
    const headCount = headAsserts.length;
    if (baseCount === 0 || headCount === 0) return [];

    const baseAriaCount = baseAsserts.filter((a) => a.isAriaSnapshot).length;
    const headAriaCount = headAsserts.filter((a) => a.isAriaSnapshot).length;
    const consolidatedIntoAria = headAriaCount > baseAriaCount && baseCount - headCount <= 2;

    const baseMax = Math.max(...baseAsserts.map((a) => a.tier));
    const headMax = Math.max(...headAsserts.map((a) => a.tier));
    const baseSumTier = baseAsserts.reduce((s, a) => s + a.tier, 0);
    const baseHasCount = baseAsserts.some((a) => a.matcher === 'toHaveCount');
    const implicitStrengthCredit = baseHasCount
      ? headAsserts.filter((a) => a.implicitCountCredit).length * 4
      : 0;
    const headSumTier = headAsserts.reduce((s, a) => s + a.tier, 0) + implicitStrengthCredit;
    const baseNegated = baseAsserts.filter((a) => a.isNegated).length;
    const headNegated = headAsserts.filter((a) => a.isNegated).length;

    // Screenshot tolerance inflation or expectApiContract schema removal
    const maxTol = (/** @type {any[]} */ list, /** @type {string} */ k) =>
      Math.max(0, ...list.map((a) => Number(a.screenshotOptions?.[k] || 0)));
    const screenshotRelaxed =
      headAsserts.some((a) => a.screenshotOptions) &&
      (['maxDiffPixelRatio', 'maxDiffPixels', 'threshold'].some((k) => maxTol(headAsserts, k) > maxTol(baseAsserts, k)));
    const baseHadApiSchema = baseAsserts.some((a) => a.matcher === 'expectApiContract' && a.hasApiSchema);
    const headHasApiSchema = headAsserts.some((a) => a.matcher === 'expectApiContract' && a.hasApiSchema);
    const apiSchemaDropped = baseHadApiSchema && !headHasApiSchema;

    const pool = computeChangesetPoolMetrics(changesetContext, file);
    const strengthRelocatedToSibling =
      pool !== null &&
      pool.siblingAddedStrength > 0 &&
      pool.totalHeadStrength >= pool.totalBaseStrength &&
      pool.totalHeadMax >= pool.totalBaseMax &&
      headNegated <= baseNegated;

    const downgraded =
      screenshotRelaxed ||
      apiSchemaDropped ||
      (!consolidatedIntoAria && !strengthRelocatedToSibling && (headMax < baseMax || headSumTier < baseSumTier)) ||
      (headNegated > baseNegated && headSumTier <= baseSumTier);

    if (downgraded && !canWaive('assertion-weakening') && !canWaive('AITEST-G103')) {
      return [
        {
          code: 'AITEST-G103',
          severity: 'error',
          file,
          message: `${file}: assertion strength downgraded (${screenshotRelaxed ? 'screenshot tolerance inflated' : apiSchemaDropped ? 'expectApiContract schema removed' : `max tier S${baseMax} -> S${headMax}, total strength ${baseSumTier} -> ${headSumTier}${headNegated > baseNegated ? ', positive->negated flip' : ''}`}).`,
          evidence: { baseMax, headMax, baseSumTier, headSumTier, baseNegated, headNegated, screenshotRelaxed, apiSchemaDropped },
        },
      ];
    }

    // Per-REQ max assertion strength conservation (`G2-F14`): prevent weakening a REQ-* test block and padding a sibling test
    const baseBlocks = baseSum.testBlocks || [];
    const headBlocks = headSum.testBlocks || [];
    const allHeadBlocks = Array.isArray(changesetContext?.entries)
      ? changesetContext.entries
          .filter((/** @type {any} */ e) => e.isExecutableSpec !== false)
          .flatMap((/** @type {any} */ e) => e.headSum?.testBlocks || [])
      : headBlocks;
    if (!consolidatedIntoAria && !canWaive('assertion-weakening') && !canWaive('AITEST-G103')) {
      for (const bBlock of baseBlocks) {
        if (!bBlock.reqIds?.length || !bBlock.assertions?.length) continue;
        if (scopeSet && !scopeSet.has(bBlock.title)) continue;
        const baseBlockMax = Math.max(...bBlock.assertions.map((/** @type {any} */ a) => a.tier));
        const matchingHead = allHeadBlocks.filter(
          (/** @type {any} */ hb) =>
            hb.title === bBlock.title || (hb.reqIds || []).some((/** @type {string} */ r) => bBlock.reqIds.includes(r))
        );
        const headBlockAsserts = matchingHead.flatMap((/** @type {any} */ hb) => hb.assertions || []);
        if (headBlockAsserts.length === 0) continue;
        const headBlockMax = Math.max(...headBlockAsserts.map((/** @type {any} */ a) => a.tier));
        if (headBlockMax < baseBlockMax) {
          return [
            {
              code: 'AITEST-G103',
              severity: 'error',
              file,
              line: bBlock.line,
              testTitle: bBlock.title,
              message: `${file}: requirement test block [${bBlock.reqIds.join(', ')}] downgraded max assertion tier (S${baseBlockMax} -> S${headBlockMax}); sibling tests cannot compensate.`,
              evidence: { reqIds: bBlock.reqIds, testTitle: bBlock.title, baseBlockMax, headBlockMax },
            },
          ];
        }
      }
    }
    return [];
  },
};

/**
 * AITEST-G104: S0 tautology, self-referential oracle, or vacuous matcher (`expect(true).toBe(true)`, `/.* /`, `() => true`).
 */
export const ruleG104 = {
  code: 'AITEST-G104',
  name: 'no-s0-tautology',
  description: 'Blocks S0 tautologies, self-referential DOM oracles, and vacuous regex/predicate matchers.',
  waiverKey: 's0-tautology',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    const { file = '', baseSum, headSum, canWaive = () => false } = ctx;
    /** @type {GateFinding[]} */
    const findings = [];
    for (const ev of diffEventSnippets(baseSum?.events?.tautologies, headSum?.events?.tautologies)) {
      if (canWaive(ev.snippet) || canWaive('AITEST-G104')) continue;
      findings.push({
        code: 'AITEST-G104',
        severity: 'error',
        file,
        line: ev.line,
        testTitle: ev.testTitle || undefined,
        message: ev.message,
        evidence: { label: ev.label, snippet: ev.snippet },
      });
    }
    return findings;
  },
};

/**
 * AITEST-G115: Removal of `@critical` or `@smoke` tags from test/describe titles.
 */
export const ruleG115 = {
  code: 'AITEST-G115',
  name: 'no-critical-tag-removal',
  description: 'Blocks removing @critical or @smoke tags from test or describe titles.',
  waiverKey: 'tag-removal',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    const {
      file = '',
      baseSum,
      headSum,
      canWaive = () => false,
      changesetContext,
      isBaselineNewSpec = false,
      baselineTestTitles = null,
      exemptBranchNewRegression = false,
      exemptScaffoldRemoval = false,
    } = ctx;
    if (!baseSum || !headSum) return [];
    if (exemptScaffoldRemoval) return [];
    if (isBaselineNewSpec && exemptBranchNewRegression) return [];

    const pool = computeChangesetPoolMetrics(changesetContext, file);
    const criticalRelocatedToSibling =
      pool !== null &&
      pool.siblingAddedCriticalTags > 0 &&
      pool.totalHeadCriticalTags >= pool.totalBaseCriticalTags;

    let baseTagCount = baseSum.criticalTags.length;
    let headTagCount = headSum.criticalTags.length;
    if (exemptBranchNewRegression && baselineTestTitles) {
      const countBranchNewBlockTags = (/** @type {any} */ sum) =>
        (sum.testBlocks || [])
          .filter((/** @type {any} */ tb) => !baselineTestTitles.has(tb.title))
          .reduce(
            (/** @type {number} */ n, /** @type {any} */ tb) =>
              n + (String(tb.title || '').match(/@(?:critical|smoke)\b/gi) || []).length,
            0
          );
      baseTagCount = Math.max(0, baseTagCount - countBranchNewBlockTags(baseSum));
      headTagCount = Math.max(0, headTagCount - countBranchNewBlockTags(headSum));
    }

    if (
      headTagCount < baseTagCount &&
      !criticalRelocatedToSibling &&
      !canWaive('tag-removal') &&
      !canWaive('AITEST-G115')
    ) {
      return [
        {
          code: 'AITEST-G115',
          severity: 'error',
          file,
          message: `${file}: @critical/@smoke tag removed from test title (${baseTagCount} -> ${headTagCount}).`,
          evidence: { baseTags: baseSum.criticalTags, headTags: headSum.criticalTags },
        },
      ];
    }
    return [];
  },
};
