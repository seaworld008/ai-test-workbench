import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './git-utils.mjs';
import { isCoveredByWaiver, isInitializedQaWorkspace } from './policy.mjs';
import { verifyPayloadT1 } from './trust-hmac.mjs';

/**
 * Layer 1 Runtime Results Audit & Fail-Closed Run Ledger Binding (`T-03`, `G-08`).
 *
 * Security invariants:
 * 1. In any initialized QA workspace, Run Ledger binding is MANDATORY (fail-closed -> `blocked`).
 *    Deleting `.aitest/runs/` no longer turns off verification!
 * 2. Both `manifest.resultsSha256` and `manifest.worktreeHash` MUST be present and match
 *    (omitting fields from manifest JSON is rejected!).
 * 3. Verifies T1 HMAC on `manifest.json` when present (detects hand-forged manifests).
 * 4. `maxSkipped` defaults to `0` (excluding policy-excluded `@mutation` tests and valid waivers).
 */

function collectSpecsFromSuite(suite, parentTitles = [], fileHint = '') {
  const collected = [];
  const nextTitles = suite.title ? [...parentTitles, suite.title] : parentTitles;
  const currentFile = suite.file || fileHint;

  for (const spec of suite.specs || []) {
    const fullTitle = [...nextTitles, spec.title].filter(Boolean).join(' > ');
    const specTags = Array.isArray(spec.tags) ? spec.tags.map((t) => (t.startsWith('@') ? t : `@${t}`)) : [];
    const inlineTags = fullTitle.match(/@[a-zA-Z0-9_-]+/g) || [];
    const allTags = [...new Set([...specTags, ...inlineTags])];

    for (const testEntry of spec.tests || []) {
      collected.push({
        title: fullTitle,
        specTitle: spec.title || '',
        file: spec.file || currentFile || '',
        line: spec.line || 0,
        projectName: testEntry.projectName || '',
        status: testEntry.status || 'unknown',
        tags: allTags,
        annotations: testEntry.annotations || [],
        results: testEntry.results || [],
      });
    }
  }

  for (const child of suite.suites || []) {
    collected.push(...collectSpecsFromSuite(child, nextTitles, currentFile));
  }
  return collected;
}

export function countMutationSpecsInFiles(testsDir) {
  if (!fs.existsSync(testsDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:spec|test)\.[jt]s$/.test(entry.name)) {
        const txt = fs.readFileSync(full, 'utf8');
        const lines = txt.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (/@mutation\b/.test(line) && /\btest(?:\.describe)?\s*\(/.test(line)) {
            found.push({
              file: path.relative(testsDir, full).replace(/\\/g, '/'),
              line: idx + 1,
              label: `${path.relative(testsDir, full).replace(/\\/g, '/')}:${idx + 1} — ${line.trim()}`,
            });
          }
        });
      }
    }
  };
  walk(testsDir);
  return found;
}

