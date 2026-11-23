// @ts-check
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactEnvEntries } from './proc.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './version.mjs';
import { computeWorkspaceInputHash, sha256Hex } from '../templates/playwright-qa/support/gate-kernel.mjs';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a lexicographically sortable 26-char Crockford Base32 ULID (`01...`).
 * @param {number} [nowMs]
 */
export function generateRunId(nowMs = Date.now()) {
  let time = Math.floor(nowMs);
  let timeChars = '';
  for (let i = 0; i < 10; i += 1) {
    timeChars = CROCKFORD_BASE32[time % 32] + timeChars;
    time = Math.floor(time / 32);
  }
  const randBytes = crypto.randomBytes(16);
  let randChars = '';
  for (let i = 0; i < 16; i += 1) {
    randChars += CROCKFORD_BASE32[randBytes[i] & 31];
  }
  return `${timeChars}${randChars}`;
}

export function resolveGitHeadSha(repoDir) {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {
    // non-git workspace
  }
  return 'nogit';
}

function summarizeResultsForLedger(resultsObj) {
  /** @type {Array<{ testId: string, file: string, line: number, title: string, projectName: string, status: string, retryPassed: boolean, durationMs: number, errorSnippet: string | null }>} */
  const tests = [];
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;

  const walkSuite = (suite, parents = [], fileHint = '') => {
    const nextParents = suite.title ? [...parents, suite.title] : parents;
    const curFile = String(suite.file || fileHint || '').replace(/\\/g, '/');
    for (const spec of suite.specs || []) {
      const fullTitle = [...nextParents, spec.title].filter(Boolean).join(' > ');
      const file = String(spec.file || curFile).replace(/\\/g, '/');
      for (const t of spec.tests || []) {
        const results = Array.isArray(t.results) ? t.results : [];
        const durationMs = results.reduce((sum, r) => sum + Number(r.duration || 0), 0);
        const retryPassed = t.status === 'expected' && results.length > 1;
        const effectiveStatus = retryPassed ? 'flaky' : String(t.status || 'unknown');
        if (effectiveStatus === 'expected') passed += 1;
        else if (effectiveStatus === 'unexpected') failed += 1;
        else if (effectiveStatus === 'flaky') flaky += 1;
        else if (effectiveStatus === 'skipped') skipped += 1;

        const lastErr = results[results.length - 1]?.error?.message || null;
        tests.push({
          testId: `${file}::${fullTitle}`,
          file,
          line: Number(spec.line || 0),
          title: fullTitle,
          projectName: String(t.projectName || ''),
          status: effectiveStatus,
          retryPassed,
          durationMs,
          errorSnippet: lastErr ? String(lastErr).split('\n')[0].slice(0, 240) : null,
        });
      }
    }
    for (const child of suite.suites || []) walkSuite(child, nextParents, curFile);
  };

  for (const s of resultsObj?.suites || []) walkSuite(s);
  return {
    counts: {
      total: tests.length,
      executed: passed + failed + flaky,
      passed,
      failed,
      flaky,
      skipped,
    },
    tests,
  };
}

/**
 * Starts a Run Ledger record before Playwright executes.
 * @param {string} qaDir
 * @param {{ suite: string, command: string, env?: Record<string, any>, repoDir?: string }} meta
 */
