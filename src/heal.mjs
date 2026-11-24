// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import {
  compareSpecSourcesAst,
  loadAitestConfig,
  resolveDefaultDiffBase,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
} from './audit.mjs';
import { generateDiagnosticsMarkdown } from './diagnose.mjs';
import { resolvePlaywrightCli } from './core/playwright-resolve.mjs';
import { redactSecrets } from './core/redact.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import {
  getFileAtGitRef,
  signPayloadT1,
  verifyPayloadT1,
} from './kernel/gate-kernel.mjs';
import { executeSuiteCore } from './runner.mjs';

export const MAX_HEAL_ATTEMPTS = 3;

function getHealsDir(qaDir) {
  return path.join(qaDir, '.aitest', 'heals');
}

function getSessionPath(qaDir, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(getHealsDir(qaDir), `${safeId}.json`);
}

function getHealLedgerPath(qaDir) {
  return path.join(getHealsDir(qaDir), 'ledger.json');
}

/**
 * Reads cross-session per-`testId` attempt counters (`T-07`, `A-6`) so opening a new heal session
 * cannot reset the 3-attempt hard cap.
 */
function readHealAttemptLedger(qaDir) {
  const lp = getHealLedgerPath(qaDir);
  if (!fs.existsSync(lp)) return { ok: true, byTestId: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(lp, 'utf8'));
    const macCheck = verifyPayloadT1('heal.ledger', parsed, parsed.mac, {
      qaDir,
      repoDir: path.dirname(qaDir),
      requireMac: Boolean(parsed.mac),
    });
    if (!macCheck.ok) {
      return { ok: false, error: `[Heal Governance Blocked] ${macCheck.reason}`, byTestId: {} };
    }
    return { ok: true, byTestId: parsed.byTestId && typeof parsed.byTestId === 'object' ? parsed.byTestId : {} };
  } catch (err) {
    return { ok: false, error: `[Heal Governance Blocked] Corrupted heal ledger: ${err.message}`, byTestId: {} };
  }
}

