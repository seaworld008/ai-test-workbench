// @ts-check
import path from 'node:path';
import { normalizeRoutePath } from './route-matcher.mjs';
import { extractJavaBaseMapperEntities, extractMybatisXmlDetails } from './rpc-mybatis-extractor.mjs';
import {
  attachSpringPackagePrefixes,
  extractJavaStringConstants,
  extractSpringPrefixRulesFromFile,
  matchAntPackagePattern,
  matchSpringPackagePattern,
  readBalancedParens,
  resolveJavaStringExpr,
  resolveSpringPackagePrefix,
  stripJavaComments,
} from './spring-prefix-resolver.mjs';

export {
  attachSpringPackagePrefixes,
  extractSpringPrefixRulesFromFile,
  matchAntPackagePattern,
  matchSpringPackagePattern,
  resolveSpringPackagePrefix,
  stripJavaComments,
};

const HTTP_METHOD_RE = /\bRequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i;
const IGNORED_FIELD_TYPES = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Short', 'Byte', 'Character', 'Number', 'Object',
  'Class', 'Void', 'BigDecimal', 'BigInteger', 'Date', 'LocalDate', 'LocalTime', 'LocalDateTime', 'Instant',
  'List', 'ArrayList', 'LinkedList', 'Set', 'HashSet', 'Map', 'HashMap', 'ConcurrentHashMap', 'Collection',
  'Optional', 'Stream', 'Pattern', 'Logger', 'AtomicInteger', 'AtomicLong', 'AtomicBoolean', 'ThreadLocal',
  'Executor', 'ExecutorService', 'ObjectMapper', 'RestTemplate', 'StringRedisTemplate', 'RedisTemplate',
  'RedissonClient', 'PlatformTransactionManager', 'HttpServletRequest', 'HttpServletResponse', 'MultipartFile',
]);
const UTILITY_HUB_NAME_RE =
  /(?:ResultBuilder\w*|CommonResult|PageResult|BeanUtils|Convert|Utils|Util|Helper|Constants|Constant|Properties|Enum|Exception|StrategyFactory|CheckChain|RedisDAO|Producer|Consumer|VO|DTO|Template)$/;

/**
 * Parses mapping paths from Spring `@*Mapping(...)` argument body, resolving Java constants when present.
 * @param {string} argsBody
 * @param {Record<string, string>} localConsts
 * @param {Map<string, string>} globalConsts
 * @param {string[]} imports
 * @param {string} packageName
 * @returns {string[]}
 */
function parseSpringMappingPaths(argsBody, localConsts, globalConsts, imports, packageName) {
  const clean = String(argsBody || '').trim();
  if (!clean) return [''];

  const resolveItem = (/** @type {string} */ item) => {
    const resolved = resolveJavaStringExpr(item, localConsts, globalConsts, imports, packageName);
    if (resolved !== null) return resolved;
    const lit = item.match(/["']([^"']*)["']/);
    return lit ? lit[1] : null;
  };

  const named = clean.match(/\b(?:value|path)\s*=\s*(\{[\s\S]*?\}|[^,)]+)/);
  if (named) {
    const raw = named[1].trim();
    if (raw.startsWith('{')) {
      const items = raw.slice(1, raw.lastIndexOf('}')).split(',').map((s) => resolveItem(s.trim())).filter((s) => s !== null);
      return items.length > 0 ? items : [''];
    }
    const single = resolveItem(raw);
    return single !== null ? [single] : [''];
  }
  if (/^\s*\{/.test(clean)) {
    const head = clean.slice(1, clean.indexOf('}'));
    const items = head.split(',').map((s) => resolveItem(s.trim())).filter((s) => s !== null);
    if (items.length > 0) return items;
  }
  const firstArg = clean.split(',')[0].trim();
  if (!firstArg.includes('=')) {
    const single = resolveItem(firstArg);
    if (single !== null) return [single];
  }
  return [''];
}

/**
 * Scans `@(Get|Post|Put|Delete|Patch|Request)Mapping` annotations inside a Java/Kotlin snippet.
 * @param {string} snippet
 * @param {Record<string, string>} localConsts
 * @param {Map<string, string>} globalConsts
 * @param {string[]} imports
 * @param {string} packageName
 * @returns {Array<{ kind: string, method: string, paths: string[], index: number, afterIdx: number }>}
 */
