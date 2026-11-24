import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCiEnvironment } from '../../core/outcome.mjs';
import {
  getFileAtGitRef,
  listChangedFilesUnderDir,
  parseGitDiffHeaderPath,
  resolveGitRoot,
} from './git-utils.mjs';
import {
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  validateAssertFunctionNames,
} from './policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * TypeScript Compiler API AST Semantic Analyzer & Diff Guard v3 (`G-01..G-11`).
 *
 * Uses the real TypeScript parser (`typescript` already installed inside `<qaDir>/node_modules`
 * or `templates/playwright-qa/node_modules`) to inspect full source files AND reconstructed
 * unified diff hunks — eliminating line-by-line regex blindness against Prettier formatting,
 * multi-line try/catch, `.not` negation flips, self-referential oracles, constant folding,
 * `page.route(...fulfill)` backend mocking, and non-ASCII quoted Git paths.
 */

const S5_EXACT_MATCHERS = new Set([
  'toEqual',
  'toStrictEqual',
  'toHaveText',
  'toHaveValue',
  'toHaveValues',
  'toHaveURL',
  'toMatchAriaSnapshot',
  'toHaveScreenshot',
  'toBe',
]);

const S4_STRUCTURAL_MATCHERS = new Set([
  'toHaveCount',
  'toHaveAttribute',
  'toHaveJSProperty',
  'toHaveCSS',
  'toHaveClass',
  'toHaveRole',
  'toHaveAccessibleName',
  'toHaveAccessibleDescription',
  'toHaveId',
  'toHaveTitle',
]);

const S3_PARTIAL_MATCHERS = new Set([
  'toContainText',
  'toContain',
  'toContainEqual',
  'toMatch',
  'toMatchObject',
  'toHaveProperty',
]);

const S2_STATE_MATCHERS = new Set([
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toBeDisabled',
  'toBeChecked',
  'toBeEditable',
  'toBeAttached',
  'toBeInViewport',
  'toBeEmpty',
  'toBeFocused',
  'toBeOK',
]);

const S1_WEAK_MATCHERS = new Set([
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
  'toBeNull',
  'toBeUndefined',
  'toBeNaN',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
]);

const DOMAIN_HELPERS = new Set(['expectAccessible', 'expectPerformanceBudget', 'expectApiContract']);

const SELF_REF_DOM_READERS = new Set([
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'getAttribute',
  'allTextContents',
  'allInnerTexts',
  'count',
  'title',
  'url',
]);

const PURE_CONVERTERS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'parseInt', 'parseFloat']);

const SEMANTIC_LOCATOR_METHODS = new Set([
  'getByRole',
  'getByLabel',
  'getByText',
  'getByTestId',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
]);

const SUCCESS_STATUS_CODES = new Set([200, 201, 202, 204, 400, 401, 403, 404, 409]);

/** @type {Map<string, any>} */
const tsModuleCache = new Map();

/**
 * Attempts to resolve `typescript` compiler module from `qaDir` or bundled template `node_modules`.
 * @param {string} [qaDir]
 */
export function resolveTypeScriptCompiler(qaDir) {
  const cacheKey = qaDir ? path.resolve(qaDir) : '__default__';
  if (tsModuleCache.has(cacheKey)) return tsModuleCache.get(cacheKey);

  const req = createRequire(import.meta.url);
  const candidates = [];
  if (qaDir) {
    candidates.push(path.join(qaDir, 'node_modules', 'typescript'));
  }
  // Support both vendored (<qa>/support/gate/) and authoritative (src/kernel/gate/) locations
  candidates.push(path.resolve(__dirname, '..', '..', 'node_modules', 'typescript'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'typescript'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'templates', 'playwright-qa', 'node_modules', 'typescript'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'typescript'));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const mod = req(candidate);
        tsModuleCache.set(cacheKey, mod);
        return mod;
      }
    } catch {
      // try next candidate
    }
  }
  tsModuleCache.set(cacheKey, null);
  return null;
}

function unwrapExpr(ts, node) {
  let cur = node;
  while (cur) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(cur))
    ) {
      cur = cur.expression;
    } else {
      break;
    }
  }
  return cur;
}

/**
 * Recursive AST constant evaluator for S0 tautology detection (`G-04`).
 * Detects `true`, `(true)`, `1 + 1`, `Number('1')`, `[1].length`, `await page.evaluate(() => 1)`, etc.
 */
function isConstantExpressionAst(ts, sf, rawNode) {
  if (!rawNode) return false;
  const node = unwrapExpr(ts, rawNode);
  if (!node) return false;

  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isBigIntLiteral(node)
  ) {
    return true;
  }

  if (ts.isIdentifier(node) && (node.text === 'undefined' || node.text === 'NaN' || node.text === 'Infinity')) {
    return true;
  }

  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((span) => isConstantExpressionAst(ts, sf, span.expression));
  }

  if (ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.expression);
  }

  if (ts.isBinaryExpression(node)) {
    return (
      isConstantExpressionAst(ts, sf, node.left) &&
      isConstantExpressionAst(ts, sf, node.right)
    );
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((el) => isConstantExpressionAst(ts, sf, el));
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) return isConstantExpressionAst(ts, sf, prop.initializer);
      return false;
    });
  }

  if (ts.isPropertyAccessExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.expression);
  }

  if (ts.isElementAccessExpression(node)) {
    return (
      isConstantExpressionAst(ts, sf, node.expression) &&
      isConstantExpressionAst(ts, sf, node.argumentExpression)
    );
  }

  if (ts.isAwaitExpression(node)) {
    const inner = unwrapExpr(ts, node.expression);
    // Detect `await page.evaluate(() => 1)` / `await locator.evaluate(() => true)`
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === 'evaluate' &&
      inner.arguments.length >= 1
    ) {
      const fnArg = unwrapExpr(ts, inner.arguments[0]);
      if (ts.isArrowFunction(fnArg) && !ts.isBlock(fnArg.body)) {
        return isConstantExpressionAst(ts, sf, fnArg.body);
      }
      if ((ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)) && ts.isBlock(fnArg.body)) {
        const stmts = fnArg.body.statements;
        if (stmts.length === 1 && ts.isReturnStatement(stmts[0]) && stmts[0].expression) {
          return isConstantExpressionAst(ts, sf, stmts[0].expression);
        }
      }
    }
    return isConstantExpressionAst(ts, sf, inner);
  }

  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && PURE_CONVERTERS.has(node.expression.text)) {
      return node.arguments.length > 0 && node.arguments.every((a) => isConstantExpressionAst(ts, sf, a));
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ['Math', 'JSON', 'Object', 'Array'].includes(node.expression.expression.text)
    ) {
      return node.arguments.every((a) => isConstantExpressionAst(ts, sf, a));
    }
  }

  return false;
}

/**
 * Detects vacuous regex / predicate arguments such as `new RegExp('.*')`, match-all regexes, `() => true` (`G-03`).
 */