function writeHealAttemptLedger(qaDir, byTestId) {
  const healsDir = getHealsDir(qaDir);
  fs.mkdirSync(healsDir, { recursive: true });
  const core = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    byTestId,
  };
  const sig = signPayloadT1('heal.ledger', core, { qaDir, repoDir: path.dirname(qaDir), createIfMissing: true });
  const payload = { ...core, ...(sig.signed ? { mac: sig.mac } : {}) };
  fs.writeFileSync(getHealLedgerPath(qaDir), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function writeSignedSession(qaDir, session) {
  const healsDir = getHealsDir(qaDir);
  fs.mkdirSync(healsDir, { recursive: true });
  const core = { ...session };
  delete core.mac;
  const sig = signPayloadT1('heal.session', core, { qaDir, repoDir: path.dirname(qaDir), createIfMissing: true });
  const signed = { ...core, ...(sig.signed ? { mac: sig.mac } : {}) };
  fs.writeFileSync(getSessionPath(qaDir, session.sessionId), JSON.stringify(signed, null, 2) + '\n', 'utf8');
  return signed;
}

function readAndVerifySession(qaDir, sessionId) {
  const sessionPath = getSessionPath(qaDir, sessionId);
  if (!sessionId || !fs.existsSync(sessionPath)) {
    return { ok: false, exitCode: 1, error: `Unknown heal session "${sessionId}". Call aitest_heal_begin first.` };
  }
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (err) {
    return { ok: false, exitCode: 2, error: `[Heal Governance Blocked] Corrupted heal session "${sessionId}": ${err.message}` };
  }
  const macCheck = verifyPayloadT1('heal.session', session, session.mac, {
    qaDir,
    repoDir: path.dirname(qaDir),
    requireMac: Boolean(session.mac),
  });
  if (!macCheck.ok) {
    return {
      ok: false,
      exitCode: 2,
      error: `[Heal Governance Blocked] Tampered heal session "${sessionId}": ${macCheck.reason}`,
    };
  }
  return { ok: true, session, sessionPath };
}

/**
 * Captures the authoritative baseline of `relSpec` from Git base ref (`T-07`) when available,
 * preventing agents from mutating the spec BEFORE calling `aitest_heal_begin`.
 */
function resolveSpecBaseline(qaDir, relSpec, absSpec) {
  const baseRes = resolveDefaultDiffBase(qaDir);
  if (baseRes.isGitRepo && baseRes.gitRoot && baseRes.resolved) {
    const relFromGitRoot = path.relative(baseRes.gitRoot, absSpec).replace(/\\/g, '/');
    const gitContent = getFileAtGitRef(baseRes.gitRoot, baseRes.resolved, relFromGitRoot);
    if (typeof gitContent === 'string') {
      return { content: gitContent, source: `git:${baseRes.resolved}`, baseSha: baseRes.sha };
    }
  }
  return {
    content: fs.existsSync(absSpec) ? fs.readFileSync(absSpec, 'utf8') : '',
    source: 'disk-snapshot',
    baseSha: null,
  };
}

/**
 * Starts a stateful, T1-HMAC-signed Heal Governance Session (`R1-4`, `T-07`).
 * Only Class A failures allow repair attempts (<= 3 across ALL sessions for the same `testId`);
 * Class B/C/D are locked to reporting/escalation.
 * @param {string} qaDir
 * @param {{ testId?: string, resultsPath?: string }} [options]
 */
export function beginHealSession(qaDir, options = {}) {
  const resultsPath = options.resultsPath
    ? path.resolve(qaDir, options.resultsPath)
    : path.join(qaDir, 'reports', 'results.json');
  if (!fs.existsSync(resultsPath)) {
    return {
      ok: false,
      exitCode: 1,
      error: `Results file not found at ${resultsPath}. Run tests before starting a heal session.`,
    };
  }

  const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
  if (diag.failures.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      error: 'No failing or flaky tests found in results.json; nothing to heal.',
    };
  }

  const targetFailure = options.testId
    ? diag.failures.find((f) => f.testId === options.testId || f.title.includes(options.testId) || f.file.includes(options.testId))
    : diag.failures[0];

  if (!targetFailure) {
    return {
      ok: false,
      exitCode: 1,
      error: `Failing test matching "${options.testId}" not found in current results.json.`,
    };
  }

  // Enforce cross-session attempt accounting per testId (`T-07`)
  const ledger = readHealAttemptLedger(qaDir);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }
  const priorAttemptsForTest = Number(ledger.byTestId[targetFailure.testId]?.attemptsUsed || 0);

  const sessionId = `heal_${crypto.randomBytes(6).toString('hex')}`;
  const relSpec = targetFailure.file.startsWith('tests/') ? targetFailure.file : `tests/${targetFailure.file}`;
  const absSpec = path.join(qaDir, relSpec);
  const baseline = resolveSpecBaseline(qaDir, relSpec, absSpec);

  const repairPermitted = targetFailure.categoryCode === 'A' && priorAttemptsForTest < MAX_HEAL_ATTEMPTS;
  const remainingAttempts = targetFailure.categoryCode === 'A' ? Math.max(0, MAX_HEAL_ATTEMPTS - priorAttemptsForTest) : 0;

  const session = {
    schemaVersion: SCHEMA_VERSIONS.healSession,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: priorAttemptsForTest >= MAX_HEAL_ATTEMPTS && targetFailure.categoryCode === 'A' ? 'escalated' : 'diagnosed',
    testId: targetFailure.testId,
    title: targetFailure.title,
    specFile: relSpec,
    line: targetFailure.line,
    categoryCode: targetFailure.categoryCode,
    category: targetFailure.category,
    confidence: targetFailure.confidence,
    candidates: targetFailure.candidates || [targetFailure.categoryCode],
    traceId: targetFailure.traceId,
    errorSnippet: targetFailure.errorSnippet,
    codeCorrelation: targetFailure.codeCorrelation,
    repairPermitted,
    maxAttempts: targetFailure.categoryCode === 'A' ? MAX_HEAL_ATTEMPTS : 0,
    attemptsUsed: priorAttemptsForTest,
    remainingAttempts,
    baselineSource: baseline.source,
    baselineSha: baseline.baseSha,
    allowedActions: repairPermitted ? ['attempt', 'conclude'] : ['conclude'],
    baselineSpecContent: baseline.content,
    attempts: [],
    conclusion: null,
  };

  writeSignedSession(qaDir, session);

  const { baselineSpecContent: _omit, ...publicSession } = session;
  return {
    ok: true,
    exitCode: 0,
    session: publicSession,
  };
}

