// @ts-check
import { normalizeLocatorExprKey } from './symbol-table.mjs';
import { unwrapExpr } from './ts-loader.mjs';

export const SELF_REF_DOM_READERS = new Set([
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
  'all',
]);

const PURE_CONVERTERS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'parseInt', 'parseFloat']);
// Guard against catastrophic ReDoS nested quantifiers like `(a+)+` while allowing lazy quantifiers `*?`, `+?`, `??` (`F07`)
const NESTED_QUANTIFIER_RE = /\([^)]*(?:[+*]|\{\d+,\d*\})[^)]*\)[+*{]/;
const EMPTY_STRING_VACUOUS_MATCHERS = new Set(['toContainText', 'toContain', 'toMatch']);

/** @param {any} ts @param {any} rawNode @param {any} symbolTable @param {string} scopeKey @param {Set<string>} visited */
export function isBooleanTrueLiteralAst(ts, rawNode, symbolTable, scopeKey, visited = new Set()) {
  const u = unwrapExpr(ts, rawNode);
  if (!u) return false;
  if (u.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isIdentifier(u) && symbolTable) {
    const bound = symbolTable.getConstInit(scopeKey, u.text);
    if (bound && !visited.has(u.text)) {
      return isBooleanTrueLiteralAst(ts, bound, symbolTable, scopeKey, new Set([...visited, u.text]));
    }
  }
  return false;
}

/** @param {any} ts @param {any} rawNode @param {any} symbolTable @param {string} scopeKey @param {Set<string>} visited */
function isBooleanFalseLiteralAst(ts, rawNode, symbolTable, scopeKey, visited) {
  const u = unwrapExpr(ts, rawNode);
  if (!u) return false;
  if (u.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(u) && symbolTable) {
    const bound = symbolTable.getConstInit(scopeKey, u.text);
    if (bound && !visited.has(u.text)) {
      return isBooleanFalseLiteralAst(ts, bound, symbolTable, scopeKey, new Set([...visited, u.text]));
    }
  }
  return false;
}

/**
 * Evaluates a constant primitive literal (string/number/boolean/null/undefined) for branch-equality checks (`G2-F08`).
 * @param {any} ts @param {any} rawNode @param {any} symbolTable @param {string | null} testTitle @param {Set<string>} [visited]
 * @returns {{ ok: boolean, value: any }}
 */
function evalConstPrimitive(ts, rawNode, symbolTable, testTitle, visited = new Set()) {
  const u = unwrapExpr(ts, rawNode);
  if (!u) return { ok: false, value: undefined };
  if (u.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (u.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (u.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return { ok: true, value: u.text };
  if (ts.isNumericLiteral(u)) return { ok: true, value: Number(u.text) };
  if (ts.isIdentifier(u)) {
    if (u.text === 'undefined') return { ok: true, value: undefined };
    if (symbolTable && !visited.has(u.text)) {
      const bound = symbolTable.getConstInit(testTitle, u.text);
      if (bound) return evalConstPrimitive(ts, bound, symbolTable, testTitle, new Set([...visited, u.text]));
    }
  }
  return { ok: false, value: undefined };
}

/**
 * Evaluates whether a regex pattern semantically matches empty or arbitrary single-char strings (vacuous match-all).
 * Guarded by length <= 256 and ReDoS nested-quantifier check while permitting lazy `*?` / `+?` (`F07`, `G2-F07`).
 * @param {string} body
 * @param {string} flags
 * @returns {boolean}
 */
export function isSemanticVacuousRegex(body, flags = '') {
  if (typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (
    trimmed === '' ||
    trimmed === '.*' ||
    trimmed === '.*?' ||
    trimmed === '^.*$' ||
    trimmed === '^.*?$' ||
    trimmed === '[\\s\\S]*' ||
    trimmed === '[\\s\\S]*?' ||
    trimmed === '[\\s\\S]' ||
    trimmed === '[\\S\\s]' ||
    trimmed === '[^]' ||
    (trimmed === '.' && String(flags || '').includes('s')) ||
    trimmed === '(?:)' ||
    trimmed === '^.*' ||
    trimmed === '.*$' ||
    trimmed === '^' ||
    trimmed === '$'
  ) {
    return true;
  }
  if (body.length > 256 || NESTED_QUANTIFIER_RE.test(body)) return false;
  try {
    const safeFlags = String(flags || '').replace(/[^dgimsuvy]/g, '').replace(/[gy]/g, '');
    const re = new RegExp(body, safeFlags);
    return re.test('') && re.test('__aitest_probe_9f3c__');
  } catch {
    return false;
  }
}

/**
 * Collects ALL `ReturnStatement` expressions inside a callback function body without descending into nested functions (`F47`).
 * @param {any} ts @param {any} fnNode @returns {any[]}
 */
export function extractCallbackReturnExprs(ts, fnNode) {
  const fn = unwrapExpr(ts, fnNode);
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return [];
  if (!ts.isBlock(fn.body)) return [unwrapExpr(ts, fn.body)];
  /** @type {any[]} */
  const out = [];
  /** @param {any} n */
  const walk = (n) => {
    if (!n) return;
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return;
    if (ts.isReturnStatement(n) && n.expression) {
      out.push(unwrapExpr(ts, n.expression));
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return out;
}

/** @param {any} ts @param {any} fnNode @returns {any | null} */
export function extractSingleReturnCallbackExpr(ts, fnNode) {
  const exprs = extractCallbackReturnExprs(ts, fnNode);
  return exprs.length === 1 ? exprs[0] : null;
}

/**
 * Recursive AST constant & logical-tautology evaluator for S0 detection (`G-04`, `WU-05`, v6.2.1).
 * @param {any} ts @param {any} sf @param {any} rawNode
 * @param {any} [symbolTable] @param {string | null} [testTitle] @param {Set<string>} [visited]
 * @returns {boolean}
 */
export function isConstantExpressionAst(ts, sf, rawNode, symbolTable = null, testTitle = null, visited = new Set()) {
  if (!rawNode) return false;
  const node = unwrapExpr(ts, rawNode);
  if (!node) return false;
  const scopeKey = testTitle || '<file>';

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

  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined' || node.text === 'NaN' || node.text === 'Infinity') return true;
    if (symbolTable && !visited.has(node.text)) {
      const bound = symbolTable.getConstInit(testTitle, node.text);
      if (bound && !ts.isArrayLiteralExpression(bound) && !ts.isObjectLiteralExpression(bound)) {
        return isConstantExpressionAst(ts, sf, bound, symbolTable, testTitle, new Set([...visited, node.text]));
      }
    }
    return false;
  }

  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((/** @type {any} */ span) =>
      isConstantExpressionAst(ts, sf, span.expression, symbolTable, testTitle, visited)
    );
  }

  if (ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.expression, symbolTable, testTitle, visited);
  }

  // `cond ? 'ok' : 'ok'` identical constant branches (`G2-F08`)
  if (ts.isConditionalExpression(node)) {
    const tConst = isConstantExpressionAst(ts, sf, node.whenTrue, symbolTable, testTitle, visited);
    const fConst = isConstantExpressionAst(ts, sf, node.whenFalse, symbolTable, testTitle, visited);
    if (tConst && fConst) {
      if (isConstantExpressionAst(ts, sf, node.condition, symbolTable, testTitle, visited)) return true;
      const tv = evalConstPrimitive(ts, node.whenTrue, symbolTable, testTitle, visited);
      const fv = evalConstPrimitive(ts, node.whenFalse, symbolTable, testTitle, visited);
      if (tv.ok && fv.ok && Object.is(tv.value, fv.value)) return true;
      try {
        if (node.whenTrue.getText(sf).replace(/\s+/g, '') === node.whenFalse.getText(sf).replace(/\s+/g, '')) {
          return true;
        }
      } catch {
        // ignore
      }
    }
    return false;
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      if (
        isBooleanTrueLiteralAst(ts, node.left, symbolTable, scopeKey, visited) ||
        isBooleanTrueLiteralAst(ts, node.right, symbolTable, scopeKey, visited)
      ) {
        return true;
      }
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (
        isBooleanFalseLiteralAst(ts, node.left, symbolTable, scopeKey, visited) ||
        isBooleanFalseLiteralAst(ts, node.right, symbolTable, scopeKey, visited)
      ) {
        return true;
      }
    }
    return (
      isConstantExpressionAst(ts, sf, node.left, symbolTable, testTitle, visited) &&
      isConstantExpressionAst(ts, sf, node.right, symbolTable, testTitle, visited)
    );
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((/** @type {any} */ el) =>
      isConstantExpressionAst(ts, sf, el, symbolTable, testTitle, visited)
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((/** @type {any} */ prop) =>
      ts.isPropertyAssignment(prop)
        ? isConstantExpressionAst(ts, sf, prop.initializer, symbolTable, testTitle, visited)
        : false
    );
  }

  if (ts.isPropertyAccessExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.expression, symbolTable, testTitle, visited);
  }

  if (ts.isElementAccessExpression(node)) {
    return (
      isConstantExpressionAst(ts, sf, node.expression, symbolTable, testTitle, visited) &&
      isConstantExpressionAst(ts, sf, node.argumentExpression, symbolTable, testTitle, visited)
    );
  }

  if (ts.isAwaitExpression(node)) {
    const inner = unwrapExpr(ts, node.expression);
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === 'evaluate' &&
      inner.arguments.length >= 1
    ) {
      const returns = extractCallbackReturnExprs(ts, inner.arguments[0]);
      if (returns.length > 0) {
        return returns.every((r) => isConstantExpressionAst(ts, sf, r, symbolTable, testTitle, visited));
      }
    }
    return isConstantExpressionAst(ts, sf, inner, symbolTable, testTitle, visited);
  }

  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && PURE_CONVERTERS.has(node.expression.text)) {
      return (
        node.arguments.length > 0 &&
        node.arguments.every((/** @type {any} */ a) => isConstantExpressionAst(ts, sf, a, symbolTable, testTitle, visited))
      );
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ['Math', 'JSON', 'Object', 'Array'].includes(node.expression.expression.text)
    ) {
      return node.arguments.every((/** @type {any} */ a) =>
        isConstantExpressionAst(ts, sf, a, symbolTable, testTitle, visited)
      );
    }
  }

  return false;
}