function inspectMatcherExpectedArgAst(ts, sf, matcher, rawExpectedNode, rawActualNode) {
  if (!rawExpectedNode) {
    return { isVacuous: false, isSelfReferential: false, isRegex: false, numericValue: null };
  }
  const expNode = unwrapExpr(ts, rawExpectedNode);
  const actNode = rawActualNode ? unwrapExpr(ts, rawActualNode) : null;

  // 1. Self-referential oracle: `expect(loc).toHaveText((await loc.textContent())!)` or `expect(x).toEqual(x)`
  let isSelfReferential = false;
  if (actNode) {
    const actText = actNode.getText(sf).replace(/\s+/g, '');
    const expText = expNode.getText(sf).replace(/\s+/g, '');
    if (actText && actText === expText && !isConstantExpressionAst(ts, sf, actNode)) {
      isSelfReferential = true;
    }
  }
  if (!isSelfReferential && ['toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute', 'toHaveTitle', 'toHaveURL', 'toHaveCount', 'toBe', 'toEqual', 'toStrictEqual'].includes(matcher)) {
    const containsSelfDomRead = (n) => {
      if (!n) return false;
      const u = unwrapExpr(ts, n);
      if (ts.isAwaitExpression(u)) return containsSelfDomRead(u.expression);
      if (
        ts.isCallExpression(u) &&
        ts.isPropertyAccessExpression(u.expression) &&
        SELF_REF_DOM_READERS.has(u.expression.name.text)
      ) {
        return true;
      }
      let hit = false;
      ts.forEachChild(u, (child) => {
        if (!hit && containsSelfDomRead(child)) hit = true;
      });
      return hit;
    };
    if (containsSelfDomRead(expNode)) {
      isSelfReferential = true;
    }
  }

  // 2. Vacuous (matches empty string) vs non-empty-only RegExp literal or `new RegExp(...)`
  let isRegex = false;
  let isVacuous = false;
  let isNonEmptyRegex = false;
  const isVacuousPattern = (pat) => {
    const trimmed = String(pat || '').trim();
    return (
      trimmed === '' ||
      trimmed === '.*' ||
      trimmed === '^.*$' ||
      trimmed === '[\\s\\S]*' ||
      trimmed === '(?:)' ||
      trimmed === '^.*' ||
      trimmed === '.*$' ||
      trimmed === '^' ||
      trimmed === '$'
    );
  };
  const isNonEmptyOnlyPattern = (pat) => {
    const trimmed = String(pat || '').trim();
    return trimmed === '.+' || trimmed === '^.+$' || trimmed === '[\\s\\S]+' || trimmed === '\\S+';
  };

  if (ts.isRegularExpressionLiteral(expNode)) {
    isRegex = true;
    const raw = expNode.getText(sf);
    const body = raw.slice(1, raw.lastIndexOf('/'));
    if (isVacuousPattern(body)) isVacuous = true;
    else if (isNonEmptyOnlyPattern(body)) isNonEmptyRegex = true;
  } else if (
    (ts.isNewExpression(expNode) || ts.isCallExpression(expNode)) &&
    ts.isIdentifier(expNode.expression) &&
    expNode.expression.text === 'RegExp'
  ) {
    isRegex = true;
    const arg0 = expNode.arguments?.[0] ? unwrapExpr(ts, expNode.arguments[0]) : null;
    if (!arg0) {
      isVacuous = true;
    } else if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
      if (isVacuousPattern(arg0.text)) isVacuous = true;
      else if (isNonEmptyOnlyPattern(arg0.text)) isNonEmptyRegex = true;
    }
  }

  // 3. Vacuous predicate function: `toHaveURL(() => true)`
  if (ts.isArrowFunction(expNode) || ts.isFunctionExpression(expNode)) {
    if (!ts.isBlock(expNode.body)) {
      const bodyUnwrapped = unwrapExpr(ts, expNode.body);
      if (bodyUnwrapped.kind === ts.SyntaxKind.TrueKeyword) isVacuous = true;
    } else {
      const stmts = expNode.body.statements;
      if (
        stmts.length === 1 &&
        ts.isReturnStatement(stmts[0]) &&
        stmts[0].expression &&
        unwrapExpr(ts, stmts[0].expression).kind === ts.SyntaxKind.TrueKeyword
      ) {
        isVacuous = true;
      }
    }
  }

  // 4. Numeric literal extraction (for HTTP status oracle checks)
  let numericValue = null;
  if (ts.isNumericLiteral(expNode)) {
    numericValue = Number(expNode.text);
  }

  return { isVacuous, isNonEmptyRegex, isSelfReferential, isRegex, numericValue };
}

/**
 * Unwraps an `expect(...)[.not].matcher(...)` AST `CallExpression`.
 */
