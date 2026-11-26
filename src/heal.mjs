// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import {
  compareSpecSourcesAst,
  loadAitestConfig,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
} from './audit.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { resolvePlaywrightCli } from './core/playwright-resolve.mjs';
import { flattenPlaywrightResults } from './core/playwright-results.mjs';
import { beginHealSession } from './heal/begin.mjs';
import { concludeHealSession, discardHealSession } from './heal/conclude.mjs';
import {
  MAX_HEAL_ATTEMPTS,
  autoCloseStaleClassBSessions,
  computeAppCodeTreeHash,
  readAndVerifySession,
  readHealAttemptLedger,
  writeHealAttemptLedger,
  writeSignedSession,
} from './heal/store.mjs';
import { openTrustContext } from './kernel/gate-kernel.mjs';
import { executeSuiteCore } from './runner.mjs';

export { MAX_HEAL_ATTEMPTS, autoCloseStaleClassBSessions, beginHealSession, concludeHealSession, discardHealSession };

const TERMINAL_HEAL_STATES = new Set(['verified', 'concluded', 'escalated', 'discarded', 'blocked_by_bug']);

/**
 * Inspects an isolated attempt Playwright JSON results file to confirm whether the target test passed.
 * Returns `null` if the results file does not exist or cannot be parsed.
 * @param {string | null | undefined} resultsPath
 * @param {Record<string, any>} session
 * @returns {boolean | null}
 */
