// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../kernel/gate-kernel.mjs';
import { readLedgerHistory } from '../ledger.mjs';

/**
 * @typedef {'new-regression' | 'persistent-failure' | 'intermittent-flaky' | 'first-observed'} RegressionHistoryKind
 */

/** @param {string} raw @returns {string} */
function normalizeTestId(raw) {
  return String(raw || '').replace(/\\/g, '/');
}

/**
 * Identifies the Run Ledger `runId` corresponding to the current `results.json` file (if already
 * finalized into `.aitest/runs/`) so historical regression analysis excludes the current run itself.
 * @param {string} qaDir
 * @param {string} rawResultsText
 * @param {Record<string, any>} resultsJson
 * @returns {string | null}
 */
function detectCurrentRunId(qaDir, rawResultsText, resultsJson) {
  const embedded = resultsJson?.config?.metadata?.runId;
  if (typeof embedded === 'string' && embedded.trim()) return embedded.trim();

  const latestPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  if (!fs.existsSync(latestPath)) return null;
  try {
    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    if (latest && typeof latest.runId === 'string' && latest.resultsSha256) {
      const actualSha = `sha256:${sha256Hex(rawResultsText)}`;
      if (latest.resultsSha256 === actualSha) return latest.runId;
    }
  } catch {
    // ignore malformed latest.json
  }
  return null;
}

/**
 * Classifies a failure's historical trajectory given ordered prior run statuses (oldest -> newest).
 * @param {ReadonlyArray<'expected' | 'unexpected' | 'flaky'>} priorStatuses
 * @param {string} [currentStatus]
 * @returns {RegressionHistoryKind}
 */
export function classifyFailureRegressionHistory(priorStatuses, currentStatus = 'unexpected') {
  if (!Array.isArray(priorStatuses) || priorStatuses.length === 0) {
    return 'first-observed';
  }
  if (currentStatus === 'flaky' || priorStatuses.includes('flaky')) {
    return 'intermittent-flaky';
  }

  const last = priorStatuses[priorStatuses.length - 1];
  const hasFailure = priorStatuses.includes('unexpected');
  if (last === 'expected') {
    // Cleanly passing previously (zero prior failures) -> fresh regression; otherwise pass/fail oscillation
    return hasFailure ? 'intermittent-flaky' : 'new-regression';
  }

  // Last prior run was already failing (`unexpected`): distinguish oscillating flaky vs persistent failure
  let transitions = 0;
  for (let i = 1; i < priorStatuses.length; i += 1) {
    if (priorStatuses[i] !== priorStatuses[i - 1]) transitions += 1;
  }
  if (transitions >= 2) {
    return 'intermittent-flaky';
  }
  return 'persistent-failure';
}

/**
 * Loads recent Run Ledger history (`.aitest/runs/index.jsonl` + optional per-run `tests-summary.json`)
 * and returns a lookup function classifying each failing `testId` into a `RegressionHistoryKind`.
 * @param {string} qaDir
 * @param {string} rawResultsText
 * @param {Record<string, any>} resultsJson
 * @param {number} [windowSize]
 * @returns {(testId: string, currentStatus?: string) => RegressionHistoryKind}
 */
export function createRegressionHistoryClassifier(qaDir, rawResultsText, resultsJson, windowSize = 20) {
  const indexRows = readLedgerHistory(qaDir, windowSize + 1);
  if (indexRows.length === 0) {
    return () => 'first-observed';
  }

  const currentRunId = detectCurrentRunId(qaDir, rawResultsText, resultsJson);
  const priorRows = indexRows.filter((r) => r && r.runId && r.runId !== currentRunId).slice(-windowSize);
  if (priorRows.length === 0) {
    return () => 'first-observed';
  }

  const runsRoot = path.join(qaDir, '.aitest', 'runs');
  /** @type {Array<{ runId: string, exitCode: number | null, hasExecuted: boolean, failedMap: Map<string, 'unexpected' | 'flaky'>, summaryMap: Map<string, 'expected' | 'unexpected' | 'flaky'> | null }>} */
  const parsedRuns = priorRows.map((row) => {
    /** @type {Map<string, 'unexpected' | 'flaky'>} */
    const failedMap = new Map();
    for (const ft of row.failedTests || []) {
      const id = normalizeTestId(ft.testId);
      if (!id) continue;
      failedMap.set(id, ft.status === 'flaky' ? 'flaky' : 'unexpected');
    }

    /** @type {Map<string, 'expected' | 'unexpected' | 'flaky'> | null} */
    let summaryMap = null;
    const summaryPath = path.join(runsRoot, String(row.runId), 'tests-summary.json');
    if (fs.existsSync(summaryPath)) {
      try {
        const tests = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        if (Array.isArray(tests)) {
          summaryMap = new Map();
          for (const t of tests) {
            if (!t || t.status === 'skipped') continue;
            const id = normalizeTestId(t.testId);
            if (!id) continue;
            if (t.status === 'expected' && !t.retryPassed) summaryMap.set(id, 'expected');
            else if (t.status === 'flaky' || t.retryPassed) summaryMap.set(id, 'flaky');
            else if (t.status === 'unexpected') summaryMap.set(id, 'unexpected');
          }
        }
      } catch {
        summaryMap = null;
      }
    }

    const executed = Number(row.counts?.executed ?? row.counts?.passed ?? 0);
    return {
      runId: String(row.runId),
      exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
      hasExecuted: executed > 0,
      failedMap,
      summaryMap,
    };
  });

  return (testId, currentStatus = 'unexpected') => {
    const normId = normalizeTestId(testId);
    /** @type {Array<'expected' | 'unexpected' | 'flaky'>} */
    const observations = [];
    for (const run of parsedRuns) {
      if (run.summaryMap) {
        const st = run.summaryMap.get(normId);
        if (st) observations.push(st);
      } else if (run.failedMap.has(normId)) {
        observations.push(/** @type {'unexpected' | 'flaky'} */ (run.failedMap.get(normId)));
      } else if (run.exitCode === 0 && run.hasExecuted) {
        observations.push('expected');
      }
    }
    return classifyFailureRegressionHistory(observations, currentStatus);
  };
}
