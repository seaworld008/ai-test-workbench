// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { computeFlakyStats } from './core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import { getHealsDir, readAndVerifySession } from './heal/store.mjs';
import { readPerTestLedgerRuns } from './ledger.mjs';
import { openTrustContext, signPayloadT1 } from './kernel/gate-kernel.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';

/** @param {string} rawPath */
function normSpecKey(rawPath) {
  return String(rawPath || '').replace(/\\/g, '/').replace(/^tests\//, '');
}

/**
 * Loads verified concluded heal session timestamps (`concludedAt` / `updatedAt`) so pre-conclusion
 * failing ledger runs during A-class healing do not trigger false 7-day flaky quarantine (`WB-P1-02`).
 * @param {string} qaDir
 */
function loadVerifiedHealCutoffs(qaDir) {
  /** @type {Map<string, number>} */
  const byTestId = new Map();
  /** @type {Map<string, number>} */
  const bySpecTitle = new Map();
  /** @type {Map<string, number>} */
  const bySpecFile = new Map();

  const healsDir = getHealsDir(qaDir);
  if (!fs.existsSync(healsDir)) return { byTestId, bySpecTitle, bySpecFile };

  const trustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: false });
  for (const name of fs.readdirSync(healsDir).filter((n) => n.endsWith('.json') && n !== 'ledger.json')) {
    const sid = name.replace(/\.json$/, '');
    const loaded = readAndVerifySession(qaDir, sid, trustCtx);
    if (!loaded.ok) continue;
    const s = loaded.session;
    const outcome = String(s.conclusion?.outcome || (/** @type {any} */ (s)).outcome || '').toLowerCase();
    if (s.state !== 'concluded' || outcome !== 'verified') continue;
    const cutoffRaw = s.conclusion?.concludedAt || s.updatedAt || s.createdAt;
    const cutoffMs = Date.parse(String(cutoffRaw || ''));
    if (!Number.isFinite(cutoffMs)) continue;

    const testIdKey = String(s.testId || '').replace(/\\/g, '/');
    if (testIdKey) {
      byTestId.set(testIdKey, Math.max(byTestId.get(testIdKey) || 0, cutoffMs));
    }
    const specKey = normSpecKey(s.specFile);
    if (specKey && s.title) {
      const stKey = `${specKey}::${s.title}`;
      bySpecTitle.set(stKey, Math.max(bySpecTitle.get(stKey) || 0, cutoffMs));
    }
    if (specKey) {
      bySpecFile.set(specKey, Math.max(bySpecFile.get(specKey) || 0, cutoffMs));
    }
  }
  return { byTestId, bySpecTitle, bySpecFile };
}

/**
 * Resolves a ledger run's timestamp in epoch ms.
 * @param {string} qaDir
 * @param {Record<string, any>} run
 * @returns {number | null}
 */
function resolveRunTimestampMs(qaDir, run) {
  const direct = run.timestamp || run.finishedAt || run.startedAt || run.createdAt;
  if (direct) {
    const parsed = Date.parse(String(direct));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (run.runId) {
    const manifestPath = path.join(qaDir, '.aitest', 'runs', String(run.runId), 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const ts = m.finishedAt || m.startedAt || m.createdAt;
        if (ts) {
          const parsed = Date.parse(String(ts));
          if (Number.isFinite(parsed)) return parsed;
        }
      } catch {
        // ignore unreadable manifest
      }
    }
  }
  return null;
}

/**
 * Computes historical flaky & failure rates per test from Run Ledger (`R1-2`).
 * Excludes pre-conclusion failed ledger runs for tests legitimately healed & verified (`WB-P1-02`).
 * @param {string} qaDir
 * @param {{ windowSize?: number, flakyThreshold?: number, minRuns?: number, releasePassStreak?: number }} [options]
 */
export function computeFlakyReport(qaDir, options = {}) {
  const windowSize = options.windowSize ?? 20;
  const flakyThreshold = options.flakyThreshold ?? 0.2;
  const minRuns = options.minRuns ?? 3;
  const releasePassStreak = options.releasePassStreak ?? 5;

  const runs = readPerTestLedgerRuns(qaDir, windowSize);
  const healCutoffs = loadVerifiedHealCutoffs(qaDir);
  /** @type {Map<string, { testId: string, file: string, title: string, observations: Array<{ status?: string, retryPassed?: boolean }>, durations: number[] }>} */
  const byTest = new Map();

  for (const run of runs) {
    const runTsMs = resolveRunTimestampMs(qaDir, run);
    for (const t of run.tests || []) {
      if (t.status === 'skipped') continue;
      const normTestId = String(t.testId || '').replace(/\\/g, '/');
      const normFile = String(t.file || '').replace(/\\/g, '/');
      const specKey = normSpecKey(normFile);
      const isFailure = t.status === 'unexpected' || t.status === 'flaky' || Boolean(t.retryPassed);
      if (isFailure && runTsMs !== null) {
        const cutoffMs =
          healCutoffs.byTestId.get(normTestId) ??
          (t.title ? healCutoffs.bySpecTitle.get(`${specKey}::${t.title}`) : undefined) ??
          (!t.title ? healCutoffs.bySpecFile.get(specKey) : undefined);
        if (cutoffMs !== undefined && runTsMs < cutoffMs) {
          continue;
        }
      }
      let rec = byTest.get(normTestId);
      if (!rec) {
        rec = {
          testId: normTestId,
          file: normFile,
          title: t.title,
          observations: [],
          durations: [],
        };
        byTest.set(normTestId, rec);
      }
      rec.observations.push({ status: t.status, retryPassed: t.retryPassed });
      if (typeof t.durationMs === 'number') rec.durations.push(t.durationMs);
    }
  }

  const metrics = [...byTest.values()].map((r) => {
    const stats = computeFlakyStats(r.observations);
    const avgDurationMs =
      r.durations.length > 0 ? Math.round(r.durations.reduce((a, b) => a + b, 0) / r.durations.length) : 0;
    const shouldQuarantine =
      stats.totalRuns >= minRuns &&
      stats.flakyRate >= flakyThreshold &&
      stats.consecutivePasses < releasePassStreak &&
      !/@critical|@smoke/.test(r.title);
    const readyToRelease = stats.consecutivePasses >= releasePassStreak;
    return {
      testId: r.testId,
      file: r.file,
      title: r.title,
      totalRuns: stats.totalRuns,
      passed: stats.passed,
      failed: stats.failed,
      flaky: stats.flaky,
      flakyRate: stats.flakyRate,
      failRate: stats.failRate,
      consecutivePasses: stats.consecutivePasses,
      avgDurationMs,
      shouldQuarantine,
      readyToRelease,
    };
  });

  metrics.sort((a, b) => b.flakyRate - a.flakyRate || b.failRate - a.failRate);

  const qPath = path.join(qaDir, '.aitest', 'quarantine.json');
  /** @type {{ schemaVersion: number, entries: Array<Record<string, any>> }} */
  let quarantine = { schemaVersion: SCHEMA_VERSIONS.quarantine, entries: [] };
  if (fs.existsSync(qPath)) {
    try {
      quarantine = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    } catch {
      // ignore
    }
  }

  return {
    runsAnalyzed: runs.length,
    windowSize,
    flakyCandidates: metrics.filter((m) => m.flakyRate > 0),
    quarantineEntries: quarantine.entries || [],
    allTests: metrics,
  };
}

