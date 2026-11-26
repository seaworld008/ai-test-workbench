// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { summarizePlaywrightResults } from './core/playwright-results.mjs';
import { redactEnvEntries } from './core/redact.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './core/version.mjs';
import {
  computeWorkspaceInputHash,
  openTrustContext,
  resolveGitHeadSha,
  sha256Hex,
  signPayloadT1,
} from './kernel/gate-kernel.mjs';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export { resolveGitHeadSha };

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

/**
 * @param {Parameters<typeof summarizePlaywrightResults>[0]} resultsObj
 */
function summarizeResultsForLedger(resultsObj) {
  const { counts, tests } = summarizePlaywrightResults(resultsObj);
  return {
    counts,
    tests: tests.map((t) => ({
      testId: t.testId,
      file: t.file,
      line: t.line,
      title: t.title,
      projectName: t.projectName,
      status: t.status,
      retryPassed: t.retryPassed,
      durationMs: t.durationMs,
      attachments: t.attachments || [],
      errorSnippet: t.errorSnippet,
    })),
  };
}

/**
 * Starts a Run Ledger record before Playwright executes (signed with T1 HMAC).
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

  /** @type {Record<string, unknown>} */
  const pickedEnv = {};
  for (const k of ['TEST_ENV', 'TEST_BASE_URL', 'TEST_ALLOWED_HOSTS', 'TEST_ALLOW_MUTATION', 'TEST_EGRESS_MODE']) {
    if (meta.env && meta.env[k] !== undefined) pickedEnv[k] = meta.env[k];
  }

  const coreManifest = {
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

  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  const sig = signPayloadT1('ledger.manifest', coreManifest, { qaDir, repoDir, createIfMissing: true, trustContext });
  const manifest = {
    ...coreManifest,
    ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}),
  };

  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { runId, runDir, manifest };
}

/**
 * Finalizes a Run Ledger record after Playwright completes, binding `reports/results.json` SHA-256,
 * workspace hash, and T1 out-of-workspace HMAC tamper-evidence (`T-03`).
 * @param {string} qaDir
 * @param {string} runId
 * @param {{ exitCode: number, resultsPath?: string }} outcome
 */
export function finalizeRunLedger(qaDir, runId, outcome) {
  const runsRoot = path.join(qaDir, '.aitest', 'runs');
  const runDir = path.join(runsRoot, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(prev.startedAt));
  const resultsPath = outcome.resultsPath || path.join(qaDir, 'reports', 'results.json');
  const repoDir = prev.repoDir || path.dirname(qaDir);

  const coreManifest = {
    ...prev,
    worktreeHash: computeWorkspaceInputHash(qaDir, repoDir),
    finishedAt,
    durationMs,
    exitCode: outcome.exitCode,
  };
  delete coreManifest.mac;
  delete coreManifest.macs;
  delete coreManifest.macKeyId;

  /** @type {ReturnType<typeof summarizeResultsForLedger> | null} */
  let summary = null;
  if (fs.existsSync(resultsPath)) {
    const rawText = fs.readFileSync(resultsPath, 'utf8');
    coreManifest.resultsSha256 = `sha256:${sha256Hex(rawText)}`;
    try {
      const parsed = JSON.parse(rawText);
      summary = summarizeResultsForLedger(parsed);
      coreManifest.counts = summary.counts;
      fs.writeFileSync(path.join(runDir, 'tests-summary.json'), JSON.stringify(summary.tests, null, 2) + '\n', 'utf8');
    } catch {
      // invalid results json will be caught by audit
    }
  }

  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  const sig = signPayloadT1('ledger.manifest', coreManifest, { qaDir, repoDir, createIfMissing: true, trustContext });
  const manifest = {
    ...coreManifest,
    ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}),
  };

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
        ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}),
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

const JSONL_TAIL_CHUNK_BYTES = 65_536;

/**
 * Reads the last `limit` valid JSON object lines from a JSONL file in O(limit) time/memory.
 * Files `<= 64KB` are read directly; larger files are scanned backwards from EOF in 64KB chunks
 * and concatenated as raw Buffers before UTF-8 decoding so multi-byte characters never split.
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {Array<Record<string, any>>}
 */
export function readJsonlTail(filePath, limit = 30) {
  if (!filePath || limit <= 0 || !fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return [];

  let rawText = '';
  if (stat.size <= JSONL_TAIL_CHUNK_BYTES) {
    rawText = fs.readFileSync(filePath, 'utf8');
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      let position = stat.size;
      let newlineCount = 0;
      const targetNewlines = limit + 2;
      /** @type {Buffer[]} */
      const chunks = [];
      while (position > 0 && newlineCount < targetNewlines) {
        const readLen = Math.min(JSONL_TAIL_CHUNK_BYTES, position);
        position -= readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const bytesRead = fs.readSync(fd, buf, 0, readLen, position);
        const slice = bytesRead === readLen ? buf : buf.subarray(0, bytesRead);
        for (let i = 0; i < slice.length; i += 1) {
          if (slice[i] === 0x0a) newlineCount += 1;
        }
        chunks.push(slice);
      }
      let combined = Buffer.concat(chunks.reverse());
      if (position > 0) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline >= 0) {
          combined = combined.subarray(firstNewline + 1);
        }
      }
      rawText = combined.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-limit);
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Reads recent Run Ledger index entries (oldest to newest within `limit`).
 * @param {string} qaDir
 * @param {number} [limit]
 */
export function readLedgerHistory(qaDir, limit = 30) {
  return readJsonlTail(path.join(qaDir, '.aitest', 'runs', 'index.jsonl'), limit);
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
