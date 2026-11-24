import { unwrapExpr } from './ts-loader.mjs';

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

/**
 * Recursive AST constant evaluator for S0 tautology detection (`G-04`).
 * Detects `true`, `(true)`, `1 + 1`, `Number('1')`, `[1].length`, `await page.evaluate(() => 1)`, etc.
 * @param {any} ts
 * @param {any} sf
 * @param {any} rawNode
 * @returns {boolean}
 */
export function isConstantExpressionAst(ts, sf, rawNode) {
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
    return node.templateSpans.every((/** @type {any} */ span) => isConstantExpressionAst(ts, sf, span.expression));
  }

  if (ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.expression);
  }

  if (ts.isBinaryExpression(node)) {
    return isConstantExpressionAst(ts, sf, node.left) && isConstantExpressionAst(ts, sf, node.right);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((/** @type {any} */ el) => isConstantExpressionAst(ts, sf, el));
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((/** @type {any} */ prop) => {
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
      return node.arguments.length > 0 && node.arguments.every((/** @type {any} */ a) => isConstantExpressionAst(ts, sf, a));
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ['Math', 'JSON', 'Object', 'Array'].includes(node.expression.expression.text)
    ) {
      return node.arguments.every((/** @type {any} */ a) => isConstantExpressionAst(ts, sf, a));
    }
  }

  return false;
}

/**
 * Detects vacuous regex / predicate arguments (`new RegExp('.*')`, match-all regexes, `() => true`)
 * and self-referential DOM oracles (`expect(loc).toHaveText(await loc.textContent())`).
 * @param {any} ts
 * @param {any} sf
 * @param {string} matcher
 * @param {any} rawExpectedNode
 * @param {any} rawActualNode
 */
export function inspectMatcherExpectedArgAst(ts, sf, matcher, rawExpectedNode, rawActualNode) {
  if (!rawExpectedNode) {
    return { isVacuous: false, isNonEmptyRegex: false, isSelfReferential: false, isRegex: false, numericValue: null };
  }
  const expNode = unwrapExpr(ts, rawExpectedNode);
  const actNode = rawActualNode ? unwrapExpr(ts, rawActualNode) : null;

  let isSelfReferential = false;
  if (actNode) {
    const actText = actNode.getText(sf).replace(/\s+/g, '');
    const expText = expNode.getText(sf).replace(/\s+/g, '');
    if (actText && actText === expText && !isConstantExpressionAst(ts, sf, actNode)) {
      isSelfReferential = true;
    }
  }
  if (
    !isSelfReferential &&
    [
      'toHaveText',
      'toContainText',
      'toHaveValue',
      'toHaveAttribute',
      'toHaveTitle',
      'toHaveURL',
      'toHaveCount',
      'toBe',
      'toEqual',
      'toStrictEqual',
    ].includes(matcher)
  ) {
    /** @param {any} n @returns {boolean} */
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
      ts.forEachChild(u, (/** @type {any} */ child) => {
        if (!hit && containsSelfDomRead(child)) hit = true;
      });
      return hit;
    };
    if (containsSelfDomRead(expNode)) {
      isSelfReferential = true;
    }
  }

  let isRegex = false;
  let isVacuous = false;
  let isNonEmptyRegex = false;
  /** @param {string} pat */
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
  /** @param {string} pat */
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

  let numericValue = null;
  if (ts.isNumericLiteral(expNode)) {
    numericValue = Number(expNode.text);
  }

  return { isVacuous, isNonEmptyRegex, isSelfReferential, isRegex, numericValue };
}
