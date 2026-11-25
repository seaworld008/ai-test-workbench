// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { readLedgerHistory } from './ledger.mjs';
import {
  GLOBAL_INFRA_PATTERNS,
  MAX_GRAPH_FILES,
  buildReqIdToSpecMap,
  buildReverseImportGraph,
  collectGitChangedFiles,
  evaluateImpactRecall,
  extractReqIdsFromFile,
  findTransitiveDependents,
  isOverbroadCatchAllGlob,
  listAllSpecFiles,
  loadAndValidateImpactRules,
  specMatchesStemExactSegment,
} from './impact/graph.mjs';

export { buildReverseImportGraph, evaluateImpactRecall, findTransitiveDependents };

/**
 * @typedef {{
 *   mode: 'full' | 'targeted' | 'only-changed',
 *   reason: string,
 *   specs: string[],
 *   totalSpecsCount?: number,
 *   reductionRatio?: number,
 *   why: Array<{ spec: string, via: string }>,
 *   recallEstimate: number | null,
 *   useOnlyChanged: boolean,
 *   changedFiles: string[],
 *   baseRef?: string,
 * }} ImpactResult
 */

/**
 * Hardened Impact v2 selector (`I-01..I-04`):
 * @param {string[]} changedFiles
 * @param {string} qaDir
 * @param {string} repoDir
 * @param {{ canUseOnlyChanged?: boolean }} [options]
 * @returns {ImpactResult}
 */
