// @ts-check
import { extractCallbackReturnExprs, isBooleanTrueLiteralAst } from './constant-eval.mjs';
import {
  RUNTIME_CAPABILITY_RE,
  SEMANTIC_LOCATOR_METHODS,
  hasExpectOrAssertCall,
  hasThrowStatement,
  inspectRouteFulfillHandler,
} from './parser-inspectors.mjs';
import { unwrapExpr } from './ts-loader.mjs';

/**
 * Checks whether an `expect.extend` custom matcher function unconditionally returns `{ pass: true }` (`F12`).
 * @param {any} ts
 * @param {any} fnNode
 * @param {any} symbolTable
 * @param {string} scopeKey
 */
function isAlwaysPassCustomMatcher(ts, fnNode, symbolTable, scopeKey) {
  if (!fnNode) return false;
  let bodyFn = fnNode;
  if (ts.isMethodDeclaration(fnNode)) {
    if (!fnNode.body) return false;
    bodyFn = { kind: ts.SyntaxKind.FunctionExpression, body: fnNode.body };
  }
  const returns = ts.isMethodDeclaration(fnNode)
    ? (() => {
        /** @type {any[]} */
        const out = [];
        /** @param {any} n */
        const walk = (n) => {
          if (!n) return;
          if (n !== fnNode && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return;
          if (ts.isReturnStatement(n) && n.expression) {
            out.push(unwrapExpr(ts, n.expression));
            return;
          }
          ts.forEachChild(n, walk);
        };
        walk(fnNode.body);
        return out;
      })()
    : extractCallbackReturnExprs(ts, bodyFn);
  if (returns.length === 0) return false;
  return returns.every((ret) => {
    const obj = unwrapExpr(ts, ret);
    if (!obj || !ts.isObjectLiteralExpression(obj)) return false;
    for (const prop of obj.properties) {
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'pass') {
        return isBooleanTrueLiteralAst(ts, prop.name, symbolTable, scopeKey, new Set());
      }
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === 'pass') ||
          (ts.isStringLiteral(prop.name) && prop.name.text === 'pass'))
      ) {
        return isBooleanTrueLiteralAst(ts, prop.initializer, symbolTable, scopeKey, new Set());
      }
    }
    return false;
  });
}

/**
 * Inspects Playwright lifecycle & anti-fake-green non-assertion call expressions
 * (`skip/fixme/only/fail`, `expect.configure({soft:true})`, `test.setTimeout`, `.toPass`, `.catch`, `page.route`, generic locators).
 * @param {any} ts
 * @param {any} sf
 * @param {any} node
 * @param {string} calleeText
 * @param {number} line
 * @param {any} ctx
 * @param {any} state
 */
