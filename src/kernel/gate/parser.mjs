// @ts-check
import {
  buildCustomAssertNameMatcher,
  classifyExpectChainAst,
  extractExpectChainFromCall,
} from './lattice.mjs';
import { inspectNonAssertionCallEvents } from './parser-calls.mjs';
import {
  BROWSER_EVAL_METHODS,
  SUCCESS_STATUS_CODES,
  extractStringLiteralText,
  hasExpectOrAssertCall,
  inspectEarlyReturnInBlock,
  inspectPropertyAssignment,
  inspectTryStatement,
} from './parser-inspectors.mjs';
import {
  assertionVerifiesSettledResult,
  extractCollectionTargetKeys,
  extractLoopTargetKeys,
  isValidLoopCountGuard,
} from './parser-loops.mjs';
import { buildSymbolTable } from './symbol-table.mjs';
import { getNodeLine, resolveTypeScriptCompiler, unwrapExpr } from './ts-loader.mjs';

/**
 * @typedef {{
 *   tier: number; label: string; matcher: string; isSoft: boolean; isNegated: boolean;
 *   isTautology: boolean; isSelfReferential?: boolean; isVacuous?: boolean; isAriaSnapshot: boolean;
 *   implicitCountCredit?: boolean; hasApiSchema?: boolean; screenshotOptions?: Record<string, number> | null;
 *   isStatusCheck?: boolean; statusCodes?: number[]; isStatusRangeCheck?: boolean;
 *   numericExpected: number | null; actualExpr?: string; expectedArg?: string; raw: string;
 *   countGuardKeys?: string[];
 *   line: number; scopeKind: string; testTitle: string | null;
 *   insideIf: boolean; insideIfInTest: boolean; insideTernary: boolean;
 *   insideDynamicLoop?: boolean; insideEventListener?: boolean; insideBrowserEvaluate: boolean;
 * }} AstAssertion
 * @typedef {{
 *   line: number; scopeKind: string; testTitle: string | null; snippet: string; message: string;
 *   kind?: string; label?: string; calleeText?: string; isStandaloneGuard?: boolean;
 *   isCapabilityGuard?: boolean; insideBrowserEvaluate?: boolean; hasAssertionInCatch?: boolean;
 *   capturesErrorFlag?: boolean; tryContainsAssert?: boolean; tryTextSnippet?: string;
 *   insideIfInTest?: boolean; urlPatternText?: string; statusCodes?: number[];
 *   isFaultInjection?: boolean; setsExternalTrapVar?: boolean;
 * }} AstEvent
 * @typedef {{ code: string; message: string; snippet: string; line: number; testTitle: string | null; scopeKind: string }} AstViolation
 * @typedef {{
 *   file: string; usedAst: boolean; compilerUnavailable: boolean;
 *   assertions: AstAssertion[]; customAssertCalls: number; semanticLocators: number; genericLocators: number;
 *   successStatuses: number; serverErrorStatuses: number; criticalTags: string[];
 *   testBlocks: Array<{ title: string; reqIds: string[]; line: number; assertions: AstAssertion[] }>;
 *   events: {
 *     configTamper: AstEvent[]; tautologies: AstEvent[]; skips: AstEvent[]; softAssertions: AstEvent[];
 *     swallowedCatches: AstEvent[]; forceTrue: AstEvent[]; timeoutOrRetry: AstEvent[];
 *     conditionalAssertions: AstEvent[]; emptyHelpers: AstEvent[]; routeFulfills: AstEvent[];
 *   };
 *   violations: AstViolation[];
 * }} AstSummary
 */

/** @param {any} ts @param {any} node @returns {boolean} */
function isStaticNonEmptyLoopNode(ts, node) {
  if (ts.isForOfStatement(node)) {
    const u = unwrapExpr(ts, node.expression);
    return Boolean(u && ts.isArrayLiteralExpression(u) && u.elements.length > 0);
  }
  return false;
}

