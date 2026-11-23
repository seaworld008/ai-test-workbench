// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import {
  analyzeHealerDiffText,
  loadAitestConfig,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
} from './audit.mjs';
import { generateDiagnosticsMarkdown } from './diagnose.mjs';
import { redactSecrets, resolvePlaywrightCli } from './proc.mjs';
import { executeSuiteCore } from './runner.mjs';
import { SCHEMA_VERSIONS } from './version.mjs';

export const MAX_HEAL_ATTEMPTS = 3;

function buildUnifiedDiffFromSnapshots(relFile, beforeText, afterText) {
  if (beforeText === afterText) return '';
  const beforeLines = String(beforeText || '').split(/\r?\n/);
  const afterLines = String(afterText || '').split(/\r?\n/);
  const lines = [
    `diff --git a/${relFile} b/${relFile}`,
    `--- a/${relFile}`,
    `+++ b/${relFile}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
  ];
  // Line-level diff preserving removed/added statements for semantic diff analysis
  const beforeCounts = new Map();
  for (const l of beforeLines) beforeCounts.set(l, (beforeCounts.get(l) || 0) + 1);
  const afterCounts = new Map();
  for (const l of afterLines) afterCounts.set(l, (afterCounts.get(l) || 0) + 1);

  const emittedRemoved = new Map();
  for (const l of beforeLines) {
    const keep = afterCounts.get(l) || 0;
    const used = emittedRemoved.get(l) || 0;
    if (used < (beforeCounts.get(l) || 0) - keep) {
      lines.push(`-${l}`);
      emittedRemoved.set(l, used + 1);
    }
  }
  const emittedAdded = new Map();
  for (const l of afterLines) {
    const keep = beforeCounts.get(l) || 0;
    const used = emittedAdded.get(l) || 0;
    if (used < (afterCounts.get(l) || 0) - keep) {
      lines.push(`+${l}`);
      emittedAdded.set(l, used + 1);
    }
  }
  return lines.join('\n');
}

function getSessionPath(qaDir, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(qaDir, '.aitest', 'heals', `${safeId}.json`);
}

/**
 * Starts a stateful Heal Governance Session (`R1-4`: `aitest_heal_begin`).
 * Only Class A failures allow repair attempts (<= 3); B/C/D are locked to reporting/escalation.
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

  const sessionId = `heal_${crypto.randomBytes(6).toString('hex')}`;
  const relSpec = targetFailure.file.startsWith('tests/') ? targetFailure.file : `tests/${targetFailure.file}`;
  const absSpec = path.join(qaDir, relSpec);
  const baselineSpecContent = fs.existsSync(absSpec) ? fs.readFileSync(absSpec, 'utf8') : '';

  const repairPermitted = targetFailure.categoryCode === 'A';
  const session = {
    schemaVersion: SCHEMA_VERSIONS.healSession,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'diagnosed',
    testId: targetFailure.testId,
    title: targetFailure.title,
    specFile: relSpec,
    line: targetFailure.line,
    categoryCode: targetFailure.categoryCode,
    category: targetFailure.category,
    confidence: targetFailure.confidence,
    traceId: targetFailure.traceId,
    errorSnippet: targetFailure.errorSnippet,
    codeCorrelation: targetFailure.codeCorrelation,
    repairPermitted,
    maxAttempts: repairPermitted ? MAX_HEAL_ATTEMPTS : 0,
    attemptsUsed: 0,
    allowedActions: repairPermitted ? ['attempt', 'conclude'] : ['conclude'],
    baselineSpecContent,
    attempts: [],
    conclusion: null,
  };

  const healDir = path.join(qaDir, '.aitest', 'heals');
  fs.mkdirSync(healDir, { recursive: true });
  fs.writeFileSync(getSessionPath(qaDir, sessionId), JSON.stringify(session, null, 2) + '\n', 'utf8');

  const { baselineSpecContent: _omit, ...publicSession } = session;
  return {
    ok: true,
    exitCode: 0,
    session: publicSession,
  };
}

/**
 * Validates and executes a single Class-A repair attempt (`aitest_heal_attempt`), enforcing:
 * 1) Category === 'A' (B/C/D hard-blocked -> 0% mis-heal rate)
 * 2) `attemptsUsed < 3`
 * 3) Layer 0 Governance Lock + Layer 2 Static AST + Layer 3 Semantic AST Diff Guard
 * 4) Optional targeted Playwright re-run when `skipRun !== true`
 */
export async function attemptHealRepair(qaDir, options = {}) {
  const sessionPath = getSessionPath(qaDir, options.sessionId);
  if (!options.sessionId || !fs.existsSync(sessionPath)) {
    return {
      ok: false,
      exitCode: 1,
      error: `Unknown heal session "${options.sessionId}". Call aitest_heal_begin first.`,
    };
  }

  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

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
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    return {
      ok: false,
      exitCode: 2,
      misHealBlocked: true,
      error: `[Heal Governance Blocked] Category "${session.category}" prohibits modifying test assertions/locators. Call aitest_heal_conclude to file a defect report or request spec clarification.`,
    };
  }

  if (session.attemptsUsed >= session.maxAttempts) {
    session.state = 'escalated';
    session.allowedActions = ['conclude'];
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    return {
      ok: false,
      exitCode: 2,
      exhausted: true,
      error: `[Heal Governance Blocked] Maximum ${session.maxAttempts} repair attempts exhausted for "${session.testId}". Session escalated to human review.`,
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

  // Enforce Semantic AST Diff Guard against baseline snapshot captured at `heal_begin`
  const absSpec = path.join(qaDir, session.specFile);
  const currentContent = fs.existsSync(absSpec) ? fs.readFileSync(absSpec, 'utf8') : '';
  const syntheticDiff = buildUnifiedDiffFromSnapshots(session.specFile, session.baselineSpecContent || '', currentContent);
  const cfg = loadAitestConfig(qaDir);
  const diffCheck = analyzeHealerDiffText(syntheticDiff, { assertFunctionNames: cfg.assertFunctionNames });
  const staticCheck = scanSpecFilesFallback(path.join(qaDir, 'tests'), {
    assertFunctionNames: cfg.assertFunctionNames,
    qaDir,
  });

  const gateViolations = [...diffCheck.violations, ...staticCheck.errors];
  if (gateViolations.length > 0) {
    session.attemptsUsed += 1;
    session.state = session.attemptsUsed >= session.maxAttempts ? 'escalated' : 'repairing';
    session.updatedAt = new Date().toISOString();
    session.attempts.push({
      attemptNumber: session.attemptsUsed,
      attemptedAt: session.updatedAt,
      gatePassed: false,
      violations: gateViolations,
    });
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    return {
      ok: false,
      exitCode: 2,
      gateBlocked: true,
      attemptsUsed: session.attemptsUsed,
      remainingAttempts: Math.max(0, session.maxAttempts - session.attemptsUsed),
      violations: gateViolations,
      error: `[Heal Semantic Gate Blocked] Repair attempt #${session.attemptsUsed} violated anti-fake-green rules:\n${gateViolations.join('\n')}`,
    };
  }

  session.attemptsUsed += 1;
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
    : session.attemptsUsed >= session.maxAttempts
      ? 'escalated'
      : 'repairing';
  if (session.state === 'verified' || session.state === 'escalated') {
    session.allowedActions = ['conclude'];
  }
  session.attempts.push({
    attemptNumber: session.attemptsUsed,
    attemptedAt: session.updatedAt,
    gatePassed: true,
    testPassed,
    runId,
  });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');

  return {
    ok: testPassed,
    exitCode: testPassed ? 0 : 1,
    sessionId: session.sessionId,
    state: session.state,
    attemptsUsed: session.attemptsUsed,
    remainingAttempts: Math.max(0, session.maxAttempts - session.attemptsUsed),
    runId,
  };
}

/**
 * Concludes a Heal Session (`aitest_heal_conclude`), generating a structured Defect Ticket for Class C bugs.
 */
export function concludeHealSession(qaDir, options = {}) {
  const sessionPath = getSessionPath(qaDir, options.sessionId);
  if (!options.sessionId || !fs.existsSync(sessionPath)) {
    return {
      ok: false,
      exitCode: 1,
      error: `Unknown heal session "${options.sessionId}".`,
    };
  }

  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
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
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');

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
