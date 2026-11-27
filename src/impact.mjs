// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { canonicalFsPath } from './kernel/gate-kernel.mjs';
import { readLedgerHistory } from './ledger.mjs';
import { buildLabeledRepoRoots, detectGlobalInfraImpact, resolveRepoFilePath } from './impact/global-infra-guard.mjs';
import { buildGraphImpactIndex, collectGitDiffHunks, evaluateGraphAssistedImpact, loadGraphImpactIndex } from './impact/graph-index.mjs';
import {
  GLOBAL_INFRA_PATTERNS, buildReqIdToSpecMap, buildReverseImportGraph, collectGitChangedFiles,
  collectMultiRepoGitChangedFiles, evaluateImpactRecall, extractReqIdsFromFile, findTransitiveDependents,
  listAllSpecFiles, loadAndValidateImpactRules, specMatchesStemExactSegment,
} from './impact/graph.mjs';
import {
  buildCodeMapFileToSpecMap, evaluateUpwardDependentClosure, extractCandidateStem,
  isIgnoredWorkbenchArtifactPath, resolveImpactRepos,
} from './impact/java-support.mjs';
import { DEFAULT_PER_REPO_GRAPH_FILES } from './impact/scanner.mjs';

export {
  buildGraphImpactIndex, buildReverseImportGraph, collectGitChangedFiles, collectGitDiffHunks,
  detectGlobalInfraImpact, evaluateGraphAssistedImpact, evaluateImpactRecall, findTransitiveDependents, loadGraphImpactIndex,
};

/**
 * @typedef {{
 *   provider: string, version: string | null, binarySha256: string | null, mode: string, usedForNarrowing: boolean,
 *   fallbackReason?: string | null, touchedSymbols?: string[], affectedControllers?: string[], affectedViews?: string[],
 * }} ImpactGraphEngineMeta
 */

/**
 * @typedef {{
 *   mode: 'full' | 'targeted' | 'only-changed', downgraded?: boolean, reason: string, specs: string[],
 *   totalSpecsCount?: number, reductionRatio?: number, why: Array<{ spec: string, via: string }>,
 *   recallEstimate: number | null, useOnlyChanged: boolean, changedFiles: string[], baseRef?: string, graphEngine?: ImpactGraphEngineMeta,
 * }} ImpactResult
 */

/**
 * @param {string} reason @param {string[]} changedFiles @param {Array<{ spec: string, via: string }>} [why]
 * @param {string} [baseRef] @param {ImpactGraphEngineMeta} [graphEngine] @returns {ImpactResult}
 */
function makeFullImpactResult(reason, changedFiles, why = [], baseRef = undefined, graphEngine = undefined) {
  return {
    mode: 'full', downgraded: true, reason, specs: [], why, recallEstimate: null, useOnlyChanged: false,
    ...(baseRef !== undefined ? { baseRef } : {}), ...(graphEngine ? { graphEngine } : {}), changedFiles,
  };
}

/** @param {string} qaDir @returns {Record<string, any> | null} */
function readCodeMapSafe(qaDir) {
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return null;
  try { return JSON.parse(fs.readFileSync(cmPath, 'utf8')); } catch { return null; }
}

/**
 * Hardened Impact v3 selector: Global Infra Guard + Pre-Synced Graph Index Reader (<20ms) +
 * Additive-Only Fail-Closed Symbol Narrowing + Native Reverse Import Graph fallback.
 * @param {string[]} changedFiles @param {string} qaDir @param {string} repoDir
 * @param {{ canUseOnlyChanged?: boolean, repos?: string[], diffHunks?: Record<string, Array<{ startLine: number, endLine: number }>> | null }} [options]
 * @returns {ImpactResult}
 */
