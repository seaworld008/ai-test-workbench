/**
 * @typedef {import('./governance-rules.mjs').GateFinding} GateFinding
 * @typedef {import('./governance-rules.mjs').RuleEvalCtx} RuleEvalCtx
 */

/**
 * Maps an HTTP status code to its coarse equivalence class (`2xx`, `3xx`, `401_403`, `404`, `409_422`, `5xx`, or generic `4xx`).
 * @param {number} code
 * @returns {string | null}
 */
export function classifyHttpStatusEquivalence(code) {
  if (!Number.isFinite(code)) return null;
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code === 401 || code === 403) return '401_403';
  if (code === 404) return '404';
  if (code === 409 || code === 422) return '409_422';
  if (code >= 400 && code < 500) return '4xx_other';
  if (code >= 500 && code < 600) return '5xx';
  return null;
}

/**
 * Collects HTTP status equivalence classes referenced across status assertions.
 * @param {any[]} assertions
 */
function summarizeStatusClasses(assertions) {
  /** @type {Set<string>} */
  const classes = new Set();
  let exactStatusChecks = 0;
  let rangeOrMultiStatusChecks = 0;

  for (const a of assertions || []) {
    if (!a.isStatusCheck) continue;
    const codes = Array.isArray(a.statusCodes) ? a.statusCodes : [];
    const clsForAssert = new Set();
    for (const c of codes) {
      const cls = classifyHttpStatusEquivalence(Number(c));
      if (cls) {
        classes.add(cls);
        clsForAssert.add(cls);
      }
    }
    if (a.isStatusRangeCheck || clsForAssert.size > 1) {
      rangeOrMultiStatusChecks += 1;
    } else if (codes.length === 1) {
      exactStatusChecks += 1;
    }
  }

  return { classes, exactStatusChecks, rangeOrMultiStatusChecks };
}

/**
 * AITEST-G116 (`WU-05`): Blocks cross-class HTTP status expectation shifts (e.g. `403 -> 200`, `200 -> 404`, `409 -> 201`)
 * and widening an exact HTTP status check into broad ranges/arrays (`res.status() < 500`, `[200, 404].includes`).
 */
export const ruleG116 = {
  code: 'AITEST-G116',
  name: 'no-status-class-or-contract-drift',
  description: 'Blocks shifting HTTP status oracles across equivalence classes (2xx/3xx/401-403/404/409-422/5xx) or widening exact status assertions into ranges.',
  waiverKey: 'status-class-drift',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} ctx @returns {GateFinding[]} */
  evaluate(ctx) {
    const {
      file = '',
      baseSum,
      headSum,
      canWaive = () => false,
      isBaselineNewSpec = false,
      baselineTestTitles = null,
      exemptBranchNewRegression = false,
    } = ctx;
    if (!baseSum || !headSum) return [];
    if (isBaselineNewSpec && exemptBranchNewRegression) return [];
    if (canWaive('status-class-drift') || canWaive('AITEST-G116')) return [];

    const scopeSet = exemptBranchNewRegression ? baselineTestTitles : null;
    const filterAsserts = (/** @type {any[]} */ list) =>
      scopeSet ? (list || []).filter((a) => !a.testTitle || scopeSet.has(a.testTitle)) : list || [];

    const baseStatus = summarizeStatusClasses(filterAsserts(baseSum.assertions));
    const headStatus = summarizeStatusClasses(filterAsserts(headSum.assertions));

    if (baseStatus.exactStatusChecks === 0 && baseStatus.classes.size === 0) return [];

    const lostClasses = [...baseStatus.classes].filter((c) => !headStatus.classes.has(c));
    const gainedClasses = [...headStatus.classes].filter((c) => !baseStatus.classes.has(c));

    if (lostClasses.length > 0 && gainedClasses.length > 0) {
      return [
        {
          code: 'AITEST-G116',
          severity: 'error',
          file,
          message: `${file}: HTTP status equivalence class shifted (${lostClasses.join(', ')} -> ${gainedClasses.join(', ')}).`,
          evidence: { lostClasses, gainedClasses },
        },
      ];
    }

    if (
      baseStatus.exactStatusChecks > 0 &&
      headStatus.rangeOrMultiStatusChecks > baseStatus.rangeOrMultiStatusChecks
    ) {
      return [
        {
          code: 'AITEST-G116',
          severity: 'error',
          file,
          message: `${file}: exact HTTP status oracle widened into range or multi-class status check.`,
          evidence: {
            baseExact: baseStatus.exactStatusChecks,
            baseRange: baseStatus.rangeOrMultiStatusChecks,
            headRange: headStatus.rangeOrMultiStatusChecks,
          },
        },
      ];
    }

    return [];
  },
};
