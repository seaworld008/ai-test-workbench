// @ts-check

/**
 * Pure zero-dependency JSON raw-string token scanner & key-order-independent recursive comparator
 * for `CP2-Body-Shape-And-Value` (`src/kernel/diff-oracle.mjs`).
 */

/** @param {string} pathStr @param {string[]} patterns @returns {boolean} */
export function isJsonPathNormalized(pathStr, patterns) {
  const wildcardPath = pathStr.replace(/\[\d+\]/g, '[*]');
  for (const pat of patterns) {
    if (pat === pathStr || pat === wildcardPath) return true;
  }
  return false;
}

/**
 * Parses JSON while capturing exact raw JSON string literal tokens per canonical JSONPath
 * so `strictByteEscape: true` catches `\uXXXX` ASCII escapes vs raw UTF-8 bytes
 * independently of key ordering or explicitly normalized fields.
 * @param {string} rawText
 * @returns {{ ok: boolean, value: any, rawStrings: Map<string, string> }}
 */
export function parseJsonWithRawStrings(rawText) {
  const src = String(rawText || '');
  /** @type {Map<string, string>} */
  const rawStrings = new Map();
  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch {
    return { ok: false, value: null, rawStrings };
  }

  let i = 0;
  const len = src.length;
  const skipWs = () => {
    while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i += 1;
  };
  const scanString = () => {
    const start = i;
    i += 1;
    while (i < len) {
      const ch = src[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { i += 1; return src.slice(start, i); }
      i += 1;
    }
    return src.slice(start);
  };

  /** @param {string} curPath */
  const scanValue = (curPath) => {
    skipWs();
    if (i >= len) return;
    const ch = src[i];
    if (ch === '"') {
      rawStrings.set(curPath, scanString());
      return;
    }
    if (ch === '{') {
      i += 1;
      skipWs();
      if (src[i] === '}') { i += 1; return; }
      while (i < len) {
        skipWs();
        if (src[i] !== '"') break;
        const rawKey = scanString();
        let keyName = rawKey.slice(1, -1);
        try { keyName = JSON.parse(rawKey); } catch { /* keep slice */ }
        skipWs();
        if (src[i] === ':') i += 1;
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyName)
          ? `${curPath}.${keyName}`
          : `${curPath}[${JSON.stringify(keyName)}]`;
        scanValue(childPath);
        skipWs();
        if (src[i] === ',') { i += 1; continue; }
        if (src[i] === '}') { i += 1; break; }
        break;
      }
      return;
    }
    if (ch === '[') {
      i += 1;
      skipWs();
      if (src[i] === ']') { i += 1; return; }
      let idx = 0;
      while (i < len) {
        scanValue(`${curPath}[${idx}]`);
        idx += 1;
        skipWs();
        if (src[i] === ',') { i += 1; continue; }
        if (src[i] === ']') { i += 1; break; }
        break;
      }
      return;
    }
    while (i < len && !/[\s,\]}]/.test(src[i])) i += 1;
  };

  scanValue('$');
  return { ok: true, value: parsed, rawStrings };
}

/**
 * Recursively compares two parsed JSON payloads key-order-independently, honoring explicit `ignoredJsonPaths`
 * and optional `strictByteEscape` raw token equality. Invokes `onDiff` on the first discrepancy.
 * @param {string} baseBodyText
 * @param {string} candBodyText
 * @param {{
 *   ignoredJsonPaths: string[];
 *   strictByteEscape: boolean;
 *   onDiff: (diffKind: string, pieceOrJsonPath: string, baseStr: string, candStr: string) => void;
 * }} opts
 */
export function compareJsonBodies(baseBodyText, candBodyText, opts) {
  const baseParsed = parseJsonWithRawStrings(baseBodyText);
  const candParsed = parseJsonWithRawStrings(candBodyText);
  if (!baseParsed.ok || !candParsed.ok) {
    if (baseBodyText !== candBodyText) opts.onDiff('text-mismatch', '$', baseBodyText, candBodyText);
    return;
  }

  let stopped = false;
  /** @param {any} a @param {any} b @param {string} curPath */
  const walk = (a, b, curPath) => {
    if (stopped || isJsonPathNormalized(curPath, opts.ignoredJsonPaths)) return;
    const typeA = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const typeB = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (typeA !== typeB) {
      opts.onDiff('type-mismatch', curPath, JSON.stringify(a), JSON.stringify(b));
      stopped = true;
      return;
    }
    if (typeA === 'array') {
      if (a.length !== b.length) {
        opts.onDiff('array-length-mismatch', curPath, JSON.stringify(a), JSON.stringify(b));
        stopped = true;
        return;
      }
      for (let i = 0; i < a.length; i += 1) {
        walk(a[i], b[i], `${curPath}[${i}]`);
        if (stopped) return;
      }
      return;
    }
    if (typeA === 'object') {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const k of keys) {
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `${curPath}.${k}` : `${curPath}[${JSON.stringify(k)}]`;
        if (isJsonPathNormalized(childPath, opts.ignoredJsonPaths)) continue;
        const inA = Object.prototype.hasOwnProperty.call(a, k);
        const inB = Object.prototype.hasOwnProperty.call(b, k);
        if (!inB) { opts.onDiff('missing-key', childPath, JSON.stringify(a[k]), ''); stopped = true; return; }
        if (!inA) { opts.onDiff('extra-key', childPath, '', JSON.stringify(b[k])); stopped = true; return; }
        walk(a[k], b[k], childPath);
        if (stopped) return;
      }
      return;
    }
    if (a !== b) {
      opts.onDiff('value-mismatch', curPath, String(a), String(b));
      stopped = true;
      return;
    }
    if (opts.strictByteEscape && typeA === 'string') {
      const rawA = baseParsed.rawStrings.get(curPath) ?? JSON.stringify(a);
      const rawB = candParsed.rawStrings.get(curPath) ?? JSON.stringify(b);
      if (rawA !== rawB) {
        opts.onDiff('byte-escape-mismatch', curPath, rawA, rawB);
        stopped = true;
      }
    }
  };

  walk(baseParsed.value, candParsed.value, '$');
}