export function evaluateImpactForFiles(changedFiles, qaDir, repoDir, options = {}) {
  const effectiveRepoDir = canonicalFsPath(repoDir) === canonicalFsPath(qaDir) ? path.dirname(qaDir) : repoDir;
  const qaRelPrefix = path.relative(canonicalFsPath(effectiveRepoDir), canonicalFsPath(qaDir)).replace(/\\/g, '/');
  const repos = Array.isArray(options.repos) && options.repos.length > 0 ? options.repos : resolveImpactRepos(effectiveRepoDir, qaDir);
  const labeledRepos = buildLabeledRepoRoots(repos);
  const normalized = [
    ...new Set((changedFiles || []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => f && !isIgnoredWorkbenchArtifactPath(f, qaRelPrefix))),
  ];

  const graphIndexRes = loadGraphImpactIndex(qaDir);
  /** @type {ImpactGraphEngineMeta} */
  const baseGraphEngine = graphIndexRes.ok && graphIndexRes.index?.graphEngine
    ? {
        provider: String(graphIndexRes.index.graphEngine.provider || 'builtin'),
        version: graphIndexRes.index.graphEngine.version ?? null,
        binarySha256: graphIndexRes.index.graphEngine.binarySha256 ?? null,
        mode: String(graphIndexRes.index.graphEngine.mode || 'builtin'),
        usedForNarrowing: false,
      }
    : { provider: 'builtin', version: null, binarySha256: null, mode: 'builtin', usedForNarrowing: false };

  if (normalized.length === 0) {
    return makeFullImpactResult('No changed files detected or diff empty — falling back to full suite for safety.', [], [], undefined, baseGraphEngine);
  }
  for (const file of normalized) {
    if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(file))) {
      return makeFullImpactResult(`Shared/infrastructure or policy file changed ("${file}") — running full regression suite.`, normalized, [{ spec: '*', via: `infra-guard: ${file}` }], undefined, { ...baseGraphEngine, fallbackReason: 'static-infra-pattern' });
    }
  }
  const globalGuard = detectGlobalInfraImpact(normalized, repos, graphIndexRes.index);
  if (globalGuard.isGlobal) {
    return makeFullImpactResult(`Global cross-cutting infrastructure changed (${globalGuard.matchedFiles.join(', ')}) — running full regression suite.`, normalized, globalGuard.reasons.map((r) => ({ spec: '*', via: `global-infra-guard: ${r}` })), undefined, { ...baseGraphEngine, fallbackReason: 'global-infra-guard' });
  }

  const allSpecs = listAllSpecFiles(path.join(qaDir, 'tests'), qaDir);
  if (allSpecs.length === 0) return makeFullImpactResult('No spec files found in QA directory — falling back to full suite.', normalized, [], undefined, baseGraphEngine);

  const loadedManual = loadAndValidateImpactRules(path.join(qaDir, 'impact-map.json'));
  if (!loadedManual.ok) {
    return makeFullImpactResult(loadedManual.errorReason || 'Invalid impact-map.json — falling back to full suite.', normalized, loadedManual.via ? [{ spec: '*', via: loadedManual.via }] : [], undefined, baseGraphEngine);
  }
  const autoRulesPath = path.join(qaDir, 'knowledge', 'impact-map.auto.json');
  const loadedAuto = fs.existsSync(autoRulesPath) ? loadAndValidateImpactRules(autoRulesPath) : { ok: true, rules: [], errorReason: null };
  const compiledRules = [...loadedManual.rules, ...(loadedAuto.ok ? loadedAuto.rules : [])];
  const reqToSpecs = buildReqIdToSpecMap(qaDir, effectiveRepoDir, allSpecs);

  /** @type {Map<string, string[]>} */ const whyBySpec = new Map();
  const addSpecReason = (/** @type {string} */ specRel, /** @type {string} */ reasonStr) => {
    const arr = whyBySpec.get(specRel) || [];
    if (!arr.includes(reasonStr)) arr.push(reasonStr);
    whyBySpec.set(specRel, arr);
  };

  let allInsideQa = true;
  /** @type {string[]} */ const qaNonSpecFiles = [];
  /** @type {string[]} */ const sourceFiles = [];

  for (const file of normalized) {
    if (/\.(md|txt)$/i.test(file) && !file.includes('specs/')) continue;
    const isInsideQa = qaRelPrefix ? file === qaRelPrefix || file.startsWith(`${qaRelPrefix}/`) : file.startsWith('tests/');
    if (isInsideQa) {
      const relInsideQa = qaRelPrefix && file.startsWith(`${qaRelPrefix}/`) ? file.slice(qaRelPrefix.length + 1) : file;
      if (isIgnoredWorkbenchArtifactPath(relInsideQa)) continue;
      if (/^tests\/.*\.(?:spec|test)\.[jt]s$/.test(relInsideQa) && allSpecs.includes(relInsideQa)) { addSpecReason(relInsideQa, `direct-spec-edit: ${relInsideQa}`); continue; }
      if (/^specs\/.*\.md$/i.test(relInsideQa)) {
        let mappedByReq = false;
        for (const reqId of extractReqIdsFromFile(path.join(qaDir, relInsideQa))) {
          for (const sp of reqToSpecs.get(reqId) || []) { addSpecReason(sp, `req-spec-link: ${relInsideQa} (${reqId})`); mappedByReq = true; }
        }
        if (mappedByReq) continue;
      }
      qaNonSpecFiles.push(relInsideQa);
      continue;
    }
    allInsideQa = false;
    sourceFiles.push(file);
    const absChanged = resolveRepoFilePath(file, labeledRepos)?.absPath || path.join(effectiveRepoDir, file);
    for (const reqId of extractReqIdsFromFile(absChanged)) {
      for (const sp of reqToSpecs.get(reqId) || []) addSpecReason(sp, `req-code-link: ${file} (${reqId})`);
    }
  }

  /** @type {ImpactGraphEngineMeta} */
  let activeGraphEngine = { ...baseGraphEngine, fallbackReason: graphIndexRes.reason || null };
  let graphNarrowed = false;

  if (sourceFiles.length > 0 && graphIndexRes.ok && graphIndexRes.index) {
    const graphEval = evaluateGraphAssistedImpact({
      changedFiles: sourceFiles, diffHunks: options.diffHunks || null, graphIndex: graphIndexRes.index,
      codeMap: readCodeMapSafe(qaDir), globalGuard, allSpecs,
    });
    if (graphEval.eligible) {
      for (const sf of [...sourceFiles, ...graphEval.affectedJavaFiles, ...graphEval.affectedViews]) {
        for (const rule of compiledRules) {
          if (!rule.patterns.some((re) => re.test(sf))) continue;
          if (rule.fullSuite) return makeFullImpactResult(`Impact rule for "${sf}" requires full suite.`, normalized, [{ spec: '*', via: `fullSuite-rule: ${sf}` }], undefined, { ...baseGraphEngine, fallbackReason: 'fullSuite-rule' });
          for (const sp of rule.specs) if (allSpecs.includes(sp)) addSpecReason(sp, `impact-rule: ${sf} (${rule.rawMatch})`);
        }
      }
      for (const item of graphEval.why) addSpecReason(item.spec, item.via);
      graphNarrowed = true;
      activeGraphEngine = { ...graphEval.graphEngine, usedForNarrowing: true, touchedSymbols: graphEval.touchedSymbols, affectedControllers: graphEval.affectedControllers, affectedViews: graphEval.affectedViews };
    } else if (/^unmapped-affected-/.test(graphEval.reason)) {
      return makeFullImpactResult(`Graph-assisted impact proved uncovered blast radius (${graphEval.reason}) — failing closed to full suite.`, normalized, [{ spec: '*', via: `graph-fail-closed: ${graphEval.reason}` }], undefined, { ...baseGraphEngine, fallbackReason: graphEval.reason });
    } else {
      activeGraphEngine = { ...baseGraphEngine, fallbackReason: graphEval.reason };
    }
  }

  if (sourceFiles.length > 0 && !graphNarrowed) {
    const codeMapFileToSpecs = buildCodeMapFileToSpecMap(qaDir, allSpecs);
    const reverseGraph = buildReverseImportGraph(effectiveRepoDir, { includeQa: false, repos });
    if (reverseGraph.truncated) {
      return makeFullImpactResult(`Import graph exceeded ${DEFAULT_PER_REPO_GRAPH_FILES}-file scan budget (truncated) — falling back to full suite for recall safety.`, normalized, [{ spec: '*', via: `graph-truncated(${DEFAULT_PER_REPO_GRAPH_FILES})` }], undefined, activeGraphEngine);
    }
    const matchCandidateFileToSpecs = (/** @type {string} */ candidateFile, /** @type {string | null} */ chainPrefix = null) => {
      let matchedAny = false;
      for (const rule of compiledRules) {
        if (!rule.patterns.some((re) => re.test(candidateFile))) continue;
        if (rule.fullSuite) return { forceFull: true, matchedAny: true };
        for (const sp of rule.specs) if (allSpecs.includes(sp)) { addSpecReason(sp, chainPrefix ? `import-graph: ${chainPrefix} -> rule(${rule.rawMatch})` : `impact-rule: ${candidateFile} (${rule.rawMatch})`); matchedAny = true; }
      }
      for (const hit of codeMapFileToSpecs.get(candidateFile) || []) { addSpecReason(hit.spec, chainPrefix ? `import-graph: ${chainPrefix} -> ${hit.via}` : `${hit.via}: ${candidateFile}`); matchedAny = true; }
      if (!matchedAny) {
        const stem = extractCandidateStem(candidateFile);
        if (stem.length >= 3 && !['index', 'main', 'app', 'utils', 'common', 'base', 'config'].includes(stem)) {
          for (const sp of allSpecs) if (specMatchesStemExactSegment(sp, stem)) { addSpecReason(sp, chainPrefix ? `import-graph: ${chainPrefix} -> stem(${stem})` : `stem-match: ${candidateFile}`); matchedAny = true; }
        }
      }
      return { forceFull: false, matchedAny };
    };
    for (const file of sourceFiles) {
      const dependents = findTransitiveDependents(file, reverseGraph);
      if (dependents.length >= 8) {
        return makeFullImpactResult(`High-fan-in module "${file}" is imported by ${dependents.length} files — running full suite.`, normalized, [{ spec: '*', via: `high-fan-in(${dependents.length}): ${file}` }], undefined, activeGraphEngine);
      }
      for (const dep of dependents) {
        if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(dep.file))) {
          return makeFullImpactResult(`Changed file "${file}" is imported by shared infrastructure "${dep.file}" — running full suite.`, normalized, [{ spec: '*', via: `import-graph-infra: ${dep.chain.join(' -> ')}` }], undefined, activeGraphEngine);
        }
      }
      const closure = evaluateUpwardDependentClosure({ file, reverseGraph, dependents, matchCandidateFileToSpecs });
      if (!closure.ok) return makeFullImpactResult(closure.reason || 'Unmapped transitive dependent.', normalized, [{ spec: '*', via: closure.via || `unmapped-fallback: ${file}` }], undefined, activeGraphEngine);
    }
  }

  if (qaNonSpecFiles.length > 0) {
    if (allInsideQa && whyBySpec.size === 0 && options.canUseOnlyChanged) {
      return {
        mode: 'only-changed', downgraded: false,
        reason: 'Only internal QA helper files changed — delegating to Playwright --only-changed dependency graph.',
        specs: [], why: [{ spec: '--only-changed', via: 'playwright-ts-dependency-graph' }],
        recallEstimate: null, useOnlyChanged: true, changedFiles: normalized, graphEngine: activeGraphEngine,
      };
    }
    const qaGraph = buildReverseImportGraph(qaDir, { includeQa: true });
    for (const qaRel of qaNonSpecFiles) {
      const depSpecs = findTransitiveDependents(qaRel, qaGraph).filter((d) => allSpecs.includes(d.file));
      if (depSpecs.length === 0) return makeFullImpactResult(`QA helper/Page Object changed ("${qaRel}") with unresolved spec dependents — running full suite.`, normalized, [{ spec: '*', via: `qa-helper-fallback: ${qaRel}` }], undefined, activeGraphEngine);
      for (const ds of depSpecs) addSpecReason(ds.file, `qa-import-graph: ${ds.chain.join(' -> ')}`);
    }
  }

  for (const r of readLedgerHistory(qaDir, 5)) {
    for (const ft of r.failedTests || []) {
      const normFailFile = String(ft.file || '').startsWith('tests/') ? ft.file : `tests/${ft.file}`;
      if (allSpecs.includes(normFailFile) && whyBySpec.size > 0) addSpecReason(normFailFile, `ledger-recent-failure: runId=${r.runId}`);
    }
  }

  if (whyBySpec.size === 0) return makeFullImpactResult('Zero specific specs resolved from diff — falling back to full regression suite.', normalized, [], undefined, activeGraphEngine);

  const sortedSpecs = [...whyBySpec.keys()].sort();
  return {
    mode: 'targeted', downgraded: false,
    reason: graphNarrowed
      ? `Graph-assisted symbol impact narrowed ${normalized.length} changed file(s) to ${sortedSpecs.length} targeted spec(s) (+ smoke).`
      : `Mapped ${normalized.length} changed file(s) to ${sortedSpecs.length} targeted spec(s) (+ smoke).`,
    specs: sortedSpecs, totalSpecsCount: allSpecs.length,
    reductionRatio: Number((sortedSpecs.length / allSpecs.length).toFixed(4)),
    why: sortedSpecs.map((sp) => ({ spec: sp, via: (whyBySpec.get(sp) || []).join('; ') })),
    recallEstimate: null, useOnlyChanged: false, changedFiles: normalized, graphEngine: activeGraphEngine,
  };
}