function normalizeMutationDedupKey(fileStr, lineNum) {
  const norm = String(fileStr || '')
    .replace(/\\/g, '/')
    .replace(/^tests\//, '');
  return `${norm}:${lineNum || 0}`;
}

/**
 * Layer 1: Audits Playwright JSON results (`reports/results.json`) with deduplicated @mutation counting
 * and strict default `maxSkipped = 0` (`G-08`).
 */
export function auditResultsJson(resultsObj, options = {}) {
  const {
    activeWaivers = [],
    requireE2e = false,
    maxFlaky = 0,
    maxSkipped = 0,
    allowMutation = false,
    excludedMutationHints = [],
    quarantinedTests = [],
  } = options;

  const errors = [];
  const warnings = [];
  const allTests = [];
  for (const suite of resultsObj.suites || []) {
    allTests.push(...collectSpecsFromSuite(suite));
  }

  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  let unwaivedSkipped = 0;
  let quarantinedCount = 0;
  let e2eExecuted = 0;

  const failedList = [];
  const flakyList = [];
  const unwaivedCriticalSkips = [];
  const waivedSkips = [];
  const seenMutationKeys = new Set();
  const policyExcludedTitles = [];

  for (const hint of excludedMutationHints) {
    if (typeof hint === 'string') {
      const m = /^([^:]+):(\d+)/.exec(hint);
      const key = m ? normalizeMutationDedupKey(m[1], Number(m[2])) : hint;
      if (!seenMutationKeys.has(key)) {
        seenMutationKeys.add(key);
        policyExcludedTitles.push(hint);
      }
    } else if (hint && typeof hint === 'object') {
      const key = normalizeMutationDedupKey(hint.file, hint.line);
      if (!seenMutationKeys.has(key)) {
        seenMutationKeys.add(key);
        policyExcludedTitles.push(hint.label || `${hint.file}:${hint.line}`);
      }
    }
  }

  const quarantineSet = new Set(
    (quarantinedTests || []).map((q) => (typeof q === 'string' ? q : `${q.file}::${q.title}`))
  );

  for (const t of allTests) {
    const isMutation = t.tags.includes('@mutation');
    const isCritical = t.tags.includes('@critical') || t.tags.includes('@smoke');
    const isE2e = t.projectName === 'e2e' || String(t.file).replace(/\\/g, '/').includes('e2e/');
    const retryPassed = t.status === 'expected' && Array.isArray(t.results) && t.results.length > 1;
    const isQuarantined =
      quarantineSet.has(t.title) || quarantineSet.has(`${String(t.file).replace(/\\/g, '/')}::${t.title}`);

    if (t.status === 'expected' && !retryPassed) {
      passed += 1;
      if (isE2e) e2eExecuted += 1;
    } else if (t.status === 'flaky' || retryPassed) {
      if (isE2e) e2eExecuted += 1;
      if (isQuarantined && !isCritical) {
        quarantinedCount += 1;
        warnings.push(`[Quarantined Flaky] ${t.file}:${t.line} — ${t.title}`);
      } else {
        flaky += 1;
        flakyList.push(`${t.file}:${t.line} — ${t.title}`);
      }
    } else if (t.status === 'unexpected') {
      if (isE2e) e2eExecuted += 1;
      if (isQuarantined && !isCritical) {
        quarantinedCount += 1;
        warnings.push(`[Quarantined Failure] ${t.file}:${t.line} — ${t.title}`);
      } else {
        failed += 1;
        failedList.push(`${t.file}:${t.line} — ${t.title}`);
      }
    } else if (t.status === 'skipped') {
      if (isMutation && !allowMutation) {
        const dedupKey = normalizeMutationDedupKey(t.file, t.line);
        if (!seenMutationKeys.has(dedupKey)) {
          seenMutationKeys.add(dedupKey);
          policyExcludedTitles.push(`${t.file}:${t.line} — ${t.title}`);
        }
        continue;
      }
      skipped += 1;
      const waiver = isCoveredByWaiver(t, activeWaivers, 'test');
      if (waiver) {
        waivedSkips.push(`${t.title} (waived by ${waiver.owner} until ${waiver.expiresAt})`);
      } else {
        unwaivedSkipped += 1;
        if (isCritical) {
          unwaivedCriticalSkips.push(`${t.file}:${t.line} — ${t.title}`);
        }
      }
    }
  }

  const policyExcludedMutations = seenMutationKeys.size;

  const topErrors = Array.isArray(resultsObj.errors) ? resultsObj.errors : [];
  if (topErrors.length > 0) {
    for (const e of topErrors) {
      errors.push(`Runner error: ${(e.message || JSON.stringify(e)).split('\n')[0]}`);
    }
  }

  const executed = passed + failed + flaky + quarantinedCount;
  if (executed === 0) {
    errors.push('Zero tests were executed (passed + failed + flaky === 0). Empty or all-skipped runs cannot pass.');
  }

  if (failed > 0) {
    errors.push(`${failed} test(s) failed: ${failedList.slice(0, 5).join('; ')}`);
  }

  if (unwaivedCriticalSkips.length > 0) {
    errors.push(
      `${unwaivedCriticalSkips.length} @critical/@smoke test(s) were skipped without an active waiver: ${unwaivedCriticalSkips.join('; ')}`
    );
  }

  if (unwaivedSkipped > maxSkipped) {
    errors.push(`Unwaived skipped test count (${unwaivedSkipped}) exceeds --max-skipped (${maxSkipped}).`);
  }

  if (flaky > maxFlaky) {
    errors.push(`Flaky test count (${flaky}) exceeds --max-flaky (${maxFlaky}): ${flakyList.join('; ')}`);
  } else if (flaky > 0) {
    warnings.push(`${flaky} flaky test(s) detected: ${flakyList.join('; ')}`);
  }

  if (requireE2e && e2eExecuted === 0) {
    errors.push('--require-e2e is enabled, but 0 online E2E tests were executed.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      total: allTests.length,
      executed,
      passed,
      failed,
      flaky,
      quarantined: quarantinedCount,
      skipped,
      unwaivedSkipped,
      policyExcludedMutations,
      e2eExecuted,
    },
    policyExcludedTitles,
    waivedSkips,
  };
}

/**
 * Fail-closed Run Ledger verification on `reports/results.json` (`T-03`).
 *
 * - When `qaDir` is an initialized QA workspace, a missing `.aitest/runs/latest.json` returns `blocked`
 *   (unless explicit CLI-only `allowUnboundResults: true` is passed — never exposed in MCP!).
 * - Requires BOTH `manifest.resultsSha256` and `manifest.worktreeHash` to be non-empty strings.
 * - Verifies T1 HMAC signature on `manifest.json` when present (detects hand-forged manifests).
 */
export function verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResultsObj, options = {}) {
  if (options.allowUnboundResults) {
    return {
      ok: true,
      status: 'pass',
      enforced: false,
      trustTier: 'T0',
      runId: null,
      resultsDigest: null,
      ledgerMac: null,
      errors: [],
      warnings: ['[Run Ledger T0 Advisory] allowUnboundResults=true bypassed Run Ledger binding.'],
    };
  }

  const latestPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  const initialized = isInitializedQaWorkspace(qaDir);
  if (!fs.existsSync(latestPath)) {
    if (initialized || options.requireLedger) {
      return {
        ok: false,
        status: 'blocked',
        enforced: true,
        trustTier: 'T0',
        runId: null,
        resultsDigest: null,
        ledgerMac: null,
        errors: [
          `[Run Ledger Blocked] Missing .aitest/runs/latest.json in initialized QA workspace (${qaDir}). Deleting Run Ledger is fail-closed; execute tests via "npx ai-test-workbench run".`,
        ],
        warnings: [],
      };
    }
    return {
      ok: true,
      status: 'pass',
      enforced: false,
      trustTier: 'T0',
      runId: null,
      resultsDigest: null,
      ledgerMac: null,
      errors: [],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      enforced: true,
      trustTier: 'T0',
      runId: null,
      resultsDigest: null,
      ledgerMac: null,
      errors: [`[Run Ledger Blocked] Corrupted .aitest/runs/latest.json: ${err.message}`],
      warnings,
    };
  }

  const runId = String(options.expectedRunId || latest.runId || '');
  const manifestPath = path.join(qaDir, '.aitest', 'runs', runId, 'manifest.json');
  if (!runId || !fs.existsSync(manifestPath)) {
    return {
      ok: false,
      status: 'blocked',
      enforced: true,
      trustTier: 'T0',
      runId: runId || null,
      resultsDigest: null,
      ledgerMac: null,
      errors: [`[Run Ledger Blocked] Missing run manifest for runId="${runId}". Re-run "npx ai-test-workbench run".`],
      warnings,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      enforced: true,
      trustTier: 'T0',
      runId,
      resultsDigest: null,
      ledgerMac: null,
      errors: [`[Run Ledger Blocked] Corrupted manifest.json for runId="${runId}": ${err.message}`],
      warnings,
    };
  }

  const resolvedDefaultResults = path.resolve(qaDir, 'reports', 'results.json');
  if (path.resolve(resultsPath) !== resolvedDefaultResults && !options.expectedRunId) {
    return {
      ok: true,
      status: 'pass',
      enforced: false,
      trustTier: 'T0',
      runId: manifest.runId,
      resultsDigest: null,
      ledgerMac: manifest.mac || null,
      errors,
      warnings: ['Auditing non-default custom results file without expectedRunId (T0 advisory).'],
    };
  }

  // Verify T1 HMAC on manifest.json (detects forged manifests written outside runner)
  const macCheck = verifyPayloadT1('ledger.manifest', manifest, manifest.mac, {
    qaDir,
    repoDir: manifest.repoDir || path.dirname(qaDir),
    requireMac: Boolean(options.requireT1Mac || manifest.mac),
  });
  if (!macCheck.ok) {
    errors.push(`[Run Ledger Tamper Blocked] ${macCheck.reason}`);
  } else if (!macCheck.verified) {
    warnings.push(`[Run Ledger T0 Advisory] ${macCheck.reason}`);
  }

  // Mandatory resultsSha256 (cannot bypass by omitting field!)
  const actualResultsSha = `sha256:${sha256Hex(fs.readFileSync(resultsPath, 'utf8'))}`;
  if (!manifest.resultsSha256 || typeof manifest.resultsSha256 !== 'string') {
    errors.push(
      `[Run Ledger Blocked] Run manifest (${manifest.runId}) is missing mandatory resultsSha256 field.`
    );
  } else if (actualResultsSha !== manifest.resultsSha256) {
    errors.push(
      `[Stale/Tampered Results Blocked] reports/results.json SHA-256 does not match Run Ledger manifest (${manifest.runId}).`
    );
  }

  const embeddedRunId = rawResultsObj?.config?.metadata?.runId;
  if (embeddedRunId && embeddedRunId !== manifest.runId) {
    errors.push(
      `[Stale Results Blocked] results.json metadata.runId (${embeddedRunId}) != Ledger runId (${manifest.runId}).`
    );
  }

  // Mandatory worktreeHash (cannot bypass by omitting field!)
  if (!manifest.worktreeHash || typeof manifest.worktreeHash !== 'string') {
    errors.push(
      `[Run Ledger Blocked] Run manifest (${manifest.runId}) is missing mandatory worktreeHash field.`
    );
  } else if (typeof options.currentWorktreeHash === 'string' && options.currentWorktreeHash !== manifest.worktreeHash) {
    errors.push(
      `[Stale Results Blocked] Workspace source/spec files changed since runId=${manifest.runId} completed (worktreeHash mismatch). Re-run "npx ai-test-workbench run" so green results match current code.`
    );
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'pass' : 'fail',
    enforced: true,
    trustTier: errors.length === 0 && macCheck.verified ? 'T1' : 'T0',
    runId: manifest.runId,
    resultsDigest: actualResultsSha,
    ledgerMac: manifest.mac || null,
    errors,
    warnings,
  };
}