/**
 * Automatically updates `.aitest/quarantine.json` based on Ledger telemetry (max TTL 7 days, max 5 entries).
 * @param {string} qaDir
 * @param {{ nowMs?: number, maxQuarantined?: number, ttlDays?: number }} [options]
 */
export function syncQuarantineFromLedger(qaDir, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxQuarantined = options.maxQuarantined ?? 5;
  const ttlDays = Math.min(7, options.ttlDays ?? 7);
  const report = computeFlakyReport(qaDir);

  const aitestDir = path.join(qaDir, '.aitest');
  const qPath = path.join(aitestDir, 'quarantine.json');
  /** @type {Map<string, any>} */
  const existingMap = new Map();
  if (fs.existsSync(qPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(qPath, 'utf8'));
      for (const e of parsed.entries || []) {
        existingMap.set(`${e.file}::${e.title}`, e);
      }
    } catch {
      // reset cleanly
    }
  }

  const added = [];
  const released = [];

  for (const m of report.allTests) {
    const key = `${m.file}::${m.title}`;
    if (existingMap.has(key) && m.readyToRelease) {
      existingMap.delete(key);
      released.push(key);
      continue;
    }
    if (!existingMap.has(key) && m.shouldQuarantine && existingMap.size < maxQuarantined) {
      const createdAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      const entry = {
        file: m.file,
        title: m.title,
        flakyRate: m.flakyRate,
        addedAt: createdAt,
        expiresAt,
        reason: `Auto-quarantined by Ledger flaky policy (flakyRate=${m.flakyRate} across ${m.totalRuns} runs)`,
      };
      existingMap.set(key, entry);
      added.push(key);
    }
  }

  const nextEntries = [...existingMap.values()];
  if (nextEntries.length === 0 && added.length === 0 && released.length === 0 && !fs.existsSync(qPath)) {
    return {
      quarantinePath: qPath,
      activeCount: 0,
      added,
      released,
      entries: [],
    };
  }

  const corePayload = {
    schemaVersion: SCHEMA_VERSIONS.quarantine,
    updatedAt: new Date(nowMs).toISOString(),
    maxQuarantined,
    ttlDays,
    entries: nextEntries,
  };
  const repoDir = path.dirname(qaDir);
  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  const sig = signPayloadT1('quarantine.json', corePayload, {
    qaDir,
    repoDir,
    createIfMissing: true,
    trustContext,
  });
  const payload = { ...corePayload, ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}) };
  fs.mkdirSync(aitestDir, { recursive: true });
  fs.writeFileSync(qPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  return {
    quarantinePath: qPath,
    activeCount: payload.entries.length,
    added,
    released,
    entries: payload.entries,
  };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, syncQuarantine?: boolean, dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runFlakyCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {string} msg */
  const failFlaky = (msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'flaky', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failFlaky(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }
  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    return failFlaky(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  let syncResult = null;
  if (options.syncQuarantine) {
    syncResult = syncQuarantineFromLedger(qaDir);
  }
  const report = computeFlakyReport(qaDir);
  const out = { ...report, syncResult };
  const summary = `Runs analyzed=${report.runsAnalyzed}, flakyCandidates=${report.flakyCandidates.length}, quarantined=${report.quarantineEntries.length}`;

  if (!options.json) {
    console.log(
      `\n=== ${lang === 'zh' ? 'Flaky 历史统计与隔离区报告' : 'Historical Flaky Telemetry & Quarantine Report'} ===`
    );
    console.log(`Runs analyzed: ${report.runsAnalyzed} · Flaky candidates: ${report.flakyCandidates.length} · Quarantined: ${report.quarantineEntries.length}`);
    for (const c of report.flakyCandidates.slice(0, 15)) {
      console.log(`  - [flakyRate=${c.flakyRate}] ${c.file} :: ${c.title} (runs=${c.totalRuns}, passStreak=${c.consecutivePasses})`);
    }
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'flaky',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary,
      data: out,
    }),
    { asJson: Boolean(options.json) }
  );
}