/**
 * Validates and executes a single Class-A repair attempt (`aitest_heal_attempt`), enforcing:
 * 1) T1 HMAC session integrity
 * 2) Category === 'A' (B/C/D hard-blocked -> 0% mis-heal rate)
 * 3) Cross-session `attemptsUsed < 3` per `testId`
 * 4) Layer 0 Governance Lock + Layer 2 Static AST + Layer 3 Full-File AST Semantic Diff Guard
 * 5) Optional targeted Playwright re-run when `skipRun !== true`
 */
export async function attemptHealRepair(qaDir, options = {}) {
  const loaded = readAndVerifySession(qaDir, options.sessionId);
  if (!loaded.ok) return loaded;
  const session = loaded.session;

  if (session.state === 'verified' || session.state === 'concluded' || session.state === 'escalated') {
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
    writeSignedSession(qaDir, session);
    return {
      ok: false,
      exitCode: 2,
      misHealBlocked: true,
      error: `[Heal Governance Blocked] Category "${session.category}" prohibits modifying test assertions/locators. Call aitest_heal_conclude to file a defect report or request spec clarification.`,
    };
  }

  const ledger = readHealAttemptLedger(qaDir);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }
  const crossSessionAttempts = Math.max(
    Number(session.attemptsUsed || 0),
    Number(ledger.byTestId[session.testId]?.attemptsUsed || 0)
  );

  if (crossSessionAttempts >= session.maxAttempts) {
    session.attemptsUsed = crossSessionAttempts;
    session.remainingAttempts = 0;
    session.state = 'escalated';
    session.allowedActions = ['conclude'];
    session.updatedAt = new Date().toISOString();
    writeSignedSession(qaDir, session);
    return {
      ok: false,
      exitCode: 2,
      exhausted: true,
      error: `[Heal Governance Blocked] Maximum ${session.maxAttempts} repair attempts exhausted across sessions for "${session.testId}". Session escalated to human review.`,
    };
  }

  // Enforce Layer 0 Governance Lock
  const govCheck = verifyGovernanceLockInQaDir(qaDir);
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
    lastSessionId: session.sessionId,
    updatedAt: new Date().toISOString(),
  };

  if (gateViolations.length > 0) {
    session.attemptsUsed = nextAttempts;
    session.remainingAttempts = Math.max(0, session.maxAttempts - nextAttempts);
    session.state = nextAttempts >= session.maxAttempts ? 'escalated' : 'repairing';
    if (session.state === 'escalated') session.allowedActions = ['conclude'];
    session.updatedAt = new Date().toISOString();
    session.attempts.push({
      attemptNumber: nextAttempts,
      attemptedAt: session.updatedAt,
      gatePassed: false,
      violations: gateViolations,
    });
    writeHealAttemptLedger(qaDir, ledger.byTestId);
    writeSignedSession(qaDir, session);
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

  if (!options.skipRun && resolvePlaywrightCli(qaDir)) {
    const runRes = await executeSuiteCore({
      target: qaDir,
      suite: session.specFile.includes('/api/') ? 'api' : session.specFile.includes('/smoke/') ? 'smoke' : 'e2e',
      extraArgs: [session.specFile],
      audit: false,
    });
    testPassed = runRes.ok;
    runId = runRes.runId || null;
  }

  session.updatedAt = new Date().toISOString();
  session.state = testPassed
    ? 'verified'
    : nextAttempts >= session.maxAttempts
      ? 'escalated'
      : 'repairing';
  if (session.state === 'verified' || session.state === 'escalated') {
    session.allowedActions = ['conclude'];
  }
  session.attempts.push({
    attemptNumber: nextAttempts,
    attemptedAt: session.updatedAt,
    gatePassed: true,
    testPassed,
    runId,
  });
  writeHealAttemptLedger(qaDir, ledger.byTestId);
  writeSignedSession(qaDir, session);

  return {
    ok: testPassed,
    exitCode: testPassed ? 0 : 1,
    sessionId: session.sessionId,
    state: session.state,
    attemptsUsed: nextAttempts,
    remainingAttempts: session.remainingAttempts,
    runId,
  };
}

