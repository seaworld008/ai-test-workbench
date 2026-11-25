#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKBENCH_VERSION,
  analyzeHealerDiffText,
  attemptHealRepair,
  beginHealSession,
  beginRunLedger,
  executeSuiteCore,
  finalizeRunLedger,
  redactSecrets,
  runAuditForQaDir,
  runCli,
  suggestFailureCategory,
} from '../src/app/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADV_DIR = path.join(ROOT, 'test', 'adversarial');
const TEMPLATE_MODULES = path.join(ROOT, 'templates', 'playwright-qa', 'node_modules');

/**
 * Starts a seeded-defect variant of the Smart Campus demo server for SDDR evaluation (`R0-6` / `R3-1`).
 * @param {'500_courses' | 'rbac_leak' | 'duplicate_enroll' | 'soldout_enabled' | 'uncaught_pageerror' | 'a11y_missing_label' | 'schema_drift'} defectId
 */
function startMutatedDemoServer(defectId) {
  let enrolledOnce = false;
  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    if (method === 'POST' && pathname === '/__test__/reset') {
      enrolledOnce = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'tok_bench_student', user: { username: 'student', role: 'student' } }));
      return;
    }

    if (method === 'GET' && pathname === '/api/courses') {
      if (defectId === '500_courses') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Database pool exhausted' }));
        return;
      }
      if (defectId === 'schema_drift') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            courses: [{ id: 'c1', title: 'Broken Schema', instructor: 'Dr. X', seatsLeft: 'ten' }],
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          courses: [
            { id: 'course-open-101', title: 'Playwright Architecture', instructor: 'Dr. Rivera', seatsLeft: 10 },
            { id: 'course-last-seat', title: 'AI Quality Engineering', instructor: 'Prof. Lin', seatsLeft: 1 },
            { id: 'course-sold-out', title: 'Legacy QA (Sold Out)', instructor: 'Prof. Grant', seatsLeft: 0 },
          ],
        })
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/enroll') {
      if (defectId === 'duplicate_enroll') {
        // Bug: allows duplicate enrollment with 201 every time!
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enrolled: true }));
        return;
      }
      if (enrolledOnce) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Duplicate' }));
        return;
      }
      enrolledOnce = true;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enrolled: true }));
      return;
    }

    if (method === 'GET' && (pathname === '/api/admin/audit' || pathname === '/admin')) {
      if (defectId === 'rbac_leak') {
        // Bug: leaks admin data with HTTP 200 instead of 403!
        res.writeHead(200, { 'Content-Type': pathname === '/admin' ? 'text/html' : 'application/json' });
        res.end(pathname === '/admin' ? '<main><h1>Admin Console Leaked</h1></main>' : JSON.stringify({ logs: ['secret'] }));
        return;
      }
      res.writeHead(403, { 'Content-Type': pathname === '/admin' ? 'text/html' : 'application/json' });
      res.end(pathname === '/admin' ? '<!DOCTYPE html><html lang="en"><head><title>403</title></head><body><main><h1>403 Forbidden</h1></main></body></html>' : JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    if (method === 'GET' && pathname === '/') {
      const soldOutAttr = defectId === 'soldout_enabled' ? '' : 'disabled';
      const labelHtml =
        defectId === 'a11y_missing_label'
          ? '<input id="course-search" type="search" />'
          : '<label for="course-search">Search courses</label><input id="course-search" type="search" />';
      const crashScript =
        defectId === 'uncaught_pageerror'
          ? '<script>setTimeout(() => { throw new TypeError("Seeded uncaught crash"); }, 10);</script>'
          : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Smart Campus</title></head>
<body>
  <main>
    <h1>Smart Campus Course Portal</h1>
    ${labelHtml}
    <ul>
      <li class="course-card" data-title="playwright architecture">Playwright Architecture <button type="button">Enroll</button></li>
      <li class="course-card" data-title="sold out">Sold Out Course <button type="button" ${soldOutAttr}>Sold Out</button></li>
    </ul>
  </main>
  ${crashScript}
</body>
</html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r(null))),
      });
    });
  });
}

