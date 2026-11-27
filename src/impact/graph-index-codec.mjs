// @ts-check
/** @param {string} a @param {string} b @returns {number} */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const PIPE_SHARDED_FORMAT = 'pipe-sharded-v1';
export const HIGH_FAN_IN_SENTINEL = '*HIGH_FAN_IN*';
export const HIGH_FAN_IN_CALLER_LIMIT = 65;
const SHARD_COUNT = 16;

export const CONTAINER_SYMBOL_KINDS = new Set(['class', 'interface', 'module', 'namespace', 'file', 'mapper', 'package']);
export const ORPHAN_PRUNE_FILE_RE =
  /(?:(?:DO|VO|DTO|Enum|Param|Query|PageReq|SaveReq|Resp|ReqVO|RespVO|ExcelVO|Convert|Constants|Constant|Test|Tests)\.java$|\/(?:vo|dto|dal\/dataobject|enums|convert)\/)/;
const NOISE_JAVA_POJO_RE = /(?:DO|VO|DTO|ReqVO|RespVO|ExcelVO|PageReq|SaveReq|Convert|Enum|Constants|Constant|Test|Tests)\.java$/;
const NOISE_NON_APP_RE = /(?:\/(?:vo|dto|dal\/dataobject|enums|convert)\/|\.(?:py|sh|bat|cmd|ps1|sql|scss|sass|css|less|md|markdown|txt|json|ya?ml|properties)$)/i;

/** Returns true for non-app scripts/styles/POJOs/pseudo-files that bloat CBM graph indexes without helping narrowing. @param {string} file */
export function isNoiseGraphFile(file) {
  const f = String(file || '').trim();
  if (!f || !f.includes('.') || /^\d+$/.test(f)) return true;
  return NOISE_JAVA_POJO_RE.test(f) || NOISE_NON_APP_RE.test(f);
}

/** Returns true for empty-file builtin pseudo-nodes (`#int`, `0#len`) or symbols rooted in noise POJO/script files. @param {string} symId */
export function isNoiseGraphSymbol(symId) {
  const s = String(symId || '').trim();
  if (!s) return true;
  if (s === HIGH_FAN_IN_SENTINEL) return false;
  const hash = s.indexOf('#');
  if (hash === 0) return true;
  if (hash > 0) return isNoiseGraphFile(s.slice(0, hash));
  return false;
}

/**
 * Selects the innermost overlapping symbols for a diff hunk, preferring callable symbols
 * (`Method`/`Function`/`mybatis-statement`/`api-function`) over enclosing containers (`Class`/`Interface`/`mapper`).
 * @param {Array<{ id?: string, name: string, kind?: string, startLine: number, endLine: number }>} fileSyms
 * @param {{ startLine: number, endLine: number }} hunk
 * @param {string} file
 * @returns {string[]}
 */
export function selectInnermostHunkSymbols(fileSyms, hunk, file) {
  const hits = (fileSyms || []).filter((s) => hunk.startLine <= s.endLine && hunk.endLine >= s.startLine);
  if (hits.length === 0) return [];
  const callables = hits.filter((s) => !CONTAINER_SYMBOL_KINDS.has(String(s.kind || '').toLowerCase()));
  let picked = callables.length > 0 ? callables : hits;
  if (picked.length > 1) {
    const innermost = picked.filter(
      (a) => !picked.some((b) => b !== a && b.startLine >= a.startLine && b.endLine <= a.endLine && b.endLine - b.startLine < a.endLine - a.startLine)
    );
    if (innermost.length > 0) picked = innermost;
  }
  return picked.map((s) => String(s.id || `${file}#${s.name}`));
}

const ESC_RE = /[%;|,~]/;
/** @param {unknown} raw @returns {string} */
function esc(raw) {
  const s = String(raw ?? '');
  if (!ESC_RE.test(s)) return s;
  return s.replace(/%/g, '%25').replace(/;/g, '%3B').replace(/\|/g, '%7C').replace(/,/g, '%2C').replace(/~/g, '%7E');
}
/** @param {string} s @returns {string} */
function unesc(s) {
  if (!s || !s.includes('%')) return s;
  return s.replace(/%7E/g, '~').replace(/%2C/g, ',').replace(/%7C/g, '|').replace(/%3B/g, ';').replace(/%25/g, '%');
}

