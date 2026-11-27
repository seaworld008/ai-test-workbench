// @ts-check
import { normalizeRoutePath } from './route-matcher.mjs';
import {
  extractJavaStringConstants,
  readBalancedParens,
  resolveJavaStringExpr,
  splitJavaTopLevel,
  unescapeJavaString,
} from './spring-prefix-resolver.mjs';

const SQL_KEYWORDS = new Set([
  'select', 'set', 'where', 'values', 'dual', 'lateral', 'unnest', 'json_table', 'information_schema',
  'as', 'on', 'and', 'or', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'if', 'in',
  'is', 'not', 'like', 'exists', 'between', 'distinct', 'all', 'any', 'some', 'union', 'order', 'group',
  'having', 'limit', 'offset', 'inner', 'left', 'right', 'outer', 'full', 'cross', 'using', 'by', 'asc',
  'desc', 'into', 'table', 'index', 'view', 'cursor', 'fetch', 'first', 'next', 'only', 'row', 'rows',
  'with', 'recursive', 'temp', 'temporary', 'each', 'new', 'old', 'result', 'count', 'sum', 'avg', 'min',
  'max', 'from', 'join', 'update', 'delete', 'insert', 'replace', 'truncate', 'alter', 'create', 'drop',
  'force', 'use', 'ignore', 'key', 'partition', 'virtual',
]);

const BASE_MAPPER_EXTENDS_RE =
  /\bextends\s+(?:[A-Za-z0-9_.]+\.)?(?:BaseMapperX|BaseMapper|MPJBaseMapper|CrudRepository|JpaRepository|PagingAndSortingRepository|ReactiveCrudRepository|Mapper)\s*<\s*([A-Z][A-Za-z0-9_$]*)/g;

/**
 * @typedef {{ name: string, httpMethod: string, path: string, line: number }} FeignMethodEntry
 * @typedef {{ file: string, interfaceName: string, fqcn: string, serviceName: string, pathPrefix: string, methods: FeignMethodEntry[] }} FeignClientEntry
 * @typedef {{ feignFile: string, interfaceName: string, interfaceFqcn: string, serviceName: string, implFile: string | null, implClass: string | null, implFqcn: string | null, isDubboService: boolean, methodsCount: number, methods: Array<{ name: string, line: number }> }} FeignBridgeEntry
 * @typedef {{ feignFile: string, feignMethod: string, callerFile: string, callerMethod: string, callerLine: number }} FeignMethodCallerEntry
 * @typedef {{ file: string, className: string, fqcn: string, version: string, interfaces: string[] }} DubboServiceEntry
 * @typedef {{ file: string, className: string, fqcn: string, fieldName: string, targetType: string, version: string }} DubboReferenceEntry
 * @typedef {{ file: string, className: string, fqcn: string, topic: string, consumerGroup: string, selectorExpression?: string, line: number }} MqListenerEntry
 * @typedef {{ file: string, className: string, fqcn: string, topic: string, sendMethod: string, line: number }} MqProducerEntry
 * @typedef {{ file: string, className: string, fqcn: string, jobName: string, methodName: string, line: number }} XxlJobEntry
 * @typedef {{ id: string, kind: 'select' | 'insert' | 'update' | 'delete', startLine: number, endLine: number, tables: string[] }} MybatisXmlStatement
 * @typedef {{ file: string, namespace: string, mapperFile: string | null, tables: string[], statements: MybatisXmlStatement[] }} MybatisXmlLink
 */

/** @param {string} text @param {number} idx @returns {number} */
function lineNumberAt(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Skips whitespace and consecutive balanced `@Annotation(...)` tokens before a Java method signature. @param {string} text @param {number} startIdx */
function skipLeadingAnnotations(text, startIdx) {
  let idx = startIdx;
  while (idx < text.length) {
    while (idx < text.length && /\s/.test(text[idx])) idx += 1;
    if (text[idx] !== '@') break;
    idx += 1;
    while (idx < text.length && /[A-Za-z0-9_$.]/.test(text[idx])) idx += 1;
    while (idx < text.length && /\s/.test(text[idx])) idx += 1;
    if (text[idx] === '(') {
      const bal = readBalancedParens(text, idx);
      if (!bal) break;
      idx = bal.endIdx + 1;
    }
  }
  return idx;
}

/**
 * Extracts generic Entity DO types from `extends BaseMapper<EntityDO>` / `BaseMapperX<EntityDO>` / `MPJBaseMapper<EntityDO>`.
 * @param {string} stripped
 * @returns {string[]}
 */
export function extractJavaBaseMapperEntities(stripped) {
  /** @type {Set<string>} */
  const entities = new Set();
  for (const m of stripped.matchAll(BASE_MAPPER_EXTENDS_RE)) {
    if (m[1] && m[1] !== 'Object' && m[1] !== 'T' && m[1].length >= 2) entities.add(m[1]);
  }
  return [...entities];
}

/** @param {string} body @returns {Record<string, string>} */
function parseAnnotationAttrs(body) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of splitJavaTopLevel(body, ',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      const k = part.slice(0, eqIdx).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) out[k] = part.slice(eqIdx + 1).trim();
    } else if (part && !out.value) {
      out.value = part;
    }
  }
  return out;
}