function inspectAttemptResultsPassed(resultsPath, session) {
  if (!resultsPath || !fs.existsSync(resultsPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const tests = flattenPlaywrightResults(raw);
    if (!Array.isArray(tests) || tests.length === 0) return false;
    const normSessionId = String(session.testId || '').replace(/\\/g, '/');
    const normSpec = String(session.specFile || '').replace(/\\/g, '/').replace(/^tests\//, '');
    const match =
      tests.find((t) => String(t.testId || '').replace(/\\/g, '/') === normSessionId) ||
      tests.find((t) => {
        const nf = String(t.file || '').replace(/\\/g, '/').replace(/^tests\//, '');
        return (nf === normSpec || nf.endsWith(`/${normSpec}`) || normSpec.endsWith(`/${nf}`)) && t.title === session.title;
      });
    if (!match) return false;
    return match.status === 'expected' || match.status === 'flaky';
  } catch {
    return null;
  }
}

/**
 * Validates and executes a single Class-A repair attempt (`aitest_heal(action="attempt")`), enforcing:
 * 1) T1 HMAC session integrity
 * 2) Category === 'A' (B/C/D hard-blocked -> 0% mis-heal rate)
 * 3) Cross-session `attemptsUsed < 3` per `testId`
 * 4) Layer 0 Governance Lock + Layer 2 Static AST + Layer 3 Full-File AST Semantic Diff Guard
 * 5) Isolated single-spec Playwright re-run (`WB-P0-02`) when `skipRun !== true`
 * @param {string} qaDir
 * @param {{ sessionId?: string, skipRun?: boolean, assumeTestPassed?: boolean, resultsPath?: string }} [options]
 */
export async function attemptHealRepair(qaDir, options = {}) {
  const loaded = readAndVerifySession(qaDir, options.sessionId);
  if (!loaded.ok) return loaded;
  const session = loaded.session;

  if (TERMINAL_HEAL_STATES.has(session.state)) {
    return {
      ok: false,
      exitCode: 2,
      error: `[Heal Governance Blocked] Session ${session.sessionId} is already in terminal state "${session.state}".`,
    };
  }

  if (!session.repairPermitted || session.categoryCode !== 'A') {
    session.updatedAt = new Date().toISOString();
    session.attempts.push({
      attemptedAt: session.updatedAt,
      blockedReason: `Category ${session.categoryCode} does not permit test modification`,
    });
    const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
    writeSignedSession(qaDir, session, writeTrustCtx);
    return {
      ok: false,
      exitCode: 2,
      misHealBlocked: true,
      error: `[Heal Governance Blocked] Category "${session.category}" prohibits modifying test assertions/locators. Call aitest_heal(action="conclude") to file a defect report or request spec clarification.`,
    };
  }

  const ledger = readHealAttemptLedger(qaDir);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }
  const currentAppCodeHash = session.appCodeTreeHash || computeAppCodeTreeHash(path.dirname(qaDir), qaDir);
  const storedEntry = ledger.byTestId[session.testId];
  const storedCount =
    storedEntry?.appCodeTreeHash && storedEntry.appCodeTreeHash !== currentAppCodeHash
      ? 0
      : Number(storedEntry?.attemptsUsed || 0);
  const crossSessionAttempts = Math.max(Number(session.attemptsUsed || 0), storedCount);

  if (crossSessionAttempts >= session.maxAttempts) {
    session.attemptsUsed = crossSessionAttempts;
    session.remainingAttempts = 0;
    session.state = 'escalated';
    session.allowedActions = ['conclude', 'discard'];
    session.updatedAt = new Date().toISOString();
    const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
    writeSignedSession(qaDir, session, writeTrustCtx);
    return {
      ok: false,
      exitCode: 2,
      exhausted: true,
      error: `[Heal Governance Blocked] Maximum ${session.maxAttempts} repair attempts exhausted across sessions for "${session.testId}". Session escalated to human review.`,
    };
  }

  // Enforce Layer 0 Governance Lock
  const govTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: false });
  const govCheck = verifyGovernanceLockInQaDir(qaDir, { trustContext: govTrustCtx });
  if (!govCheck.ok) {
    return {
      ok: false,
      exitCode: 2,
      gateBlocked: true,
      violations: govCheck.errors,
      error: govCheck.errors.join('\n'),
    };
  }

  // Enforce Full-File AST Semantic Diff Guard against Git/session baseline (`B-1`)
  const absSpec = path.join(qaDir, session.specFile);
  const currentContent = fs.existsSync(absSpec) ? fs.readFileSync(absSpec, 'utf8') : '';
  const cfg = loadAitestConfig(qaDir);
  const astDiffCheck = compareSpecSourcesAst(session.specFile, session.baselineSpecContent || '', currentContent, {
    assertFunctionNames: cfg.assertFunctionNames,
    qaDir,
  });
  const staticCheck = scanSpecFilesFallback(path.join(qaDir, 'tests'), {
    assertFunctionNames: cfg.assertFunctionNames,
    qaDir,
  });

  const gateViolations = [...new Set([...astDiffCheck.violations, ...staticCheck.errors])];
  const nextAttempts = crossSessionAttempts + 1;
  ledger.byTestId[session.testId] = {
    attemptsUsed: nextAttempts,
    appCodeTreeHash: currentAppCodeHash,
    lastSessionId: session.sessionId,
    updatedAt: new Date().toISOString(),
  };

  if (gateViolations.length > 0) {
    session.attemptsUsed = nextAttempts;
    session.remainingAttempts = Math.max(0, session.maxAttempts - nextAttempts);
    session.state = nextAttempts >= session.maxAttempts ? 'escalated' : 'repairing';
    if (session.state === 'escalated') session.allowedActions = ['conclude', 'discard'];
    session.updatedAt = new Date().toISOString();
    session.attempts.push({
      attemptNumber: nextAttempts,
      attemptedAt: session.updatedAt,
      gatePassed: false,
      violations: gateViolations,
    });
    const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
    writeHealAttemptLedger(qaDir, ledger.byTestId, writeTrustCtx);
    writeSignedSession(qaDir, session, writeTrustCtx);
    return {
      ok: false,
      exitCode: 2,
      gateBlocked: true,
      sessionId: session.sessionId,
      state: session.state,
      attemptsUsed: nextAttempts,
      remainingAttempts: session.remainingAttempts,
      violations: gateViolations,
      error: `[Heal Semantic Gate Blocked] Repair attempt #${nextAttempts} violated anti-fake-green rules:\n${gateViolations.join('\n')}`,
    };
  }

  session.attemptsUsed = nextAttempts;
  session.remainingAttempts = Math.max(0, session.maxAttempts - nextAttempts);
  let testPassed = Boolean(options.assumeTestPassed);
  let runId = null;
  const attemptResultsRel = path.join('.aitest', 'heals', session.sessionId, `attempt-${nextAttempts}-results.json`);
  const attemptResultsAbs = path.join(qaDir, attemptResultsRel);
  let recordedResultsPath = null;

  if (!options.skipRun && resolvePlaywrightCli(qaDir)) {
    const runRes = await executeSuiteCore({
      target: qaDir,
      suite: session.specFile.includes('/api/') ? 'api' : session.specFile.includes('/smoke/') ? 'smoke' : 'e2e',
      extraArgs: [session.specFile],
      audit: false,
      isolatedResultsPath: attemptResultsAbs,
      skipGlobalLedgerLatest: true,
      partialHealSessionId: session.sessionId,
    });
    const effectiveResultsAbs = runRes.resultsPath || attemptResultsAbs;
    const inspectedPass = inspectAttemptResultsPassed(effectiveResultsAbs, session);
    testPassed = Boolean(runRes.ok) && (inspectedPass === null ? true : inspectedPass);
    runId = runRes.runId || null;
    if (fs.existsSync(effectiveResultsAbs)) {
      recordedResultsPath = path.relative(qaDir, effectiveResultsAbs).replace(/\\/g, '/');
    }
  } else if (options.resultsPath && options.assumeTestPassed === undefined) {
    const resolvedInputResults = path.resolve(qaDir, options.resultsPath);
    const inspectedPass = inspectAttemptResultsPassed(resolvedInputResults, session);
    if (inspectedPass !== null) testPassed = inspectedPass;
    if (fs.existsSync(resolvedInputResults)) {
      recordedResultsPath = path.relative(qaDir, resolvedInputResults).replace(/\\/g, '/');
    }
  }

  session.updatedAt = new Date().toISOString();
  session.state = testPassed
    ? 'verified'
    : nextAttempts >= session.maxAttempts
      ? 'escalated'
      : 'repairing';
  if (session.state === 'verified') {
    session.allowedActions = ['conclude'];
  } else if (session.state === 'escalated') {
    session.allowedActions = ['conclude', 'discard'];
  }
  session.attempts.push({
    attemptNumber: nextAttempts,
    attemptedAt: session.updatedAt,
    gatePassed: true,
    testPassed,
    runId,
    resultsPath: recordedResultsPath,
  });
  const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
  writeHealAttemptLedger(qaDir, ledger.byTestId, writeTrustCtx);
  writeSignedSession(qaDir, session, writeTrustCtx);

  return {
    ok: testPassed,
    exitCode: testPassed ? 0 : 1,
    sessionId: session.sessionId,
    state: session.state,
    attemptsUsed: nextAttempts,
    remainingAttempts: session.remainingAttempts,
    runId,
    resultsPath: recordedResultsPath,
  };
}