/** @param {string} k @returns {number} */
function shardOfEncodedKey(k) {
  const m = k.match(/^(\d+)(?:#|$)/);
  return m ? Number(m[1]) % SHARD_COUNT : 0;
}

/**
 * Encodes `graph-impact-index` into zero-JSON-escape pipe/semicolon sharded deterministic JSON (`_fmt: 'pipe-sharded-v1'`)
 * so 1M-LOC CBM repos stay `<4.5 MB` and load in `<15 ms` via lazy shard Proxy hydration.
 * @param {Record<string, any>} graphIndex
 * @returns {string}
 */
export function serializeGraphImpactIndex(graphIndex) {
  /** @type {string[]} */ const ft = [];
  /** @type {Map<string, number>} */ const fMap = new Map();
  const intern = (/** @type {string} */ f) => {
    let idx = fMap.get(f);
    if (idx === undefined) { idx = ft.length; fMap.set(f, idx); ft.push(f); }
    return idx;
  };
  const encSym = (/** @type {string} */ raw) => {
    if (raw === HIGH_FAN_IN_SENTINEL) return raw;
    const hash = raw.indexOf('#');
    if (hash > 0) return `${intern(raw.slice(0, hash))}#${esc(raw.slice(hash + 1))}`;
    if (raw.includes('/') || /\.[a-z0-9]{1,6}$/i.test(raw)) return String(intern(raw));
    return esc(raw);
  };
  const encStrMap = (/** @type {Record<string, string[]>} */ obj, /** @type {(v: string) => string} */ valFn = encSym, /** @type {(k: string) => string} */ keyFn = encSym) => {
    /** @type {string[]} */ const recs = [];
    for (const k of Object.keys(obj || {}).sort(cmp)) {
      const vals = obj[k] || [];
      if (vals.length > 0) recs.push(`${keyFn(k)}|${vals.map(valFn).join(',')}`);
    }
    return recs.join(';');
  };

  /** @type {string[][]} */ const fsShards = Array.from({ length: SHARD_COUNT }, () => []);
  let filesCount = 0;
  let symbolsCount = 0;
  for (const file of Object.keys(graphIndex.fileSymbols || {}).sort(cmp)) {
    const syms = graphIndex.fileSymbols[file] || [];
    if (syms.length === 0) continue;
    const fi = intern(file);
    filesCount += 1;
    symbolsCount += syms.length;
    const encSyms = syms.map((/** @type {any} */ s) => {
      const customId = s.id && s.id !== `${file}#${s.name}` ? esc(s.id) : '';
      return customId
        ? `${esc(s.name)}~${esc(s.kind || 'function')}~${s.startLine}~${s.endLine}~${s.exported ? 1 : 0}~${customId}`
        : s.exported
          ? `${esc(s.name)}~${esc(s.kind || 'function')}~${s.startLine}~${s.endLine}~1`
          : `${esc(s.name)}~${esc(s.kind || 'function')}~${s.startLine}~${s.endLine}`;
    });
    fsShards[fi % SHARD_COUNT].push(`${fi}|${encSyms.join(',')}`);
  }

  /** @type {string[][]} */ const scShards = Array.from({ length: SHARD_COUNT }, () => []);
  const scKeys = Object.keys(graphIndex.symbolCallers || {}).sort(cmp);
  for (const k of scKeys) {
    const vals = graphIndex.symbolCallers[k] || [];
    if (vals.length === 0) continue;
    const ek = encSym(k);
    scShards[shardOfEncodedKey(ek)].push(`${ek}|${vals.map(encSym).join(',')}`);
  }

  /** @type {string[]} */ const ceRecs = [];
  const ceKeys = Object.keys(graphIndex.controllerEndpoints || {}).sort(cmp);
  for (const k of ceKeys) {
    const eps = graphIndex.controllerEndpoints[k] || [];
    if (eps.length === 0) continue;
    const encEps = eps.map((/** @type {any} */ ep) => {
      const cf = ep.controllerFile || (k.includes('#') ? k.slice(0, k.indexOf('#')) : k);
      return `${esc(ep.method || 'ANY')}~${esc(ep.path)}~${intern(cf)}${ep.handler ? `~${esc(ep.handler)}` : ''}`;
    });
    ceRecs.push(`${encSym(k)}|${encEps.join(',')}`);
  }

  /** @type {string[]} */ const rvaRecs = [];
  for (const route of Object.keys(graphIndex.routeToVueApis || {}).sort(cmp)) {
    const apis = graphIndex.routeToVueApis[route] || [];
    if (apis.length === 0) continue;
    rvaRecs.push(`${esc(route)}|${apis.map((/** @type {any} */ a) => `${intern(a.apiFile)}~${esc(a.fnName || '')}${a.method ? `~${esc(a.method)}` : ''}`).join(',')}`);
  }

  /** @type {Record<string, any[]>} */ const _gc = {};
  for (const f of Object.keys(graphIndex.globalComponents || {}).sort(cmp)) {
    const gc = graphIndex.globalComponents[f];
    if (!gc) continue;
    _gc[String(intern(f))] = [
      gc.name || '',
      (gc.tags || []).map(esc).join(','),
      (gc.consumers || []).map((/** @type {string} */ c) => String(intern(c))).join(','),
      gc.complete ? 1 : 0,
    ];
  }

  const br = graphIndex.crossModuleBridges || {};
  const _vavStr = encStrMap(graphIndex.vueApiToViews, (v) => String(intern(v)));
  const _vcpStr = encStrMap(graphIndex.vueComponentParents, (v) => String(intern(v)), (k) => String(intern(k)));
  const _f2iStr = encStrMap(br.feignToImpl);
  const _i2fStr = encStrMap(br.implToFeign);
  const _m2mStr = encStrMap(br.mybatisToMapper);

  const {
    fileSymbols: _1, symbolCallers: _2, controllerEndpoints: _3,
    vueApiToViews: _4, routeToVueApis: _5, vueComponentParents: _6,
    crossModuleBridges: _7, globalComponents: _8, ...rest
  } = graphIndex;

  return JSON.stringify({
    ...rest,
    _fmt: PIPE_SHARDED_FORMAT,
    summary: { filesCount, symbolsCount, callerKeysCount: scKeys.length, controllerEndpointsCount: ceKeys.length },
    _ftStr: ft.map(esc).join(';'),
    _fsS: fsShards.map((s) => s.join(';')),
    _scS: scShards.map((s) => s.join(';')),
    _ceStr: ceRecs.join(';'),
    _vavStr,
    _rvaStr: rvaRecs.join(';'),
    _vcpStr,
    _f2iStr,
    _i2fStr,
    _m2mStr,
    _gc,
  });
}

/** @param {Record<string, any>} mapFn @param {(prop: string) => any} getVal @param {() => string[]} getKeys */
function makeProxy(mapFn, getVal, getKeys) {
  return new Proxy(mapFn, {
    get(_t, prop) { return typeof prop === 'string' ? getVal(prop) : undefined; },
    has(_t, prop) { return typeof prop === 'string' && getVal(prop) !== undefined; },
    ownKeys() { return getKeys(); },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      const val = getVal(prop);
      return val === undefined ? undefined : { enumerable: true, configurable: true, value: val };
    },
  });
}

/** @param {string} rawStr @returns {Map<string, string>} */
function parseKvStr(rawStr) {
  /** @type {Map<string, string>} */ const m = new Map();
  if (!rawStr) return m;
  for (const rec of rawStr.split(';')) {
    const bar = rec.indexOf('|');
    if (bar > 0) m.set(rec.slice(0, bar), rec.slice(bar + 1));
  }
  return m;
}

/** Hydrates `pipe-sharded-v1` payloads lazily per shard so `loadGraphImpactIndex` runs in `<15ms`. @param {Record<string, any>} parsed */
function hydratePipeSharded(parsed) {
  /** @type {string[] | null} */ let ft = null;
  /** @type {Map<string, number> | null} */ let fToIdx = null;
  const getFt = () => ft || (ft = parsed._ftStr ? String(parsed._ftStr).split(';').map(unesc) : []);
  const getFMap = () => {
    if (fToIdx) return fToIdx;
    const arr = getFt();
    fToIdx = new Map();
    for (let i = 0; i < arr.length; i += 1) fToIdx.set(arr[i], i);
    return fToIdx;
  };
  const encKey = (/** @type {string} */ k) => {
    const hash = k.indexOf('#');
    if (hash > 0) {
      const idx = getFMap().get(k.slice(0, hash));
      return idx === undefined ? null : `${idx}#${esc(k.slice(hash + 1))}`;
    }
    const idx = getFMap().get(k);
    return idx !== undefined ? String(idx) : esc(k);
  };
  const decSym = (/** @type {string} */ s) => {
    if (s === HIGH_FAN_IN_SENTINEL) return s;
    const hash = s.indexOf('#');
    if (hash > 0) {
      const idx = Number(s.slice(0, hash));
      const f = Number.isInteger(idx) ? getFt()[idx] : undefined;
      return f !== undefined ? `${f}#${unesc(s.slice(hash + 1))}` : unesc(s);
    }
    if (/^\d+$/.test(s)) {
      const f = getFt()[Number(s)];
      if (f !== undefined) return f;
    }
    return unesc(s);
  };

  /** @type {Array<Map<string, string> | null>} */ const fsShardMaps = Array(SHARD_COUNT).fill(null);
  const getFsShard = (/** @type {number} */ sh) => fsShardMaps[sh] || (fsShardMaps[sh] = parseKvStr(parsed._fsS?.[sh] || ''));
  /** @type {Map<string, any[]>} */ const fsCache = new Map();
  const decodeFs = (/** @type {string} */ file) => {
    if (fsCache.has(file)) return fsCache.get(file);
    const fi = getFMap().get(file);
    if (fi === undefined) return undefined;
    const raw = getFsShard(fi % SHARD_COUNT).get(String(fi));
    if (!raw) return undefined;
    const out = raw.split(',').map((t) => {
      const p = t.split('~');
      const name = unesc(p[0]);
      return {
        id: p[5] ? unesc(p[5]) : `${file}#${name}`,
        name, kind: unesc(p[1]), startLine: Number(p[2]), endLine: Number(p[3]),
        ...(p[4] === '1' ? { exported: true } : {}),
      };
    });
    fsCache.set(file, out);
    return out;
  };
  const fileSymbols = makeProxy(Object.create(null), decodeFs, () => {
    /** @type {string[]} */ const keys = [];
    for (let s = 0; s < SHARD_COUNT; s += 1) for (const k of getFsShard(s).keys()) { const f = getFt()[Number(k)]; if (f) keys.push(f); }
    return keys;
  });

  /** @type {Array<Map<string, string> | null>} */ const scShardMaps = Array(SHARD_COUNT).fill(null);
  const getScShard = (/** @type {number} */ sh) => scShardMaps[sh] || (scShardMaps[sh] = parseKvStr(parsed._scS?.[sh] || ''));
  /** @type {Map<string, string[]>} */ const scCache = new Map();
  const decodeSc = (/** @type {string} */ key) => {
    if (scCache.has(key)) return scCache.get(key);
    const ek = encKey(key);
    if (ek === null) return undefined;
    const raw = getScShard(shardOfEncodedKey(ek)).get(ek);
    if (!raw) return undefined;
    const out = raw.split(',').map(decSym);
    scCache.set(key, out);
    return out;
  };
  const symbolCallers = makeProxy(Object.create(null), decodeSc, () => {
    /** @type {string[]} */ const keys = [];
    for (let s = 0; s < SHARD_COUNT; s += 1) for (const k of getScShard(s).keys()) keys.push(decSym(k));
    return keys;
  });

  const makeLazyKvProxy = (/** @type {string} */ str, /** @type {(v: string) => any} */ valDec, /** @type {(k: string) => string} */ kDec = decSym, /** @type {(k: string) => string | null} */ kEnc = encKey) => {
    /** @type {Map<string, string> | null} */ let m = null;
    /** @type {Map<string, any>} */ const cache = new Map();
    const getM = () => m || (m = parseKvStr(str));
    return makeProxy(
      Object.create(null),
      (prop) => {
        if (cache.has(prop)) return cache.get(prop);
        const ek = kEnc(prop);
        if (ek === null) return undefined;
        const raw = getM().get(ek);
        if (raw === undefined) return undefined;
        const val = valDec(raw);
        cache.set(prop, val);
        return val;
      },
      () => [...getM().keys()].map(kDec)
    );
  };

  const controllerEndpoints = makeLazyKvProxy(parsed._ceStr || '', (raw) =>
    raw.split(',').map((t) => {
      const p = t.split('~');
      return { method: unesc(p[0]), path: unesc(p[1]), controllerFile: getFt()[Number(p[2])] || unesc(p[2]), ...(p[3] ? { handler: unesc(p[3]) } : {}) };
    })
  );
  const vueApiToViews = makeLazyKvProxy(parsed._vavStr || '', (raw) => raw.split(',').map((i) => getFt()[Number(i)] || unesc(i)));
  const routeToVueApis = makeLazyKvProxy(
    parsed._rvaStr || '',
    (raw) => raw.split(',').map((t) => {
      const p = t.split('~');
      return { apiFile: getFt()[Number(p[0])] || unesc(p[0]), fnName: unesc(p[1] || ''), ...(p[2] ? { method: unesc(p[2]) } : {}) };
    }),
    unesc,
    esc
  );
  const vueComponentParents = makeLazyKvProxy(
    parsed._vcpStr || '',
    (raw) => raw.split(',').map((i) => getFt()[Number(i)] || unesc(i)),
    (rk) => getFt()[Number(rk)] || unesc(rk),
    (k) => { const idx = getFMap().get(k); return idx === undefined ? null : String(idx); }
  );
  const crossModuleBridges = {
    feignToImpl: makeLazyKvProxy(parsed._f2iStr || '', (raw) => raw.split(',').map(decSym)),
    implToFeign: makeLazyKvProxy(parsed._i2fStr || '', (raw) => raw.split(',').map(decSym)),
    mybatisToMapper: makeLazyKvProxy(parsed._m2mStr || '', (raw) => raw.split(',').map(decSym)),
  };
  const rawGc = parsed._gc || {};
  /** @type {Map<string, any>} */ const gcCache = new Map();
  const globalComponents = makeProxy(
    Object.create(null),
    (file) => {
      if (gcCache.has(file)) return gcCache.get(file);
      const idx = getFMap().get(file);
      if (idx === undefined) return undefined;
      const t = rawGc[String(idx)];
      if (!Array.isArray(t)) return undefined;
      const val = {
        name: String(t[0] || ''),
        tags: t[1] ? String(t[1]).split(',').map(unesc) : [],
        consumers: t[2] ? String(t[2]).split(',').map((i) => getFt()[Number(i)] || unesc(i)) : [],
        complete: Boolean(t[3]),
      };
      gcCache.set(file, val);
      return val;
    },
    () => Object.keys(rawGc).map((rk) => getFt()[Number(rk)] || rk)
  );

  return {
    ...parsed,
    fileSymbols, symbolCallers, controllerEndpoints,
    vueApiToViews, routeToVueApis, vueComponentParents, crossModuleBridges, globalComponents,
  };
}

/**
 * Hydrates plain, legacy `_ft` array, or `pipe-sharded-v1` `graph-impact-index` payloads
 * into a 100% API-compatible object with O(1) lazy Proxy decoding.
 * @param {Record<string, any>} parsed
 * @returns {Record<string, any>}
 */
export function hydrateGraphImpactIndex(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed._fmt === PIPE_SHARDED_FORMAT) return hydratePipeSharded(parsed);
  if (!Array.isArray(parsed._ft)) return parsed;
  const ft = /** @type {string[]} */ (parsed._ft);
  /** @type {Map<string, number>} */ const fToIdx = new Map();
  for (let i = 0; i < ft.length; i += 1) fToIdx.set(ft[i], i);
  const encKey = (/** @type {string} */ k) => {
    const h = k.indexOf('#');
    if (h <= 0) return k;
    const idx = fToIdx.get(k.slice(0, h));
    return idx === undefined ? null : `${idx}${k.slice(h)}`;
  };
  const decKey = (/** @type {string} */ k) => {
    const h = k.indexOf('#');
    if (h <= 0) return k;
    const idx = Number(k.slice(0, h));
    return Number.isInteger(idx) && ft[idx] !== undefined ? `${ft[idx]}${k.slice(h)}` : k;
  };
  const rawFs = parsed._fs || {}; const rawSc = parsed._sc || {}; const rawCe = parsed._ce || {};
  const fileSymbols = makeProxy(
    Object.create(null),
    (file) => {
      const idx = fToIdx.get(file);
      const tuples = idx === undefined ? null : rawFs[String(idx)];
      return Array.isArray(tuples) ? tuples.map((/** @type {any[]} */ t) => ({ id: t[5] || `${file}#${t[0]}`, name: t[0], kind: t[1], startLine: t[2], endLine: t[3], ...(t[4] ? { exported: true } : {}) })) : undefined;
    },
    () => Object.keys(rawFs).map((rk) => ft[Number(rk)] ?? rk)
  );
  const symbolCallers = makeProxy(
    Object.create(null),
    (key) => { const ek = encKey(key); const raw = (ek !== null && rawSc[ek]) || rawSc[key]; return Array.isArray(raw) ? raw.map(decKey) : undefined; },
    () => Object.keys(rawSc).map(decKey)
  );
  const controllerEndpoints = makeProxy(
    Object.create(null),
    (key) => {
      const ek = encKey(key); const raw = (ek !== null && rawCe[ek]) || rawCe[key];
      return Array.isArray(raw) ? raw.map((/** @type {any[]} */ t) => ({ method: t[0], path: t[1], controllerFile: typeof t[2] === 'number' && ft[t[2]] !== undefined ? ft[t[2]] : String(t[2] || ''), ...(t[3] ? { handler: t[3] } : {}) })) : undefined;
    },
    () => Object.keys(rawCe).map(decKey)
  );
  return { ...parsed, fileSymbols, symbolCallers, controllerEndpoints };
}
