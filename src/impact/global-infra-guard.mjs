// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { GRAPH_EXTS, stripJsCommentsPreserveStrings } from './scanner.mjs';

const SPRING_FACTORIES_RE = /(?:^|\/)META-INF\/spring\.factories$/i;
const SPRING_AUTOCONFIG_IMPORTS_RE = /(?:^|\/)META-INF\/spring\/org\.springframework\.boot\.autoconfigure\.AutoConfiguration\.imports$/i;
const VUE_GLOBAL_INFRA_RE = [
  { re: /(?:^|\/)src\/utils\/request\.[jt]s$/i, tag: 'vue-axios-request' },
  { re: /(?:^|\/)src\/utils\/platformRequest\.[jt]s$/i, tag: 'vue-platform-request' },
  { re: /(?:^|\/)src\/utils\/crudFactory\.[jt]s$/i, tag: 'vue-crud-factory' },
  { re: /(?:^|\/)src\/main\.[jt]s$/i, tag: 'vue-main-entry' },
  { re: /(?:^|\/)src\/permission\.[jt]s$/i, tag: 'vue-permission-guard' },
  { re: /(?:^|\/)src\/store\/modules\/permission\.[jt]s$/i, tag: 'vue-permission-store' },
];
const JAVA_GLOBAL_TYPE_RULES = [
  { re: /\bimplements\b[^{]*\bWebFilter\b/, tag: 'java-web-filter' },
  { re: /\bimplements\b[^{]*\bGlobalFilter\b/, tag: 'java-global-filter' },
  { re: /\bextends\b[^{]*\bOncePerRequestFilter\b/, tag: 'java-once-per-request-filter' },
  { re: /\bimplements\b[^{]*\bFilter\b/, tag: 'java-servlet-filter' },
  { re: /\bimplements\b[^{]*\b(?:Async)?HandlerInterceptor\b/, tag: 'java-handler-interceptor' },
  { re: /@(?:Rest)?ControllerAdvice\b/, tag: 'java-controller-advice' },
  { re: /\bimplements\b[^{]*\bWeb(?:Mvc|Flux)Configurer\b/, tag: 'java-web-configurer' },
  { re: /\b(?:class|interface|record)\s+WebProperties\b/, tag: 'java-web-properties' },
  { re: /\bimplements\b[^{]*\bRequestInterceptor\b/, tag: 'java-feign-request-interceptor' },
  { re: /@Intercepts\b|\bimplements\b[^{]*\bInterceptor\b/, tag: 'java-mybatis-interceptor' },
];
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'qa', '.aitest', '.sandbox', 'test', 'java']);

/** @param {string} p @returns {string} */
const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Resolves repo root labels matching `buildReverseImportGraph` / `collectMultiRepoGitChangedFiles`.
 * @param {string[]} repoRoots
 * @returns {Array<{ root: string, label: string }>}
 */
export function buildLabeledRepoRoots(repoRoots) {
  const valid = [...new Set((repoRoots || []).filter((r) => r && fs.existsSync(r)).map((r) => path.resolve(r)))];
  if (valid.length <= 1) return valid.map((root) => ({ root, label: '' }));
  const used = new Set();
  return valid.map((root) => {
    const base = path.basename(root) || 'repo';
    let label = base;
    for (let n = 2; used.has(label); n += 1) label = `${base}-${n}`;
    used.add(label);
    return { root, label };
  });
}

/**
 * Resolves a normalized changed file path back to disk using labeled repo roots.
 * @param {string} relFile
 * @param {Array<{ root: string, label: string }>} labeledRepos
 * @returns {{ absPath: string, repoRoot: string, repoLabel: string, bareRel: string } | null}
 */
export function resolveRepoFilePath(relFile, labeledRepos) {
  const clean = normRel(relFile);
  if (!clean || labeledRepos.length === 0) return null;
  if (labeledRepos.length > 1) {
    const slash = clean.indexOf('/');
    if (slash > 0) {
      const hit = labeledRepos.find((r) => r.label === clean.slice(0, slash));
      if (hit) {
        const rest = clean.slice(slash + 1);
        return { absPath: path.join(hit.root, rest), repoRoot: hit.root, repoLabel: hit.label, bareRel: rest };
      }
    }
  }
  for (const r of labeledRepos) {
    const abs = path.join(r.root, clean);
    if (fs.existsSync(abs)) return { absPath: abs, repoRoot: r.root, repoLabel: r.label, bareRel: clean };
  }
  const first = labeledRepos[0];
  return { absPath: path.join(first.root, clean), repoRoot: first.root, repoLabel: first.label, bareRel: clean };
}

/** @param {string} text @param {boolean} isFactories @returns {string[]} */
function parseAutoConfigDescriptor(text, isFactories) {
  /** @type {Set<string>} */
  const classes = new Set();
  const src = isFactories ? String(text || '').replace(/\\\r?\n[ \t]*/g, '') : String(text || '');
  for (const rawLine of src.split(/\r?\n/)) {
    const line = (isFactories ? rawLine : rawLine.replace(/#.*$/, '')).trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const rhs = isFactories ? (line.includes('=') ? line.slice(line.indexOf('=') + 1) : '') : line;
    for (const part of rhs.split(',')) {
      const fqcn = part.trim();
      if (/^[a-zA-Z0-9_$.]+$/.test(fqcn)) classes.add(fqcn);
    }
  }
  return [...classes];
}

/**
 * Discovers `META-INF/spring.factories` and `AutoConfiguration.imports` quickly (skipping `java/` trees).
 * @param {string} repoRoot
 */
function findSpringAutoConfigDescriptors(repoRoot) {
  /** @type {Array<{ moduleDir: string, fqcns: string[] }>} */
  const out = [];
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
    if (depth > 7) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'META-INF') {
        const moduleDir = path.resolve(dir, '..', '..', '..');
        for (const [sub, isFac] of [
          ['spring.factories', true],
          [path.join('spring', 'org.springframework.boot.autoconfigure.AutoConfiguration.imports'), false],
        ]) {
          const fp = path.join(full, /** @type {string} */ (sub));
          if (!fs.existsSync(fp)) continue;
          try { out.push({ moduleDir, fqcns: parseAutoConfigDescriptor(fs.readFileSync(fp, 'utf8'), Boolean(isFac)) }); } catch { /* ignore */ }
        }
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(repoRoot, 0);
  return out;
}

/**
 * Resolves Spring AutoConfiguration classes and all Java classes they import/reference.
 * @param {Array<{ root: string, label: string }>} labeledRepos
 */
export function collectSpringAutoConfigRegistry(labeledRepos) {
  /** @type {Set<string>} */ const autoConfigFqcns = new Set();
  /** @type {Set<string>} */ const referencedFqcns = new Set();
  /** @type {Set<string>} */ const referencedSimpleNames = new Set();
  /** @type {Set<string>} */ const autoConfigRelFiles = new Set();

  for (const { root, label } of labeledRepos) {
    for (const desc of findSpringAutoConfigDescriptors(root)) {
      for (const fqcn of desc.fqcns) {
        autoConfigFqcns.add(fqcn);
        const relJava = `${fqcn.replace(/\./g, '/')}.java`;
        const hit = [path.join(desc.moduleDir, 'src', 'main', 'java', relJava), path.join(root, 'src', 'main', 'java', relJava)]
          .find((p) => fs.existsSync(p));
        if (!hit) continue;
        const bare = normRel(path.relative(root, hit));
        autoConfigRelFiles.add(label ? `${label}/${bare}` : bare);
        try {
          const text = stripJsCommentsPreserveStrings(fs.readFileSync(hit, 'utf8'));
          const pkg = text.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m)?.[1] || '';
          for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.$]+)\s*;/gm)) referencedFqcns.add(m[1]);
          for (const m of text.matchAll(/\b(?:new\s+|(?:FilterRegistrationBean|WebFilter|HandlerInterceptor|Interceptor)<)([A-Z][A-Za-z0-9_$]*)/g)) {
            referencedSimpleNames.add(m[1]);
            if (pkg) referencedFqcns.add(`${pkg}.${m[1]}`);
          }
        } catch { /* ignore */ }
      }
    }
  }
  return { autoConfigFqcns, referencedFqcns, referencedSimpleNames, autoConfigRelFiles };
}

/**
 * Extracts `Vue.component('Name', Comp)` / `app.component('Name', Comp)` global registrations from `src/main.[jt]s`.
 * @param {Array<{ root: string, label: string }>} labeledRepos
 * @returns {Map<string, { name: string, sourceEntry: string }>}
 */
export function collectVueGlobalRegistrations(labeledRepos) {
  /** @type {Map<string, { name: string, sourceEntry: string }>} */
  const registered = new Map();
  const resolveImportFile = (/** @type {string} */ root, /** @type {string} */ entryRel, /** @type {string} */ spec) => {
    const baseRel = spec.startsWith('@/') || spec.startsWith('~/')
      ? `src/${spec.slice(2)}`
      : spec.startsWith('./') || spec.startsWith('../')
        ? path.posix.normalize(`${path.posix.dirname(entryRel)}/${spec}`)
        : '';
    if (!baseRel) return null;
    for (const ext of GRAPH_EXTS) {
      const cand = `${baseRel}${ext}`;
      try { if (fs.statSync(path.join(root, cand)).isFile()) return normRel(cand); } catch { /* next */ }
    }
    return null;
  };

  for (const { root, label } of labeledRepos) {
    for (const entryRel of ['src/main.js', 'src/main.ts', 'src/components/index.js', 'src/components/index.ts']) {
      const abs = path.join(root, entryRel);
      if (!fs.existsSync(abs)) continue;
      let text = '';
      try { text = stripJsCommentsPreserveStrings(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      /** @type {Map<string, string>} */
      const importByIdent = new Map();
      for (const m of text.matchAll(/import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"`]([^'"`]+)['"`]/g)) {
        const resolved = resolveImportFile(root, entryRel, m[2]);
        if (resolved) importByIdent.set(m[1], label ? `${label}/${resolved}` : resolved);
      }
      for (const m of text.matchAll(/(?:Vue|app)\.component\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g)) {
        const compFile = importByIdent.get(m[2]);
        if (compFile) registered.set(compFile, { name: m[1], sourceEntry: label ? `${label}/${entryRel}` : entryRel });
      }
    }
  }
  return registered;
}

/** @param {string} absPath */
function inspectJavaGlobalInfraFile(absPath) {
  let raw = '';
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    raw = fs.readFileSync(absPath, 'utf8');
  } catch { return null; }
  const text = stripJsCommentsPreserveStrings(raw);
  const pkg = text.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m)?.[1] || '';
  const className = text.match(/\b(?:class|interface|record)\s+([A-Za-z0-9_$]+)/)?.[1] || path.basename(absPath, '.java');
  const fqcn = pkg ? `${pkg}.${className}` : className;
  const hit = JAVA_GLOBAL_TYPE_RULES.find((r) => r.re.test(text));
  if (hit) return { fqcn, className, matchedRule: hit.tag };
  if (/(?:AutoConfiguration|WebConfiguration)\.java$/i.test(absPath) && /@(?:Auto)?Configuration\b/.test(text)) {
    return { fqcn, className, matchedRule: 'java-auto-configuration' };
  }
  return { fqcn, className, matchedRule: null };
}

/**
 * Fail-closed detector for global cross-cutting infrastructure across Spring Cloud + Vue repos (`GA-4`).
 * @param {string[]} changedFiles
 * @param {string[]} repoRoots
 * @param {Record<string, any> | null} [graphIndex]
 * @returns {{ isGlobal: boolean, reasons: string[], matchedFiles: string[] }}
 */
export function detectGlobalInfraImpact(changedFiles, repoRoots, graphIndex = null) {
  const labeledRepos = buildLabeledRepoRoots(repoRoots || []);
  /** @type {string[]} */ const reasons = [];
  /** @type {Set<string>} */ const matchedFiles = new Set();
  const flag = (/** @type {string} */ file, /** @type {string} */ reason) => {
    matchedFiles.add(file);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const preGlobal = new Set([
    ...(Array.isArray(graphIndex?.globalInfra?.globalFiles) ? graphIndex.globalInfra.globalFiles : []),
    ...(Array.isArray(graphIndex?.globalInfra?.springAutoConfigFiles) ? graphIndex.globalInfra.springAutoConfigFiles : []),
    ...(Array.isArray(graphIndex?.globalInfra?.springAutoConfigTargets) ? graphIndex.globalInfra.springAutoConfigTargets : []),
  ]);
  const graphGlobalComps = graphIndex?.globalComponents && typeof graphIndex.globalComponents === 'object' ? graphIndex.globalComponents : null;
  const graphClean = Boolean(graphIndex?.coverage?.clean);

  /** @type {ReturnType<typeof collectSpringAutoConfigRegistry> | null} */ let springReg = null;
  /** @type {ReturnType<typeof collectVueGlobalRegistrations> | null} */ let vueRegs = null;

  for (const rawFile of changedFiles || []) {
    const file = normRel(rawFile);
    if (!file) continue;
    if (SPRING_FACTORIES_RE.test(file) || SPRING_AUTOCONFIG_IMPORTS_RE.test(file)) { flag(file, `spring-auto-config-descriptor: ${file}`); continue; }
    if (preGlobal.has(file)) { flag(file, `graph-index-global-infra: ${file}`); continue; }
    const vueHit = VUE_GLOBAL_INFRA_RE.find((r) => r.re.test(file));
    if (vueHit) { flag(file, `${vueHit.tag}: ${file}`); continue; }

    if (file.endsWith('.java')) {
      const resolved = resolveRepoFilePath(file, labeledRepos);
      const info = resolved ? inspectJavaGlobalInfraFile(resolved.absPath) : null;
      if (info?.matchedRule) { flag(file, `${info.matchedRule}: ${file}`); continue; }
      if (info) {
        if (!springReg) springReg = collectSpringAutoConfigRegistry(labeledRepos);
        if (springReg.autoConfigRelFiles.has(file) || springReg.autoConfigFqcns.has(info.fqcn)) {
          flag(file, `spring-factories-autoconfig: ${file} (${info.fqcn})`);
          continue;
        }
        if (springReg.referencedFqcns.has(info.fqcn) || (/(?:Filter|Interceptor|Advice|Properties)$/.test(info.className) && springReg.referencedSimpleNames.has(info.className))) {
          flag(file, `spring-autoconfig-referenced-bean: ${file} (${info.fqcn})`);
          continue;
        }
      }
    }
    if (/\.(?:vue|[jt]sx?)$/i.test(file)) {
      const gcEntry = graphGlobalComps?.[file];
      if (!vueRegs) vueRegs = collectVueGlobalRegistrations(labeledRepos);
      const diskReg = vueRegs.get(file);
      if (gcEntry || diskReg) {
        const complete = Boolean(gcEntry?.complete === true && Array.isArray(gcEntry.consumers) && gcEntry.consumers.length > 0 && graphClean);
        if (!complete) flag(file, `vue-global-component-unresolved: ${file} (${gcEntry?.name || diskReg?.name || path.basename(file)})`);
      }
    }
  }
  return { isGlobal: matchedFiles.size > 0, reasons, matchedFiles: [...matchedFiles].sort() };
}
