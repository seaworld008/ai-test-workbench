// @ts-check
import { normalizeRoutePath, normalizeSlash } from './route-matcher.mjs';
import { findBalancedClose, parseStaticImports, stripJsComments } from './vue-extractor.mjs';

const WRAPPER_MODULE_RE = /(?:^|\/)(?:utils|config|request|http|lib|core)\/.*\.(?:js|ts|mjs|cjs)$/i;
const ENDPOINT_API_DIR_RE = /(?:^|\/)api\//i;
const URL_PARAM_RHS_RE = /^(?:url|path|[a-zA-Z_$][a-zA-Z0-9_$]*\.(?:url|path))\b/;

const STANDARD_HTML_AND_UI_TAGS = new Set(
  'a,abbr,address,area,article,aside,audio,b,base,bdi,bdo,blockquote,body,br,button,canvas,caption,cite,code,col,colgroup,data,datalist,dd,del,details,dfn,dialog,div,dl,dt,em,embed,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,i,iframe,img,input,ins,kbd,label,legend,li,link,main,map,mark,menu,meta,meter,nav,noscript,object,ol,optgroup,option,output,p,param,picture,pre,progress,q,rp,rt,ruby,s,samp,script,section,select,small,source,span,strong,style,sub,summary,sup,svg,path,g,circle,rect,line,polygon,polyline,defs,use,symbol,table,tbody,td,template,textarea,tfoot,th,thead,time,title,tr,track,u,ul,var,video,wbr,slot,component,transition,transition-group,keep-alive,teleport,suspense,router-view,router-link,nuxt-link,nuxt-child'.split(
    ','
  )
);

/**
 * Default RuoYi / Yudao 9-endpoint CRUD factory specification (`createCrudApi(entityName, prefix)`).
 * @type {Array<{ fnPrefix: string, suffixPath: string, method: string }>}
 */
export const DEFAULT_CRUD_FACTORY_ENDPOINTS = [
  { fnPrefix: 'create', suffixPath: '/create', method: 'POST' },
  { fnPrefix: 'update', suffixPath: '/update', method: 'PUT' },
  { fnPrefix: 'delete', suffixPath: '/delete', method: 'DELETE' },
  { fnPrefix: 'get', suffixPath: '/get', method: 'GET' },
  { fnPrefix: 'getPage', suffixPath: '/page', method: 'GET' },
  { fnPrefix: 'getPageSimple', suffixPath: '/page-simple', method: 'GET' },
  { fnPrefix: 'getList', suffixPath: '/list', method: 'GET' },
  { fnPrefix: 'exportExcel', suffixPath: '/export-excel', method: 'GET' },
  { fnPrefix: 'getImportTemplate', suffixPath: '/get-import-template', method: 'GET' },
];

/**
 * @typedef {{ ownPrefix: string | null, delegatesToFile: string | null, prependPrefix: string | null, prefixes: string[] }} AxiosWrapperInfo
 * @typedef {{ name: string, endpoints: Array<{ fnPrefix: string, suffixPath: string, method: string }>, clientFile: string | null, sourceFile: string }} CrudFactoryDef
 * @typedef {{ name: string, kebabName: string, file: string, registeredIn: string }} GlobalVueComponent
 */

/** @param {string} str @returns {string} */
export const toKebabCase = (str) => String(str || '').replace(/\B([A-Z])/g, '-$1').replace(/_/g, '-').toLowerCase();

