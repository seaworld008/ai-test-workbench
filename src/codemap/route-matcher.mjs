// @ts-check

const ROUTE_MATCH_CACHE_MAX = 4096;

/** @type {WeakMap<readonly string[], { len: number, first: string | undefined, last: string | undefined, matcher: (runtimeRoute: string) => string }>} */
const patternArrayMatcherCache = new WeakMap();

/** @param {string | null | undefined} p @returns {string} */
export function normalizeSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** @param {string | null | undefined} routePath @returns {string} */
export function normalizeRoutePath(routePath) {
  let clean = String(routePath || '').trim().split('?')[0].split('#')[0];
  if (!clean) return '/';
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}

/**
 * Converts bracket route segments (`[id]`, `[...slug]`, `[[...opt]]`) into parameterized patterns (`:id`, `:slug*`, `:opt*`) (`K-03`).
 * @param {string} seg
 * @returns {string}
 */
export function convertBracketSegment(seg) {
  if (/^\[\[\.\.\.([^\]]+)\]\]$/.test(seg)) return `:${seg.slice(5, -2)}*`;
  if (/^\[\.\.\.([^\]]+)\]$/.test(seg)) return `:${seg.slice(4, -1)}*`;
  if (/^\[\[([^\]]+)\]\]$/.test(seg)) return `:${seg.slice(2, -2)}`;
  if (/^\[([^\]]+)\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
  return seg;
}

/**
 * Pre-compiles a static route pattern list into a linear-setup, memoized O(1)-amortized route matcher.
 * Separates exact static patterns (`Set`) from pre-sorted parameterized/wildcard patterns and caches
 * resolved runtime routes in a bounded `Map` (`MAX = 4096`).
 * @param {readonly string[]} staticPatterns
 * @returns {(runtimeRoute: string) => string}
 */
export function createRoutePatternMatcher(staticPatterns) {
  /** @type {Set<string>} */
  const exactSet = new Set();
  /** @type {Array<{ pat: string, patSegs: string[], hasWildcard: boolean, staticCount: number }>} */
  const paramPatterns = [];
  /** @type {Set<string>} */
  const seenParams = new Set();

  for (const raw of staticPatterns || []) {
    const pat = normalizeRoutePath(raw);
    exactSet.add(pat);
    if (pat.includes(':') && !seenParams.has(pat)) {
      seenParams.add(pat);
      const patSegs = pat.split('/').filter(Boolean);
      const hasWildcard = patSegs.some((s) => s.endsWith('*'));
      const staticCount = patSegs.filter((s) => !s.startsWith(':')).length;
      paramPatterns.push({ pat, patSegs, hasWildcard, staticCount });
    }
  }

  paramPatterns.sort((a, b) => {
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    if (b.staticCount !== a.staticCount) return b.staticCount - a.staticCount;
    return b.patSegs.length - a.patSegs.length;
  });

  /** @type {Map<string, string>} */
  const memo = new Map();

  return function matchRoute(runtimeRoute) {
    const norm = normalizeRoutePath(runtimeRoute);
    if (exactSet.has(norm)) return norm;
    if (paramPatterns.length === 0) return norm;

    const cached = memo.get(norm);
    if (cached !== undefined) return cached;

    const rtSegs = norm.split('/').filter(Boolean);
    let resolved = norm;
    for (const { pat, patSegs, hasWildcard } of paramPatterns) {
      if (hasWildcard) {
        const prefixLen = patSegs.length - 1;
        if (rtSegs.length >= prefixLen) {
          let prefixOk = true;
          for (let idx = 0; idx < prefixLen; idx += 1) {
            const ps = patSegs[idx];
            if (!ps.startsWith(':') && ps !== rtSegs[idx]) {
              prefixOk = false;
              break;
            }
          }
          if (prefixOk) {
            resolved = pat;
            break;
          }
        }
        continue;
      }
      if (patSegs.length !== rtSegs.length) continue;
      let matched = true;
      for (let idx = 0; idx < patSegs.length; idx += 1) {
        const ps = patSegs[idx];
        if (!ps.startsWith(':') && ps !== rtSegs[idx]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        resolved = pat;
        break;
      }
    }

    if (memo.size >= ROUTE_MATCH_CACHE_MAX) {
      const oldestKey = memo.keys().next().value;
      if (oldestKey !== undefined) memo.delete(oldestKey);
    }
    memo.set(norm, resolved);
    return resolved;
  };
}

/**
 * Matches a concrete runtime URL (`/courses/course-open-101`, `/users/42`) back to a parameterized static route (`/courses/:id`) (`K-03`).
 * Backward-compatible wrapper caching compiled matchers by `staticPatterns` array reference via `WeakMap`.
 * @param {string} runtimeRoute
 * @param {readonly string[]} staticPatterns
 * @returns {string}
 */
export function matchRuntimeRouteToPattern(runtimeRoute, staticPatterns) {
  if (!Array.isArray(staticPatterns)) {
    return createRoutePatternMatcher(staticPatterns || [])(runtimeRoute);
  }
  const len = staticPatterns.length;
  const first = len > 0 ? staticPatterns[0] : undefined;
  const last = len > 0 ? staticPatterns[len - 1] : undefined;
  let cached = patternArrayMatcherCache.get(staticPatterns);
  if (!cached || cached.len !== len || cached.first !== first || cached.last !== last) {
    cached = { len, first, last, matcher: createRoutePatternMatcher(staticPatterns) };
    patternArrayMatcherCache.set(staticPatterns, cached);
  }
  return cached.matcher(runtimeRoute);
}