/**
 * Concludes a Heal Session (`aitest_heal_conclude`), generating a structured Defect Ticket for Class C bugs.
 */
export function concludeHealSession(qaDir, options = {}) {
  const loaded = readAndVerifySession(qaDir, options.sessionId);
  if (!loaded.ok) return loaded;
  const session = loaded.session;
  const outcome = String(options.outcome || (session.state === 'verified' ? 'verified' : 'reported')).toLowerCase();

  if (outcome === 'verified' && session.state !== 'verified') {
    return {
      ok: false,
      exitCode: 2,
      error: `[Heal Governance Blocked] Cannot conclude session as "verified" when state is "${session.state}".`,
    };
  }

  let defectTicketPath = null;
  if (session.categoryCode === 'C' || outcome === 'reported' || outcome === 'defect') {
    const defectsDir = path.join(qaDir, 'reports', 'defects');
    fs.mkdirSync(defectsDir, { recursive: true });
    defectTicketPath = path.join(defectsDir, `${session.sessionId}.md`);
    const ticketJsonPath = path.join(defectsDir, `${session.sessionId}.json`);
    const summaryNote = redactSecrets(String(options.summary || 'Product/backend regression detected; test intentionally kept red.'));

    const ticketObj = {
      sessionId: session.sessionId,
      createdAt: new Date().toISOString(),
      category: session.category,
      testId: session.testId,
      specFile: session.specFile,
      line: session.line,
      traceId: session.traceId,
      codeCorrelation: session.codeCorrelation,
      summary: summaryNote,
      errorSnippet: session.errorSnippet,
    };
    fs.writeFileSync(ticketJsonPath, JSON.stringify(ticketObj, null, 2) + '\n', 'utf8');
    fs.writeFileSync(
      defectTicketPath,
      [
        `# Defect Ticket (${session.sessionId}) — ${session.title}`,
        '',
        `- **Classification**: **${session.category}**`,
        `- **Failing Spec**: \`${session.specFile}:${session.line}\` *(Kept RED per Anti-Fake-Green Iron Rule)*`,
        `- **32-char Distributed Trace ID**: \`${session.traceId || 'n/a'}\``,
        `- **Summary**: ${summaryNote}`,
        '',
        '## Error Evidence (Redacted)',
        '```text',
        session.errorSnippet || '',
        '```',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  session.state = 'concluded';
  session.updatedAt = new Date().toISOString();
  session.conclusion = {
    outcome,
    summary: redactSecrets(String(options.summary || '')),
    defectTicketPath,
    concludedAt: session.updatedAt,
  };
  writeSignedSession(qaDir, session);

  return {
    ok: true,
    exitCode: 0,
    sessionId: session.sessionId,
    outcome,
    defectTicketPath,
  };
}

export async function runHealCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }
  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
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
  } else {
    console.error(`Unknown heal action "${action}". Use: begin | attempt | conclude`);
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.exitCode;
  }
  if (!res.ok) {
    console.error(res.error);
    return res.exitCode;
  }
  console.log(JSON.stringify(res, null, 2));
  return 0;
}