export function beginRunLedger(qaDir, meta) {
  const repoDir = meta.repoDir || path.dirname(qaDir);
  const runId = generateRunId();
  const startedAt = new Date().toISOString();
  const gitSha = resolveGitHeadSha(repoDir);
  const worktreeHash = computeWorkspaceInputHash(qaDir, repoDir);

  const runDir = path.join(qaDir, '.aitest', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const pickedEnv = {};
  for (const k of ['TEST_ENV', 'TEST_BASE_URL', 'TEST_ALLOWED_HOSTS', 'TEST_ALLOW_MUTATION', 'TEST_EGRESS_MODE']) {
    if (meta.env && meta.env[k] !== undefined) pickedEnv[k] = meta.env[k];
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.ledgerManifest,
    runId,
    toolVersion: WORKBENCH_VERSION,
    repoDir: path.resolve(repoDir),
    gitSha,
    worktreeHash,
    suite: meta.suite,
    command: meta.command,
    envFingerprint: redactEnvEntries(pickedEnv),
    startedAt,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    resultsSha256: null,
    counts: null,
  };

  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { runId, runDir, manifest };
}

/**
 * Finalizes a Run Ledger record after Playwright completes, binding `reports/results.json` SHA-256 and workspace hash.
 * @param {string} qaDir
 * @param {string} runId
 * @param {{ exitCode: number, resultsPath?: string }} outcome
 */
export function finalizeRunLedger(qaDir, runId, outcome) {
  const runsRoot = path.join(qaDir, '.aitest', 'runs');
  const runDir = path.join(runsRoot, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(manifest.startedAt));
  const resultsPath = outcome.resultsPath || path.join(qaDir, 'reports', 'results.json');

  // Re-compute worktreeHash at completion using the same repoDir recorded at begin
  manifest.worktreeHash = computeWorkspaceInputHash(qaDir, manifest.repoDir || path.dirname(qaDir));
  manifest.finishedAt = finishedAt;
  manifest.durationMs = durationMs;
  manifest.exitCode = outcome.exitCode;

  /** @type {ReturnType<typeof summarizeResultsForLedger> | null} */
  let summary = null;
  if (fs.existsSync(resultsPath)) {
    const rawText = fs.readFileSync(resultsPath, 'utf8');
    manifest.resultsSha256 = `sha256:${sha256Hex(rawText)}`;
    try {
      const parsed = JSON.parse(rawText);
      summary = summarizeResultsForLedger(parsed);
      manifest.counts = summary.counts;
      fs.writeFileSync(path.join(runDir, 'tests-summary.json'), JSON.stringify(summary.tests, null, 2) + '\n', 'utf8');
    } catch {
      // invalid results json will be caught by audit
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(runsRoot, 'latest.json'),
    JSON.stringify(
      {
        runId,
        suite: manifest.suite,
        gitSha: manifest.gitSha,
        worktreeHash: manifest.worktreeHash,
        resultsSha256: manifest.resultsSha256,
        finishedAt,
        exitCode: outcome.exitCode,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const indexRow = {
    runId,
    startedAt: manifest.startedAt,
    finishedAt,
    durationMs,
    suite: manifest.suite,
    gitSha: manifest.gitSha,
    exitCode: outcome.exitCode,
    counts: manifest.counts,
    failedTests: (summary?.tests || [])
      .filter((t) => t.status === 'unexpected' || t.status === 'flaky')
      .map((t) => ({ testId: t.testId, file: t.file, line: t.line, status: t.status })),
  };
  fs.appendFileSync(path.join(runsRoot, 'index.jsonl'), JSON.stringify(indexRow) + '\n', 'utf8');

  return { manifest, tests: summary?.tests || [] };
}

/**
 * Reads recent Run Ledger index entries (oldest to newest within `limit`).
 * @param {string} qaDir
 * @param {number} [limit]
 */
export function readLedgerHistory(qaDir, limit = 30) {
  const indexPath = path.join(qaDir, '.aitest', 'runs', 'index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  const lines = fs
    .readFileSync(indexPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-limit);
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Reads per-test execution history across the last `windowSize` runs.
 * @param {string} qaDir
 * @param {number} [windowSize]
 */
export function readPerTestLedgerRuns(qaDir, windowSize = 20) {
  const index = readLedgerHistory(qaDir, windowSize);
  const runsRoot = path.join(qaDir, '.aitest', 'runs');
  /** @type {Array<{ runId: string, finishedAt: string, tests: Array<any> }>} */
  const detailed = [];
  for (const row of index) {
    const summaryPath = path.join(runsRoot, row.runId, 'tests-summary.json');
    if (!fs.existsSync(summaryPath)) continue;
    try {
      const tests = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      detailed.push({ runId: row.runId, finishedAt: row.finishedAt, tests });
    } catch {
      // ignore missing summary
    }
  }
  return detailed;
}