export function inspectNonAssertionCallEvents(ts, sf, node, calleeText, line, ctx, state) {
  const { fileLabel, isCustomAssertName, symbolTable, pendingAllSettledCalls, summary, pushViolation } = state;

  // Skip / fixme / only / fail (`AITEST-G105`)
  if (
    /^(?:test|it|describe|test\.describe)\.(?:skip|fixme|only)$/.test(calleeText) ||
    /^(?:testInfo|info)\.(?:skip|fixme)$/.test(calleeText)
  ) {
    const rawCall = node.getText(sf);
    const firstLine = rawCall.split(/\r?\n/)[0].trim();
    const isStandaloneGuard =
      /^(?:test|testInfo|info)\.skip$/.test(calleeText) &&
      node.arguments.length >= 1 &&
      !(node.arguments.length >= 2 && (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))) &&
      !(node.arguments.length >= 3 && (ts.isArrowFunction(node.arguments[2]) || ts.isFunctionExpression(node.arguments[2])));
    const condText = isStandaloneGuard ? node.arguments[0].getText(sf) : '';
    const isCapabilityGuard = isStandaloneGuard && RUNTIME_CAPABILITY_RE.test(condText);
    const ev = {
      kind: calleeText.endsWith('.only') ? 'only' : 'skip',
      calleeText,
      line,
      scopeKind: ctx.scopeKind,
      testTitle: ctx.testTitle,
      isStandaloneGuard,
      isCapabilityGuard,
      snippet: rawCall.slice(0, 160),
      message: `${fileLabel}: added skip/fixme/only ("${firstLine}").`,
    };
    summary.events.skips.push(ev);
    pushViolation('AITEST-G105', ev.message, rawCall, ev);
  }

  if (/^(?:test|it|describe|test\.describe|testInfo|info)\.fail$/.test(calleeText)) {
    const rawCall = node.getText(sf);
    const firstLine = rawCall.split(/\r?\n/)[0].trim();
    const ev = {
      kind: 'fail',
      calleeText,
      line,
      scopeKind: ctx.scopeKind,
      testTitle: ctx.testTitle,
      isStandaloneGuard: false,
      isCapabilityGuard: false,
      snippet: rawCall.slice(0, 160),
      message: `${fileLabel}: added expectation-inverting .fail() ("${firstLine}").`,
    };
    summary.events.skips.push(ev);
    pushViolation('AITEST-G105', ev.message, rawCall, ev);
  }

  // `expect.configure({ soft: true })` or shorthand `{ soft }` with `soft = true` (`AITEST-G106`, `G2-F04`)
  const isConfigureCall =
    calleeText === 'expect.configure' ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'configure' &&
      ts.isIdentifier(node.expression.expression) &&
      (symbolTable?.expectAliases?.has(node.expression.expression.text) ||
        /expect/i.test(node.expression.expression.text)));
  if (isConfigureCall && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const scopeKey = ctx.testTitle || '<file>';
    const hasSoftTrue = node.arguments[0].properties.some((/** @type {any} */ p) => {
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'soft') {
        return isBooleanTrueLiteralAst(ts, p.name, symbolTable, scopeKey, new Set());
      }
      if (
        ts.isPropertyAssignment(p) &&
        ((ts.isIdentifier(p.name) && p.name.text === 'soft') ||
          (ts.isStringLiteral(p.name) && p.name.text === 'soft'))
      ) {
        return isBooleanTrueLiteralAst(ts, p.initializer, symbolTable, scopeKey, new Set());
      }
      return false;
    });
    if (hasSoftTrue) {
      const ev = {
        kind: 'expect.configure',
        line,
        scopeKind: ctx.scopeKind,
        testTitle: ctx.testTitle,
        snippet: node.getText(sf),
        message: `${fileLabel}: expect.configure({ soft: true }) globally weakens assertions to soft mode.`,
      };
      summary.events.softAssertions.push(ev);
      pushViolation('AITEST-G106', ev.message, ev.snippet, ev);
    }
  }

  // `test.setTimeout(>=60000)` & `.toPass({ timeout: >=30000 })` (`AITEST-G109`)
  if (calleeText === 'test.setTimeout' && node.arguments[0]) {
    const arg0 = unwrapExpr(ts, node.arguments[0]);
    if (ts.isNumericLiteral(arg0) && Number(arg0.text) >= 60_000) {
      const ev = {
        line,
        scopeKind: ctx.scopeKind,
        testTitle: ctx.testTitle,
        snippet: node.getText(sf),
        message: `${fileLabel}: excessive test.setTimeout(${arg0.text}ms >= 60000ms).`,
      };
      summary.events.timeoutOrRetry.push(ev);
      pushViolation('AITEST-G109', ev.message, ev.snippet, ev);
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
          const ev = {
            line,
            scopeKind: ctx.scopeKind,
            testTitle: ctx.testTitle,
            snippet: node.getText(sf),
            message: `${fileLabel}: inflated toPass({ timeout: ${unwrapExpr(ts, p.initializer).text} }) masks product latency/failure.`,
          };
          summary.events.timeoutOrRetry.push(ev);
          pushViolation('AITEST-G109', ev.message, ev.snippet, ev);
        }
      }
    }
  }

  // `expect.extend({ m() { return { pass: true }; } })` & `<alias>.extend` (`AITEST-G104`, `F12`)
  const isExtendCall =
    calleeText === 'expect.extend' ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'extend' &&
      ts.isIdentifier(node.expression.expression) &&
      (symbolTable?.expectAliases?.has(node.expression.expression.text) ||
        /expect/i.test(node.expression.expression.text)));
  if (isExtendCall && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const scopeKey = ctx.testTitle || '<file>';
    const hasAlwaysPass = node.arguments[0].properties.some((/** @type {any} */ p) => {
      if (ts.isMethodDeclaration(p)) return isAlwaysPassCustomMatcher(ts, p, symbolTable, scopeKey);
      if (ts.isPropertyAssignment(p)) return isAlwaysPassCustomMatcher(ts, p.initializer, symbolTable, scopeKey);
      return false;
    });
    if (hasAlwaysPass) {
      const snippet = node.getText(sf).slice(0, 160);
      const ev = {
        line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, label: 'S0-expect-extend-pass-true', snippet,
        message: `${fileLabel}: expect.extend() custom matcher returning unconditional { pass: true } forbidden.`,
      };
      summary.events.tautologies.push(ev);
      pushViolation('AITEST-G104', ev.message, snippet, ev);
    }
  }

  // `Promise.allSettled(...)` without settled assertion (`AITEST-G107` resolved post-visit)
  if (calleeText === 'Promise.allSettled' && ctx.scopeKind === 'test' && pendingAllSettledCalls) {
    pendingAllSettledCalls.push({
      line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, snippet: node.getText(sf).slice(0, 160),
    });
  }

  // Swallowed `.catch(...)` or 2-arg `.then(onFulfilled, onRejected)` without rethrow (`AITEST-G107`)
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then' && node.arguments.length >= 2) {
    const rejHandler = node.arguments[1];
    if (rejHandler && !hasThrowStatement(ts, rejHandler)) {
      const rawCall = node.getText(sf);
      const ev = {
        kind: 'dot-then-swallow',
        line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
        insideBrowserEvaluate: ctx.insideBrowserEvaluate,
        hasAssertionInCatch: hasExpectOrAssertCall(ts, sf, rejHandler, isCustomAssertName),
        capturesErrorFlag: false, snippet: rawCall.slice(0, 160),
        message: `${fileLabel}: 2-arg .then(onFulfilled, onRejected) swallows rejection without throwing.`,
      };
      summary.events.swallowedCatches.push(ev);
      pushViolation('AITEST-G107', ev.message, rawCall, ev);
    }
  }
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
    const handler = node.arguments[0];
    if (!handler || !hasThrowStatement(ts, handler)) {
      const rawCall = node.getText(sf);
      const ev = {
        kind: 'dot-catch',
        line,
        scopeKind: ctx.scopeKind,
        testTitle: ctx.testTitle,
        insideBrowserEvaluate: ctx.insideBrowserEvaluate,
        hasAssertionInCatch: handler ? hasExpectOrAssertCall(ts, sf, handler, isCustomAssertName) : false,
        capturesErrorFlag: false,
        snippet: rawCall.slice(0, 160),
        message: `${fileLabel}: swallowed exception via non-rethrowing .catch() ("${rawCall.split(/\r?\n/)[0].trim()}").`,
      };
      summary.events.swallowedCatches.push(ev);
      pushViolation('AITEST-G107', ev.message, rawCall, ev);
    }
  }

  // Backend faking via `page.route` (direct callback OR 1-hop named handler) or `routeFromHAR` (`AITEST-G114`)
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'routeFromHAR') {
    const firstLine = node.getText(sf).split(/\r?\n/)[0];
    const ev = {
      line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
      urlPatternText: node.arguments[0]?.getText(sf) || 'har',
      statusCodes: [], isFaultInjection: false, setsExternalTrapVar: false,
      snippet: firstLine.slice(0, 160),
      message: `${fileLabel}: routeFromHAR() replays mocked traffic instead of hitting live backend (requires waiver).`,
    };
    summary.events.routeFulfills.push(ev);
    pushViolation('AITEST-G114', ev.message, firstLine, ev);
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'route' &&
    node.arguments.length >= 2
  ) {
    const rawHandler = node.arguments[1];
    const handler =
      ts.isIdentifier(rawHandler) && symbolTable?.namedRouteHandlers?.has(rawHandler.text)
        ? symbolTable.namedRouteHandlers.get(rawHandler.text)
        : rawHandler;
    const meta = inspectRouteFulfillHandler(ts, sf, handler);
    if (meta.hasFulfill) {
      const firstLine = node.getText(sf).split(/\r?\n/)[0];
      const urlPatternText = node.arguments[0].getText(sf);
      const ev = {
        line,
        scopeKind: ctx.scopeKind,
        testTitle: ctx.testTitle,
        urlPatternText,
        statusCodes: meta.statusCodes,
        isFaultInjection: meta.isFaultInjection,
        setsExternalTrapVar: meta.setsExternalTrapVar,
        snippet: firstLine.slice(0, 160),
        message: `${fileLabel}: mocking backend response via route.fulfill() in spec can fabricate fake-green oracles (requires waiver).`,
      };
      summary.events.routeFulfills.push(ev);
      pushViolation('AITEST-G114', ev.message, firstLine, ev);
    }
  }

  // Semantic vs generic locators (`AITEST-G111`)
  if (ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    if (SEMANTIC_LOCATOR_METHODS.has(methodName)) summary.semanticLocators += 1;
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
}
