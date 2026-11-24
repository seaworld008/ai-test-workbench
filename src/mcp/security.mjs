// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MCP Security & Workspace Boundary Enforcement (`M-02`, `M-03`, `M-09`).
 *
 * Security invariants:
 * 1. Client-supplied roots can ONLY narrow (intersect) server-configured workspace roots — NEVER expand them!
 * 2. When no workspace roots are configured at all, fail-closed to `[defaultTarget || process.cwd()]`.
 * 3. Every path argument (`target`, `repo`, `qaDir`, `output`, `results`, `waivers`) is canonicalized
 *    via `realpath` and checked against boundary containment (forbidding absolute or `..` escapes).
 */

export function parseWorkspaceRoots(rawInput) {
  const roots = [];
  const items = Array.isArray(rawInput)
    ? rawInput
    : String(rawInput || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  for (const item of items) {
    try {
      if (String(item).startsWith('file://')) {
        roots.push(path.resolve(fileURLToPath(String(item))));
      } else {
        roots.push(path.resolve(String(item)));
      }
    } catch {
      // skip invalid root URI
    }
  }
  return [...new Set(roots)];
}

export function resolveComparableRealPath(p) {
  const resolved = path.resolve(p);
  try {
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    // Walk up until an existing parent is found to resolve symlinks on not-yet-created output files
    let cur = resolved;
    const tail = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    const realBase = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
    return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
  } catch {
    return resolved;
  }
}

export function isPathWithinRoot(targetPath, rootPath) {
  const normTarget = resolveComparableRealPath(targetPath);
  const normRoot = resolveComparableRealPath(rootPath);
  const targetCmp = process.platform === 'win32' ? normTarget.toLowerCase() : normTarget;
  const rootCmp = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  if (targetCmp === rootCmp) return true;
  const withSep = rootCmp.endsWith(path.sep) ? rootCmp : `${rootCmp}${path.sep}`;
  return targetCmp.startsWith(withSep);
}

/**
 * Enforces MCP workspace root boundary (`M-02`, `M-03`):
 * Fail-closed when `allowedRoots` is empty (defaults to `[process.cwd()]` instead of allowing all!).
 * @param {string | null | undefined} targetPath
 * @param {string[]} allowedRoots
 */
export function isTargetWithinAllowedRoots(targetPath, allowedRoots = []) {
  if (!targetPath) return true;
  const effective = Array.isArray(allowedRoots) && allowedRoots.length > 0 ? allowedRoots : [process.cwd()];
  return effective.some((root) => isPathWithinRoot(targetPath, root));
}

/**
 * Computes effective allowed workspace roots via strict INTERSECTION (`M-02`):
 * - Server ceiling = `ctx.workspaceRoots` + `AITEST_MCP_WORKSPACE_ROOTS` (or `[ctx.defaultTarget || process.cwd()]`).
 * - Client roots (`ctx.clientRoots`) can ONLY narrow the server ceiling; any client root outside the server
 *   ceiling is discarded so a client can NEVER expand filesystem access!
 * @param {Record<string, any>} [ctx]
 */
export function getEffectiveAllowedRoots(ctx = {}) {
  const envRoots = parseWorkspaceRoots(process.env.AITEST_MCP_WORKSPACE_ROOTS || '');
  const ctxServerRoots = Array.isArray(ctx.workspaceRoots) ? parseWorkspaceRoots(ctx.workspaceRoots) : [];
  const serverCeiling = [...new Set([...ctxServerRoots, ...envRoots])];

  const effectiveCeiling =
    serverCeiling.length > 0
      ? serverCeiling
      : ctx.defaultTarget
        ? [path.resolve(ctx.defaultTarget)]
        : [process.cwd()];

  const clientRoots = Array.isArray(ctx.clientRoots) ? parseWorkspaceRoots(ctx.clientRoots) : [];
  if (clientRoots.length === 0) {
    return effectiveCeiling;
  }

  // Intersection: keep ONLY client roots that are strictly inside serverCeiling
  const narrowed = clientRoots.filter((cr) => effectiveCeiling.some((sr) => isPathWithinRoot(cr, sr)));
  return narrowed;
}

/**
 * Validates ALL path arguments (`target`, `repo`, `qaDir`, `output`, `results`, `waivers`) against
 * workspace root boundaries and forbids `..` traversal or absolute overrides in relative parameters (`M-03`).
 * @param {Record<string, any>} args
 * @param {string | null} target
 * @param {string[]} allowedRoots
 */
export function validateToolPathArgs(args, target, allowedRoots) {
  if (allowedRoots.length === 0) {
    return {
      ok: false,
      error: '[Workspace Boundary Blocked] Effective allowed workspace roots are empty (client roots did not intersect server roots).',
    };
  }

  if (target && !isTargetWithinAllowedRoots(target, allowedRoots)) {
    return {
      ok: false,
      error: `[Workspace Boundary Blocked] Target "${target}" is outside allowed workspace roots.`,
      blockedPath: target,
    };
  }

  if (args.repo && !isTargetWithinAllowedRoots(args.repo, allowedRoots)) {
    return {
      ok: false,
      error: `[Workspace Boundary Blocked] Repo "${args.repo}" is outside allowed workspace roots.`,
      blockedPath: args.repo,
    };
  }

  // Relative sub-path parameters MUST NOT be absolute paths or escape via `..` (`M-03`)
  for (const field of ['qaDir', 'output', 'results', 'waivers']) {
    const val = args[field];
    if (val === undefined || val === null || val === '') continue;
    const raw = String(val);
    if (path.isAbsolute(raw) || raw.includes('\0')) {
      return {
        ok: false,
        error: `[Workspace Boundary Blocked] Parameter "${field}" must be a relative path within the target workspace (got "${raw}").`,
        blockedPath: raw,
      };
    }
    const baseDir = target ? path.resolve(target) : allowedRoots[0];
    const resolved = path.resolve(baseDir, raw);
    const segments = raw.replace(/\\/g, '/').split('/');
    if (segments.includes('..') || !isPathWithinRoot(resolved, baseDir) || !isTargetWithinAllowedRoots(resolved, allowedRoots)) {
      return {
        ok: false,
        error: `[Workspace Boundary Blocked] Parameter "${field}" ("${raw}") escapes target workspace boundary.`,
        blockedPath: raw,
      };
    }
  }

  return { ok: true, error: null };
}

export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '127.0.0.1').toLowerCase());
}

/**
 * Constant-time Bearer token check via SHA-256 digest (`M-09`).
 */
export function verifyBearerTokenConstantTime(authHeader, expectedToken) {
  const expectedFull = `Bearer ${expectedToken}`;
  const actualHash = crypto.createHash('sha256').update(String(authHeader || ''), 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expectedFull, 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function isAllowedHttpOrigin(originHeader, extraOrigins = []) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    const hostname = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true;
    const configured = [
      ...extraOrigins,
      ...String(process.env.AITEST_MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    return configured.some((allowed) => {
      const normalized = allowed.toLowerCase();
      return parsed.origin.toLowerCase() === normalized || hostname === normalized;
    });
  } catch {
    return false;
  }
}