/**
 * Checks if an expression performs an arithmetic or substantive template derivation (e.g. `count + 1`, `` `doubled: ${(count + 1) * 2}` ``),
 * which indicates a genuine computed expectation rather than a raw copy-back self-referential oracle.
 * @param {any} ts @param {any} rawNode @returns {boolean}
 */
function hasArithmeticOrSubstantiveDerivation(ts, rawNode) {
  let derived = false;
  /** @param {any} n */
  const walk = (n) => {
    if (derived || !n) return;
    const u = unwrapExpr(ts, n);
    if (ts.isBinaryExpression(u)) {
      const op = u.operatorToken.kind;
      if (
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.SlashToken ||
        op === ts.SyntaxKind.PercentToken ||
        op === ts.SyntaxKind.AsteriskAsteriskToken
      ) {
        derived = true;
        return;
      }
      if (op === ts.SyntaxKind.PlusToken) {
        const l = unwrapExpr(ts, u.left);
        const r = unwrapExpr(ts, u.right);
        const isEmptyStrCoerce =
          (ts.isStringLiteral(l) && l.text === '') || (ts.isStringLiteral(r) && r.text === '');
        if (!isEmptyStrCoerce) {
          derived = true;
          return;
        }
      }
    }
    if (ts.isTemplateExpression(u)) {
      const hasStaticText =
        (u.head?.text || '').trim().length > 0 ||
        u.templateSpans.some((/** @type {any} */ sp) => (sp.literal?.text || '').trim().length > 0);
      if (hasStaticText) {
        derived = true;
        return;
      }
    }
    ts.forEachChild(u, walk);
  };
  walk(rawNode);
  return derived;
}

