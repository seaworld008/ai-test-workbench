#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSpecSourcesAst, resolveTypeScriptCompiler } from '../src/kernel/gate/ast-analyzer.mjs';
import { GATE_KERNEL_VERSION } from '../src/kernel/gate/engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_QA_DIR = path.join(REPO_ROOT, 'templates', 'playwright-qa');
const DEFAULT_CORPUS_PATH = path.join(REPO_ROOT, 'bench', 'real-world', 'corpus.json');
const DEFAULT_ADJUDICATIONS_PATH = path.join(REPO_ROOT, 'bench', 'real-world', 'adjudications.json');
const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, 'bench', 'real-world', 'results');
const CACHE_DIR = path.join(REPO_ROOT, 'bench', 'real-world', '.cache');

const Z_95 = 1.959963984540054;

/**
 * Computes exact Wilson score 95% confidence interval for binomial proportion k / n.
 * @param {number} k
 * @param {number} n
 */
export function wilson95(k, n) {
  if (!n || n <= 0) {
    return { k: 0, n: 0, rate: 0, lower: 0, upper: 0, percent: '0.0%', ci95Percent: '[0.0%, 0.0%]' };
  }
  const p = k / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    k,
    n,
    rate: Number(p.toFixed(6)),
    lower: Number(lower.toFixed(6)),
    upper: Number(upper.toFixed(6)),
    percent: `${(p * 100).toFixed(1)}%`,
    ci95Percent: `[${(lower * 100).toFixed(1)}%, ${(upper * 100).toFixed(1)}%]`,
  };
}

function parseCliArgs(argv) {
  const opts = {
    smoke: false,
    limit: null,
    corpusPath: DEFAULT_CORPUS_PATH,
    adjudicationsPath: DEFAULT_ADJUDICATIONS_PATH,
    outDir: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') {
      opts.smoke = true;
      if (opts.limit === null) opts.limit = 5;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--limit' && argv[i + 1]) {
      opts.limit = Math.max(1, Number(argv[++i]));
    } else if (a === '--corpus' && argv[i + 1]) {
      opts.corpusPath = path.resolve(argv[++i]);
    } else if (a === '--adjudications' && argv[i + 1]) {
      opts.adjudicationsPath = path.resolve(argv[++i]);
    } else if (a === '--out-dir' && argv[i + 1]) {
      opts.outDir = path.resolve(argv[++i]);
    }
  }
  if (!opts.outDir) {
    opts.outDir = opts.smoke ? path.join(CACHE_DIR, 'smoke-results') : DEFAULT_RESULTS_DIR;
  }
  return opts;
}

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function ensureBareRepoAndCommits(repo, requiredShas) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const repoDir = path.join(CACHE_DIR, `${repo.replace('/', '__')}.git`);
  const remoteUrl = `https://github.com/${repo}.git`;

  if (!fs.existsSync(repoDir)) {
    const initRes = runGit(['init', '--bare', repoDir], CACHE_DIR);
    if (initRes.status !== 0) {
      throw new Error(`git init --bare failed for ${repo}: ${initRes.stderr}`);
    }
    runGit(['remote', 'add', 'origin', remoteUrl], repoDir);
  }

  const missing = [];
  for (const sha of new Set(requiredShas)) {
    const check = runGit(['cat-file', '-e', `${sha}^{commit}`], repoDir);
    if (check.status !== 0) missing.push(sha);
  }

  if (missing.length > 0) {
    // Batch-fetch missing exact commits with blobless shallow fetch (no working tree checkout, no code execution)
    const fetchRes = runGit(['fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', ...missing], repoDir);
    if (fetchRes.status !== 0) {
      throw new Error(`git fetch missing commits failed for ${repo}: ${fetchRes.stderr}`);
    }
  }
  return repoDir;
}

function readGitBlob(repoDir, sha, filePath) {
  const res = runGit(['show', `${sha}:${filePath}`], repoDir);
  if (res.status !== 0) {
    return null;
  }
  return res.stdout;
}

function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function countPattern(source, re) {
  const stripped = stripComments(source);
  const matches = stripped.match(re);
  return matches ? matches.length : 0;
}

function extractRuleCodes(violations) {
  const codes = new Set();
  for (const v of violations) {
    const m = /\[(AITEST-G\d+|STATIC-[A-Z0-9-]+)\]/.exec(String(v));
    if (m) codes.add(m[1]);
    else codes.add('UNKNOWN-RULE');
  }
  return [...codes].sort();
}