function extractExpectChainFromCall(ts, sf, callNode) {
  if (!ts.isCallExpression(callNode)) return null;
  const callee = callNode.expression;

  // Domain helper call: expectAccessible(...), expectApiContract(...), expectPerformanceBudget(...)
  if (ts.isIdentifier(callee) && DOMAIN_HELPERS.has(callee.text)) {
    return {
      kind: 'domainHelper',
      matcher: callee.text,
      actualNode: callNode.arguments[0] || null,
      expectedNode: callNode.arguments[1] || null,
      isSoft: false,
      isPoll: false,
      isNegated: false,
    };
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  const matcher = callee.name.text;

  // Walk backwards through `.not` / `.resolves` / `.rejects` to find root `expect(...)` call
  let cur = callee.expression;
  let isNegated = false;
  while (cur && ts.isPropertyAccessExpression(cur)) {
    const propName = cur.name.text;
    if (propName === 'not') {
      isNegated = !isNegated;
      cur = cur.expression;
    } else if (propName === 'resolves' || propName === 'rejects') {
      cur = cur.expression;
    } else {
      break;
    }
  }

  if (!cur || !ts.isCallExpression(cur)) return null;
  const rootCallee = cur.expression;
  let isExpect = false;
  let isSoft = false;
  let isPoll = false;

  if (ts.isIdentifier(rootCallee) && rootCallee.text === 'expect') {
    isExpect = true;
  } else if (
    ts.isPropertyAccessExpression(rootCallee) &&
    ts.isIdentifier(rootCallee.expression) &&
    rootCallee.expression.text === 'expect' &&
    (rootCallee.name.text === 'soft' || rootCallee.name.text === 'poll')
  ) {
    isExpect = true;
    isSoft = rootCallee.name.text === 'soft';
    isPoll = rootCallee.name.text === 'poll';
  }

  if (!isExpect) return null;

  return {
    kind: 'expect',
    matcher,
    actualNode: cur.arguments[0] || null,
    expectedNode: callNode.arguments[0] || null,
    matcherArgs: callNode.arguments,
    isSoft,
    isPoll,
    isNegated,
  };
}

/**
 * Classifies an AST expect chain on the S0..S5 strength lattice with full negation,
 * constant-folding, self-referential oracle, and vacuous regex/predicate handling.
 */
function classifyExpectChainAst(ts, sf, chain, rawText) {
  if (chain.kind === 'domainHelper') {
    return {
      tier: 5,
      label: 'S5-domain-contract',
      matcher: chain.matcher,
      isSoft: false,
      isNegated: false,
      isTautology: false,
      isSelfReferential: false,
      isVacuous: false,
      isAriaSnapshot: false,
      numericExpected: null,
      raw: rawText,
    };
  }

  const matcher = chain.matcher;
  const actualExpr = chain.actualNode ? chain.actualNode.getText(sf).trim() : '';
  const expectedArg = chain.expectedNode ? chain.expectedNode.getText(sf).trim() : '';

  // S0: Constant expression actual (handles `(true)`, `1+1`, `Number('1')`, `[1].length`, `evaluate(() => 1)`)
  if (isConstantExpressionAst(ts, sf, chain.actualNode)) {
    return {
      tier: 0,
      label: 'S0-tautology',
      matcher,
      isSoft: chain.isSoft,
      isNegated: chain.isNegated,
      isTautology: true,
      isSelfReferential: false,
      isVacuous: false,
      isAriaSnapshot: false,
      numericExpected: null,
      actualExpr,
      expectedArg,
      raw: rawText,
    };
  }

  const expInfo = inspectMatcherExpectedArgAst(ts, sf, matcher, chain.expectedNode, chain.actualNode);

  if (expInfo.isSelfReferential) {
    return {
      tier: 0,
      label: 'S0-self-referential-oracle',
      matcher,
      isSoft: chain.isSoft,
      isNegated: chain.isNegated,
      isTautology: true,
      isSelfReferential: true,
      isVacuous: false,
      isAriaSnapshot: false,
      numericExpected: expInfo.numericValue,
      actualExpr,
      expectedArg,
      raw: rawText,
    };
  }

  if (expInfo.isVacuous) {
    return {
      tier: 0,
      label: 'S0-vacuous-matcher',
      matcher,
      isSoft: chain.isSoft,
      isNegated: chain.isNegated,
      isTautology: true,
      isSelfReferential: false,
      isVacuous: true,
      isAriaSnapshot: false,
      numericExpected: expInfo.numericValue,
      actualExpr,
      expectedArg,
      raw: rawText,
    };
  }

  let baseTier = 3;
  let label = 'S3-other';

  if (expInfo.isNonEmptyRegex) {
    baseTier = 1;
    label = 'S1-nonempty-regex';
  } else if (S5_EXACT_MATCHERS.has(matcher)) {
    if ((matcher === 'toHaveText' || matcher === 'toHaveURL') && expInfo.isRegex) {
      baseTier = 3;
      label = 'S3-regex-match';
    } else if (
      matcher === 'toBe' &&
      /^(true|false)$/.test(expectedArg) &&
      !/\.(status|ok|isDisabled|isChecked|isVisible)\b/.test(actualExpr) &&
      !/\bArray\.isArray\b|\btypeof\b/.test(actualExpr)
    ) {
      baseTier = 2;
      label = 'S2-boolean-check';
    } else {
      baseTier = 5;
      label = 'S5-exact';
    }
  } else if (S4_STRUCTURAL_MATCHERS.has(matcher)) {
    if (matcher === 'toHaveTitle' && expInfo.isRegex) {
      baseTier = 3;
      label = 'S3-regex-title';
    } else {
      baseTier = 4;
      label = 'S4-structural';
    }
  } else if (S3_PARTIAL_MATCHERS.has(matcher)) {
    baseTier = 3;
    label = 'S3-partial';
  } else if (S2_STATE_MATCHERS.has(matcher)) {
    baseTier = 2;
    label = 'S2-state';
  } else if (S1_WEAK_MATCHERS.has(matcher)) {
    baseTier = 1;
    label = 'S1-weak';
  }

  // Negation (`.not.*`) weakens positive exact assertions (`G-02`)
  const finalTier = chain.isNegated ? Math.max(1, baseTier - 2) : baseTier;
  if (chain.isNegated) {
    label = `S${finalTier}-negated(${matcher})`;
  }

  return {
    tier: finalTier,
    label,
    matcher,
    isSoft: chain.isSoft,
    isNegated: chain.isNegated,
    isTautology: false,
    isSelfReferential: false,
    isVacuous: false,
    isAriaSnapshot: matcher === 'toMatchAriaSnapshot',
    numericExpected: expInfo.numericValue,
    actualExpr,
    expectedArg,
    raw: rawText,
  };
}

/**
 * Classifies an assertion statement or expression on the S0..S5 strength lattice.
 * Uses real TypeScript AST when available so parentheses, constant folding, `.not`,
 * `new RegExp('.*')`, predicates, and self-referential oracles are accurately evaluated.
 * @param {string} stmt
 * @param {string} [qaDir]
 */
export function classifyAssertionStatement(stmt, qaDir) {
  const clean = String(stmt || '').trim();
  const ts = resolveTypeScriptCompiler(qaDir);
  if (ts && clean) {
    try {
      const wrapped = `async function __expr__() {\n${clean}\n}`;
      const sf = ts.createSourceFile('__stmt__.ts', wrapped, ts.ScriptTarget.Latest, true);
      let found = null;
      const visit = (node) => {
        if (found) return;
        if (ts.isCallExpression(node)) {
          const chain = extractExpectChainFromCall(ts, sf, node);
          if (chain) {
            found = classifyExpectChainAst(ts, sf, chain, clean);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      if (found) return found;
    } catch {
      // fall back to regex classifier below
    }
  }

  // Lightweight fallback when TypeScript is unavailable
  const isSoft = /\bexpect\.soft\s*\(/.test(clean);
  if (/\b(?:expectAccessible|expectPerformanceBudget|expectApiContract)\s*\(/.test(clean)) {
    return { tier: 5, label: 'S5-domain-contract', matcher: 'domainHelper', isSoft, isNegated: false, isTautology: false, raw: clean };
  }
  const expMatch =
    /\bexpect(?:\.(?:soft|poll))?\s*\(\s*([\s\S]*?)\s*\)\s*(\.\s*not\s*)?\.\s*([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)/.exec(
      clean
    );
  if (!expMatch) {
    return { tier: 3, label: 'S3-custom-helper', matcher: 'custom', isSoft, isNegated: false, isTautology: false, raw: clean };
  }
  const actualExpr = expMatch[1].trim().replace(/^\(+|\)+$/g, '').trim();
  const isNegated = Boolean(expMatch[2]);
  const matcher = expMatch[3].trim();
  const expectedArg = expMatch[4].trim();

  if (
    /^(true|false|null|undefined|NaN|\d[\d_.]*|'[^']*'|"[^"]*"|`[^`$]*`|\{\s*\}|\[\s*\])$/.test(actualExpr) ||
    /^(true|false|null|undefined|\d+)\s*,/.test(actualExpr)
  ) {
    return { tier: 0, label: 'S0-tautology', matcher, isSoft, isNegated, isTautology: true, expectedArg, actualExpr, raw: clean };
  }

  let baseTier = S5_EXACT_MATCHERS.has(matcher)
    ? 5
    : S4_STRUCTURAL_MATCHERS.has(matcher)
      ? 4
      : S3_PARTIAL_MATCHERS.has(matcher)
        ? 3
        : S2_STATE_MATCHERS.has(matcher)
          ? 2
          : S1_WEAK_MATCHERS.has(matcher)
            ? 1
            : 3;
  const finalTier = isNegated ? Math.max(1, baseTier - 2) : baseTier;
  return {
    tier: finalTier,
    label: isNegated ? `S${finalTier}-negated` : `S${finalTier}`,
    matcher,
    isSoft,
    isNegated,
    isTautology: false,
    expectedArg,
    actualExpr,
    raw: clean,
  };
}

function buildAssertRegex(assertPatterns) {
  const safePatterns = assertPatterns.filter((p) => p && p !== '*');
  if (safePatterns.length === 0) return /\bexpect\s*\(/;
  const parts = safePatterns.map((pat) => {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-zA-Z0-9_$]*');
    return `\\b${escaped}\\s*\\(`;
  });
  return new RegExp(parts.join('|'));
}

function buildCustomAssertNameMatcher(assertFunctionNames) {
  const customPatterns = (assertFunctionNames || [])
    .filter((p) => p && p !== '*' && p !== 'expect' && p !== 'expect*')
    .map((pat) => {
      const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-zA-Z0-9_$]*');
      return new RegExp(`^${escaped}$`);
    });
  return (fnName) => customPatterns.some((re) => re.test(fnName));
}

function subtreeContainsKind(ts, node, predicate) {
  if (!node) return false;
  if (predicate(node)) return true;
  let hit = false;
  ts.forEachChild(node, (child) => {
    if (!hit && subtreeContainsKind(ts, child, predicate)) hit = true;
  });
  return hit;
}

function hasThrowStatement(ts, node) {
  return subtreeContainsKind(ts, node, (n) => ts.isThrowStatement(n));
}

function hasReturnStatement(ts, node) {
  return subtreeContainsKind(ts, node, (n) => ts.isReturnStatement(n));
}

function hasExpectOrAssertCall(ts, sf, node, isCustomAssertName) {
  return subtreeContainsKind(ts, node, (n) => {
    if (!ts.isCallExpression(n)) return false;
    if (extractExpectChainFromCall(ts, sf, n)) return true;
    const expr = n.expression;
    if (ts.isIdentifier(expr) && (expr.text === 'expect' || expr.text === 'assert' || isCustomAssertName(expr.text))) {
      return true;
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'expect') {
      return true;
    }
    return false;
  });
}

/**
 * Extracts a structured semantic summary of a TypeScript/JavaScript source snippet using the TS Compiler API.
 * Used both for whole-file analysis (`compareSpecSourcesAst`, `scanSpecFilesFallback`) and hunk analysis (`analyzeHealerDiffText`).
 *
 * @param {string} fileLabel
 * @param {string} sourceText
 * @param {{ assertFunctionNames?: string[], qaDir?: string, wrapInAsyncFn?: boolean }} [options]
 */
export function analyzeSourceAst(fileLabel, sourceText, options = {}) {
  const assertFunctionNames = options.assertFunctionNames || ['expect*', 'assert*', 'verify*'];
  const isCustomAssertName = buildCustomAssertNameMatcher(assertFunctionNames);
  const ts = 'tsCompiler' in options ? options.tsCompiler : resolveTypeScriptCompiler(options.qaDir);

  /** @type {{
   *   usedAst: boolean,
   *   compilerUnavailable: boolean,
   *   assertions: Array<any>,
   *   customAssertCalls: number,
   *   semanticLocators: number,
   *   genericLocators: number,
   *   successStatuses: number,
   *   serverErrorStatuses: number,
   *   criticalTags: string[],
   *   violations: Array<{ code: string, message: string, snippet: string }>
   * }} */
  const summary = {
    usedAst: false,
    compilerUnavailable: false,
    assertions: [],
    customAssertCalls: 0,
    semanticLocators: 0,
    genericLocators: 0,
    successStatuses: 0,
    serverErrorStatuses: 0,
    criticalTags: [],
    violations: [],
  };

  if (!ts) {
    summary.compilerUnavailable = true;
    return summary;
  }

  if (!sourceText || !sourceText.trim()) {
    summary.usedAst = true;
    return summary;
  }

  const codeToParse = options.wrapInAsyncFn ? `async function __aitest_hunk__() {\n${sourceText}\n}` : sourceText;
  const sf = ts.createSourceFile(fileLabel || 'spec.ts', codeToParse, ts.ScriptTarget.Latest, true);
  summary.usedAst = true;

  const pushViolation = (code, message, snippet = '') => {
    summary.violations.push({ code, message, snippet: String(snippet || '').slice(0, 160) });
  };

  /** Check for early `if (...) return;` preceding assertions inside any block (`G-05`, Appendix A #11) */
  const hasBareReturn = (node) => subtreeContainsKind(ts, node, (n) => ts.isReturnStatement(n) && !n.expression);
  const checkEarlyReturnInBlock = (blockNode) => {
    if (!blockNode || !Array.isArray(blockNode.statements)) return;
    const isSyntheticHunkBody =
      Boolean(options.wrapInAsyncFn) &&
      blockNode.parent &&
      ts.isFunctionDeclaration(blockNode.parent) &&
      blockNode.parent.name?.text === '__aitest_hunk__';
    let sawConditionalReturn = null;
    for (const stmt of blockNode.statements) {
      if (ts.isIfStatement(stmt) && hasReturnStatement(ts, stmt.thenStatement)) {
        const snippet = stmt.getText(sf).trim().split(/\r?\n/)[0];
        if (isSyntheticHunkBody && hasBareReturn(stmt.thenStatement)) {
          // In a diff hunk snippet, assertions may follow right below the hunk boundary
          pushViolation(
            'AITEST-G110',
            `${fileLabel}: early bare return inside conditional bypasses subsequent test assertions ("${snippet}").`,
            snippet
          );
          sawConditionalReturn = null;
        } else {
          sawConditionalReturn = snippet;
        }
      } else if (sawConditionalReturn && hasExpectOrAssertCall(ts, sf, stmt, isCustomAssertName)) {
        pushViolation(
          'AITEST-G110',
          `${fileLabel}: early return inside conditional before assertion bypasses test checks ("${sawConditionalReturn}").`,
          sawConditionalReturn
        );
        sawConditionalReturn = null;
      }
    }
  };

  const visit = (node, ctx = { insideIf: false, insideTernary: false }) => {
    if (ts.isBlock(node)) {
      checkEarlyReturnInBlock(node);
    }

    // 1. Try / Catch / Finally exception swallowing (`G-05` / `AITEST-G107`)
    if (ts.isTryStatement(node)) {
      if (node.catchClause && !hasThrowStatement(ts, node.catchClause.block)) {
        pushViolation(
          'AITEST-G107',
          `${fileLabel}: swallowed exception in try/catch block without rethrow.`,
          node.catchClause.getText(sf).slice(0, 120)
        );
      }
      if (node.finallyBlock && hasReturnStatement(ts, node.finallyBlock)) {
        pushViolation(
          'AITEST-G107',
          `${fileLabel}: return inside finally block suppresses thrown assertion failures.`,
          node.finallyBlock.getText(sf).slice(0, 120)
        );
      }
    }

    // 2. Empty custom assertion helper (`AITEST-G113`)
    if (ts.isFunctionDeclaration(node) && node.name && isCustomAssertName(node.name.text) && node.body) {
      if (!hasExpectOrAssertCall(ts, sf, node.body, isCustomAssertName)) {
        pushViolation(
          'AITEST-G113',
          `${fileLabel}: custom assertion helper "${node.name.text}" contains zero real expect() calls.`,
          node.name.text
        );
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isCustomAssertName(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      if (!hasExpectOrAssertCall(ts, sf, node.initializer.body, isCustomAssertName)) {
        pushViolation(
          'AITEST-G113',
          `${fileLabel}: custom assertion helper "${node.name.text}" contains zero real expect() calls.`,
          node.name.text
        );
      }
    }

    // 3. Object literal properties: { force: true }, { retries: >=1 }, { timeout: >=60000 }, { soft: true }, testIgnore
    if (ts.isPropertyAssignment(node)) {
      const propName = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : '';
      const init = unwrapExpr(ts, node.initializer);
      if (propName === 'force' && init.kind === ts.SyntaxKind.TrueKeyword) {
        pushViolation('AITEST-G108', `${fileLabel}: added { force: true } bypassing actionability checks.`, node.getText(sf));
      }
      if (propName === 'retries' && ts.isNumericLiteral(init) && Number(init.text) >= 1) {
        pushViolation('AITEST-G109', `${fileLabel}: added test retry inflation (retries: ${init.text}).`, node.getText(sf));
      }
      if (propName === 'timeout' && ts.isNumericLiteral(init) && Number(init.text) >= 60_000) {
        pushViolation('AITEST-G109', `${fileLabel}: excessive timeout (${init.text}ms >= 60000ms).`, node.getText(sf));
      }
      if (propName === 'testIgnore') {
        pushViolation('AITEST-G101', `${fileLabel}: added testIgnore exclusion.`, node.getText(sf));
      }
      if (
        propName.startsWith('playwright/') &&
        ts.isStringLiteral(init) &&
        (init.text === 'off' || init.text === 'warn')
      ) {
        pushViolation('AITEST-G101', `${fileLabel}: weakened eslint-plugin-playwright rule "${propName}: ${init.text}".`, node.getText(sf));
      }
    }

    // 4. Call expressions (assertions, skip/fixme/fail/only, .catch, route.fulfill, expect.configure, toPass, locators)
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sf).replace(/\s+/g, '');

      // 4a. Extract @critical / @smoke tags from test(...) / test.describe(...) titles (`G-08` / `AITEST-G115`)
      if (
        /^(?:test|it|test\.describe|describe)(?:\.[a-z]+)?$/.test(calleeText) &&
        node.arguments.length >= 1
      ) {
        const titleArg = unwrapExpr(ts, node.arguments[0]);
        if (ts.isStringLiteral(titleArg) || ts.isNoSubstitutionTemplateLiteral(titleArg)) {
          const tags = titleArg.text.match(/@(?:critical|smoke)\b/gi) || [];
          for (const t of tags) summary.criticalTags.push(t.toLowerCase());
        }
        // Also inspect Playwright 1.42+ `{ tag: ['@critical'] }` options object
        if (node.arguments.length >= 2 && ts.isObjectLiteralExpression(node.arguments[1])) {
          const optText = node.arguments[1].getText(sf);
          const objTags = optText.match(/@(?:critical|smoke)\b/gi) || [];
          for (const t of objTags) summary.criticalTags.push(t.toLowerCase());
        }
      }

      // 4b. Skip / fixme / only / fail (`AITEST-G105`) including testInfo.skip(), test.describe.skip()
      if (
        /^(?:test|it|describe|test\.describe)\.(?:skip|fixme|only)$/.test(calleeText) ||
        /^(?:testInfo|info)\.(?:skip|fixme)$/.test(calleeText)
      ) {
        pushViolation(
          'AITEST-G105',
          `${fileLabel}: added skip/fixme/only ("${node.getText(sf).split(/\r?\n/)[0].trim()}").`,
          node.getText(sf)
        );
      }
      if (/^(?:test|it|describe|test\.describe|testInfo|info)\.fail$/.test(calleeText)) {
        pushViolation(
          'AITEST-G105',
          `${fileLabel}: added expectation-inverting .fail() ("${node.getText(sf).split(/\r?\n/)[0].trim()}").`,
          node.getText(sf)
        );
      }

      // 4c. `expect.configure({ soft: true })` (`G-04`/`Appendix A #12` -> `AITEST-G106`)
      if (calleeText === 'expect.configure' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const hasSoftTrue = node.arguments[0].properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ((ts.isIdentifier(p.name) && p.name.text === 'soft') || (ts.isStringLiteral(p.name) && p.name.text === 'soft')) &&
            unwrapExpr(ts, p.initializer).kind === ts.SyntaxKind.TrueKeyword
        );
        if (hasSoftTrue) {
          pushViolation(
            'AITEST-G106',
            `${fileLabel}: expect.configure({ soft: true }) globally weakens assertions to soft mode.`,
            node.getText(sf)
          );
        }
      }

      // 4d. `test.setTimeout(>=60000)` & `.toPass({ timeout: >=30000 })` (`AITEST-G109`)
      if (calleeText === 'test.setTimeout' && node.arguments[0]) {
        const arg0 = unwrapExpr(ts, node.arguments[0]);
        if (ts.isNumericLiteral(arg0) && Number(arg0.text) >= 60_000) {
          pushViolation('AITEST-G109', `${fileLabel}: excessive test.setTimeout(${arg0.text}ms >= 60000ms).`, node.getText(sf));
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toPass') {
        const arg0 = node.arguments[0];
        if (arg0 && ts.isObjectLiteralExpression(arg0)) {
          for (const p of arg0.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'timeout' &&
              ts.isNumericLiteral(unwrapExpr(ts, p.initializer)) &&
              Number(unwrapExpr(ts, p.initializer).text) >= 30_000
            ) {
              pushViolation(
                'AITEST-G109',
                `${fileLabel}: inflated toPass({ timeout: ${unwrapExpr(ts, p.initializer).text} }) masks product latency/failure.`,
                node.getText(sf)
              );
            }
          }
        }
      }

      // 4e. Swallowed `.catch(...)` without rethrow (`G-05` / `AITEST-G107`)
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
        const handler = node.arguments[0];
        if (!handler || !hasThrowStatement(ts, handler)) {
          pushViolation(
            'AITEST-G107',
            `${fileLabel}: swallowed exception via non-rethrowing .catch() ("${node.getText(sf).split(/\r?\n/)[0].trim()}").`,
            node.getText(sf)
          );
        }
      }

      // 4f. Backend faking via `page.route(... r.fulfill(...))` / `context.route(... fulfill ...)` (`G-06` / `AITEST-G114`)
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'route' &&
        node.arguments.length >= 2
      ) {
        const handler = node.arguments[1];
        const usesFulfill = subtreeContainsKind(
          ts,
          handler,
          (n) =>
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === 'fulfill'
        );
        if (usesFulfill) {
          pushViolation(
            'AITEST-G114',
            `${fileLabel}: mocking backend response via route.fulfill() in spec can fabricate fake-green oracles (requires waiver).`,
            node.getText(sf).split(/\r?\n/)[0]
          );
        }
      }

      // 4g. Semantic vs generic locators (`AITEST-G111`)
      if (ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text;
        if (SEMANTIC_LOCATOR_METHODS.has(methodName)) {
          summary.semanticLocators += 1;
        }
        if (methodName === 'locator' && node.arguments[0]) {
          const sel = unwrapExpr(ts, node.arguments[0]);
          if (
            (ts.isStringLiteral(sel) || ts.isNoSubstitutionTemplateLiteral(sel)) &&
            /^(body|html|\*|div)$/i.test(sel.text.trim())
          ) {
            summary.genericLocators += 1;
          }
        }
      }

      // 4h. Expect chain classification + S0/soft/conditional checks
      const chain = extractExpectChainFromCall(ts, sf, node);
      if (chain) {
        const snippet = node.getText(sf).trim();
        const cls = classifyExpectChainAst(ts, sf, chain, snippet);
        summary.assertions.push(cls);

        if (cls.numericExpected !== null) {
          if (SUCCESS_STATUS_CODES.has(cls.numericExpected)) summary.successStatuses += 1;
          if (cls.numericExpected >= 500 && cls.numericExpected < 600) summary.serverErrorStatuses += 1;
        }

        if (cls.isTautology) {
          pushViolation(
            'AITEST-G104',
            `${fileLabel}: ${cls.label} assertion forbidden ("${snippet.split(/\r?\n/)[0]}").`,
            snippet
          );
        }
        if (cls.isSoft) {
          pushViolation(
            'AITEST-G106',
            `${fileLabel}: soft assertion expect.soft() weakens gate enforcement ("${snippet.split(/\r?\n/)[0]}").`,
            snippet
          );
        }
        if (ctx.insideIf) {
          pushViolation(
            'AITEST-G110',
            `${fileLabel}: wrapping expect() inside conditional if-block is forbidden.`,
            snippet
          );
        }
        if (ctx.insideTernary) {
          pushViolation(
            'AITEST-G110',
            `${fileLabel}: conditional ternary expect() is forbidden.`,
            snippet
          );
        }
      } else if (ts.isIdentifier(node.expression) && isCustomAssertName(node.expression.text)) {
        summary.customAssertCalls += 1;
        summary.assertions.push({
          tier: 3,
          label: 'S3-custom-helper',
          matcher: node.expression.text,
          isSoft: false,
          isNegated: false,
          isTautology: false,
          isAriaSnapshot: false,
          raw: node.getText(sf).trim(),
        });
      }
    }

    const nextCtx = {
      insideIf: ctx.insideIf || ts.isIfStatement(node),
      insideTernary: ctx.insideTernary || ts.isConditionalExpression(node),
    };
    ts.forEachChild(node, (child) => visit(child, nextCtx));
  };

  visit(sf);
  return summary;
}

/**
 * Compares two AST summaries (base vs head) for the same file/hunk and emits semantic violations.
 */
function compareAstSummaries(fileLabel, baseSum, headSum, canWaive) {
  /** @type {string[]} */
  const violations = [];

  // Emit newly introduced structural violations (present in head, not already in base)
  const baseViolKeys = new Set(baseSum.violations.map((v) => `${v.code}:${v.snippet}`));
  for (const v of headSum.violations) {
    const key = `${v.code}:${v.snippet}`;
    if (baseViolKeys.has(key)) continue;
    if (canWaive(v.snippet) || canWaive(v.code)) continue;
    violations.push(`[Healer Diff Guard][${v.code}] ${v.message}`);
  }

  const baseCount = baseSum.assertions.length;
  const headCount = headSum.assertions.length;

  // AITEST-G102: Net assertion reduction (allow benign consolidation into new toMatchAriaSnapshot)
  const baseAriaCount = baseSum.assertions.filter((a) => a.isAriaSnapshot).length;
  const headAriaCount = headSum.assertions.filter((a) => a.isAriaSnapshot).length;
  const consolidatedIntoAria = headAriaCount > baseAriaCount && baseCount - headCount <= 2;

  if (baseCount > headCount && !consolidatedIntoAria && !canWaive('assertion-deletion')) {
    violations.push(
      `[Healer Diff Guard][AITEST-G102] ${fileLabel}: net assertion reduction detected (base ${baseCount} -> head ${headCount}).`
    );
  }

  // AITEST-G103: Assertion strength lattice downgrade OR positive -> negative flip
  if (baseCount > 0 && headCount > 0) {
    const baseMax = Math.max(...baseSum.assertions.map((a) => a.tier));
    const headMax = Math.max(...headSum.assertions.map((a) => a.tier));
    const baseSumTier = baseSum.assertions.reduce((s, a) => s + a.tier, 0);
    const headSumTier = headSum.assertions.reduce((s, a) => s + a.tier, 0);
    const baseNegated = baseSum.assertions.filter((a) => a.isNegated).length;
    const headNegated = headSum.assertions.filter((a) => a.isNegated).length;

    const downgraded =
      (!consolidatedIntoAria && (headMax < baseMax || headSumTier < baseSumTier)) ||
      (headNegated > baseNegated && headSumTier <= baseSumTier);

    if (downgraded && !canWaive('assertion-weakening')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G103] ${fileLabel}: assertion strength downgraded (max tier S${baseMax} -> S${headMax}, total strength ${baseSumTier} -> ${headSumTier}${headNegated > baseNegated ? ', positive->negated flip' : ''}).`
      );
    }
  }

  // AITEST-G111: Semantic locator degraded to generic body/html/*/div
  if (
    headSum.semanticLocators < baseSum.semanticLocators &&
    headSum.genericLocators > baseSum.genericLocators &&
    !canWaive('locator-degradation')
  ) {
    violations.push(
      `[Healer Diff Guard][AITEST-G111] ${fileLabel}: semantic locator (getByRole/Label/Text/TestId) degraded to generic body/html/*/div locator.`
    );
  }

  // AITEST-G112: HTTP status oracle flipped from 2xx/4xx to 5xx
  if (
    headSum.successStatuses < baseSum.successStatuses &&
    headSum.serverErrorStatuses > baseSum.serverErrorStatuses &&
    !canWaive('oracle-5xx-flip')
  ) {
    violations.push(
      `[Healer Diff Guard][AITEST-G112] ${fileLabel}: HTTP status oracle flipped from 2xx/4xx to 5xx to mask backend failure.`
    );
  }

  // AITEST-G115: Critical/smoke tag removed from test title (`G-08` / Appendix A #14)
  if (headSum.criticalTags.length < baseSum.criticalTags.length && !canWaive('tag-removal')) {
    violations.push(
      `[Healer Diff Guard][AITEST-G115] ${fileLabel}: @critical/@smoke tag removed from test title (${baseSum.criticalTags.length} -> ${headSum.criticalTags.length}).`
    );
  }

  return violations;
}

/**
 * Full-file AST semantic comparison between base source (e.g. `git show base:file`) and head source (`B-1`).
 * Eliminates hunk-boundary blindness and Prettier formatting false positives completely.
 *
 * @param {string} filePath
 * @param {string} baseSource
 * @param {string} headSource
 * @param {{ assertFunctionNames?: string[], activeWaivers?: any[], qaDir?: string }} [options]
 */
export function compareSpecSourcesAst(filePath, baseSource, headSource, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [], qaDir } = options;
  const canWaive = (key) => isCoveredByWaiver({ file: filePath, title: key }, activeWaivers, 'diff');
  const violations = [...validateAssertFunctionNames(assertFunctionNames)];

  if (isProtectedDiffPath(filePath) && baseSource !== headSource && !canWaive('protected-file')) {
    violations.push(
      `[Healer Diff Guard][AITEST-G101] ${filePath}: modification to protected governance/config file is forbidden without human approval.`
    );
  }

  const astOpts = {
    assertFunctionNames,
    qaDir,
    wrapInAsyncFn: false,
    ...('tsCompiler' in options ? { tsCompiler: options.tsCompiler } : {}),
  };
  const baseSum = analyzeSourceAst(filePath, baseSource || '', astOpts);
  const headSum = analyzeSourceAst(filePath, headSource || '', astOpts);

  if (baseSum.compilerUnavailable || headSum.compilerUnavailable) {
    violations.push(
      `[Healer Diff Guard Blocked] ${filePath}: TypeScript compiler unavailable; fail-closed instead of skipping AST semantic diff guard.`
    );
    return { ok: false, blocked: true, outcome: 'blocked', violations: [...new Set(violations)] };
  }

  if (baseSum.usedAst || headSum.usedAst) {
    violations.push(...compareAstSummaries(filePath, baseSum, headSum, canWaive));
  }

  return {
    ok: violations.length === 0,
    blocked: false,
    outcome: violations.length === 0 ? 'pass' : 'fail',
    violations: [...new Set(violations)],
  };
}

/**
 * Splits a unified diff into per-file hunk records, properly unquoting non-ASCII Git paths (`G-07`).
 * Preserves context lines (` `) alongside `-` and `+` lines so multi-line Prettier assertions
 * and multi-line `try/catch` blocks reconstruct into valid AST syntax!
 */
function parseUnifiedDiffByFile(diffText) {
  /** @type {Array<{ file: string, hunks: Array<{ beforeLines: string[], afterLines: string[], addedOnlyLines: string[], removedOnlyLines: string[] }> }>} */
  const files = [];
  let curFileRec = null;
  let curHunk = null;

  const ensureHunk = () => {
    if (!curFileRec) {
      curFileRec = { file: 'unknown', hunks: [] };
      files.push(curFileRec);
    }
    if (!curHunk) {
      curHunk = { beforeLines: [], afterLines: [], addedOnlyLines: [], removedOnlyLines: [] };
      curFileRec.hunks.push(curHunk);
    }
  };

  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const parsedPath = parseGitDiffHeaderPath(line);
      curFileRec = { file: parsedPath, hunks: [] };
      files.push(curFileRec);
      curHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      // Also inspect `+++ b/...` in case diff header was simplified
      const rawPlus = line.slice(4).trim();
      if (curFileRec && curFileRec.file === 'unknown' && rawPlus !== '/dev/null') {
        curFileRec.file = parseGitDiffHeaderPath(`diff --git a/x ${rawPlus}`);
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    }
    if (line.startsWith('@@ ')) {
      curHunk = { beforeLines: [], afterLines: [], addedOnlyLines: [], removedOnlyLines: [] };
      if (!curFileRec) {
        curFileRec = { file: 'unknown', hunks: [] };
        files.push(curFileRec);
      }
      curFileRec.hunks.push(curHunk);
      continue;
    }
    if (line.startsWith('\\ No newline')) continue;

    if (line.startsWith('-')) {
      ensureHunk();
      const body = line.slice(1);
      curHunk.beforeLines.push(body);
      curHunk.removedOnlyLines.push(body);
    } else if (line.startsWith('+')) {
      ensureHunk();
      const body = line.slice(1);
      curHunk.afterLines.push(body);
      curHunk.addedOnlyLines.push(body);
    } else if (line.startsWith(' ')) {
      ensureHunk();
      const body = line.slice(1);
      curHunk.beforeLines.push(body);
      curHunk.afterLines.push(body);
    }
  }

  return files;
}

/**
 * Layer 3 Semantic Diff Guard v3 (`AITEST-G101` .. `AITEST-G115`).
 * Reconstructs each hunk's before/after code (including context lines) and compares them with
 * the TypeScript Compiler API AST analyzer — catching all multi-line Prettier downgrades,
 * `.not` flips, self-referential oracles, vacuous regexes/predicates, multi-line catch/finally,
 * early returns, ternary assertions, `page.route(...fulfill)`, `expect.configure({ soft: true })`,
 * `toPass({ timeout })`, `@critical` tag removal, and quoted non-ASCII paths.
 */
export function analyzeHealerDiffText(diffText, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [], qaDir } = options;
  const violations = [...validateAssertFunctionNames(assertFunctionNames)];

  if (!diffText || !diffText.trim()) {
    return { ok: violations.length === 0, violations };
  }

  const ts = resolveTypeScriptCompiler(qaDir);
  const parsedFiles = parseUnifiedDiffByFile(diffText);

  for (const fileRec of parsedFiles) {
    const currentFile = fileRec.file;
    const canWaive = (key) => isCoveredByWaiver({ file: currentFile, title: key }, activeWaivers, 'diff');

    // AITEST-G101: Protected governance / config / policy file modified
    if (isProtectedDiffPath(currentFile) && !canWaive('protected-file')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G101] ${currentFile}: modification to protected governance/config file is forbidden without human approval.`
      );
    }

    const beforeCombined = fileRec.hunks.map((h) => h.beforeLines.join('\n')).join('\n;\n');
    const afterCombined = fileRec.hunks.map((h) => h.afterLines.join('\n')).join('\n;\n');
    const addedOnlyCombined = fileRec.hunks.map((h) => h.addedOnlyLines.join('\n')).join('\n');

    // Config-level bypass patterns even if filename is unusual or partial snippet isn't valid TS object
    if (/\btestIgnore\s*:/.test(addedOnlyCombined) && !canWaive('testIgnore')) {
      violations.push(`[Healer Diff Guard][AITEST-G101] ${currentFile}: added testIgnore exclusion.`);
    }
    if (/['"]playwright\/[^'"]+['"]\s*:\s*['"](?:off|warn)['"]/.test(addedOnlyCombined) && !canWaive('eslint-rule')) {
      violations.push(`[Healer Diff Guard][AITEST-G101] ${currentFile}: weakened eslint-plugin-playwright rule.`);
    }

    // Skip AST comparison on pure JSON/gitignore files (already protected via G101 above)
    if (/\.(json|gitignore|md|txt|yml|yaml)$/i.test(currentFile) || path.basename(currentFile) === '.gitignore') {
      continue;
    }

    if (ts) {
      // Parse reconstructed before/after hunks with real TS Compiler API!
      const baseSum = analyzeSourceAst(currentFile, beforeCombined, {
        assertFunctionNames,
        qaDir,
        wrapInAsyncFn: true,
      });
      const headSum = analyzeSourceAst(currentFile, afterCombined, {
        assertFunctionNames,
        qaDir,
        wrapInAsyncFn: true,
      });
      violations.push(...compareAstSummaries(currentFile, baseSum, headSum, canWaive));
    } else {
      // Minimal fallback when TypeScript is completely unavailable
      const assertRe = new RegExp(buildAssertRegex(assertFunctionNames).source, 'g');
      const remMatches = beforeCombined.match(assertRe) || [];
      const addMatches = afterCombined.match(assertRe) || [];
      if (remMatches.length > addMatches.length && !canWaive('assertion-deletion')) {
        violations.push(
          `[Healer Diff Guard][AITEST-G102] ${currentFile}: net assertion reduction detected (removed ${remMatches.length}, added ${addMatches.length}).`
        );
      }
      if (/\b(?:test|it|describe|testInfo)\.(?:skip|fixme|only|fail)\s*\(/.test(addedOnlyCombined)) {
        violations.push(`[Healer Diff Guard][AITEST-G105] ${currentFile}: added skip/fixme/only/fail.`);
      }
      if (/\bforce\s*:\s*true\b/.test(addedOnlyCombined)) {
        violations.push(`[Healer Diff Guard][AITEST-G108] ${currentFile}: added { force: true }.`);
      }
      if (/\.catch\s*\(/.test(addedOnlyCombined) || /\bcatch\s*(\([^)]*\))?\s*\{/.test(addedOnlyCombined)) {
        violations.push(`[Healer Diff Guard][AITEST-G107] ${currentFile}: swallowed exception in catch.`);
      }
    }
  }

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * Full-file + Git-diff Layer 3 Semantic Guard (`G-01..G-09`).
 * For every modified TS/JS spec file under `qaDir`, compares FULL `git show <diffBase>:<file>`
 * against live disk content using the TypeScript AST analyzer (eliminating hunk-boundary blindness!),
 * while also inspecting protected file changes and untracked files cleanly with `-c core.quotePath=off -z`.
 */
export function runGitDiffGuard(qaDir, diffBase, options = {}) {
  const gitRoot = resolveGitRoot(qaDir);
  if (!gitRoot) {
    return {
      ok: false,
      status: 'blocked',
      violations: [`[Healer Diff Guard] Directory "${qaDir}" is not inside a Git repository; fail-closed.`],
    };
  }

  const changedInfo = listChangedFilesUnderDir(gitRoot, diffBase, qaDir);
  if (!changedInfo.ok) {
    return {
      ok: false,
      status: 'blocked',
      violations: [`[Healer Diff Guard] git diff "${diffBase}" failed: ${changedInfo.error}`],
    };
  }

  const cfg = loadAitestConfig(qaDir);
  const activeWaivers = options.activeWaivers || [];
  const violations = [...validateAssertFunctionNames(cfg.assertFunctionNames)];
  let blocked = false;

  const allChangedRelFromGitRoot = [
    ...changedInfo.changed.map((c) => ({ rel: c.path, status: c.status, oldRel: c.oldPath || c.path })),
    ...changedInfo.untracked.map((p) => ({ rel: p, status: 'U', oldRel: null })),
  ];

  const realQaDir = (() => {
    try {
      return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(qaDir) : fs.realpathSync(qaDir);
    } catch {
      return path.resolve(qaDir);
    }
  })();

  for (const item of allChangedRelFromGitRoot) {
    const absPath = path.join(gitRoot, item.rel);
    const relInsideQa = path.relative(realQaDir, absPath).replace(/\\/g, '/');
    if (/^(reports|playwright-report|test-results|knowledge|\.aitest\/runs|\.aitest\/heals|\.aitest\/jobs|node_modules)\//.test(relInsideQa)) {
      continue;
    }

    const canWaive = (key) => isCoveredByWaiver({ file: relInsideQa, title: key }, activeWaivers, 'diff');

    // 1. Check protected file path regardless of extension or non-ASCII parent path (`G-07`, `G-09`)
    if (isProtectedDiffPath(relInsideQa, cfg.governance?.protected) && !canWaive('protected-file')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G101] ${relInsideQa}: modification to protected governance/config file is forbidden without human approval.`
      );
      continue;
    }

    // 2. Full-file AST semantic diff for TS/JS/MJS files (`B-1`)
    if (/\.(ts|tsx|js|jsx|mjs)$/i.test(relInsideQa)) {
      const baseSource = item.oldRel && item.status !== 'A' && item.status !== 'U'
        ? getFileAtGitRef(gitRoot, diffBase, item.oldRel) || ''
        : '';
      const headSource = fs.existsSync(absPath) && fs.statSync(absPath).isFile()
        ? fs.readFileSync(absPath, 'utf8')
        : '';

      const cmp = compareSpecSourcesAst(relInsideQa, baseSource, headSource, {
        assertFunctionNames: cfg.assertFunctionNames,
        activeWaivers,
        qaDir,
        ...('tsCompiler' in options ? { tsCompiler: options.tsCompiler } : {}),
      });
      if (cmp.blocked) blocked = true;
      violations.push(...cmp.violations);
    }
  }

  const unique = [...new Set(violations)];
  return {
    ok: !blocked && unique.length === 0,
    status: blocked ? 'blocked' : unique.length === 0 ? 'pass' : 'fail',
    violations: unique,
  };
}