/**
 * @param {string} targetDir
 * @param {{ qaDir?: string, base?: string, files?: string[], repos?: string[], repo?: string | string[], diffHunks?: Record<string, Array<{ startLine: number, endLine: number }>> | null }} [options]
 * @returns {Promise<ImpactResult>}
 */
export async function computeImpact(targetDir, options = {}) {
  const repoDir = path.resolve(targetDir);
  const qaDir = resolveQaDirectory(repoDir, options.qaDir);
  if (!qaDir) throw new Error(`QA directory not found under ${repoDir}`);

  const repos = resolveImpactRepos(repoDir, qaDir, options);
  const effectiveRepoDir = canonicalFsPath(repoDir) === canonicalFsPath(qaDir) ? path.dirname(qaDir) : repoDir;
  const qaRelPrefix = path.relative(canonicalFsPath(effectiveRepoDir), canonicalFsPath(qaDir)).replace(/\\/g, '/');

  const baseRef = options.base || 'HEAD~1';
  if (Array.isArray(options.files) && options.files.length > 0) {
    return evaluateImpactForFiles(options.files, qaDir, effectiveRepoDir, { canUseOnlyChanged: false, repos, diffHunks: options.diffHunks || null });
  }

  const gitInfo = await collectMultiRepoGitChangedFiles(repos, baseRef, { qaRelPrefix });
  if (!gitInfo.ok) return makeFullImpactResult(`${gitInfo.reason} Falling back to full regression suite.`, [], [], baseRef);

  let diffHunks = options.diffHunks || null;
  if (!diffHunks && gitInfo.files.length > 0 && loadGraphImpactIndex(qaDir).ok) {
    const hunkRes = await collectGitDiffHunks(repos, baseRef);
    if (hunkRes.ok) diffHunks = hunkRes.hunksByFile;
  }
  const evaluated = evaluateImpactForFiles(gitInfo.files, qaDir, effectiveRepoDir, { canUseOnlyChanged: gitInfo.validBaseRef && repos.length <= 1, repos, diffHunks });
  return { ...evaluated, baseRef };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, base?: string, files?: string | string[], repos?: string[], repo?: string | string[], dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runImpactCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  if (!options.target) {
    const msg = lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    if (!asJson) console.error(msg);
    return emitCommandResult(buildCommandResult({ tool: 'impact', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }), { asJson, compatSpreadData: false });
  }
  const explicitFiles = options.files ? String(options.files).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const impact = await computeImpact(options.target, { qaDir: options.qaDir, base: options.base, files: explicitFiles, repos: options.repos, repo: options.repo });

  if (!asJson) {
    console.log(`\n=== ${lang === 'zh' ? 'Diff-Impact v3 受影响测试分析 (全局守卫 + 符号图谱)' : 'Diff-Impact v3 Test Selection (Infra Guard + Symbol Graph)'} ===`);
    console.log(`Mode: ${impact.mode.toUpperCase()}\nReason: ${impact.reason}`);
    if (impact.graphEngine) console.log(`Graph Engine: ${impact.graphEngine.provider} (mode=${impact.graphEngine.mode}, narrowed=${impact.graphEngine.usedForNarrowing})`);
    if (impact.changedFiles.length > 0) console.log(`Changed Files (${impact.changedFiles.length}): ${impact.changedFiles.join(', ')}`);
    if (impact.why?.length > 0 && impact.specs.length > 0) {
      console.log(`Selected Specs (${impact.specs.length}):`);
      for (const item of impact.why) console.log(`  - ${item.spec}  <- [${item.via}]`);
    }
    console.log(`\nNote: ${lang === 'zh' ? 'impact 仅用于本地与 PR 快速反馈；合入主干、Nightly 与正式发版门禁必须执行全量套件。' : 'Impact mode is for fast local/PR feedback only; merge, nightly, and release gates must run the full suite.'}\n`);
  }
  return emitCommandResult(
    buildCommandResult({ tool: 'impact', outcome: 'pass', ok: true, exitCode: 0, summary: `Impact mode=${impact.mode} (${impact.specs.length} targeted spec(s), ${impact.changedFiles.length} changed file(s))`, data: impact }),
    { asJson }
  );
}