/**
 * Reads balanced annotation attributes right after an annotation name match.
 * @param {string} text
 * @param {number} afterNameIdx
 * @returns {{ body: string, attrs: Record<string, string>, endIdx: number }}
 */
function readAnnotationArgs(text, afterNameIdx) {
  let idx = afterNameIdx;
  while (idx < text.length && /\s/.test(text[idx])) idx += 1;
  if (text[idx] !== '(') return { body: '', attrs: {}, endIdx: idx };
  const bal = readBalancedParens(text, idx);
  if (!bal) return { body: '', attrs: {}, endIdx: idx };
  return { body: bal.body, attrs: parseAnnotationAttrs(bal.body), endIdx: bal.endIdx + 1 };
}

/** @param {string} relFile @param {string} stripped @param {Map<string, string>} globalConsts */
function createConstEval(relFile, stripped, globalConsts) {
  const decl = extractJavaStringConstants(relFile, stripped);
  /** @type {Record<string, string>} */
  const local = {};
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [k, rhs] of Object.entries(decl.rawConsts)) {
      if (k in local) continue;
      const v = resolveJavaStringExpr(rhs, local, globalConsts, decl.imports, decl.packageName);
      if (v !== null) local[k] = v;
    }
  }
  const evalStr = (/** @type {string | undefined} */ rawExpr) => {
    if (!rawExpr) return '';
    const v = resolveJavaStringExpr(rawExpr, local, globalConsts, decl.imports, decl.packageName);
    if (v !== null) return v;
    const lit = rawExpr.match(/^"((?:[^"\\]|\\.)*)"$/);
    return lit ? unescapeJavaString(lit[1]) : rawExpr.replace(/\s+/g, ' ').trim();
  };
  return { decl, evalStr };
}

/**
 * Extracts `@FeignClient` interface metadata and method mappings (resolving `ApiConstants.NAME` / `PREFIX + "/..."`).
 * @param {string} relFile
 * @param {string} stripped
 * @param {Map<string, string>} [globalConsts]
 * @returns {FeignClientEntry | null}
 */