/**
 * Extracts a structured, scope-aware semantic summary of a TS/JS spec source (`WU-05` SymbolTable enabled).
 * @param {string} fileLabel @param {string} sourceText
 * @param {{ assertFunctionNames?: string[], qaDir?: string, wrapInAsyncFn?: boolean, tsCompiler?: any }} [options]
 * @returns {AstSummary}
 */
export function analyzeSourceAst(fileLabel, sourceText, options = {}) {
  const assertFunctionNames = options.assertFunctionNames || ['expect*', 'assert*', 'verify*'];
  const isCustomAssertName = buildCustomAssertNameMatcher(assertFunctionNames);
  const ts = 'tsCompiler' in options ? options.tsCompiler : resolveTypeScriptCompiler(options.qaDir);

  /** @type {AstSummary} */
  const summary = {
    file: fileLabel,
    usedAst: false,
    compilerUnavailable: false,
    assertions: [],
    customAssertCalls: 0,
    semanticLocators: 0,
    genericLocators: 0,
    successStatuses: 0,
    serverErrorStatuses: 0,
    criticalTags: [],
    testBlocks: [],
    events: {
      configTamper: [], tautologies: [], skips: [], softAssertions: [], swallowedCatches: [],
      forceTrue: [], timeoutOrRetry: [], conditionalAssertions: [], emptyHelpers: [], routeFulfills: [],
    },
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
  const symbolTable = buildSymbolTable(ts, sf);

  /** @param {string} code @param {string} message @param {string} [snippet] @param {Record<string, any>} [meta] */
  const pushViolation = (code, message, snippet = '', meta = {}) => {
    summary.violations.push({
      code,
      message,
      snippet: String(snippet || '').slice(0, 160),
      line: meta.line || 1,
      testTitle: meta.testTitle || null,
      scopeKind: meta.scopeKind || 'top-level',
    });
  };

  /** @type {Array<{ line: number, scopeKind: string, testTitle: string | null, snippet: string, loopTargetKeys: string[] }>} */
  const pendingLoopAssertions = [];
  /** @type {Array<{ line: number, scopeKind: string, testTitle: string | null, snippet: string }>} */
  const pendingAllSettledCalls = [];

  const state = {
    fileLabel,
    wrapInAsyncFn: Boolean(options.wrapInAsyncFn),
    isCustomAssertName,
    symbolTable,
    pendingAllSettledCalls,
    summary,
    pushViolation,
  };

  const initialCtx = {
    insideIf: false,
    insideIfInTest: false,
    insideTernary: false,
    insideDynamicLoop: false,
    loopTargetKeys: /** @type {string[]} */ ([]),
    insideEventListener: false,
    insideBrowserEvaluate: false,
    scopeKind: options.wrapInAsyncFn ? 'test' : 'top-level',
    testTitle: /** @type {string | null} */ (null),
  };

  /** @param {any} node @param {typeof initialCtx} [ctx] */
  const visit = (node, ctx = initialCtx) => {
    const line = getNodeLine(ts, sf, node);

    if (ts.isBlock(node)) inspectEarlyReturnInBlock(ts, sf, node, ctx, state);
    if (ts.isTryStatement(node)) inspectTryStatement(ts, sf, node, line, ctx, state);

    if (ts.isFunctionDeclaration(node) && node.name && isCustomAssertName(node.name.text) && node.body) {
      if (!hasExpectOrAssertCall(ts, sf, node.body, isCustomAssertName)) {
        const ev = {
          line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, snippet: node.name.text,
          message: `${fileLabel}: custom assertion helper "${node.name.text}" contains zero real expect() calls.`,
        };
        summary.events.emptyHelpers.push(ev);
        pushViolation('AITEST-G113', ev.message, ev.snippet, ev);
      }
    }
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isCustomAssertName(node.name.text) &&
      node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      if (!hasExpectOrAssertCall(ts, sf, node.initializer.body, isCustomAssertName)) {
        const ev = {
          line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, snippet: node.name.text,
          message: `${fileLabel}: custom assertion helper "${node.name.text}" contains zero real expect() calls.`,
        };
        summary.events.emptyHelpers.push(ev);
        pushViolation('AITEST-G113', ev.message, ev.snippet, ev);
      }
    }

    if (ts.isPropertyAssignment(node)) inspectPropertyAssignment(ts, sf, node, line, ctx, state);

    /** @type {Partial<typeof initialCtx> | null} */
    let childScopeOverride = null;
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sf).replace(/\s+/g, '');

      if (/^(?:test|it|test\.describe|describe)(?:\.[a-z]+)?$/.test(calleeText) && node.arguments.length >= 1) {
        const titleStr = extractStringLiteralText(ts, node.arguments[0]);
        if (titleStr) {
          for (const tag of titleStr.match(/@(?:critical|smoke)\b/gi) || []) summary.criticalTags.push(tag.toLowerCase());
        }
        if (node.arguments.length >= 2 && ts.isObjectLiteralExpression(node.arguments[1])) {
          for (const objTag of node.arguments[1].getText(sf).match(/@(?:critical|smoke)\b/gi) || []) {
            summary.criticalTags.push(objTag.toLowerCase());
          }
        }
        const isDescribe = /^(?:test\.describe|describe)\b/.test(calleeText);
        const isHook = /^test\.(?:beforeEach|afterEach|beforeAll|afterAll)$/.test(calleeText);
        const isTestDef = !isDescribe && !isHook && /^(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?$/.test(calleeText) && node.arguments.length >= 2;
        if (isTestDef) {
          const testTitle = titleStr || (node.arguments[0] ? node.arguments[0].getText(sf).slice(0, 80) : '<unnamed>');
          const reqIds = [...new Set(testTitle.match(/\bREQ-[A-Za-z0-9_-]+\b/g) || [])];
          summary.testBlocks.push({ title: testTitle, reqIds, line, assertions: [] });
          childScopeOverride = { scopeKind: 'test', testTitle, insideIfInTest: false, insideDynamicLoop: false, loopTargetKeys: [], insideEventListener: false };
        } else if (isDescribe) {
          childScopeOverride = { scopeKind: 'describe' };
        } else if (isHook) {
          childScopeOverride = { scopeKind: 'hook', insideIfInTest: false, insideDynamicLoop: false, loopTargetKeys: [], insideEventListener: false };
        }
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const mName = node.expression.name.text;
        if (BROWSER_EVAL_METHODS.has(mName)) {
          childScopeOverride = { ...(childScopeOverride || {}), scopeKind: 'browser-evaluate', insideBrowserEvaluate: true };
        } else if ((mName === 'forEach' || mName === 'map') && node.arguments.length >= 1) {
          const recv = unwrapExpr(ts, node.expression.expression);
          const isGuaranteedNonEmpty =
            Boolean(recv && ts.isArrayLiteralExpression(recv) && recv.elements.length > 0) ||
            Boolean(
              recv &&
              ts.isCallExpression(recv) &&
              ts.isPropertyAccessExpression(recv.expression) &&
              recv.expression.name.text === 'split'
            );
          if (!isGuaranteedNonEmpty) {
            const loopKeys = extractCollectionTargetKeys(ts, sf, recv, symbolTable, ctx.testTitle);
            childScopeOverride = { ...(childScopeOverride || {}), insideDynamicLoop: true, loopTargetKeys: loopKeys };
          }
        } else if ((mName === 'on' || mName === 'addListener') && node.arguments.length >= 2) {
          childScopeOverride = { ...(childScopeOverride || {}), insideEventListener: true };
        }
      }

      inspectNonAssertionCallEvents(ts, sf, node, calleeText, line, ctx, state);

      const chain = extractExpectChainFromCall(ts, sf, node, symbolTable);
      if (chain) {
        const snippet = node.getText(sf).trim();
        const countGuardKeys = extractCollectionTargetKeys(ts, sf, chain.actualNode, symbolTable, ctx.testTitle);
        const cls = {
          ...classifyExpectChainAst(ts, sf, chain, snippet, { symbolTable, testTitle: ctx.testTitle }),
          countGuardKeys,
          line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
          insideIf: ctx.insideIf, insideIfInTest: ctx.insideIfInTest, insideTernary: ctx.insideTernary,
          insideDynamicLoop: ctx.insideDynamicLoop, insideEventListener: ctx.insideEventListener,
          insideBrowserEvaluate: ctx.insideBrowserEvaluate,
        };
        summary.assertions.push(cls);
        if (ctx.testTitle) {
          const activeTest = summary.testBlocks[summary.testBlocks.length - 1];
          if (activeTest && activeTest.title === ctx.testTitle) activeTest.assertions.push(cls);
        }
        if (cls.numericExpected !== null) {
          if (SUCCESS_STATUS_CODES.has(cls.numericExpected)) summary.successStatuses += 1;
          if (cls.numericExpected >= 500 && cls.numericExpected < 600) summary.serverErrorStatuses += 1;
        }
        if (cls.isTautology) {
          const ev = {
            line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, label: cls.label, snippet,
            message: `${fileLabel}: ${cls.label} assertion forbidden ("${snippet.split(/\r?\n/)[0]}").`,
          };
          summary.events.tautologies.push(ev);
          pushViolation('AITEST-G104', ev.message, snippet, ev);
        }
        if (cls.isSoft) {
          const ev = {
            kind: 'expect.soft', line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, snippet,
            message: `${fileLabel}: soft assertion weakenings gate enforcement ("${snippet.split(/\r?\n/)[0]}").`,
          };
          summary.events.softAssertions.push(ev);
          pushViolation('AITEST-G106', ev.message, snippet, ev);
        }
        if (ctx.insideIf) {
          const ev = {
            kind: 'if-wrap', line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
            insideIfInTest: ctx.insideIfInTest, insideBrowserEvaluate: ctx.insideBrowserEvaluate, snippet,
            message: `${fileLabel}: wrapping expect() inside conditional if-block is forbidden.`,
          };
          summary.events.conditionalAssertions.push(ev);
          pushViolation('AITEST-G110', ev.message, snippet, ev);
        }
        if (ctx.insideTernary) {
          const ev = {
            kind: 'ternary-wrap', line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
            insideIfInTest: ctx.insideIfInTest, insideBrowserEvaluate: ctx.insideBrowserEvaluate, snippet,
            message: `${fileLabel}: conditional ternary expect() is forbidden.`,
          };
          summary.events.conditionalAssertions.push(ev);
          pushViolation('AITEST-G110', ev.message, snippet, ev);
        }
        if (ctx.insideEventListener && ctx.scopeKind === 'test') {
          const ev = {
            kind: 'event-listener', line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
            insideIfInTest: true, insideBrowserEvaluate: ctx.insideBrowserEvaluate, snippet,
            message: `${fileLabel}: expect() inside event listener (.on/.addListener) silently passes if event never fires.`,
          };
          summary.events.conditionalAssertions.push(ev);
          pushViolation('AITEST-G110', ev.message, snippet, ev);
        }
        if (ctx.insideDynamicLoop && ctx.scopeKind === 'test') {
          pendingLoopAssertions.push({
            line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle, snippet, loopTargetKeys: ctx.loopTargetKeys,
          });
        }
      } else if (ts.isIdentifier(node.expression) && isCustomAssertName(node.expression.text)) {
        summary.customAssertCalls += 1;
        const fnName = node.expression.text;
        const isResolved = symbolTable.localAssertHelpers.has(fnName) || symbolTable.trustedHelperImports.has(fnName);
        const customAssertion = {
          tier: isResolved ? 3 : 1,
          label: isResolved ? 'S3-custom-helper' : 'S1-unresolved-custom-helper',
          matcher: fnName, isSoft: false, isNegated: false, isTautology: false, isAriaSnapshot: false,
          numericExpected: null, line, scopeKind: ctx.scopeKind, testTitle: ctx.testTitle,
          insideIf: ctx.insideIf, insideIfInTest: ctx.insideIfInTest, insideTernary: ctx.insideTernary,
          insideBrowserEvaluate: ctx.insideBrowserEvaluate, raw: node.getText(sf).trim(),
        };
        summary.assertions.push(customAssertion);
        if (ctx.testTitle) {
          const activeTest = summary.testBlocks[summary.testBlocks.length - 1];
          if (activeTest && activeTest.title === ctx.testTitle) activeTest.assertions.push(customAssertion);
        }
      }
    }

    const enteredDynamicLoop =
      ts.isForStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      (ts.isForOfStatement(node) && !isStaticNonEmptyLoopNode(ts, node));
    const enteredLoopTargetKeys = enteredDynamicLoop
      ? extractLoopTargetKeys(ts, sf, node, symbolTable, ctx.testTitle)
      : [];

    const nextCtx = {
      insideIf: ctx.insideIf || ts.isIfStatement(node),
      insideIfInTest:
        childScopeOverride?.insideIfInTest !== undefined
          ? childScopeOverride.insideIfInTest
          : ctx.insideIfInTest || (ts.isIfStatement(node) && ctx.scopeKind === 'test'),
      insideTernary: ctx.insideTernary || ts.isConditionalExpression(node),
      insideDynamicLoop:
        childScopeOverride?.insideDynamicLoop !== undefined
          ? childScopeOverride.insideDynamicLoop
          : ctx.insideDynamicLoop || enteredDynamicLoop,
      loopTargetKeys:
        childScopeOverride?.loopTargetKeys !== undefined
          ? childScopeOverride.loopTargetKeys
          : enteredDynamicLoop
            ? enteredLoopTargetKeys
            : ctx.loopTargetKeys,
      insideEventListener:
        childScopeOverride?.insideEventListener !== undefined
          ? childScopeOverride.insideEventListener
          : ctx.insideEventListener,
      insideBrowserEvaluate:
        childScopeOverride?.insideBrowserEvaluate !== undefined ? childScopeOverride.insideBrowserEvaluate : ctx.insideBrowserEvaluate,
      scopeKind: childScopeOverride?.scopeKind || ctx.scopeKind,
      testTitle: childScopeOverride?.testTitle !== undefined ? childScopeOverride.testTitle : ctx.testTitle,
    };

    ts.forEachChild(node, (/** @type {any} */ child) => visit(child, nextCtx));
  };

  visit(sf, initialCtx);

  for (const lp of pendingLoopAssertions) {
    const scoped = lp.testTitle
      ? summary.assertions.filter((a) => a.testTitle === lp.testTitle)
      : summary.assertions;
    const hasCountGuard = scoped.some((a) => isValidLoopCountGuard(a, lp.loopTargetKeys, symbolTable, lp.testTitle));
    if (!hasCountGuard) {
      const ev = {
        kind: 'loop-without-count-guard',
        line: lp.line, scopeKind: lp.scopeKind, testTitle: lp.testTitle,
        insideIfInTest: true, snippet: lp.snippet,
        message: `${fileLabel}: expect() inside dynamic loop without preceding matching non-zero count guard silently passes on 0 iterations.`,
      };
      summary.events.conditionalAssertions.push(ev);
      pushViolation('AITEST-G110', ev.message, lp.snippet, ev);
    }
  }

  for (const asc of pendingAllSettledCalls) {
    const scoped = asc.testTitle
      ? summary.assertions.filter((a) => a.testTitle === asc.testTitle)
      : summary.assertions;
    const assertsFulfilled = scoped.some(assertionVerifiesSettledResult);
    if (!assertsFulfilled) {
      const ev = {
        kind: 'all-settled-swallow',
        line: asc.line, scopeKind: asc.scopeKind, testTitle: asc.testTitle,
        hasAssertionInCatch: false, capturesErrorFlag: false, snippet: asc.snippet,
        message: `${fileLabel}: Promise.allSettled() inside test suppresses rejections without verifying every settled result is fulfilled.`,
      };
      summary.events.swallowedCatches.push(ev);
      pushViolation('AITEST-G107', ev.message, asc.snippet, ev);
    }
  }

  return summary;
}
