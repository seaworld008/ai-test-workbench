// @ts-check
import { getNodeLine, resolveTypeScriptCompiler, unwrapExpr } from '../ts-loader.mjs';

/**
 * @typedef {import('./governance-rules.mjs').GateFinding} GateFinding
 * @typedef {import('./governance-rules.mjs').RuleEvalCtx} RuleEvalCtx
 */

const DIESELGATE_PATTERNS = [
  { label: 'Playwright/Headless UA sniffing', re: /\b(?:Playwright|HeadlessChrome|Puppeteer|WebDriver|pw-test)\b/i },
  { label: 'navigator.webdriver probe', re: /\bnavigator\s*\.\s*webdriver\b|\b\.webdriver\b/ },
  {
    label: 'NODE_ENV test branch',
    re: /\bNODE_ENV\b[^=!\n]{0,20}(?:===|!==|==|!=)\s*['"`]test['"`]|['"`]test['"`]\s*(?:===|!==|==|!=)\s*[^&\n]{0,24}\bNODE_ENV\b/,
  },
  { label: 'CI/PLAYWRIGHT env branch', re: /\bprocess\s*\.\s*env\s*\.\s*(?:CI|PLAYWRIGHT|PW_TEST|E2E_TEST)\b/ },
  { label: 'test runner custom header check', re: /\bx-(?:playwright|aitest|headless|webdriver)\b/i },
  { label: 'browser fetch-metadata/client-hints sniffing', re: /\bsec-(?:fetch-(?:dest|mode|site|user)|ch-ua(?:-[a-z]+)?)\b/i },
];

