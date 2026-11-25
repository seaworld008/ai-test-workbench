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

/** @param {string | string[] | null | undefined} rawInput @returns {string[]} */
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

/** @param {string} p @returns {string} */
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

/** @param {string} targetPath @param {string} rootPath @returns {boolean} */
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

/** @param {string | null | undefined} host @returns {boolean} */
export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '127.0.0.1').toLowerCase());
}

/**
 * Validates HTTP `Host` header against exact `host:port` (or canonical loopback hostnames at listening port)
 * to prevent DNS Rebinding against `GET /sse` and `/mcp` (`WU-03`).
 * @param {string | string[] | undefined | null} hostHeader
 * @param {string} bindHost
 * @param {number | null | undefined} listenPort
 * @param {string[]} [extraHosts]
 * @returns {boolean}
 */
export function isAllowedHttpHost(hostHeader, bindHost, listenPort, extraHosts = []) {
  if (!hostHeader || Array.isArray(hostHeader)) return false;
  const raw = String(hostHeader).trim().toLowerCase();
  if (!raw || /[/\s@\\]/.test(raw)) return false;

  const port = listenPort && Number.isInteger(listenPort) && listenPort > 0 ? listenPort : null;
  const configuredExtra = [
    ...extraHosts,
    ...String(process.env.AITEST_MCP_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ].map((h) => h.toLowerCase());

  if (configuredExtra.includes(raw)) return true;

  if (isLoopbackHost(bindHost)) {
    const loopbackBases = ['127.0.0.1', 'localhost', '[::1]'];
    if (port) {
      if (loopbackBases.some((b) => raw === `${b}:${port}`)) return true;
      if ((port === 80 || port === 443) && loopbackBases.includes(raw)) return true;
      return false;
    }
    return loopbackBases.some((b) => raw === b || raw.startsWith(`${b}:`));
  }

  const normalizedBind = String(bindHost || '').toLowerCase();
  if (port) {
    return raw === `${normalizedBind}:${port}` || ((port === 80 || port === 443) && raw === normalizedBind);
  }
  return raw === normalizedBind || raw.startsWith(`${normalizedBind}:`);
}

/**
 * Enforces `application/json` media type on POST requests (`WU-03`, `415 Unsupported Media Type`).
 * @param {string | string[] | undefined | null} contentTypeHeader
 * @returns {boolean}
 */
export function hasJsonContentType(contentTypeHeader) {
  if (!contentTypeHeader || Array.isArray(contentTypeHeader)) return false;
  const mime = String(contentTypeHeader).split(';')[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

/**
 * Strips host filesystem absolute paths before sending HTTP transport errors back to clients.
 * @param {string} msg
 * @returns {string}
 */
export function sanitizeHttpErrorMessage(msg) {
  return String(msg || '')
    .replace(/\b[A-Za-z]:\\[^\s"'`,;)]+/g, '<HOST_PATH>')
    .replace(/\/(?:Users|home|tmp|var|etc|opt|srv|root)\/[^\s"'`,;)]+/g, '<HOST_PATH>');
}

/**
 * Reads an HTTP request body up to `maxBytes` (`M-09`).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export function readHttpBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Writes a JSON HTTP response safely.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendHttpJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Constant-time Bearer token check via SHA-256 digest (`M-09`).
 * @param {string | string[] | null | undefined} authHeader
 * @param {string} expectedToken
 * @returns {boolean}
 */
export function verifyBearerTokenConstantTime(authHeader, expectedToken) {
  const expectedFull = `Bearer ${expectedToken}`;
  const actualHash = crypto.createHash('sha256').update(String(authHeader || ''), 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expectedFull, 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

/** @param {string | null | undefined} originHeader @param {string[]} [extraOrigins] @returns {boolean} */
export function isAllowedHttpOrigin(originHeader, extraOrigins = []) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true;
    const configured = [
      ...extraOrigins,
      ...String(process.env.AITEST_MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    return configured.some((allowed) => parsed.origin.toLowerCase() === allowed.toLowerCase());
  } catch {
    return false;
  }
}