/**
 * @param {{
 *   lang?: 'zh' | 'en' | string,
 *   target?: string,
 *   qaDir?: string,
 *   action?: string,
 *   testId?: string,
 *   results?: string,
 *   sessionId?: string,
 *   skipRun?: boolean,
 *   outcome?: string,
 *   summary?: string,
 *   json?: boolean,
 *   dryRun?: boolean,
 *   force?: boolean,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runHealCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {string} msg */
  const failHeal = (msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'heal', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failHeal(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }
  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    return failHeal(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  const action = String(options.action || 'begin').toLowerCase();
  let res;
  if (action === 'begin') {
    res = beginHealSession(qaDir, { testId: options.testId, resultsPath: options.results });
  } else if (action === 'attempt') {
    res = await attemptHealRepair(qaDir, {
      sessionId: options.sessionId,
      skipRun: Boolean(options.skipRun),
    });
  } else if (action === 'conclude') {
    res = concludeHealSession(qaDir, {
      sessionId: options.sessionId,
      outcome: options.outcome,
      summary: options.summary,
    });
  } else if (action === 'discard') {
    res = discardHealSession(qaDir, {
      sessionId: options.sessionId,
      summary: options.summary,
    });
  } else {
    const errMsg = `Unknown heal action "${action}". Use: begin | attempt | conclude | discard`;
    if (!options.json) console.error(errMsg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'heal',
        outcome: 'fail',
        ok: false,
        exitCode: 64,
        summary: errMsg,
        data: { error: errMsg },
      }),
      { asJson: Boolean(options.json) }
    );
  }

  if (!options.json) {
    if (!res.ok) {
      console.error('error' in res ? res.error : undefined);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
  }
  const healRecord = /** @type {Record<string, any>} */ (res);
  const summary = res.ok
    ? `Heal ${action} succeeded (session=${healRecord.sessionId || healRecord.session?.sessionId || 'none'})`
    : 'error' in res && res.error
      ? String(res.error)
      : `Heal ${action} failed`;
  return emitCommandResult(
    buildCommandResult({
      tool: 'heal',
      outcome: res.exitCode === 2 ? 'blocked' : res.ok ? 'pass' : 'fail',
      ok: Boolean(res.ok),
      exitCode: res.exitCode,
      summary,
      data: res,
    }),
    { asJson: Boolean(options.json) }
  );
}