const UA_CORRELATED_BROWSER_TOKEN_RE = /\b(?:Safari\/537\.36|Safari|Chrome|Mozilla)\b/i;
const UA_ACCESS_RE = /\b(?:user-agent|userAgent)\b/i;
const MATCH_OP_OR_REGEX_RE =
  /\/[^/\r\n]+\/[a-z]*\s*\.\s*test\s*\(|\.\s*(?:test|match|includes|indexOf|startsWith|endsWith|search)\s*\(|===|!==|==|!=|\bnew\s+RegExp\s*\(|\bheaders\b|\buser-agent\b|\buserAgent\b/i;
const HTTP_RESPONSE_MUTATION_RE =
  /\b(?:res|reply|response|ctx)\s*\.\s*(?:writeHead|status|statusCode|end|send|json|setHeader|redirect)\b|\bnew\s+Response\s*\(|\breturn\s+(?:200|201|204|400|401|403|404|500)\b/;
const STARTUP_OPS_CALL_RE =
  /(?:\.listen\s*\(|\.close\s*\(|\bprocess\.(?:on|once|exit)\s*\(|\bsetInterval\s*\(|\bcron\b|\bconsole\.(?:log|info|warn)|\blogger\.)/;

/**
 * Evaluates simple static strings including concatenation, array `.join('')`, `Buffer.from(..., 'base64')`, and `atob(...)`.
 * @param {any} ts @param {any} rawNode @param {Map<string, string>} strConsts @param {Set<string>} [seen]
 * @returns {string | null}
 */
function evalStaticString(ts, rawNode, strConsts, seen = new Set()) {
  if (!rawNode) return null;
  const n = unwrapExpr(ts, rawNode);
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isIdentifier(n) && strConsts.has(n.text) && !seen.has(n.text)) {
    return strConsts.get(n.text) ?? null;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalStaticString(ts, n.left, strConsts, seen);
    const r = evalStaticString(ts, n.right, strConsts, seen);
    if (l !== null && r !== null) return l + r;
  }
  if (ts.isCallExpression(n)) {
    if (ts.isIdentifier(n.expression) && n.expression.text === 'atob' && n.arguments[0]) {
      const arg = evalStaticString(ts, n.arguments[0], strConsts, seen);
      if (arg) {
        try {
          return Buffer.from(arg, 'base64').toString('utf8');
        } catch {
          return null;
        }
      }
    }
    if (ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (method === 'join' && ts.isArrayLiteralExpression(unwrapExpr(ts, n.expression.expression))) {
        const sep = n.arguments[0] ? evalStaticString(ts, n.arguments[0], strConsts, seen) ?? '' : ',';
        const parts = unwrapExpr(ts, n.expression.expression).elements.map((/** @type {any} */ el) =>
          evalStaticString(ts, el, strConsts, seen)
        );
        if (parts.every((/** @type {any} */ p) => p !== null)) return parts.join(sep);
      }
      if (method === 'toString') {
        const inner = unwrapExpr(ts, n.expression.expression);
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          ts.isIdentifier(inner.expression.expression) &&
          inner.expression.expression.text === 'Buffer' &&
          inner.expression.name.text === 'from' &&
          inner.arguments.length >= 2
        ) {
          const payload = evalStaticString(ts, inner.arguments[0], strConsts, seen);
          const enc = evalStaticString(ts, inner.arguments[1], strConsts, seen);
          if (payload && enc && /^base64(?:url)?|hex$/i.test(enc)) {
            try {
              return Buffer.from(payload, /** @type {BufferEncoding} */ (enc.toLowerCase())).toString('utf8');
            } catch {
              return null;
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Matches Dieselgate patterns against an expression's raw source and decoded static strings.
 * Requires regex/match/comparison/header context for `Playwright` tokens so inert data literals
 * (e.g. course titles `'Playwright Architecture & Test Agents'`) never false-positive.
 * @param {string} rawText @param {string[]} decodedStrings @param {boolean} hasUaContext @param {boolean} isMatchExpr
 * @returns {Array<{ label: string }>}
 */
function matchDieselgatePatterns(rawText, decodedStrings, hasUaContext, isMatchExpr) {
  const combined = decodedStrings.length > 0 ? `${rawText}\n${decodedStrings.join('\n')}` : rawText;
  /** @type {Array<{ label: string }>} */
  const hits = [];
  const seen = new Set();
  for (const pat of DIESELGATE_PATTERNS) {
    if (pat.label === 'Playwright/Headless UA sniffing' && !isMatchExpr && !hasUaContext) {
      continue;
    }
    if (pat.re.test(combined) && !seen.has(pat.label)) {
      seen.add(pat.label);
      hits.push({ label: pat.label });
    }
  }
  if ((hasUaContext || UA_ACCESS_RE.test(combined)) && UA_CORRELATED_BROWSER_TOKEN_RE.test(combined)) {
    const label = 'Playwright/Headless UA sniffing';
    if (!seen.has(label)) {
      seen.add(label);
      hits.push({ label });
    }
  }
  return hits;
}

/**
 * Collects decoded static strings and identifier/call references within an expression WITHOUT descending into nested function bodies.
 * @param {any} ts @param {any} root @param {Map<string, string>} strConsts
 */
function inspectExprShallow(ts, root, strConsts) {
  /** @type {string[]} */
  const decodedStrings = [];
  /** @type {Set<string>} */
  const idRefs = new Set();
  /** @type {Set<string>} */
  const callNames = new Set();
  /** @param {any} n */
  const walk = (n) => {
    if (!n) return;
    if (
      n !== root &&
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))
    ) {
      return;
    }
    const s = evalStaticString(ts, n, strConsts);
    if (s && s.length >= 3) decodedStrings.push(s);
    if (ts.isIdentifier(n)) idRefs.add(n.text);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) callNames.add(n.expression.text);
    ts.forEachChild(n, walk);
  };
  walk(root);
  return { decodedStrings, idRefs, callNames };
}

/**
 * Collects shallow return expressions of a helper function without descending into nested functions.
 * @param {any} ts @param {any} fnNode @returns {any[]}
 */
function collectFunctionReturnExprs(ts, fnNode) {
  if (!fnNode?.body) return [];
  if (!ts.isBlock(fnNode.body)) return [unwrapExpr(ts, fnNode.body)];
  /** @type {any[]} */
  const out = [];
  /** @param {any} n */
  const walk = (n) => {
    if (!n) return;
    if (
      n !== fnNode &&
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n))
    ) {
      return;
    }
    if (ts.isReturnStatement(n) && n.expression) {
      out.push(unwrapExpr(ts, n.expression));
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(fnNode.body);
  return out;
}

/**
 * Exempts legitimate top-level module startup operational guards like
 * `if (process.env.NODE_ENV !== 'test') { server.listen(port); }` that never touch HTTP route responses (`G2-L03`).
 * @param {any} ts @param {any} sf @param {any} ifNode @param {Array<{ label: string }>} hits
 */
function isBenignTopLevelStartupGuard(ts, sf, ifNode, hits) {
  if (!ts.isIfStatement(ifNode)) return false;
  if (hits.length === 0) return false;
  const onlyEnvGuards = hits.every(
    (h) => h.label === 'NODE_ENV test branch' || h.label === 'CI/PLAYWRIGHT env branch'
  );
  if (!onlyEnvGuards) return false;
  const condText = ifNode.expression.getText(sf);
  if (!/!==|!=/.test(condText)) return false;
  const bodyText = ifNode.thenStatement.getText(sf);
  if (HTTP_RESPONSE_MUTATION_RE.test(bodyText)) return false;
  return STARTUP_OPS_CALL_RE.test(bodyText) && !ifNode.elseStatement;
}

/**
 * Extracts normalized conditional branch snippets referencing automated-test/browser-driver detection
 * from an arbitrary product JS/TS/MJS source file using TypeScript AST + local Def-Use taint (`WU-05`, v6.2.1 `AITEST-G117`).
 *
 * @param {string} filePath
 * @param {string} sourceText
 * @param {{ tsCompiler?: any, qaDir?: string }} [options]
 * @returns {{ usedAst: boolean, branches: Array<{ line: number, label: string, key: string, snippet: string }> }}
 */
function extractDieselgateBranches(filePath, sourceText, options = {}) {
  if (!sourceText || !sourceText.trim()) return { usedAst: true, branches: [] };
  const ts = 'tsCompiler' in options ? options.tsCompiler : resolveTypeScriptCompiler(options.qaDir);
  if (!ts) {
    /** @type {Array<{ line: number, label: string, key: string, snippet: string }>} */
    const fallback = [];
    const lines = sourceText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i];
      if (!/\b(?:if|switch|&&|\|\||\?)\b/.test(lineText)) continue;
      for (const pat of DIESELGATE_PATTERNS) {
        if (pat.re.test(lineText)) {
          fallback.push({
            line: i + 1,
            label: pat.label,
            key: `${pat.label}:${lineText.replace(/\s+/g, '')}`,
            snippet: lineText.trim().slice(0, 140),
          });
        }
      }
    }
    return { usedAst: false, branches: fallback };
  }

  const sf = ts.createSourceFile(filePath || 'product.ts', sourceText, ts.ScriptTarget.Latest, true);
  /** @type {Map<string, string>} */
  const strConsts = new Map();
  /** @type {Set<string>} */
  const uaVars = new Set();
  /** @type {Map<string, Array<{ label: string }>>} */
  const taintedVars = new Map();
  /** @type {Map<string, Array<{ label: string }>>} */
  const taintedFns = new Map();

  /** @param {any} expr @param {boolean} [isConditionContext] */
  const evalExprTaint = (expr, isConditionContext = false) => {
    if (!expr) return [];
    const u = unwrapExpr(ts, expr);
    if (!u || ts.isObjectLiteralExpression(u) || ts.isArrayLiteralExpression(u)) return [];
    const raw = u.getText(sf);
    const { decodedStrings, idRefs, callNames } = inspectExprShallow(ts, u, strConsts);
    const hasUa = UA_ACCESS_RE.test(raw) || [...idRefs].some((id) => uaVars.has(id));
    const isMatchExpr = isConditionContext || MATCH_OP_OR_REGEX_RE.test(raw);
    const hits = matchDieselgatePatterns(raw, decodedStrings, hasUa, isMatchExpr);
    const seen = new Set(hits.map((h) => h.label));
    for (const id of idRefs) {
      for (const h of taintedVars.get(id) || []) {
        if (!seen.has(h.label)) {
          seen.add(h.label);
          hits.push(h);
        }
      }
    }
    for (const fn of callNames) {
      for (const h of taintedFns.get(fn) || []) {
        if (!seen.has(h.label)) {
          seen.add(h.label);
          hits.push(h);
        }
      }
    }
    return hits;
  };

  /** @param {any} fnNode */
  const evalFunctionReturnTaint = (fnNode) => {
    const returns = collectFunctionReturnExprs(ts, fnNode);
    /** @type {Array<{ label: string }>} */
    const combined = [];
    const seen = new Set();
    for (const r of returns) {
      for (const h of evalExprTaint(r, false)) {
        if (!seen.has(h.label)) {
          seen.add(h.label);
          combined.push(h);
        }
      }
    }
    return combined;
  };

  // Pass 1 (fixed-point up to 3 iterations): collect static strings, UA vars, tainted vars, and predicate helpers
  for (let pass = 0; pass < 3; pass += 1) {
    /** @param {any} node */
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        const init = unwrapExpr(ts, node.initializer);
        const s = evalStaticString(ts, init, strConsts);
        if (s !== null) strConsts.set(name, s);
        const initText = init.getText(sf);
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init) && UA_ACCESS_RE.test(initText)) {
          uaVars.add(name);
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const fnHits = evalFunctionReturnTaint(init);
          if (fnHits.length > 0) taintedFns.set(name, fnHits);
        } else {
          const hits = evalExprTaint(init, false);
          if (hits.length > 0) taintedVars.set(name, hits);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const name = node.left.text;
        const rhs = unwrapExpr(ts, node.right);
        if (UA_ACCESS_RE.test(rhs.getText(sf))) uaVars.add(name);
        const hits = evalExprTaint(rhs, false);
        if (hits.length > 0) taintedVars.set(name, hits);
      } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const fnHits = evalFunctionReturnTaint(node);
        if (fnHits.length > 0) taintedFns.set(node.name.text, fnHits);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  /** @type {Array<{ line: number, label: string, key: string, snippet: string }>} */
  const branches = [];

  /** @param {any} expr @param {any} node @param {number} fnDepth */
  const checkConditionExpr = (expr, node, fnDepth) => {
    if (!expr) return;
    const hits = evalExprTaint(expr, true);
    if (hits.length === 0) return;
    if (fnDepth === 0 && isBenignTopLevelStartupGuard(ts, sf, node, hits)) return;
    const condText = expr.getText(sf);
    const snippet = condText.replace(/\s+/g, ' ').trim().slice(0, 140);
    for (const h of hits) {
      branches.push({
        line: getNodeLine(ts, sf, node),
        label: h.label,
        key: `${h.label}:${condText.replace(/\s+/g, '')}`,
        snippet,
      });
    }
  };

  /** @param {any} node @param {number} fnDepth */
  const visit = (node, fnDepth) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    const nextDepth = isFn ? fnDepth + 1 : fnDepth;

    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      checkConditionExpr(node.expression || node.condition, node, fnDepth);
    } else if (ts.isSwitchStatement(node)) {
      checkConditionExpr(node.expression, node, fnDepth);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      checkConditionExpr(node.left, node, fnDepth);
    }
    ts.forEachChild(node, (/** @type {any} */ child) => visit(child, nextDepth));
  };
  visit(sf, 0);
  return { usedAst: true, branches };
}

/**
 * Compares product-side base vs head source files to detect newly added Dieselgate test-traffic
 * special-casing (`Playwright`, `HeadlessChrome`, `navigator.webdriver`, `NODE_ENV === 'test'`, `process.env.CI`,
 * `sec-fetch-*`, hoisted variables, Base64/concat obfuscation).
 *
 * @param {string} filePath
 * @param {string} baseSource
 * @param {string} headSource
 * @param {{ tsCompiler?: any, qaDir?: string }} [options]
 * @returns {{ ok: boolean, findings: GateFinding[], violations: string[] }}
 */
export function evaluateProductFileAst(filePath, baseSource, headSource, options = {}) {
  const baseBranches = extractDieselgateBranches(filePath, baseSource || '', options);
  const headBranches = extractDieselgateBranches(filePath, headSource || '', options);
  const baseKeys = new Set(baseBranches.branches.map((b) => b.key));
  /** @type {GateFinding[]} */
  const findings = [];
  const seen = new Set();

  for (const b of headBranches.branches) {
    if (baseKeys.has(b.key) || seen.has(b.key)) continue;
    seen.add(b.key);
    findings.push({
      code: 'AITEST-G117',
      severity: 'error',
      file: filePath,
      line: b.line,
      message: `${filePath}:${b.line}: product code introduces test-traffic special-casing (${b.label}: "${b.snippet}") (Dieselgate bypass forbidden).`,
      evidence: { label: b.label, snippet: b.snippet },
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    violations: findings.map((f) => `[Healer Diff Guard][${f.code}] ${f.message}`),
  };
}

/**
 * AITEST-G117 registry metadata entry (product-side evaluation runs via `evaluateProductFileAst` in `changeset.mjs`).
 */
export const ruleG117 = {
  code: 'AITEST-G117',
  name: 'no-dieselgate-test-branching',
  description: 'Blocks introducing Playwright/HeadlessChrome/navigator.webdriver/sec-fetch/NODE_ENV===test conditional branches (including hoisted variables and obfuscated strings) in product source files.',
  waiverKey: 'dieselgate-branch',
  defaultEnabled: true,
  /** @param {RuleEvalCtx} _ctx @returns {GateFinding[]} */
  evaluate(_ctx) {
    return [];
  },
};