async function runBenchmark() {
  const skipLiveBrowser = process.argv.includes('--fast') || !fs.existsSync(path.join(TEMPLATE_MODULES, '@playwright', 'test', 'cli.js'));

  // 1. Evaluate Fake-Green Escape Rate (FGER) across 20 diff bypasses + 5 governance tampers + 1 stale-result cheat
  const diffCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'diff-bypasses.cases.json'), 'utf8'));
  let escapedCheats = 0;
  let totalCheats = 0;

  for (const c of diffCases) {
    totalCheats += 1;
    const res = analyzeHealerDiffText(c.diff);
    if (res.ok) escapedCheats += 1;
  }

  // Test 5 live workspace governance tampers + 1 stale result cheat + 1 C-class mis-heal attempt
  let misHeals = 0;
  const cClassSessions = 2;
  const benchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-bench-'));
  try {
    await runCli(['init', '--name', 'bench-ws', '--target', benchTmp, '--preset', 'demo-campus', '--skip-install', '--loop', 'none']);
    const qaDir = path.join(benchTmp, 'qa');

    for (const rel of ['playwright.config.ts', 'eslint.config.mjs', 'aitest.config.json', 'waivers.json', 'tests/fixtures/base.ts']) {
      totalCheats += 1;
      const full = path.join(qaDir, rel);
      const orig = fs.readFileSync(full, 'utf8');
      fs.writeFileSync(full, rel.endsWith('.json') ? '{"maxFlaky":99}' : `${orig}\n// cheat\n`, 'utf8');
      const gRes = runAuditForQaDir(qaDir, { staticOnly: true });
      if (gRes.ok) escapedCheats += 1;
      fs.writeFileSync(full, orig, 'utf8');
    }

    // Stale result cheat
    totalCheats += 1;
    fs.mkdirSync(path.join(benchTmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(benchTmp, 'src', 'app.ts'), 'export const v = 1;\n', 'utf8');
    const b = beginRunLedger(qaDir, { suite: 'smoke', command: 'playwright test', repoDir: benchTmp });
    const rp = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(
      rp,
      JSON.stringify({
        config: { metadata: { runId: b.runId } },
        suites: [{ file: 'tests/smoke/workbench.spec.ts', specs: [{ title: 'ok', line: 1, tests: [{ status: 'expected', results: [] }] }] }],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, b.runId, { exitCode: 0, resultsPath: rp });
    fs.writeFileSync(path.join(benchTmp, 'src', 'app.ts'), 'export const v = 2; // unverified edit\n', 'utf8');
    if (runAuditForQaDir(qaDir).ok) escapedCheats += 1;

    // C-class & D-class mis-heal attempts
    for (const errMsg of ['[Same-Origin 5xx Guard]\n500 GET /api/courses', 'Ambiguous spec: missing REQ-999']) {
      const bFail = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir: benchTmp });
      fs.writeFileSync(
        rp,
        JSON.stringify({
          config: { metadata: { runId: bFail.runId } },
          suites: [
            {
              file: 'tests/e2e/campus-portal.spec.ts',
              specs: [{ title: 'fail', line: 4, tests: [{ status: 'unexpected', results: [{ error: { message: errMsg } }] }] }],
            },
          ],
        }),
        'utf8'
      );
      finalizeRunLedger(qaDir, bFail.runId, { exitCode: 1, resultsPath: rp });
      const hs = beginHealSession(qaDir);
      if (!hs.ok || !hs.session) {
        throw new Error(`Expected valid heal session for mis-heal probe, got: ${hs.error}`);
      }
      const attempt = await attemptHealRepair(qaDir, { sessionId: hs.session.sessionId, skipRun: true });
      if (attempt.ok) misHeals += 1;
    }

    // 2. Seeded Defect Detection Rate (SDDR) across 7 live seeded product defects on demo-webapp!
    let seededTotal = 0;
    let seededDetected = 0;
    const seededDetails = [];

    if (!skipLiveBrowser) {
      fs.symlinkSync(TEMPLATE_MODULES, path.join(qaDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      /** @type {Array<{ id: any, suite: string, allowMutation?: boolean }>} */
      const defectScenarios = [
        { id: '500_courses', suite: 'api' },
        { id: 'schema_drift', suite: 'api' },
        { id: 'rbac_leak', suite: 'api' },
        { id: 'duplicate_enroll', suite: 'api', allowMutation: true },
        { id: 'soldout_enabled', suite: 'e2e' },
        { id: 'uncaught_pageerror', suite: 'e2e' },
        { id: 'a11y_missing_label', suite: 'e2e' },
      ];

      for (const sc of defectScenarios) {
        seededTotal += 1;
        const srv = await startMutatedDemoServer(sc.id);
        try {
          fs.writeFileSync(
            path.join(qaDir, '.env'),
            `TEST_ENV=local\nTEST_BASE_URL=${srv.baseURL}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\nREQUIRE_TEST_TARGET=1\nE2E_USERNAME=student_qa_0\nE2E_PASSWORD=qa-pass-123\n`,
            'utf8'
          );
          const out = await executeSuiteCore({
            target: benchTmp,
            suite: sc.suite,
            baseUrl: srv.baseURL,
            allowMutation: Boolean(sc.allowMutation),
            audit: true,
          });
          const detected = !out.ok && out.exitCode !== 0;
          if (detected) seededDetected += 1;
          seededDetails.push({ defectId: sc.id, suite: sc.suite, detected });
        } finally {
          await srv.close();
        }
      }
    }

    // 1b. Red-Team Holdout Diff Bypasses (Appendix A — 24 out-of-sample cheats) & Benign Refactoring FPR (12 cases)
    const holdoutCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'holdout-diff-bypasses.cases.json'), 'utf8'));
    let holdoutEscaped = 0;
    for (const hc of holdoutCases) {
      const hRes = analyzeHealerDiffText(hc.diff);
      if (hRes.ok) holdoutEscaped += 1;
    }

    const benignCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'benign-refactors.cases.json'), 'utf8'));
    let benignFalsePositives = 0;
    for (const bc of benignCases) {
      const bRes = analyzeHealerDiffText(bc.diff);
      if (!bRes.ok) benignFalsePositives += 1;
    }

    // 3. Triage Accuracy (45 internal + 12 real Playwright stack traces with C->A guard) & Redaction Recall
    const triageCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'triage.cases.json'), 'utf8'));
    let triageCorrect = 0;
    for (const tc of triageCases) {
      if (suggestFailureCategory(tc.error, tc.guard || null).categoryCode === tc.expected) triageCorrect += 1;
    }

    const realPwTriageCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'real-playwright-triage.cases.json'), 'utf8'));
    let realPwCorrect = 0;
    let realPwClassCTotal = 0;
    let realPwCToAMisclassified = 0;
    for (const rc of realPwTriageCases) {
      const got = suggestFailureCategory(rc.error, rc.guard || null).categoryCode;
      if (got === rc.expected) realPwCorrect += 1;
      if (rc.expected === 'C') {
        realPwClassCTotal += 1;
        if (got === 'A') realPwCToAMisclassified += 1;
      }
    }

    const redactCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'redaction.cases.json'), 'utf8'));
    let redactClean = 0;
    for (const rc of redactCases) {
      if (!redactSecrets(rc.input).includes(rc.mustNotContain)) redactClean += 1;
    }

    const fgerInternal = Number((escapedCheats / totalCheats).toFixed(4));
    const fgerHoldout = Number((holdoutEscaped / holdoutCases.length).toFixed(4));
    const gateFpr = Number((benignFalsePositives / benignCases.length).toFixed(4));
    const sddr = seededTotal > 0 ? Number((seededDetected / seededTotal).toFixed(4)) : null;
    const triageAccuracy = Number((triageCorrect / triageCases.length).toFixed(4));
    const realStackTriageAccuracy = Number((realPwCorrect / realPwTriageCases.length).toFixed(4));
    const cToAMisclassifyRate =
      realPwClassCTotal > 0 ? Number((realPwCToAMisclassified / realPwClassCTotal).toFixed(4)) : 0;
    const redactionRecall = Number((redactClean / redactCases.length).toFixed(4));
    const misHealRate = Number((misHeals / cClassSessions).toFixed(4));

    const scorecard = {
      schemaVersion: 2,
      toolVersion: WORKBENCH_VERSION,
      evaluatedAt: new Date().toISOString(),
      corpusDisclosure: {
        internalRegression: totalCheats,
        redTeamHoldout: holdoutCases.length,
        benignRefactors: benignCases.length,
        realPlaywrightStacks: realPwTriageCases.length,
        seededDemoDefects: seededTotal,
      },
      metrics: {
        fakeGreenEscapeRate_FGER: fgerInternal,
        fakeGreenEscapeRate_FGER_internal: fgerInternal,
        cheatingPatchesBlocked: `${totalCheats - escapedCheats}/${totalCheats}`,
        fakeGreenEscapeRate_FGER_holdout: fgerHoldout,
        holdoutCheatsBlocked: `${holdoutCases.length - holdoutEscaped}/${holdoutCases.length}`,
        gateFalsePositiveRate_FPR: gateFpr,
        benignRefactorsAllowed: `${benignCases.length - benignFalsePositives}/${benignCases.length}`,
        seededDefectDetectionRate_SDDR: sddr,
        seededDefectsDetected: seededTotal > 0 ? `${seededDetected}/${seededTotal}` : 'skipped (--fast)',
        triageAccuracy,
        triageCorrect: `${triageCorrect}/${triageCases.length}`,
        realStackTriageAccuracy,
        realStackTriageCorrect: `${realPwCorrect}/${realPwTriageCases.length}`,
        cToAMisclassifyRate,
        redactionRecall,
        redactionBlocked: `${redactClean}/${redactCases.length}`,
        misHealRate,
      },
      seededDetails,
    };

    // Always write scorecard to gitignored reports/ so `npm run bench` never leaves tracked artifacts (`WU-03`)
    const outDir = path.join(ROOT, 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const scorecardPath = path.join(outDir, 'bench-scorecard.json');
    fs.writeFileSync(scorecardPath, JSON.stringify(scorecard, null, 2) + '\n', 'utf8');

    console.log(
      `[Bench Scorecard v${WORKBENCH_VERSION}] FGER-int=${(fgerInternal * 100).toFixed(1)}% (${scorecard.metrics.cheatingPatchesBlocked}) | FGER-holdout=${(fgerHoldout * 100).toFixed(1)}% (${scorecard.metrics.holdoutCheatsBlocked}) | Gate-FPR=${(gateFpr * 100).toFixed(1)}% (${scorecard.metrics.benignRefactorsAllowed}) | SDDR=${sddr !== null ? `${(sddr * 100).toFixed(1)}% (${scorecard.metrics.seededDefectsDetected})` : 'skipped'} | Triage=${(triageAccuracy * 100).toFixed(1)}% | RealStacks=${(realStackTriageAccuracy * 100).toFixed(1)}% (C->A=${(cToAMisclassifyRate * 100).toFixed(1)}%) | Redaction=${(redactionRecall * 100).toFixed(1)}% | MisHeal=${(misHealRate * 100).toFixed(1)}%`
    );
    console.log(`  Scorecard written to: ${scorecardPath}`);

    if (
      fgerInternal > 0 ||
      fgerHoldout > 0 ||
      gateFpr > 0.03 ||
      cToAMisclassifyRate > 0 ||
      misHealRate > 0 ||
      triageAccuracy < 0.9 ||
      realStackTriageAccuracy < 0.9 ||
      redactionRecall < 1 ||
      (sddr !== null && sddr < 1)
    ) {
      console.error('[Bench FAILED] One or more North-Star verification thresholds were not met.');
      process.exit(1);
    }
  } finally {
    fs.rmSync(benchTmp, { recursive: true, force: true });
  }
}

await runBenchmark();