function evaluateCommitOffline(repoDir, entry, adjudicationsMap) {
  const key = `${entry.repo}@${entry.sha}`;
  const fileResults = [];
  const allViolations = [];

  for (const testPath of entry.testPaths) {
    const baseSource = readGitBlob(repoDir, entry.parentSha, testPath);
    const headSource = readGitBlob(repoDir, entry.sha, testPath);
    if (baseSource === null || headSource === null) {
      fileResults.push({
        testPath,
        status: 'blocked',
        violations: [`[Offline Bench Blocked] Unable to load ${entry.parentSha}:${testPath} or ${entry.sha}:${testPath}`],
      });
      allViolations.push(`[STATIC-MISSING-BLOB] Unable to load blob for ${testPath}`);
      continue;
    }

    // Layer 3: Full-file TypeScript AST Semantic Diff Guard (AITEST-G101..G115)
    const astCmp = compareSpecSourcesAst(testPath, baseSource, headSource, {
      qaDir: TEMPLATE_QA_DIR,
    });
    const violations = [...astCmp.violations];

    // Differential Layer 2 static anti-patterns (newly introduced only, never blaming legacy lines)
    const baseWait = countPattern(baseSource, /\bwaitForTimeout\s*\(/g);
    const headWait = countPattern(headSource, /\bwaitForTimeout\s*\(/g);
    if (headWait > baseWait) {
      violations.push(
        `[Static Check][STATIC-WAIT-FOR-TIMEOUT] ${testPath}: newly introduced waitForTimeout() (${baseWait} -> ${headWait}).`
      );
    }

    const baseNewCtx = countPattern(baseSource, /\brequest\.newContext\s*\(/g);
    const headNewCtx = countPattern(headSource, /\brequest\.newContext\s*\(/g);
    if (headNewCtx > baseNewCtx) {
      violations.push(
        `[Static Check][STATIC-RAW-REQUEST-CONTEXT] ${testPath}: newly introduced request.newContext() (${baseNewCtx} -> ${headNewCtx}).`
      );
    }

    const uniqueViolations = [...new Set(violations)];
    fileResults.push({
      testPath,
      status: uniqueViolations.length === 0 ? 'pass' : 'fail',
      ruleCodes: extractRuleCodes(uniqueViolations),
      violations: uniqueViolations,
    });
    allViolations.push(...uniqueViolations);
  }

  const uniqueAll = [...new Set(allViolations)];
  const flagged = uniqueAll.length > 0;
  const ruleCodes = extractRuleCodes(uniqueAll);
  const adjudication = adjudicationsMap.get(key) || null;

  return {
    id: key,
    repo: entry.repo,
    sha: entry.sha,
    parentSha: entry.parentSha,
    license: entry.license,
    testPaths: entry.testPaths,
    commitUrl: `https://github.com/${entry.repo}/commit/${entry.sha}`,
    evaluationMode: 'offline-static-ast-only',
    gateOutcome: flagged ? 'fail' : 'pass',
    flagged,
    ruleCodes,
    violations: uniqueAll,
    files: fileResults,
    adjudication: flagged
      ? adjudication
        ? {
            label: adjudication.label,
            reviewedAt: adjudication.reviewedAt || null,
            rationale: adjudication.rationale || '',
          }
        : {
            label: 'UNREVIEWED',
            reviewedAt: null,
            rationale: 'Flagged by offline gate; awaiting manual diff adjudication.',
          }
      : {
          label: 'PASS',
          reviewedAt: null,
          rationale: 'Gate passed with zero violations.',
        },
  };
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!resolveTypeScriptCompiler(TEMPLATE_QA_DIR)) {
    throw new Error(
      `TypeScript compiler not found under ${path.join(TEMPLATE_QA_DIR, 'node_modules', 'typescript')}. Run "cd templates/playwright-qa && npm ci" before executing bench-real-world.mjs (fail-closed).`
    );
  }
  if (!fs.existsSync(opts.corpusPath)) {
    throw new Error(`Corpus file not found: ${opts.corpusPath}`);
  }
  const corpus = JSON.parse(fs.readFileSync(opts.corpusPath, 'utf8'));
  const allCommits = Array.isArray(corpus.commits) ? corpus.commits : [];
  if (allCommits.length === 0) {
    throw new Error(`Corpus contains 0 commits: ${opts.corpusPath}`);
  }

  const selectedCommits = opts.limit ? allCommits.slice(0, opts.limit) : allCommits;

  /** @type {Map<string, any>} */
  const adjudicationsMap = new Map();
  if (fs.existsSync(opts.adjudicationsPath)) {
    const rawAdj = JSON.parse(fs.readFileSync(opts.adjudicationsPath, 'utf8'));
    const entries = rawAdj.adjudications || rawAdj || {};
    for (const [k, v] of Object.entries(entries)) {
      if (v && typeof v === 'object' && (v.label === 'FP' || v.label === 'TP')) {
        adjudicationsMap.set(k, v);
      }
    }
  }

  // Group required SHAs by repo and ensure isolated bare cache has them
  /** @type {Map<string, string[]>} */
  const shasByRepo = new Map();
  for (const c of selectedCommits) {
    if (!shasByRepo.has(c.repo)) shasByRepo.set(c.repo, []);
    shasByRepo.get(c.repo).push(c.sha, c.parentSha);
  }

  /** @type {Map<string, string>} */
  const repoDirs = new Map();
  for (const [repo, shas] of shasByRepo.entries()) {
    if (!opts.json) console.log(`[bench-real-world] Preparing isolated bare cache for ${repo} (${shas.length / 2} commits)...`);
    repoDirs.set(repo, ensureBareRepoAndCommits(repo, shas));
  }

  const commitsOutDir = path.join(opts.outDir, 'commits');
  fs.rmSync(commitsOutDir, { recursive: true, force: true });
  fs.mkdirSync(commitsOutDir, { recursive: true });

  const results = [];
  const violationsByRule = {};
  const byRepo = {};

  for (let i = 0; i < selectedCommits.length; i++) {
    const entry = selectedCommits[i];
    const repoDir = repoDirs.get(entry.repo);
    const res = evaluateCommitOffline(repoDir, entry, adjudicationsMap);
    results.push(res);

    const idxStr = String(i + 1).padStart(2, '0');
    const shortSha = entry.sha.slice(0, 10);
    const safeRepo = entry.repo.replace('/', '__');
    const outFile = path.join(commitsOutDir, `${idxStr}-${safeRepo}-${shortSha}.json`);
    fs.writeFileSync(outFile, `${JSON.stringify(res, null, 2)}\n`, 'utf8');

    for (const rc of res.ruleCodes) {
      violationsByRule[rc] = (violationsByRule[rc] || 0) + 1;
    }

    if (!byRepo[entry.repo]) {
      byRepo[entry.repo] = {
        license: entry.license,
        total: 0,
        passed: 0,
        flagged: 0,
        fp: 0,
        tp: 0,
        unreviewed: 0,
      };
    }
    byRepo[entry.repo].total += 1;
    if (!res.flagged) {
      byRepo[entry.repo].passed += 1;
    } else {
      byRepo[entry.repo].flagged += 1;
      if (res.adjudication.label === 'FP') byRepo[entry.repo].fp += 1;
      else if (res.adjudication.label === 'TP') byRepo[entry.repo].tp += 1;
      else byRepo[entry.repo].unreviewed += 1;
    }
  }

  const n = results.length;
  const passedCount = results.filter((r) => !r.flagged).length;
  const flaggedCount = results.filter((r) => r.flagged).length;
  const fpCount = results.filter((r) => r.flagged && r.adjudication.label === 'FP').length;
  const tpCount = results.filter((r) => r.flagged && r.adjudication.label === 'TP').length;
  const unreviewedCount = results.filter((r) => r.flagged && r.adjudication.label === 'UNREVIEWED').length;
  const normalCount = n - tpCount;

  const summary = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    gateKernelVersion: GATE_KERNEL_VERSION,
    preregistrationDoc: corpus.preregistrationDoc || 'bench/real-world/PREREGISTRATION.md',
    samplingSeed: corpus.samplingSeed ?? 20261124,
    mode: opts.smoke ? 'smoke' : 'pilot',
    evaluationScope: 'offline-static-ast-only (Layer 3 AST Semantic Diff + Differential Layer 2 Static Checks; zero target code execution; zero target site network access)',
    formalEvaluation200Status: 'pending',
    counts: {
      totalCommits: n,
      passed: passedCount,
      flagged: flaggedCount,
      adjudicatedFP: fpCount,
      adjudicatedTP: tpCount,
      unreviewedFlagged: unreviewedCount,
      normalCommits: normalCount,
    },
    metrics: {
      rawAlertRate: wilson95(flaggedCount, n),
      adjudicatedFprOnNormal: wilson95(fpCount, normalCount),
      adjudicatedFprOnAll: wilson95(fpCount, n),
    },
    violationsByRule,
    byRepository: byRepo,
    flaggedCommits: results
      .filter((r) => r.flagged)
      .map((r) => ({
        id: r.id,
        repo: r.repo,
        sha: r.sha,
        commitUrl: r.commitUrl,
        testPaths: r.testPaths,
        ruleCodes: r.ruleCodes,
        violations: r.violations,
        adjudication: r.adjudication,
      })),
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const summaryPath = path.join(opts.outDir, 'summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n=== Real-World Open-Source Playwright Gate FPR Benchmark ===');
    console.log(`Mode: ${summary.mode} | n = ${n} | Gate Kernel: v${GATE_KERNEL_VERSION} | Seed: ${summary.samplingSeed}`);
    console.log(
      `Passed: ${passedCount}/${n} | Flagged: ${flaggedCount}/${n} (Raw Alert Rate: ${summary.metrics.rawAlertRate.percent}, Wilson 95% CI ${summary.metrics.rawAlertRate.ci95Percent})`
    );
    console.log(
      `Adjudication: FP=${fpCount}, TP=${tpCount}, Unreviewed=${unreviewedCount} | Adjudicated FPR (FP/normal): ${summary.metrics.adjudicatedFprOnNormal.percent} (n_normal=${normalCount}, Wilson 95% CI ${summary.metrics.adjudicatedFprOnNormal.ci95Percent})`
    );
    console.log('Per-Repository Breakdown:');
    for (const [repo, st] of Object.entries(byRepo)) {
      console.log(`  - ${repo} (${st.license}): total=${st.total}, pass=${st.passed}, flagged=${st.flagged} (FP=${st.fp}, TP=${st.tp}, unreviewed=${st.unreviewed})`);
    }
    console.log(`Violations by rule:`, violationsByRule);
    console.log(`Summary written to: ${path.relative(REPO_ROOT, summaryPath)}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error('[bench-real-world] Fatal error:', err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