/**
 * Inspects ALL matcher arguments (`args[0..N]`) for vacuous regexes/empty strings/predicates
 * and same-locator, no-intervening-action self-referential DOM oracles (`WU-05`, v6.2.1).
 * @param {any} ts @param {any} sf @param {string} matcher
 * @param {any | any[]} rawExpectedOrArgs @param {any} rawActualNode
 * @param {any} [symbolTable] @param {string | null} [testTitle]
 */
export function inspectMatcherExpectedArgAst(ts, sf, matcher, rawExpectedOrArgs, rawActualNode, symbolTable = null, testTitle = null) {
  const argsList = Array.isArray(rawExpectedOrArgs)
    ? rawExpectedOrArgs.filter(Boolean)
    : rawExpectedOrArgs
      ? [rawExpectedOrArgs]
      : [];
  if (argsList.length === 0) {
    return { isVacuous: false, isNonEmptyRegex: false, isSelfReferential: false, isRegex: false, numericValue: null };
  }

  const actNode = rawActualNode ? unwrapExpr(ts, rawActualNode) : null;
  const scopeKey = testTitle || '<file>';
  const aliases = symbolTable?.locatorAliases || new Map();
  const assertPos = actNode && typeof actNode.getStart === 'function' ? actNode.getStart(sf) : actNode?.pos || 0;
  let actLocatorKey = actNode ? normalizeLocatorExprKey(ts, sf, actNode, aliases, scopeKey) : '';
  if (actNode && ts.isIdentifier(actNode) && symbolTable?.getDomTaintInfo) {
    const actTaint = symbolTable.getDomTaintInfo(testTitle, actNode.text);
    if (actTaint?.locatorKey) actLocatorKey = actTaint.locatorKey;
  }

  const resolveNode = (/** @type {any} */ raw, visited = new Set()) => {
    const u = unwrapExpr(ts, raw);
    if (ts.isIdentifier(u) && symbolTable && !visited.has(u.text)) {
      const bound = symbolTable.getConstInit(testTitle, u.text);
      if (bound) return resolveNode(bound, new Set([...visited, u.text]));
    }
    return u;
  };

  let isSelfReferential = false;
  const selfRefMatchers = new Set([
    'toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute',
    'toHaveTitle', 'toHaveURL', 'toHaveCount', 'toBe', 'toEqual', 'toStrictEqual',
  ]);

  /** @param {any} n @returns {{ locatorKey: string, readPos: number } | null} */
  const findExpectedDomTaint = (n) => {
    if (!n) return null;
    const u = unwrapExpr(ts, n);
    if (ts.isAwaitExpression(u)) return findExpectedDomTaint(u.expression);
    if (ts.isIdentifier(u) && symbolTable?.getDomTaintInfo) {
      const info = symbolTable.getDomTaintInfo(testTitle, u.text);
      if (info) return { locatorKey: info.locatorKey, readPos: info.readPos };
    }
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && SELF_REF_DOM_READERS.has(u.expression.name.text)) {
      const lk = normalizeLocatorExprKey(ts, sf, u.expression.expression, aliases, scopeKey);
      const pos = typeof u.getStart === 'function' ? u.getStart(sf) : u.pos || 0;
      return { locatorKey: lk, readPos: pos };
    }
    /** @type {{ locatorKey: string, readPos: number } | null} */
    let hit = null;
    ts.forEachChild(u, (/** @type {any} */ child) => {
      if (!hit) hit = findExpectedDomTaint(child);
    });
    return hit;
  };

  let isRegex = false;
  let isVacuous = false;
  let isNonEmptyRegex = false;
  let numericValue = null;
  const isNonEmptyOnlyPattern = (/** @type {string} */ pat) => {
    const trimmed = String(pat || '').trim();
    return (
      trimmed === '.+' ||
      trimmed === '.+?' ||
      trimmed === '^.+$' ||
      trimmed === '[\\s\\S]+' ||
      trimmed === '[\\s\\S]+?' ||
      trimmed === '\\S+' ||
      trimmed === '\\S+?'
    );
  };

  for (let i = 0; i < argsList.length; i += 1) {
    const expNode = unwrapExpr(ts, argsList[i]);
    const resolved = resolveNode(expNode);
    if (actNode) {
      const actText = actNode.getText(sf).replace(/\s+/g, '');
      const expText = expNode.getText(sf).replace(/\s+/g, '');
      if (actText && actText === expText && !isConstantExpressionAst(ts, sf, actNode, symbolTable, testTitle)) {
        isSelfReferential = true;
      }
    }
    if (!isSelfReferential && selfRefMatchers.has(matcher) && !hasArithmeticOrSubstantiveDerivation(ts, expNode)) {
      const domTaint = findExpectedDomTaint(expNode);
      if (domTaint && domTaint.locatorKey && actLocatorKey) {
        const sameLocator = domTaint.locatorKey === actLocatorKey;
        const hadAction = symbolTable?.hasActionBetween
          ? symbolTable.hasActionBetween(testTitle, domTaint.readPos, assertPos)
          : false;
        if (sameLocator && !hadAction) {
          isSelfReferential = true;
        }
      }
    }

    if (
      i === 0 &&
      EMPTY_STRING_VACUOUS_MATCHERS.has(matcher) &&
      (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) &&
      resolved.text === ''
    ) {
      isVacuous = true;
    }

    if (ts.isRegularExpressionLiteral(resolved)) {
      isRegex = true;
      const raw = resolved.getText(sf);
      const lastSlash = raw.lastIndexOf('/');
      const body = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      if (isSemanticVacuousRegex(body, flags)) isVacuous = true;
      else if (isNonEmptyOnlyPattern(body)) isNonEmptyRegex = true;
    } else if (
      (ts.isNewExpression(resolved) || ts.isCallExpression(resolved)) &&
      ts.isIdentifier(resolved.expression) &&
      resolved.expression.text === 'RegExp'
    ) {
      isRegex = true;
      const arg0 = resolved.arguments?.[0] ? resolveNode(resolved.arguments[0]) : null;
      const arg1 = resolved.arguments?.[1] ? resolveNode(resolved.arguments[1]) : null;
      const flags = arg1 && (ts.isStringLiteral(arg1) || ts.isNoSubstitutionTemplateLiteral(arg1)) ? arg1.text : '';
      if (!arg0) {
        isVacuous = true;
      } else if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
        if (isSemanticVacuousRegex(arg0.text, flags)) isVacuous = true;
        else if (isNonEmptyOnlyPattern(arg0.text)) isNonEmptyRegex = true;
      }
    }

    const retExprs = extractCallbackReturnExprs(ts, expNode);
    if (
      retExprs.length > 0 &&
      retExprs.every((r) => isBooleanTrueLiteralAst(ts, r, symbolTable, scopeKey, new Set()))
    ) {
      isVacuous = true;
    }

    if (i === 0 && ts.isNumericLiteral(resolved)) {
      numericValue = Number(resolved.text);
    }
  }

  return { isVacuous, isNonEmptyRegex, isSelfReferential, isRegex, numericValue };
}