/** @param {string} str @returns {string} */
export const toPascalCase = (str) =>
  String(str || '').split(/[-_\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

/** @param {string} rawExpr @param {Record<string, string>} consts @param {string | null} stopParam @returns {string | null} */
function evalStaticPrefixOrString(rawExpr, consts, stopParam) {
  const expr = rawExpr.trim().replace(/;$/, '').replace(/\s+as\s+[A-Za-z_$][A-Za-z0-9_$.<>[\]]*$/, '').trim();
  if (!expr) return null;
  if (expr.startsWith('`') && expr.endsWith('`')) {
    const tpl = expr.slice(1, -1), paramRe = stopParam ? new RegExp(`^${stopParam}(?:[^A-Za-z0-9_$]|$)`) : null;
    for (let pos = 0, acc = ''; ; ) {
      const open = tpl.indexOf('${', pos);
      if (open < 0) return stopParam ? null : `${acc}${tpl.slice(pos)}`;
      acc += tpl.slice(pos, open);
      const close = findBalancedClose(tpl, open + 1, '{', '}');
      const inner = close >= 0 ? tpl.slice(open + 2, close).trim() : '';
      if (close < 0) return null;
      if (paramRe && paramRe.test(inner)) return acc && !/\s/.test(acc) && !acc.includes('${') ? acc : null;
      if (!Object.hasOwn(consts, inner)) return null;
      acc += consts[inner]; pos = close + 1;
    }
  }
  if (!expr.includes('+')) return null;
  let acc = '';
  for (const p of expr.split('+').map((s) => s.trim()).filter(Boolean)) {
    if (stopParam && (p === stopParam || p.startsWith(`${stopParam}.`))) return acc && !/\s/.test(acc) ? acc : null;
    const lm = p.match(/^(['"`])([^'"`\\${}\n]*)\1$/);
    if (lm) acc += lm[2];
    else if (Object.hasOwn(consts, p)) acc += consts[p];
    else return null;
  }
  return stopParam ? null : acc || null;
}

/**
 * Extracts local `const`/`let`/`var` string literal and chained constant bindings from JS/TS source.
 * @param {string} stripped @param {Record<string, string>} [seedConsts] @returns {Record<string, string>}
 */
export function extractLocalJsStringConsts(stripped, seedConsts = {}) {
  /** @type {Record<string, string>} */
  const out = { ...seedConsts };
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;\n{]+)?\s*=\s*(['"`])([^'"`\\${}\n]+)\2/g)) out[m[1]] = m[3];
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;\n{]+)?\s*=\s*([^\n;]+)/g)) {
    const val = Object.hasOwn(out, m[1]) ? null : evalStaticPrefixOrString(m[2], out, null);
    if (val && !val.includes('\n')) out[m[1]] = val;
  }
  return out;
}

/**
 * Recognizes simple 1-arg URL prefix helpers (`const baseUrlApi = (url: string) => \`/api/v1/${url}\``).
 * @param {string} stripped @param {Record<string, string>} [localConsts] @returns {Record<string, string>}
 */
export function extractUrlPrefixHelpers(stripped, localConsts) {
  const consts = localConsts || extractLocalJsStringConsts(stripped);
  /** @type {Record<string, string>} */
  const helpers = {};
  const addRet = (/** @type {string} */ n, /** @type {string} */ b, /** @type {string} */ p) => {
    const ret = b.trim().match(/^return\s+([\s\S]+?);?\s*$/);
    const pref = ret && !ret[1].includes(';') ? evalStaticPrefixOrString(ret[1], consts, p) : null;
    if (pref) helpers[n] = pref;
  };
  for (const m of stripped.matchAll(/\b(?:export\s+(?:default\s+)?)?function(?:\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^)=,]+)?(?:\s*=\s*['"`][^'"`]*['"`])?\s*\)(?:\s*:\s*[^{]+)?\s*\{/g)) {
    const fnName = m[1] || (/^\s*export\s+default\b/.test(m[0]) ? 'default' : ''), cl = fnName ? findBalancedClose(stripped, (m.index || 0) + m[0].length - 1, '{', '}') : -1;
    if (cl > 0) addRet(fnName, stripped.slice((m.index || 0) + m[0].length, cl), m[2]);
  }
  for (const m of stripped.matchAll(/(?:^|[^\w$.])(?:(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=;\n{]+)?\s*=|export\s+(default)|(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=)\s*(?:\(\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^)=,]+)?(?:\s*=\s*['"`][^'"`]*['"`])?\s*\)(?:\s*:\s*[^=>{;\n]+)?|([A-Za-z_$][A-Za-z0-9_$]*))\s*=>/g)) {
    const fnName = m[1] || m[2] || m[3], param = m[4] || m[5];
    let c = (m.index || 0) + m[0].length;
    while (c < stripped.length && /\s/.test(stripped[c])) c += 1;
    if (!fnName || !param) continue;
    if (stripped[c] === '{') { const end = findBalancedClose(stripped, c, '{', '}'); if (end > c) addRet(fnName, stripped.slice(c + 1, end), param); continue; }
    let i = c;
    for (; i < stripped.length && stripped[i] !== ';'; i += 1) {
      if (stripped[i] === "'" || stripped[i] === '"' || stripped[i] === '`') { const q = stripped[i]; i += 1; while (i < stripped.length && stripped[i] !== q) { if (stripped[i] === '\\') i += 1; i += 1; } }
      else if (stripped[i] === '(' || stripped[i] === '{' || stripped[i] === '[') { const cl = findBalancedClose(stripped, i, stripped[i], stripped[i] === '(' ? ')' : stripped[i] === '{' ? '}' : ']'); if (cl > i) i = cl; }
      else if (stripped[i] === '\n' && !/\+\s*$/.test(stripped.slice(c, i)) && !/^\s*\+/.test(stripped.slice(i + 1))) break;
    }
    const pref = evalStaticPrefixOrString(stripped.slice(c, i), consts, param);
    if (pref) helpers[fnName] = pref;
  }
  return helpers;
}

/** @param {string} expr @param {Record<string, string>} localConsts @returns {string | null} */
function extractPathPrefixFromJsExpr(expr, localConsts) {
  /** @type {string[]} */
  const segments = [];
  for (const part of String(expr || '').split('+').map((p) => p.trim()).filter(Boolean)) {
    const lit = part.match(/^(['"`])(\/[A-Za-z0-9_/-]+)\1$/);
    if (lit) segments.push(lit[2]);
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) && part in localConsts && localConsts[part].startsWith('/')) {
      segments.push(localConsts[part]);
    }
  }
  return segments.length > 0 ? normalizeRoutePath(segments.join('')) : null;
}

/**
 * Extracts Axios client `baseURL` (resolving local string variables like `const apiUrl = "/admin-api"`)
 * and chained wrapper delegation (`platformRequest.js` importing `./request` and prepending `"/platform-api"`).
 * Strictly ignores endpoint modules under `src/api/` so endpoint URL concatenations never pollute wrapper prefixes.
 * @param {{
 *   filePath: string, relFile: string, text: string, repoDir: string, fileIndex?: any,
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} ctx
 * @returns {AxiosWrapperInfo | null}
 */
export function extractAxiosWrapperInfo({ filePath, relFile, text, repoDir, fileIndex, resolveImportCandidate }) {
  if (!WRAPPER_MODULE_RE.test(relFile) || ENDPOINT_API_DIR_RE.test(relFile)) return null;
  const stripped = stripJsComments(text);
  const localConsts = extractLocalJsStringConsts(stripped);
  const { identifierToSpec } = parseStaticImports(stripped);

  /** @type {string | null} */
  let ownPrefix = null;
  /** @type {Set<string>} */
  const prefixes = new Set();

  for (const m of stripped.matchAll(/\bbaseURL\s*:\s*([^\n,;}{]{1,220})/g)) {
    const resolved = extractPathPrefixFromJsExpr(m[1], localConsts);
    if (resolved && resolved !== '/') { if (!ownPrefix) ownPrefix = resolved; prefixes.add(resolved); }
  }
  /** @type {string | null} */
  let delegatesToFile = null, prependPrefix = null;
  for (const m of stripped.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*\{/g)) {
    const spec = identifierToSpec.get(m[1]);
    if (!spec || !(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/'))) continue;
    const openIdx = (m.index || 0) + m[0].length - 1, closeIdx = findBalancedClose(stripped, openIdx, '{', '}');
    if (closeIdx <= openIdx) continue;
    const body = stripped.slice(openIdx + 1, closeIdx);
    const concatM = body.match(/\burl\s*:\s*(['"`])(\/[A-Za-z0-9_/-]+)\1\s*\+\s*([^\s,}\n]+)/) || body.match(/\burl\s*:\s*`(\/[A-Za-z0-9_/-]+)\$\{([^}]+)\}`/);
    if (!concatM) continue;
    const rawPrepend = concatM[2] || concatM[1], rhs = (concatM[3] || concatM[2] || '').trim();
    if (!rawPrepend.startsWith('/') || rawPrepend.split('/').filter(Boolean).length > 2 || !URL_PARAM_RHS_RE.test(rhs)) continue;
    const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
    if (chk.exists && chk.resolvedRel) { delegatesToFile = chk.resolvedRel; prependPrefix = normalizeRoutePath(rawPrepend); break; }
  }
  for (const m of stripped.matchAll(/\bconst\s+[A-Z0-9_]*(?:API_PREFIX|BASE_API|PREFIX)[A-Z0-9_]*\s*=\s*['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) {
    const p = normalizeRoutePath(m[1]);
    if (p !== '/') { if (!ownPrefix) ownPrefix = p; prefixes.add(p); }
  }
  if (!ownPrefix && !delegatesToFile && prefixes.size === 0) return null;
  return { ownPrefix, delegatesToFile, prependPrefix, prefixes: [...prefixes] };
}

/**
 * Resolves chained Axios wrapper prefixes (`request.js` -> `/admin-api`, `platformRequest.js` -> `/admin-api/platform-api`).
 * @param {Record<string, AxiosWrapperInfo>} wrapperInfoByFile
 * @returns {Record<string, string>}
 */
export function resolveChainedAxiosPrefixes(wrapperInfoByFile) {
  /** @type {Record<string, string>} */
  const resolved = {};
  for (const [file, info] of Object.entries(wrapperInfoByFile || {})) if (info.ownPrefix) resolved[file] = normalizeRoutePath(info.ownPrefix);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const [file, info] of Object.entries(wrapperInfoByFile || {})) {
      if (resolved[file] || !info.delegatesToFile || !info.prependPrefix) continue;
      const parent = resolved[info.delegatesToFile];
      if (!parent) continue;
      resolved[file] = parent.endsWith(info.prependPrefix) ? parent : normalizeRoutePath(`${parent}${info.prependPrefix}`);
      changed = true;
    }
    if (!changed) break;
  }
  for (const [file, info] of Object.entries(wrapperInfoByFile || {})) {
    if (!resolved[file]) { const fb = info.prependPrefix || info.prefixes[0] || ''; if (fb) resolved[file] = normalizeRoutePath(fb); }
  }
  return resolved;
}

/**
 * Parses a CRUD API factory definition (e.g. `src/utils/crudFactory.js` exporting `createCrudApi`).
 * @param {{
 *   filePath: string, relFile: string, text: string, repoDir: string, fileIndex?: any,
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} ctx
 * @returns {CrudFactoryDef | null}
 */
export function extractCrudFactoryDefinition({ filePath, relFile, text, repoDir, fileIndex, resolveImportCandidate }) {
  if (!/\.(?:js|ts|mjs)$/i.test(relFile) || !/\bcreateCrudApi\b/.test(text)) return null;
  const stripped = stripJsComments(text), fnMatch = stripped.match(/\bexport\s+(?:const|function)\s+(createCrudApi)\b/);
  if (!fnMatch) return null;
  const { identifierToSpec } = parseStaticImports(stripped);
  let clientFile = null;
  for (const [id, spec] of identifierToSpec.entries()) {
    if (/request|service|http/i.test(id) && (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/'))) {
      const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
      if (chk.exists && chk.resolvedRel) { clientFile = chk.resolvedRel; break; }
    }
  }
  /** @type {Array<{ fnPrefix: string, suffixPath: string, method: string }>} */
  const endpoints = [];
  const re = /\[\s*`([A-Za-z_$][A-Za-z0-9_$]*)\$\{[^}]+\}`\s*\]\s*:\s*[^=]*=>\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*(['"`])(\/[^'"`]+)\2\s*,\s*(['"`])([A-Za-z]+)\4/g;
  for (const m of stripped.matchAll(re)) endpoints.push({ fnPrefix: m[1], suffixPath: m[3], method: m[5].toUpperCase() });
  return { name: fnMatch[1], endpoints: endpoints.length > 0 ? endpoints : DEFAULT_CRUD_FACTORY_ENDPOINTS, clientFile, sourceFile: relFile };
}

/**
 * Expands `createCrudApi('SiteBanner', '/teach')` invocations into generated REST API calls with exported `fnName`s.
 * @param {string} relFile
 * @param {string} text
 * @param {CrudFactoryDef[]} [factoryDefs]
 */
export function extractCrudFactoryApiCalls(relFile, text, factoryDefs = []) {
  if (!/\bcreateCrudApi\s*\(/.test(text)) return [];
  const stripped = stripJsComments(text), def = factoryDefs[0] || null;
  const specList = def?.endpoints.length ? def.endpoints : DEFAULT_CRUD_FACTORY_ENDPOINTS;
  /** @type {Array<{ method: string, path: string, rawPath: string, file: string, fnName: string, clientFile?: string, generatedBy: string }>} */
  const out = [];
  for (const m of stripped.matchAll(/\bcreateCrudApi\s*\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*(['"`])([^'"`]*)\3)?/g)) {
    const entityName = m[2].trim();
    if (!entityName) continue;
    const rawPrefix = (m[4] || '/').trim(), suffix = entityName.charAt(0).toUpperCase() + entityName.slice(1);
    const resourcePath = normalizeRoutePath(`${rawPrefix === '/' ? '' : rawPrefix.replace(/\/+$/, '')}/${toKebabCase(entityName)}`);
    for (const ep of specList) {
      const fullPath = normalizeRoutePath(`${resourcePath}${ep.suffixPath}`);
      out.push({ method: ep.method, path: fullPath, rawPath: fullPath, file: relFile, fnName: `${ep.fnPrefix}${suffix}`, ...(def?.clientFile ? { clientFile: def.clientFile } : {}), generatedBy: 'createCrudApi' });
    }
  }
  return out;
}

/**
 * Extracts custom `<template>` component tags (normalized kebab <-> Pascal) and local `components: {}` bindings from `.vue` SFCs.
 * @param {string} text
 * @returns {{ templateTags: string[], localComponents: Record<string, string> }}
 */
export function extractVueTemplateComponents(text) {
  /** @type {Set<string>} */
  const tags = new Set();
  const tplMatch = text.match(/<template\b[^>]*>([\s\S]*)<\/template>/i);
  if (tplMatch) {
    for (const m of tplMatch[1].replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/<([A-Za-z][A-Za-z0-9_-]*)(?=[\s/>])/g)) {
      const rawTag = m[1], lower = rawTag.toLowerCase();
      if (!STANDARD_HTML_AND_UI_TAGS.has(lower) && !/^(?:el|a|van|ant|n|v|t|u|i|svg|fa|icon)-/i.test(lower) && (/[A-Z]/.test(rawTag) || rawTag.includes('-'))) tags.add(toPascalCase(rawTag));
    }
  }
  /** @type {Record<string, string>} */
  const localComponents = {};
  const scriptBlocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  if (scriptBlocks) {
    const stripped = stripJsComments(scriptBlocks);
    for (const m of stripped.matchAll(/\bcomponents\s*:\s*\{/g)) {
      const openIdx = (m.index || 0) + m[0].length - 1, closeIdx = findBalancedClose(stripped, openIdx, '{', '}');
      if (closeIdx <= openIdx) continue;
      for (const part of stripped.slice(openIdx + 1, closeIdx).split(',')) {
        const clean = part.trim(), kv = clean.match(/^['"]?([A-Za-z0-9_$-]+)['"]?\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)$/);
        if (kv) localComponents[toPascalCase(kv[1])] = kv[2];
        else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean)) localComponents[toPascalCase(clean)] = clean;
      }
    }
  }
  return { templateTags: [...tags], localComponents };
}

/**
 * Extracts global `Vue.component('RightToolbar', RightToolbar)` / `app.component(...)` registrations
 * (handles hoisted ES imports declared either before OR after `Vue.component(...)` in `src/main.js`).
 * @param {{
 *   filePath: string, relFile: string, text: string, repoDir: string, fileIndex?: any,
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} ctx
 * @returns {GlobalVueComponent[]}
 */
export function extractGlobalVueComponents({ filePath, relFile, text, repoDir, fileIndex, resolveImportCandidate }) {
  if (!/\.(?:js|ts|mjs|jsx|tsx)$/i.test(relFile) || !/\.\s*component\s*\(/.test(text)) return [];
  const stripped = stripJsComments(text);
  const { identifierToSpec } = parseStaticImports(stripped);
  /** @type {GlobalVueComponent[]} */
  const out = [];
  const seen = new Set();
  for (const m of stripped.matchAll(/\b(?:Vue|app)\s*\.\s*component\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const rawName = m[2].trim(), spec = identifierToSpec.get(m[3].trim());
    if (!spec || !(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/'))) continue;
    const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
    if (!chk.exists || !chk.resolvedRel) continue;
    const key = `${toPascalCase(rawName)}::${chk.resolvedRel}`;
    if (!seen.has(key)) { seen.add(key); out.push({ name: rawName, kebabName: toKebabCase(rawName), file: chk.resolvedRel, registeredIn: relFile }); }
  }
  return out;
}

/**
 * Resolves `<template>` custom component tags to local or globally registered Vue component files.
 * @param {Array<{ relFile: string, templateTags: string[], localComponents: Record<string, string>, identifierToFile: Map<string, string> }>} rawVueTemplates
 * @param {GlobalVueComponent[]} globalComponents
 * @returns {Record<string, string[]>}
 */
export function resolveVueTemplateRefs(rawVueTemplates, globalComponents) {
  /** @type {Map<string, string>} */
  const globalByPascal = new Map();
  for (const g of globalComponents || []) { globalByPascal.set(toPascalCase(g.name), g.file); globalByPascal.set(toPascalCase(g.kebabName), g.file); }
  /** @type {Record<string, string[]>} */
  const refs = {};
  for (const item of rawVueTemplates || []) {
    /** @type {Set<string>} */
    const matched = new Set();
    for (const tag of item.templateTags) {
      const target = item.identifierToFile.get(item.localComponents[tag] || tag) || item.identifierToFile.get(tag) || globalByPascal.get(tag);
      if (target) matched.add(target);
    }
    if (matched.size > 0) refs[item.relFile] = [...matched];
  }
  return refs;
}

/**
 * Resolves a dynamic DB menu `component` path (`teach/applyOrder/createOrder所有字段动态获取`, `platform/dataBoard/index`)
 * to its exact view file in `viewFiles`, supporting Chinese/Unicode filenames and URL-encoded paths.
 * @param {string} componentPath
 * @param {string[]} viewFiles
 * @returns {string | null}
 */
export function resolveDynamicMenuView(componentPath, viewFiles) {
  let raw = String(componentPath || '').trim();
  if (!raw || !Array.isArray(viewFiles) || viewFiles.length === 0) return null;
  try { if (/%[0-9A-Fa-f]{2}/.test(raw)) raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  const clean = normalizeSlash(raw).normalize('NFC').replace(/^@\/(?:views|pages)\//, '').replace(/^(?:src\/)?(?:views|pages)\//, '').replace(/^\/+/, '').replace(/\.(?:vue|[jt]sx?|svelte|astro)$/i, '');
  if (!clean) return null;
  const cleanLower = clean.toLowerCase();
  /** @type {string | null} */
  let ciHit = null;
  for (const vf of viewFiles) {
    const stripped = normalizeSlash(vf).normalize('NFC').replace(/^[^/]+\/(?=src\/(?:views|pages)\/)/, '').replace(/^(?:src\/)?(?:views|pages)\//, '').replace(/\.(?:vue|[jt]sx?|svelte|astro)$/i, '');
    if (stripped === clean || stripped === `${clean}/index` || `${stripped}/index` === clean) return vf;
    const sl = stripped.toLowerCase();
    if (!ciHit && (sl === cleanLower || sl === `${cleanLower}/index` || `${sl}/index` === cleanLower)) ciHit = vf;
  }
  return ciHit;
}

const SUB_COMP_VIEW_RE = /(?:^|\/)(?:child|children|components|modals|dialogs|menus|tabs)\//i;
const GENERIC_ROUTE_LEAF_RE = /^(?:list|index|manage|home|main)$/;

/** Splits camelCase / kebab-case / snake_case into lowercase word tokens. @param {string} s @returns {string[]} */
const splitRouteWords = (s) =>
  String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 2);

/** True if Damerau-Levenshtein edit distance (incl. 1 adjacent transposition) <= 1. @param {string} a @param {string} b */
function isWithinOneTypo(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Generalizes route-path -> Vue view resolution (GA-5): ignores sub-components, matches compact camelCase leaves,
 * strips generic `/list|/index|/manage` suffixes, supports `platform*` prefix, word overlap & 1-edit typo tolerance.
 * @param {string} routePath
 * @param {string[]} viewFiles
 * @returns {string | null}
 */
export function matchRoutePathToViewFile(routePath, viewFiles) {
  const routeSegs = normalizeRoutePath(routePath).split('/').filter((s) => s && !s.startsWith(':'));
  if (routeSegs.length === 0 || !Array.isArray(viewFiles) || viewFiles.length === 0) return null;

  const rawPool = viewFiles.filter((vf) => !SUB_COMP_VIEW_RE.test(vf));
  const entries = (rawPool.length > 0 ? rawPool : viewFiles).map((vf) => {
    const rawBody = normalizeSlash(vf).replace(/^[^/]+\/(?=src\/(?:views|pages)\/)/, '').replace(/^(?:src\/)?(?:views|pages)\//, '').replace(/\/index\.(?:vue|[jt]sx?|svelte|astro)$/i, '').replace(/\.(?:vue|[jt]sx?|svelte|astro)$/i, '');
    const body = rawBody.toLowerCase();
    const segs = body.split('/').filter(Boolean);
    const leaf = segs[segs.length - 1] || '';
    return { vf, body, segs, leaf, compactBody: body.replace(/[-_]/g, ''), compactLeaf: leaf.replace(/[-_]/g, ''), words: new Set(splitRouteWords(rawBody)), leafWords: new Set(splitRouteWords(rawBody.split('/').pop() || '')) };
  });

  const joined = routeSegs.join('/').toLowerCase();
  const reversed = routeSegs.length === 2 ? `${routeSegs[1]}/${routeSegs[0]}`.toLowerCase() : '';
  const exact = entries.filter((e) => e.body === joined || (reversed && e.body === reversed));
  if (exact.length === 1) return exact[0].vf;

  const lowerSegs = routeSegs.map((s) => s.toLowerCase());
  const trimmedSegs = lowerSegs.length >= 2 && GENERIC_ROUTE_LEAF_RE.test(lowerSegs[lowerSegs.length - 1]) ? lowerSegs.slice(0, -1) : lowerSegs;
  const rCompactJoined = lowerSegs.join('/').replace(/[-_]/g, '');
  const tCompactJoined = trimmedSegs.join('/').replace(/[-_]/g, '');
  const pickBest = (/** @type {typeof entries} */ hits) => {
    if (hits.length === 1) return hits[0].vf;
    if (hits.length === 0) return null;
    const scored = hits.map((e) => ({ vf: e.vf, score: lowerSegs.reduce((s, seg) => (e.compactBody.includes(seg.replace(/[-_]/g, '')) ? s + 3 : s), 0) + (e.body.includes('platform/') ? 1 : 0) - e.segs.length * 0.25 })).sort((a, b) => b.score - a.score);
    return scored[0].score > scored[1].score ? scored[0].vf : null;
  };

  const hit1 = pickBest(entries.filter((e) => e.compactBody === rCompactJoined || e.compactBody.endsWith(`/${rCompactJoined}`) || (tCompactJoined !== rCompactJoined && (e.compactBody === tCompactJoined || e.compactBody.endsWith(`/${tCompactJoined}`)))));
  if (hit1) return hit1;

  const rLeaf = lowerSegs[lowerSegs.length - 1].replace(/[-_]/g, '');
  const tLeaf = trimmedSegs[trimmedSegs.length - 1].replace(/[-_]/g, '');
  const rConcat = lowerSegs.join('').replace(/[-_]/g, '');
  const hit2 = pickBest(entries.filter((e) => e.compactLeaf === rLeaf || e.compactLeaf === tLeaf || e.compactLeaf === rConcat || e.compactLeaf === `platform${rLeaf}` || e.compactLeaf === `platform${tLeaf}` || e.compactLeaf === `platform${rConcat}`));
  if (hit2) return hit2;

  const rWords = [...new Set(splitRouteWords(routeSegs.join('/')))].filter((w) => !GENERIC_ROUTE_LEAF_RE.test(w));
  if (rWords.length >= 2) {
    const hit3 = pickBest(entries.filter((e) => rWords.every((w) => e.words.has(w) || [...e.words].some((ew) => ew.startsWith(w) || w.startsWith(ew))) && rWords.some((w) => e.leafWords.has(w) || [...e.leafWords].some((ew) => ew.startsWith(w) || w.startsWith(ew)))));
    if (hit3) return hit3;
  }

  if (rLeaf.length >= 8) {
    const hit4 = pickBest(entries.filter((e) => e.compactLeaf.length >= 7 && isWithinOneTypo(rLeaf, e.compactLeaf)));
    if (hit4) return hit4;
  }
  return null;
}