export function extractFeignClientFromFile(relFile, stripped, globalConsts = new Map()) {
  const feignMatch = stripped.match(/@FeignClient\b/);
  if (!feignMatch || feignMatch.index === undefined) return null;

  const { decl, evalStr } = createConstEval(relFile, stripped, globalConsts);
  const { attrs } = readAnnotationArgs(stripped, feignMatch.index + feignMatch[0].length);
  const serviceName = evalStr(attrs.name || attrs.value);
  const pathPrefix = evalStr(attrs.path);

  const ifaceMatch = stripped.match(/\binterface\s+([A-Za-z0-9_$]+)[^{]*\{/);
  const interfaceName = ifaceMatch ? ifaceMatch[1] : decl.className;
  const fqcn = decl.packageName ? `${decl.packageName}.${interfaceName}` : interfaceName;
  const bodyStart = ifaceMatch && ifaceMatch.index !== undefined ? ifaceMatch.index + ifaceMatch[0].length : 0;
  const body = bodyStart > 0 ? stripped.slice(bodyStart) : stripped;

  /** @type {FeignMethodEntry[]} */
  const methods = [];
  for (const m of body.matchAll(/@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g)) {
    const kind = m[1];
    const annIdx = m.index || 0;
    const { body: annBody, attrs: mAttrs, endIdx } = readAnnotationArgs(body, annIdx + m[0].length);
    let httpMethod = kind === 'Request' ? 'ANY' : kind.toUpperCase();
    if (kind === 'Request') {
      const rm = annBody.match(/\bRequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i);
      if (rm) httpMethod = rm[1].toUpperCase();
    }
    const resolvedPath = evalStr(mAttrs.value || mAttrs.path);
    const fullPath =
      pathPrefix && resolvedPath && !resolvedPath.startsWith(pathPrefix)
        ? normalizeRoutePath(`${pathPrefix}/${resolvedPath.replace(/^\/+/, '')}`)
        : normalizeRoutePath(resolvedPath || pathPrefix || '/');
    const sigIdx = skipLeadingAnnotations(body, endIdx);
    const methodMatch = body.slice(sigIdx, sigIdx + 400).match(/\b([a-zA-Z_$][A-Za-z0-9_$]*)\s*\(/);
    methods.push({
      name: methodMatch ? methodMatch[1] : `rpc_${methods.length + 1}`,
      httpMethod, path: fullPath.replace(/\{([^}:]+)(?::[^}]*)?\}/g, ':$1'), line: lineNumberAt(stripped, bodyStart + annIdx),
    });
  }
  return { file: relFile, interfaceName, fqcn, serviceName, pathPrefix, methods };
}

/**
 * Extracts `@DubboService`, `@DubboReference`, `@RocketMQMessageListener`, RocketMQ producer sends, and `@XxlJob`.
 * @param {string} relFile
 * @param {string} stripped
 * @param {Map<string, string>} [globalConsts]
 */
export function extractRpcAndJobSignals(relFile, stripped, globalConsts = new Map()) {
  /** @type {DubboServiceEntry[]} */
  const dubboServices = [];
  /** @type {DubboReferenceEntry[]} */
  const dubboReferences = [];
  /** @type {MqListenerEntry[]} */
  const mqListeners = [];
  /** @type {MqProducerEntry[]} */
  const mqProducers = [];
  /** @type {XxlJobEntry[]} */
  const xxlJobs = [];

  if (!/@DubboService\b|@DubboReference\b|@RocketMQMessageListener\b|@XxlJob\b|\.(?:syncSend|asyncSend|sendOneWay|convertAndSend|syncSendOrderly|asyncSendOrderly)\s*\(/.test(stripped)) {
    return { dubboServices, dubboReferences, mqListeners, mqProducers, xxlJobs };
  }

  const { decl, evalStr } = createConstEval(relFile, stripped, globalConsts);
  const implMatch = stripped.match(/\bclass\s+[A-Za-z0-9_$]+(?:<[^>]*>)?[^{]*\bimplements\s+([^{]+)/);
  const implemented = implMatch
    ? implMatch[1].split(',').map((s) => s.trim().replace(/<[^>]*>/g, '').split(/\s+/)[0]).filter((s) => /^[A-Z][A-Za-z0-9_$]*$/.test(s))
    : [];

  for (const m of stripped.matchAll(/@DubboService\b/g)) {
    const { attrs } = readAnnotationArgs(stripped, (m.index || 0) + m[0].length);
    dubboServices.push({ file: relFile, className: decl.className, fqcn: decl.fqcn, version: evalStr(attrs.version), interfaces: implemented });
  }
  for (const m of stripped.matchAll(/@DubboReference\b/g)) {
    const { attrs, endIdx } = readAnnotationArgs(stripped, (m.index || 0) + m[0].length);
    const fm = stripped.slice(endIdx, endIdx + 200).match(/(?:private|protected|public)?\s*(?:final\s+)?([A-Z][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+([a-zA-Z_$][A-Za-z0-9_$]*)\s*[;=]/);
    if (fm) dubboReferences.push({ file: relFile, className: decl.className, fqcn: decl.fqcn, targetType: fm[1], fieldName: fm[2], version: evalStr(attrs.version) });
  }
  for (const m of stripped.matchAll(/@RocketMQMessageListener\b/g)) {
    const startIdx = m.index || 0;
    const { attrs } = readAnnotationArgs(stripped, startIdx + m[0].length);
    const topic = evalStr(attrs.topic);
    const consumerGroup = evalStr(attrs.consumerGroup);
    const selectorExpression = evalStr(attrs.selectorExpression);
    if (topic || consumerGroup) {
      mqListeners.push({
        file: relFile, className: decl.className, fqcn: decl.fqcn, topic, consumerGroup,
        ...(selectorExpression ? { selectorExpression } : {}),
        line: lineNumberAt(stripped, startIdx),
      });
    }
  }
  const sendRe = /\b[a-zA-Z_$][A-Za-z0-9_$]*(?:RocketMQ|RocketMq|Mq|MQ)[A-Za-z0-9_$]*\.(syncSend|asyncSend|sendOneWay|convertAndSend|syncSendOrderly|asyncSendOrderly)\s*\(/g;
  for (const m of stripped.matchAll(sendRe)) {
    const startIdx = m.index || 0;
    const bal = readBalancedParens(stripped, startIdx + m[0].length - 1);
    const args = bal ? splitJavaTopLevel(bal.body, ',') : [];
    const topic = args.length > 0 ? evalStr(args[0]).split(':')[0].trim() : '';
    if (topic) mqProducers.push({ file: relFile, className: decl.className, fqcn: decl.fqcn, topic, sendMethod: m[1], line: lineNumberAt(stripped, startIdx) });
  }
  for (const m of stripped.matchAll(/@XxlJob\b/g)) {
    const startIdx = m.index || 0;
    const { attrs, endIdx } = readAnnotationArgs(stripped, startIdx + m[0].length);
    const jobName = evalStr(attrs.value);
    const sigIdx = skipLeadingAnnotations(stripped, endIdx);
    const mm = stripped.slice(sigIdx, sigIdx + 240).match(/\b([a-zA-Z_$][A-Za-z0-9_$]*)\s*\(/);
    if (jobName) xxlJobs.push({ file: relFile, className: decl.className, fqcn: decl.fqcn, jobName, methodName: mm ? mm[1] : '', line: lineNumberAt(stripped, startIdx) });
  }
  return { dubboServices, dubboReferences, mqListeners, mqProducers, xxlJobs };
}

/** @param {string} rawSql @returns {string[]} */
function extractSqlTablesFromSnippet(rawSql) {
  const cleaned = rawSql.replace(/<!--[\s\S]*?-->/g, ' ').replace(/#\{[^}]*\}|\$\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ');
  /** @type {Set<string>} */
  const tables = new Set();
  for (const m of cleaned.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"']?([A-Za-z_][A-Za-z0-9_.]{1,63})[`"']?/gi)) {
    const raw = m[1].includes('.') ? m[1].split('.').pop() || m[1] : m[1];
    if (raw.length >= 2 && !SQL_KEYWORDS.has(raw.toLowerCase())) tables.add(raw);
  }
  return [...tables];
}

/**
 * Parses MyBatis `*Mapper.xml`: `<mapper namespace="...">`, every `<select|insert|update|delete id="...">`
 * with 1-based line ranges and extracted SQL tables.
 * @param {string} relFile
 * @param {string} ext
 * @param {string} text
 */
export function extractMybatisXmlDetails(relFile, ext, text) {
  if (ext !== '.xml' || !/<mapper\b/i.test(text)) return null;
  const nsMatch = text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i);
  const namespace = nsMatch ? nsMatch[1].trim() : '';
  /** @type {MybatisXmlStatement[]} */
  const statements = [];
  /** @type {Set<string>} */
  const allTables = new Set();

  for (const m of text.matchAll(/<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const idMatch = m[2].match(/\bid\s*=\s*["']([^"']+)["']/i);
    if (!idMatch) continue;
    const startIdx = m.index || 0;
    const tables = extractSqlTablesFromSnippet(m[3]);
    for (const t of tables) allTables.add(t);
    statements.push({
      id: idMatch[1].trim(),
      kind: /** @type {'select' | 'insert' | 'update' | 'delete'} */ (m[1].toLowerCase()),
      startLine: lineNumberAt(text, startIdx),
      endLine: lineNumberAt(text, startIdx + m[0].length),
      tables,
    });
  }
  for (const t of extractSqlTablesFromSnippet(text)) allTables.add(t);
  const tableList = [...allTables];
  return {
    entities: tableList.map((table) => ({ table, file: relFile, source: 'mybatis-xml', ...(namespace ? { namespace } : {}) })),
    mapper: namespace ? { file: relFile, namespace, tables: tableList, statements } : null,
  };
}

/**
 * Links `@FeignClient` interfaces (`*-api`) to implementing `@RestController`/`@DubboService` `*ApiImpl` classes (`*-biz`).
 * @param {FeignClientEntry[]} feignClients
 * @param {Record<string, { relFile: string, className: string, fqcn: string, packageName: string, superTypes?: string[], implementsTypes?: string[], isController?: boolean, isDubboService?: boolean }>} javaFileInfos
 * @param {DubboServiceEntry[]} [dubboServices]
 * @returns {FeignBridgeEntry[]}
 */
export function buildFeignAndDubboBridges(feignClients, javaFileInfos, dubboServices = []) {
  const dubboFileSet = new Set((dubboServices || []).map((d) => d.file));
  /** @type {Map<string, Array<{ relFile: string, className: string, fqcn: string, packageName: string }>>} */
  const implByIface = new Map();
  for (const meta of Object.values(javaFileInfos || {})) {
    if (!meta || (!meta.isController && !meta.isDubboService && !dubboFileSet.has(meta.relFile) && !/ApiImpl$/.test(meta.className))) continue;
    for (const iface of meta.implementsTypes?.length ? meta.implementsTypes : meta.superTypes || []) {
      const list = implByIface.get(iface) || [];
      list.push(meta);
      implByIface.set(iface, list);
    }
  }
  return (feignClients || []).map((fc) => {
    const cands = implByIface.get(fc.interfaceName) || [];
    const exactPkg = cands.find((c) => fc.fqcn.startsWith(`${c.packageName}.`));
    const modPrefix = fc.file.replace(/-api\//, '-biz/').split('/').slice(0, 2).join('/');
    const chosen = exactPkg || cands.find((c) => c.relFile.startsWith(modPrefix)) || cands[0] || null;
    return {
      feignFile: fc.file, interfaceName: fc.interfaceName, interfaceFqcn: fc.fqcn, serviceName: fc.serviceName,
      implFile: chosen ? chosen.relFile : null, implClass: chosen ? chosen.className : null, implFqcn: chosen ? chosen.fqcn : null,
      isDubboService: Boolean(chosen && (dubboFileSet.has(chosen.relFile) || javaFileInfos[chosen.relFile]?.isDubboService)),
      methodsCount: fc.methods.length, methods: fc.methods.map((m) => ({ name: m.name, line: m.line })),
    };
  });
}

/**
 * Extracts L0 cross-module Java `<injectedFeignField>.<method>(` callers for known `@FeignClient` interfaces,
 * attributing each call to its enclosing Java method so `graph-impact-index.json` narrows Feign edits accurately.
 * @param {Array<{ relFile: string, stripped: string }>} javaCallBuffers
 * @param {FeignBridgeEntry[]} feignBridges
 * @param {Record<string, { relFile: string, className: string, fqcn: string, imports?: string[], isFeignClient?: boolean }>} javaFileInfos
 * @returns {FeignMethodCallerEntry[]}
 */
export function extractFeignMethodCallers(javaCallBuffers, feignBridges, javaFileInfos) {
  /** @type {Map<string, FeignBridgeEntry[]>} */
  const bridgesByIface = new Map();
  for (const fb of feignBridges || []) {
    if (!fb?.interfaceName || !fb.feignFile) continue;
    const list = bridgesByIface.get(fb.interfaceName) || [];
    list.push(fb);
    bridgesByIface.set(fb.interfaceName, list);
  }
  if (bridgesByIface.size === 0) return [];

  /** @type {FeignMethodCallerEntry[]} */
  const callers = [];
  const seen = new Set();
  const fieldDeclRe = /(?:private|protected|public)?\s*(?:final\s+)?([A-Z][A-Za-z0-9_$]*)\s+([a-z_$][A-Za-z0-9_$]*)\s*[;=,)]/g;
  const methodDeclRe = /\b(?:public|protected|private)\s+(?:static\s+|final\s+|synchronized\s+)*(?:<[^>{;]+>\s*)?[A-Za-z0-9_$.<>,?\s[\]]+\s+([a-zA-Z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:throws\s+[A-Za-z0-9_.,\s]+)?\{/g;

  for (const buf of javaCallBuffers || []) {
    const meta = javaFileInfos[buf.relFile];
    if (meta?.isFeignClient) continue;
    const stripped = buf.stripped;
    /** @type {Array<{ varName: string, bridge: FeignBridgeEntry, knownMethods: Set<string> }>} */
    const injectedVars = [];
    for (const fm of stripped.matchAll(fieldDeclRe)) {
      const cands = bridgesByIface.get(fm[1]);
      if (!cands || cands.length === 0) continue;
      const imps = meta?.imports || [];
      const chosen = cands.find((c) => imps.includes(c.interfaceFqcn)) || (cands.length === 1 ? cands[0] : null);
      if (!chosen || chosen.feignFile === buf.relFile) continue;
      if (!injectedVars.some((iv) => iv.varName === fm[2] && iv.bridge.feignFile === chosen.feignFile)) {
        injectedVars.push({ varName: fm[2], bridge: chosen, knownMethods: new Set((chosen.methods || []).map((m) => m.name)) });
      }
    }
    if (injectedVars.length === 0) continue;

    /** @type {Array<{ name: string, index: number }>} */
    const enclosingMethods = [];
    for (const mm of stripped.matchAll(methodDeclRe)) {
      if (mm.index !== undefined && mm[1] !== meta?.className) enclosingMethods.push({ name: mm[1], index: mm.index });
    }
    const findEnclosing = (/** @type {number} */ idx) => {
      let cur = meta?.className || 'class';
      for (const em of enclosingMethods) {
        if (em.index <= idx) cur = em.name;
        else break;
      }
      return cur;
    };

    for (const iv of injectedVars) {
      const callRe = new RegExp(`\\b${iv.varName}\\s*\\.\\s*([a-zA-Z_$][A-Za-z0-9_$]*)\\s*\\(`, 'g');
      for (const cm of stripped.matchAll(callRe)) {
        const mName = cm[1];
        if (iv.knownMethods.size > 0 && !iv.knownMethods.has(mName)) continue;
        const callerMethod = findEnclosing(cm.index || 0);
        const key = `${iv.bridge.feignFile}#${mName}<-${buf.relFile}#${callerMethod}`;
        if (seen.has(key)) continue;
        seen.add(key);
        callers.push({ feignFile: iv.bridge.feignFile, feignMethod: mName, callerFile: buf.relFile, callerMethod, callerLine: lineNumberAt(stripped, cm.index || 0) });
      }
    }
  }
  return callers;
}

/**
 * Links RocketMQ producers and `@RocketMQMessageListener` consumers by resolved topic.
 * @param {MqListenerEntry[]} listeners
 * @param {MqProducerEntry[]} producers
 */
export function buildMqEdges(listeners, producers) {
  /** @type {Map<string, MqListenerEntry[]>} */
  const byTopic = new Map();
  for (const l of listeners || []) {
    if (!l.topic) continue;
    const list = byTopic.get(l.topic) || [];
    list.push(l);
    byTopic.set(l.topic, list);
  }
  /** @type {Array<{ topic: string, producerFile: string | null, producerClass: string | null, consumerFile: string, consumerClass: string, consumerGroup: string }>} */
  const edges = [];
  const matched = new Set();
  for (const p of producers || []) {
    for (const l of byTopic.get(p.topic) || []) {
      matched.add(`${l.file}::${l.topic}`);
      edges.push({ topic: p.topic, producerFile: p.file, producerClass: p.className, consumerFile: l.file, consumerClass: l.className, consumerGroup: l.consumerGroup });
    }
  }
  for (const l of listeners || []) {
    if (!matched.has(`${l.file}::${l.topic}`)) {
      edges.push({ topic: l.topic, producerFile: null, producerClass: null, consumerFile: l.file, consumerClass: l.className, consumerGroup: l.consumerGroup });
    }
  }
  return edges;
}

/**
 * Links MyBatis `*Mapper.xml` files to their Java `*Mapper.java` files by FQCN namespace.
 * @param {Array<{ file: string, namespace: string, tables: string[], statements?: MybatisXmlStatement[] }>} mybatisMappers
 * @param {Record<string, { relFile: string, fqcn: string }>} javaFileInfos
 * @returns {MybatisXmlLink[]}
 */
export function buildMybatisXmlLinks(mybatisMappers, javaFileInfos) {
  /** @type {Map<string, string>} */
  const fqcnToFile = new Map();
  for (const meta of Object.values(javaFileInfos || {})) if (meta?.fqcn) fqcnToFile.set(meta.fqcn, meta.relFile);
  return (mybatisMappers || []).map((m) => ({
    file: m.file, namespace: m.namespace, mapperFile: fqcnToFile.get(m.namespace) || null, tables: m.tables || [], statements: m.statements || [],
  }));
}