function scanMappingAnnotations(snippet, localConsts, globalConsts, imports, packageName) {
  /** @type {Array<{ kind: string, method: string, paths: string[], index: number, afterIdx: number }>} */
  const out = [];
  const annRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g;
  for (const m of snippet.matchAll(annRe)) {
    const kind = m[1];
    const startIdx = m.index || 0;
    let idx = startIdx + m[0].length;
    while (idx < snippet.length && /\s/.test(snippet[idx])) idx += 1;
    let body = '';
    let afterIdx = idx;
    if (snippet[idx] === '(') {
      const balanced = readBalancedParens(snippet, idx);
      if (balanced) {
        body = balanced.body;
        afterIdx = balanced.endIdx + 1;
      }
    }
    let method = kind === 'Request' ? 'ANY' : kind.toUpperCase();
    if (kind === 'Request') {
      const rm = body.match(HTTP_METHOD_RE);
      if (rm) method = rm[1].toUpperCase();
    }
    out.push({
      kind,
      method,
      paths: parseSpringMappingPaths(body, localConsts, globalConsts, imports, packageName),
      index: startIdx,
      afterIdx,
    });
  }
  return out;
}

/**
 * Extracts Java package, class name, imports, super-types (preserving `BaseMapper<EntityDO>` generic entity types!),
 * `implements` vs `extends`, injected/declared field types, and utility/hub classification.
 * @param {string} relFile
 * @param {string} stripped
 */
