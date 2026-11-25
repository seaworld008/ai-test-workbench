// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { computeFlakyStats } from './core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import { readPerTestLedgerRuns } from './ledger.mjs';
import { openTrustContext, signPayloadT1 } from './kernel/gate-kernel.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';

/**
 * Computes historical flaky & failure rates per test from Run Ledger (`R1-2`).
 * @param {string} qaDir
 * @param {{ windowSize?: number, flakyThreshold?: number, minRuns?: number, releasePassStreak?: number }} [options]
 */
export function computeFlakyReport(qaDir, options = {}) {
  const windowSize = options.windowSize ?? 20;
  const flakyThreshold = options.flakyThreshold ?? 0.2;
  const minRuns = options.minRuns ?? 3;
  const releasePassStreak = options.releasePassStreak ?? 5;

  const runs = readPerTestLedgerRuns(qaDir, windowSize);
  /** @type {Map<string, { testId: string, file: string, title: string, observations: Array<{ status?: string, retryPassed?: boolean }>, durations: number[] }>} */
  const byTest = new Map();

  for (const run of runs) {
    for (const t of run.tests || []) {
      if (t.status === 'skipped') continue;
      const normTestId = String(t.testId || '').replace(/\\/g, '/');
      let rec = byTest.get(normTestId);
      if (!rec) {
        rec = {
          testId: normTestId,
          file: String(t.file || '').replace(/\\/g, '/'),
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