/**
 * AST + Structural Static Spec Scanner (`Layer 2`).
 * Scans `*.spec.ts`, `*.spec.js`, `*.test.ts`, `*.test.js`, and nested `seed.spec.ts` (exempting only root `tests/seed.spec.ts`).
 */
export function scanSpecFilesFallback(testsDir, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [], qaDir } = options;
  const errors = [...validateAssertFunctionNames(assertFunctionNames)];
  if (!fs.existsSync(testsDir)) return { ok: errors.length === 0, errors };

  const assertRegex = buildAssertRegex(assertFunctionNames);
  const ts = resolveTypeScriptCompiler(qaDir || path.dirname(testsDir));

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:spec|test)\.[jt]s$/.test(entry.name)) continue;
      const rel = path.relative(testsDir, full).replace(/\\/g, '/');
      if (rel === 'seed.spec.ts' || entry.name.endsWith('.official.example.ts')) continue;

      const raw = fs.readFileSync(full, 'utf8');
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      if (/\bwaitForTimeout\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Hardcoded waitForTimeout() forbidden in ${rel}`);
      }
      if (/\brequest\.newContext\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Raw request.newContext() bypasses API safety guard in ${rel}; use { request } fixture from base.ts.`);
      }
      if (/\b(?:fetch\s*\(|from\s+['"](?:node:http|node:https|http|https|undici|axios)['"])/.test(stripped)) {
        errors.push(`[Static Check] Raw Node HTTP/fetch bypasses target/egress safety guard in ${rel}; use { request } fixture from base.ts.`);
      }

      if (ts) {
        const astSum = analyzeSourceAst(rel, raw, { assertFunctionNames, qaDir: qaDir || path.dirname(testsDir) });
        for (const v of astSum.violations) {
          if (['AITEST-G104', 'AITEST-G105', 'AITEST-G106', 'AITEST-G107', 'AITEST-G108', 'AITEST-G110', 'AITEST-G113', 'AITEST-G114'].includes(v.code)) {
            const covered = isCoveredByWaiver({ file: rel, title: v.snippet || v.code }, activeWaivers, 'spec');
            if (!covered) {
              errors.push(`[Static Check][${v.code}] ${v.message}`);
            }
          }
        }
        const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
        if (hasTestCall && astSum.assertions.length === 0 && !assertRegex.test(stripped)) {
          errors.push(
            `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
          );
        }
      } else {
        // Fallback regex checks when TypeScript is absent
        if (/\b(?:test|it|describe)\.only\s*\(/.test(stripped)) {
          errors.push(`[Static Check] Focused test (.only) forbidden in ${rel}`);
        }
        if (/\b(?:test|it|describe|testInfo)\.(?:skip|fixme)\s*\(/.test(stripped)) {
          const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
          if (!covered) errors.push(`[Static Check] Unwaived test.skip/test.fixme forbidden in ${rel}`);
        }
        if (/\b(?:test|it|describe|testInfo)\.fail\s*\(/.test(stripped)) {
          const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
          if (!covered) errors.push(`[Static Check] Expectation-inverting test.fail() forbidden in ${rel}`);
        }
        const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
        if (hasTestCall && !assertRegex.test(stripped)) {
          errors.push(
            `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
          );
        }
      }
    }
  };

  walk(testsDir);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * Layer 2 Static Check runner (`tsc --noEmit` + `eslint` + AST semantic scanner).
 * Fail-closed when `strictTools` or `process.env.CI === 'true'` and compilers are missing.
 */
export function runStaticSpecChecks(qaDir, options = {}) {
  const cfg = loadAitestConfig(qaDir);
  const activeWaivers = options.activeWaivers || [];
  const requireCompilers =
    options.requireCompilers !== undefined ? Boolean(options.requireCompilers) : isCiEnvironment(options.env);
  const errors = [...validateAssertFunctionNames(cfg.assertFunctionNames)];
  const warnings = [];
  let blocked = false;

  const tscBin = path.join(qaDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsconfigPath = path.join(qaDir, 'tsconfig.json');
  if (fs.existsSync(tscBin) && fs.existsSync(tsconfigPath)) {
    const tscRes = execNodeSync([tscBin, '--noEmit', '-p', tsconfigPath], qaDir);
    if (tscRes.status !== 0) {
      const msg = (tscRes.stdout || tscRes.stderr || '').trim();
      errors.push(`[TypeCheck] tsc --noEmit failed:\n${msg}`);
    }
  } else if (requireCompilers) {
    blocked = true;
    errors.push('[TypeCheck Blocked] typescript compiler not installed locally; fail-closed in CI/strict mode.');
  } else {
    warnings.push('[TypeCheck] typescript compiler not installed locally; skipped tsc --noEmit.');
  }

  const eslintBin = path.join(qaDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const eslintCfg = path.join(qaDir, 'eslint.config.mjs');
  const testsDir = path.join(qaDir, 'tests');

  if (fs.existsSync(eslintBin) && fs.existsSync(eslintCfg) && fs.existsSync(testsDir)) {
    const eslintRes = execNodeSync([eslintBin, 'tests'], qaDir);
    if (eslintRes.status !== 0) {
      const msg = (eslintRes.stdout || eslintRes.stderr || '').trim();
      errors.push(`[ESLint] Playwright anti-fake-green lint failed:\n${msg}`);
    }
    const semanticScan = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
    });
    for (const e of semanticScan.errors) {
      if (!errors.includes(e)) errors.push(e);
    }
  } else {
    if (requireCompilers) {
      blocked = true;
      errors.push('[Static Check Blocked] eslint not found in node_modules; fail-closed in CI/strict mode.');
    } else {
      warnings.push('[Static Check] eslint not found in node_modules; running built-in AST/semantic spec scanner.');
    }
    const fallback = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
    });
    errors.push(...fallback.errors);
  }

  return {
    ok: errors.length === 0,
    status: blocked ? 'blocked' : errors.length === 0 ? 'pass' : 'fail',
    errors,
    warnings,
  };
}

function execNodeSync(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
}