export function extractJavaMetadata(relFile, stripped) {
  const pkgMatch = stripped.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m);
  const packageName = pkgMatch ? pkgMatch[1] : '';
  const typeDecl = stripped.match(
    /(?:^|\s)(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|sealed\s+|static\s+|data\s+|open\s+)*\b(?:class|interface|record)\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?([^;{]*)\{/
  );
  const className = typeDecl ? typeDecl[1] : path.basename(relFile).replace(/\.(java|kt)$/i, '');
  const fqcn = packageName ? `${packageName}.${className}` : className;

  /** @type {string[]} */
  const imports = [];
  for (const m of stripped.matchAll(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*$]+)\s*;/gm)) {
    imports.push(m[1]);
  }

  /** @type {string[]} */
  const superTypes = [];
  /** @type {string[]} */
  const implementsTypes = [];
  if (typeDecl && typeDecl[2]) {
    const clause = typeDecl[2];
    for (const m of clause.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
      if (!['Object', 'Serializable'].includes(m[1])) superTypes.push(m[1]);
    }
    const implPart = clause.match(/\bimplements\s+([\s\S]*)$/);
    if (implPart) {
      for (const item of implPart[1].split(',')) {
        const clean = item.trim().replace(/<[^>]*>/g, '').split(/\s+/)[0];
        if (/^[A-Z][A-Za-z0-9_$]*$/.test(clean) && clean !== 'Serializable') implementsTypes.push(clean);
      }
    }
  }

  const genericEntityTypes = extractJavaBaseMapperEntities(stripped);
  for (const ent of genericEntityTypes) {
    if (!superTypes.includes(ent)) superTypes.push(ent);
  }

  /** @type {string[]} */
  const fieldTypes = [];
  const annotatedFieldRe =
    /@(?:Resource|Autowired|Inject|DubboReference)\b(?:\s*\([^)]*\))?\s*(?:private|protected|public)?\s*(?:final\s+)?([A-Z][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+[a-zA-Z_$][A-Za-z0-9_$]*\s*[;=]/g;
  for (const m of stripped.matchAll(annotatedFieldRe)) {
    if (!IGNORED_FIELD_TYPES.has(m[1])) fieldTypes.push(m[1]);
  }
  const memberFieldRe =
    /^\s*(?:private|protected)\s+(?:final\s+)?([A-Z][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+[a-zA-Z_$][A-Za-z0-9_$]*\s*;/gm;
  for (const m of stripped.matchAll(memberFieldRe)) {
    if (!IGNORED_FIELD_TYPES.has(m[1])) fieldTypes.push(m[1]);
  }

  const isFeignClient = /@FeignClient\b/.test(stripped);
  const isDubboService = /@DubboService\b/.test(stripped);
  const isController = !isFeignClient && /@(?:Rest)?Controller\b/.test(stripped);
  const isService = /@Service\b/.test(stripped) || /Service(?:Impl)?$/.test(className);
  const isMapper = /@Mapper\b/.test(stripped) || /Mapper$/.test(className) || genericEntityTypes.length > 0;
  const isEntity = /@(?:TableName|Table|Entity)\b/.test(stripped) || /(?:DO|Entity|PO)$/.test(className);
  const isApiImpl = (isController || isDubboService) && /ApiImpl$/.test(className);
  const isUtilityHub =
    !isController &&
    !isMapper &&
    !isEntity &&
    (UTILITY_HUB_NAME_RE.test(className) || (!isService && imports.length > 60));

  return {
    relFile,
    packageName,
    className,
    fqcn,
    imports,
    superTypes: [...new Set(superTypes)],
    implementsTypes: [...new Set(implementsTypes)],
    genericEntityTypes,
    fieldTypes: [...new Set(fieldTypes)],
    isController,
    isService,
    isMapper,
    isEntity,
    isFeignClient,
    isDubboService,
    isApiImpl,
    isUtilityHub,
  };
}

/**
 * Extracts Spring MVC endpoints (header/body boundary, zero `/x/x` duplication, skips `@FeignClient`)
 * and `@TableName`/`@Table` DB entities from Java/Kotlin sources.
 * @param {string} relFile
 * @param {string} ext
 * @param {string} text
 * @param {Map<string, string>} [globalConsts]
 */
export function extractSpringEndpointsAndEntities(relFile, ext, text, globalConsts = new Map()) {
  if (ext !== '.java' && ext !== '.kt') return null;
  const stripped = stripJavaComments(text);
  /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */
  const endpoints = [];
  /** @type {import('./backend-adapters.mjs').DbEntity[]} */
  const entities = [];
  const javaMeta = extractJavaMetadata(relFile, stripped);

  for (const m of stripped.matchAll(/@(?:TableName|Table)\s*\(([^)]*)\)/g)) {
    const args = m[1];
    const tblMatch =
      args.match(/\b(?:value|name)\s*=\s*["']([a-zA-Z0-9_.]+)["']/) ||
      args.match(/^\s*["']([a-zA-Z0-9_.]+)["']/);
    if (tblMatch) {
      entities.push({ table: tblMatch[1], file: relFile, source: 'jpa/mybatis' });
    }
  }

  if (javaMeta.isFeignClient) {
    return { endpoints, entities, javaMeta };
  }

  const decl = extractJavaStringConstants(relFile, stripped);
  /** @type {Record<string, string>} */
  const localConsts = {};
  for (const [k, rhs] of Object.entries(decl.rawConsts)) {
    const val = resolveJavaStringExpr(rhs, localConsts, globalConsts, decl.imports, decl.packageName);
    if (val !== null) localConsts[k] = val;
  }

  const classMatch = stripped.match(
    /(?:^|\s)(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|sealed\s+|static\s+|data\s+|open\s+)*\b(?:class|interface|record)\s+[A-Za-z0-9_$]+[^{;]*\{/
  );
  const splitIdx = classMatch && classMatch.index !== undefined ? classMatch.index + classMatch[0].length : 0;
  const headerText = splitIdx > 0 ? stripped.slice(0, splitIdx) : '';
  const bodyText = splitIdx > 0 ? stripped.slice(splitIdx) : stripped;

  const classMappings = scanMappingAnnotations(headerText, localConsts, globalConsts, decl.imports, decl.packageName).filter(
    (a) => a.kind === 'Request'
  );
  const classPrefixes = classMappings.length > 0 ? classMappings.flatMap((c) => c.paths) : [''];

  for (const methodAnn of scanMappingAnnotations(bodyText, localConsts, globalConsts, decl.imports, decl.packageName)) {
    const sigSlice = bodyText.slice(methodAnn.afterIdx, methodAnn.afterIdx + 500);
    const sigNoAnns = sigSlice.replace(/@[A-Za-z0-9_.$]+(?:\s*\([^)]*\))?\s*/g, ' ');
    const methodMatch = sigNoAnns.match(
      /\b(?:public|protected|private)\s+(?:static\s+|final\s+|synchronized\s+)*(?:<[^>{;]+>\s*)?[A-Za-z0-9_$.<>,?\s[\]]+\s+([a-zA-Z_$][A-Za-z0-9_$]*)\s*\(/
    );
    const handler = methodMatch ? methodMatch[1] : undefined;
    for (const cPref of classPrefixes) {
      for (const mPath of methodAnn.paths) {
        const cleanPref = cPref.replace(/\/+$/, '');
        const cleanMethod = mPath.replace(/^\/+/, '');
        const combined = cleanMethod ? `${cleanPref}/${cleanMethod}` : cleanPref || '/';
        if (!combined || (combined === '/' && !cPref && !mPath)) continue;
        const normalized = normalizeRoutePath(combined).replace(/\{([^}:]+)(?::[^}]*)?\}/g, ':$1');
        endpoints.push({
          method: methodAnn.method,
          path: normalized,
          file: relFile,
          framework: 'spring',
          ...(handler ? { handler } : {}),
          ...(javaMeta.packageName ? { packageName: javaMeta.packageName } : {}),
        });
      }
    }
  }

  return { endpoints, entities, javaMeta };
}

/**
 * Extracts `<mapper namespace="...">`, SQL table references, and per-statement line ranges from MyBatis `*Mapper.xml`.
 * @param {string} relFile
 * @param {string} ext
 * @param {string} text
 */
export function extractMybatisXmlEntities(relFile, ext, text) {
  return extractMybatisXmlDetails(relFile, ext, text);
}