export function evaluateImpactForFiles(changedFiles, qaDir, repoDir, options = {}) {
  const normalized = [
    ...new Set(
      (changedFiles || [])
        .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean)
    ),
  ];

  if (normalized.length === 0) {
    return {
      mode: 'full',
      reason: 'No changed files detected or diff empty — falling back to full suite for safety.',
      specs: [],
      why: [],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: [],
    };
  }

  for (const file of normalized) {
    if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(file))) {
      return {
        mode: 'full',
        reason: `Shared/infrastructure or policy file changed ("${file}") — running full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `infra-guard: ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  const qaRelPrefix = path.relative(repoDir, qaDir).replace(/\\/g, '/');
  const allSpecs = listAllSpecFiles(path.join(qaDir, 'tests'), qaDir);
  if (allSpecs.length === 0) {
    return {
      mode: 'full',
      reason: 'No spec files found in QA directory — falling back to full suite.',
      specs: [],
      why: [],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  const loadedManual = loadAndValidateImpactRules(path.join(qaDir, 'impact-map.json'));
  if (!loadedManual.ok) {
    return {
      mode: 'full',
      reason: loadedManual.errorReason || 'Invalid impact-map.json — falling back to full suite.',
      specs: [],
      why: loadedManual.via ? [{ spec: '*', via: loadedManual.via }] : [],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }
  const autoRulesPath = path.join(qaDir, 'knowledge', 'impact-map.auto.json');
  const loadedAuto = fs.existsSync(autoRulesPath)
    ? loadAndValidateImpactRules(autoRulesPath)
    : { ok: true, rules: [], errorReason: null };
  const compiledRules = [
    ...loadedManual.rules,
    ...(loadedAuto.ok ? loadedAuto.rules : []),
  ];
  const reqToSpecs = buildReqIdToSpecMap(qaDir, repoDir, allSpecs);

  const reverseGraph = buildReverseImportGraph(repoDir, { includeQa: false });
  if (reverseGraph.truncated) {
    return {
      mode: 'full',
      reason: `Import graph exceeded ${MAX_GRAPH_FILES}-file scan budget (truncated) — falling back to full suite for recall safety.`,
      specs: [],
      why: [{ spec: '*', via: `graph-truncated(${MAX_GRAPH_FILES})` }],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  /** @type {Map<string, string[]>} */
  const whyBySpec = new Map();
  const addSpecReason = (/** @type {string} */ specRel, /** @type {string} */ reasonStr) => {
    const arr = whyBySpec.get(specRel) || [];
    if (!arr.includes(reasonStr)) arr.push(reasonStr);
    whyBySpec.set(specRel, arr);
  };

  let allInsideQa = true;
  /** @type {string[]} */
  let qaNonSpecFiles = [];

  const matchCandidateFileToSpecs = (/** @type {string} */ candidateFile, /** @type {string | null} */ chainPrefix = null) => {
    let matchedAny = false;
    for (const rule of compiledRules) {
      if (rule.patterns.some((re) => re.test(candidateFile))) {
        if (rule.fullSuite) return { forceFull: true, matchedAny: true };
        for (const sp of rule.specs) {
          if (allSpecs.includes(sp)) {
            addSpecReason(
              sp,
              chainPrefix
                ? `import-graph: ${chainPrefix} -> rule(${rule.rawMatch})`
                : `impact-rule: ${candidateFile} (${rule.rawMatch})`
            );
            matchedAny = true;
          }
        }
      }
    }

    if (!matchedAny) {
      const stem = path
        .basename(candidateFile)
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/\.(controller|service|view|page|component|route|routes)$/i, '')
        .toLowerCase();
      if (stem.length >= 3 && !['index', 'main', 'app', 'utils', 'common', 'base', 'config'].includes(stem)) {
        for (const sp of allSpecs) {
          if (specMatchesStemExactSegment(sp, stem)) {
            addSpecReason(sp, chainPrefix ? `import-graph: ${chainPrefix} -> stem(${stem})` : `stem-match: ${candidateFile}`);
            matchedAny = true;
          }
        }
      }
    }

    return { forceFull: false, matchedAny };
  };

  for (const file of normalized) {
    if (/\.(md|txt)$/i.test(file) && !file.includes('specs/')) {
      continue;
    }

    const isInsideQa = qaRelPrefix ? file === qaRelPrefix || file.startsWith(`${qaRelPrefix}/`) : file.startsWith('tests/');
    if (isInsideQa) {
      const relInsideQa = qaRelPrefix ? file.slice(qaRelPrefix.length + 1) : file;
      if (/^tests\/.*\.(?:spec|test)\.[jt]s$/.test(relInsideQa) && allSpecs.includes(relInsideQa)) {
        addSpecReason(relInsideQa, `direct-spec-edit: ${relInsideQa}`);
        continue;
      }
      if (/^specs\/.*\.md$/i.test(relInsideQa)) {
        const linkedReqs = extractReqIdsFromFile(path.join(qaDir, relInsideQa));
        let mappedByReq = false;
        for (const reqId of linkedReqs) {
          for (const sp of reqToSpecs.get(reqId) || []) {
            addSpecReason(sp, `req-spec-link: ${relInsideQa} (${reqId})`);
            mappedByReq = true;
          }
        }
        if (mappedByReq) continue;
      }
      qaNonSpecFiles.push(relInsideQa);
      continue;
    }

    const absChanged = path.join(repoDir, file);
    for (const reqId of extractReqIdsFromFile(absChanged)) {
      for (const sp of reqToSpecs.get(reqId) || []) {
        addSpecReason(sp, `req-code-link: ${file} (${reqId})`);
      }
    }

    allInsideQa = false;

    const direct = matchCandidateFileToSpecs(file, null);
    if (direct.forceFull) {
      return {
        mode: 'full',
        reason: `Impact rule for "${file}" requires full suite.`,
        specs: [],
        why: [{ spec: '*', via: `fullSuite-rule: ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    const dependents = findTransitiveDependents(file, reverseGraph);
    if (dependents.length >= 8) {
      return {
        mode: 'full',
        reason: `High-fan-in module "${file}" is imported by ${dependents.length} files — running full suite.`,
        specs: [],
        why: [{ spec: '*', via: `high-fan-in(${dependents.length}): ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    let transitiveMatched = false;
    for (const dep of dependents) {
      if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(dep.file))) {
        return {
          mode: 'full',
          reason: `Changed file "${file}" is imported by shared infrastructure "${dep.file}" — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `import-graph-infra: ${dep.chain.join(' -> ')}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      const depMatch = matchCandidateFileToSpecs(dep.file, dep.chain.join(' -> '));
      if (depMatch.forceFull) {
        return {
          mode: 'full',
          reason: `Transitive dependent "${dep.file}" of "${file}" requires full suite.`,
          specs: [],
          why: [{ spec: '*', via: `import-graph: ${dep.chain.join(' -> ')}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      if (depMatch.matchedAny) {
        transitiveMatched = true;
      } else {
        // Every transitive dependent MUST map cleanly; any unmapped dependent forces full suite (`I-03`)!
        return {
          mode: 'full',
          reason: `Transitive dependent "${dep.file}" of "${file}" is unmapped — falling back to full suite to prevent missed regressions.`,
          specs: [],
          why: [{ spec: '*', via: `unmapped-transitive: ${dep.chain.join(' -> ')}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
    }

    if (!direct.matchedAny && !transitiveMatched) {
      return {
        mode: 'full',
        reason: `Unmapped source file "${file}" has unknown blast radius — falling back to full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `unmapped-fallback: ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  // Handle Page Object / helper edits inside `qa/` (`I-02`) — NEVER drop their dependent specs!
  if (qaNonSpecFiles.length > 0) {
    if (allInsideQa && whyBySpec.size === 0 && options.canUseOnlyChanged) {
      return {
        mode: 'only-changed',
        reason: 'Only internal QA helper files changed — delegating to Playwright --only-changed dependency graph.',
        specs: [],
        why: [{ spec: '--only-changed', via: 'playwright-ts-dependency-graph' }],
        recallEstimate: null,
        useOnlyChanged: true,
        changedFiles: normalized,
      };
    }

    // Trace reverse imports inside `qaDir` for modified Page Objects / helpers!
    const qaGraph = buildReverseImportGraph(qaDir, { includeQa: true });
    for (const qaRel of qaNonSpecFiles) {
      const qaDeps = findTransitiveDependents(qaRel, qaGraph);
      const depSpecs = qaDeps.filter((d) => allSpecs.includes(d.file));
      if (depSpecs.length === 0) {
        return {
          mode: 'full',
          reason: `QA helper/Page Object changed ("${qaRel}") with unresolved spec dependents — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `qa-helper-fallback: ${qaRel}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      for (const ds of depSpecs) {
        addSpecReason(ds.file, `qa-import-graph: ${ds.chain.join(' -> ')}`);
      }
    }
  }

  // Boost with recently failing specs from Run Ledger
  const recentRuns = readLedgerHistory(qaDir, 5);
  for (const r of recentRuns) {
    for (const ft of r.failedTests || []) {
      const normFailFile = String(ft.file || '').startsWith('tests/') ? ft.file : `tests/${ft.file}`;
      if (allSpecs.includes(normFailFile) && whyBySpec.size > 0) {
        addSpecReason(normFailFile, `ledger-recent-failure: runId=${r.runId}`);
      }
    }
  }

  if (whyBySpec.size === 0) {
    return {
      mode: 'full',
      reason: 'Zero specific specs resolved from diff — falling back to full regression suite.',
      specs: [],
      why: [],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  const sortedSpecs = [...whyBySpec.keys()].sort();
  const whyList = sortedSpecs.map((sp) => ({
    spec: sp,
    via: (whyBySpec.get(sp) || []).join('; '),
  }));

  return {
    mode: 'targeted',
    reason: `Mapped ${normalized.length} changed file(s) to ${sortedSpecs.length} targeted spec(s) (+ smoke).`,
    specs: sortedSpecs,
    totalSpecsCount: allSpecs.length,
    reductionRatio: Number((sortedSpecs.length / allSpecs.length).toFixed(4)),
    why: whyList,
    recallEstimate: null,
    useOnlyChanged: false,
    changedFiles: normalized,
  };
}

export { collectGitChangedFiles };

/**
 * @param {string} targetDir
 * @param {{ qaDir?: string, base?: string, files?: string[] }} [options]
 * @returns {Promise<ImpactResult>}
 */
export async function computeImpact(targetDir, options = {}) {
  const repoDir = path.resolve(targetDir);
  const qaDir = resolveQaDirectory(repoDir, options.qaDir);
  if (!qaDir) {
    throw new Error(`QA directory not found under ${repoDir}`);
  }

  const baseRef = options.base || 'HEAD~1';
  if (Array.isArray(options.files) && options.files.length > 0) {
    return evaluateImpactForFiles(options.files, qaDir, repoDir, { canUseOnlyChanged: false });
  }

  const gitInfo = await collectGitChangedFiles(repoDir, baseRef);
  if (!gitInfo.ok) {
    return {
      mode: 'full',
      reason: `${gitInfo.reason} Falling back to full regression suite.`,
      specs: [],
      why: [],
      recallEstimate: null,
      useOnlyChanged: false,
      baseRef,
      changedFiles: [],
    };
  }

  const evaluated = evaluateImpactForFiles(gitInfo.files, qaDir, repoDir, {
    canUseOnlyChanged: gitInfo.validBaseRef,
  });
  return { ...evaluated, baseRef };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, base?: string, files?: string | string[], dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runImpactCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  if (!options.target) {
    const msg = lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'impact', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  }

  const explicitFiles = options.files
    ? String(options.files)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const impact = await computeImpact(options.target, {
    qaDir: options.qaDir,
    base: options.base,
    files: explicitFiles,
  });

  if (!options.json) {
    console.log(`\n=== ${lang === 'zh' ? 'Diff-Impact v2 受影响测试分析 (含依赖图)' : 'Diff-Impact v2 Test Selection (Import Graph)'} ===`);
    console.log(`Mode: ${impact.mode.toUpperCase()}`);
    console.log(`Reason: ${impact.reason}`);
    if (impact.changedFiles.length > 0) {
      console.log(`Changed Files (${impact.changedFiles.length}): ${impact.changedFiles.join(', ')}`);
    }
    if (impact.why && impact.why.length > 0 && impact.specs.length > 0) {
      console.log(`Selected Specs (${impact.specs.length}):`);
      for (const item of impact.why) console.log(`  - ${item.spec}  <- [${item.via}]`);
    }
    console.log(
      `\nNote: ${
        lang === 'zh'
          ? 'impact 仅用于本地与 PR 快速反馈；合入主干、Nightly 与正式发版门禁必须执行全量套件。'
          : 'Impact mode is for fast local/PR feedback only; merge, nightly, and release gates must run the full suite.'
      }\n`
    );
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'impact',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `Impact mode=${impact.mode} (${impact.specs.length} targeted spec(s), ${impact.changedFiles.length} changed file(s))`,
      data: impact,
    }),
    { asJson: Boolean(options.json) }
  );
}
