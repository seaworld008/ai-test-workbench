import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, any>} */
const tsModuleCache = new Map();

/**
 * Resolves the `typescript` compiler module from `qaDir`, root `node_modules`,
 * or bundled template `node_modules`.
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

/**
 * Unwraps parentheses, `as`, non-null `!`, type assertions, and `satisfies` wrappers.
 */
export function unwrapExpr(ts, node) {
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
 * Depth-first predicate test over an AST subtree.
 */
export function subtreeContainsKind(ts, node, predicate) {
  if (!node) return false;
  if (predicate(node)) return true;
  let hit = false;
  ts.forEachChild(node, (child) => {
    if (!hit && subtreeContainsKind(ts, child, predicate)) hit = true;
  });
  return hit;
}

/**
 * Computes 1-based line number for a TypeScript AST node.
 */
export function getNodeLine(ts, sf, node) {
  if (!sf || !node || typeof sf.getLineAndCharacterOfPosition !== 'function') return 1;
  try {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  } catch {
    return 1;
  }
}
