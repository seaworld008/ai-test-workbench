// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { redactSecrets } from './proc.mjs';

function flattenFailedTests(suites, parents = [], fileHint = '') {
  const failures = [];
  const nextParents = suites.title ? [...parents, suites.title] : parents;
  const currentFile = suites.file || fileHint;

  for (const spec of suites.specs || []) {
    const title = [...nextParents, spec.title].filter(Boolean).join(' > ');
    for (const testItem of spec.tests || []) {
      const retryPassed = testItem.status === 'expected' && Array.isArray(testItem.results) && testItem.results.length > 1;
      if (testItem.status === 'unexpected' || testItem.status === 'flaky' || retryPassed) {
        failures.push({
          title,
          file: spec.file || currentFile || 'unknown',
          line: spec.line || 0,
          projectName: testItem.projectName || '',
          status: retryPassed ? 'flaky' : testItem.status,
          results: testItem.results || [],
        });
      }
    }
  }
  for (const child of suites.suites || []) {
    failures.push(...flattenFailedTests(child, nextParents, currentFile));
  }
  return failures;
}

/**
 * Extracts the pure 32-hex W3C trace-id segment from `traceparent` (`00-<32hex>-<16hex>-01`) or header key-value (`D-02`).
 * @param {string} rawEntry
 */
export function extractQueryableTraceId(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'string') return '<trace-id>';
  const valPart = rawEntry.includes(':') ? rawEntry.split(':').slice(1).join(':').trim() : rawEntry.trim();
  const w3cMatch = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(valPart);
  if (w3cMatch) return w3cMatch[1];
  return redactSecrets(valPart);
}

/**
 * Data-driven rule table + structured `workbench-runtime-guard.json` signal classifier (`D-01`, `R1-3`).
 * Returns `{ categoryCode: 'A'|'B'|'C'|'D', category, confidence, candidates, guidance }`.
 * @param {string} errorText
 * @param {{ serverErrors?: string[], blockedRequests?: string[], pageErrors?: string[] } | null} [guardSignals]
 */
export function suggestFailureCategory(errorText, guardSignals = null) {
  const raw = String(errorText || '');
  const txt = raw.toLowerCase();

  // 1. Highest priority: Structured runtime guard attachment signals
  if (guardSignals) {
    if (Array.isArray(guardSignals.serverErrors) && guardSignals.serverErrors.length > 0) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Backend Defect)',
        confidence: 'high',
        candidates: ['C'],
        guidance:
          'Structured 5xx server error captured by runtime guard. NEVER weaken assertions or add test.skip/fixme; file a C-class defect with traceId.',
      };
    }
    if (Array.isArray(guardSignals.blockedRequests) && guardSignals.blockedRequests.length > 0) {
      return {
        categoryCode: 'B',
        category: 'B (Environment / Auth / Network)',
        confidence: 'high',
        candidates: ['B', 'A'],
        guidance:
          'Request blocked by outbound/mutation safety guard. Check TEST_ALLOWED_HOSTS, TEST_EGRESS_MODE, or add @mutation if state write is intentional.',
      };
    }
    if (Array.isArray(guardSignals.pageErrors) && guardSignals.pageErrors.length > 0) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Backend Defect)',
        confidence: 'medium-high',
        candidates: ['C'],
        guidance: 'Uncaught frontend exception captured by pageerror guard. Keep red and report product defect.',
      };
    }
  }

  // 2. Explicit Spec / Requirement Ambiguity -> Class D
  if (
    /ambiguous spec|requirement conflict|missing req-|todo:\s*confirm|notimplementederror|specification unclear|undocumented status|schema ambiguity/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'D',
      category: 'D (Needs Requirement / Spec Clarification)',
      confidence: 'medium-high',
      candidates: ['D'],
      guidance: 'Explicit specification ambiguity detected. Pause test edits and confirm expected behavior with user.',
    };
  }

  // 3. Backend 5xx, Uncaught PageError, Runtime Guard 5xx, HTTP 5xx contract failure -> Class C (`F-10` fix!)
  if (
    /\[same-origin 5xx guard\]|\[uncaught pageerror guard\]|server 5xx|status 50\d|\b50[0234]\b.*(?:internal server error|bad gateway|service unavailable|gateway timeout)|got 50\d\b|expected http \d+.*got 5\d\d|pageerror|uncaught (?:typeerror|referenceerror|syntaxerror|rangeerror)|json schema contract violation|openapi contract drift/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'high',
      candidates: ['C'],
      guidance:
        'Backend 5xx, uncaught frontend exception, or API contract violation. Do NOT weaken assertions or add test.skip/fixme; file a bug report with traceId.',
    };
  }

  // 4. Network Guard, Request Guard, Egress Block, Auth 401/403 (unexpected), DNS/TCP refusal -> Class B (`F-10` fix!)
  if (
    /\[ai test workbench network guard\]|\[ai test workbench request guard\]|\[ai test workbench target guard\]|\[ai test workbench config error\]|test_egress_mode|test_strict_readonly|blocked outbound request|blocked dangerous endpoint|blocked request to denied origin|econnrefused|enotfound|econnreset|etimedout|err_name_not_resolved|err_connection|net::err_|401 unauthorized|qa api login failed|target guard|test_allowed_hosts|storagestate/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'B',
      category: 'B (Environment / Auth / Network)',
      confidence: 'high',
      candidates: ['B'],
      guidance:
        'Environment, network firewall, or authentication failure. Do NOT rewrite business assertions; verify server reachability, .env allowlist, and storageState.',
    };
  }

  // 5. Locator / Strict Mode / DOM Synchronization Drift -> Class A
  if (
    /strict mode violation|resolved to \d+ elements|waiting for getby|waiting for locator|locator\(|timeout \d+ms exceeded.*(?:locator|getby|click|fill|visible)|element is not (?:visible|enabled|attached|stable)|element was detached|subtree intercepts pointer events/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'A',
      category: 'A (Test Script / Locator / Synchronization)',
      confidence: 'medium-high',
      candidates: ['A'],
      guidance:
        'Inspect ARIA snapshot in error-context.md. If UI locator drifted legitimately without business regression, repair semantic locator (max 3 attempts via aitest_heal_begin).',
    };
  }

  // 6. Business State / HTTP 4xx Status / Value Assertion Failure -> Class C (with A/D secondary verification) (`F-10` fix!)
  if (
    /expect\(.*\)\.(?:tobe|toequal|tostrictequal|tohavetext|tocontaintext|tohavevalue|tohavecount|tohaveurl|tohaveattribute|tobedisabled|tobeenabled|tomatchariasnapshot)|expected (?:string|substring|pattern|number|value):|expected:\s*.*\s*received:\s*/i.test(
      txt
    )
  ) {
    // Distinguish copy/text mismatch (dual candidate C/A) vs hard data/status regression (C)
    const isTextCopyMismatch = /tohavetext|tocontaintext|tomatchariasnapshot|expected string:/i.test(txt) && !/500|error|undefined|nan|null/i.test(txt);
    if (isTextCopyMismatch) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Copy Regression — Dual Candidate C/A)',
        confidence: 'medium',
        candidates: ['C', 'A'],
        guidance:
          'Rendered UI text/ARIA differs from expected assertion. Treat as Class C regression unless specs/*.md confirms an intentional UI copy update (Class A).',
      };
    }
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'medium-high',
      candidates: ['C'],
      guidance:
        'Business value or HTTP status assertion failed against expected contract. Keep red and report product defect with traceId.',
    };
  }

  // 7. Fallback ambiguous failure -> Class D
  return {
    categoryCode: 'D',
    category: 'D (Needs Requirement / Spec Clarification)',
    confidence: 'low',
    candidates: ['D'],
    guidance:
      'Ambiguous failure signature. Compare actual app behavior against specs/*.md and confirm expected behavior with user.',
  };
}

function extractAttachmentsAndErrorContext(resultObj, qaDir) {
  let tracePath = null;
  let errorContextText = null;
  let traceIds = [];
  let injectedTraceId = null;
  let timeWindow = null;
  let guardSignals = null;

  for (const att of resultObj.attachments || []) {
    let parsedGuard = null;
    if (att.name === 'workbench-runtime-guard.json' || att.name === 'workbench-trace-context.json') {
      try {
        if (att.body) {
          parsedGuard = JSON.parse(Buffer.from(att.body, 'base64').toString('utf8'));
        } else if (att.path) {
          const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
          if (fs.existsSync(resolved)) parsedGuard = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        }
      } catch {
        parsedGuard = null;
      }
      if (parsedGuard) {
        if (Array.isArray(parsedGuard.traceIds)) traceIds.push(...parsedGuard.traceIds);
        if (parsedGuard.injectedTraceId) injectedTraceId = parsedGuard.injectedTraceId;
        if (parsedGuard.timeWindow) timeWindow = parsedGuard.timeWindow;
        if (att.name === 'workbench-runtime-guard.json') {
          guardSignals = {
            serverErrors: parsedGuard.serverErrors || [],
            blockedRequests: parsedGuard.blockedRequests || [],
            pageErrors: parsedGuard.pageErrors || [],
          };
        }
      }
    }

    if (!att.path) continue;
    const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
    if (att.name === 'trace' || resolved.endsWith('trace.zip')) {
      tracePath = resolved;
    }
    if ((att.name === 'error-context' || resolved.endsWith('error-context.md')) && fs.existsSync(resolved)) {
      errorContextText = fs.readFileSync(resolved, 'utf8');
    }
  }

  if (!errorContextText && tracePath) {
    const candidate = path.join(path.dirname(tracePath), 'error-context.md');
    if (fs.existsSync(candidate)) {
      errorContextText = fs.readFileSync(candidate, 'utf8');
    }
  }

  return {
    tracePath,
    errorContextText,
    traceIds: [...new Set(traceIds)],
    injectedTraceId,
    timeWindow,
    guardSignals,
  };
}

function loadCodeMapCorrelations(qaDir, specFile) {
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return null;
  try {
    const cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
    const normalizedSpec = String(specFile || '').replace(/\\/g, '/');
    const matchedRoutes = Object.values(cm.routes || {}).filter((r) =>
      (r.coveringSpecs || []).some((s) => normalizedSpec.endsWith(s) || s.endsWith(normalizedSpec))
    );
    if (matchedRoutes.length === 0) return null;
    return {
      routes: matchedRoutes.map((r) => r.route),
      frontendFiles: [...new Set(matchedRoutes.map((r) => r.frontendFile).filter(Boolean))],
      backendFiles: [...new Set(matchedRoutes.flatMap((r) => r.linkedBackendFiles || []))],
      dbTables: [...new Set(matchedRoutes.flatMap((r) => r.linkedDbTables || []))],
      apis: [...new Set(matchedRoutes.flatMap((r) => r.linkedApis || []))],
    };
  } catch {
    return null;
  }
}

/**
 * Structured failure diagnosis returning both Markdown report and typed `diagnosedFailures` array (`R1-3`).
 */
export function generateDiagnosticsMarkdown(qaDir, resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Results file not found: ${resultsPath}`);
  }
  const resultsJson = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const failures = [];
  for (const suite of resultsJson.suites || []) {
    failures.push(...flattenFailedTests(suite));
  }

  const lines = [
    '# AI Test Workbench — Failure Diagnostics Summary (Redacted)',
    '',
    `> Generated at: ${new Date().toISOString()}`,
    '> **Security & Governance Notice**: Credentials in text snippets are automatically redacted, but raw `trace.zip` and video files may still contain rendered session data — treat report directories as sensitive artifacts.',
    '> **Triage Notice**: Categories below follow structured runtime-guard + rule-table triage. Use `aitest_heal_begin` to enforce A/B/C/D governance; NEVER use `test.skip`, `test.fixme`, or assertion weakening.',
    '',
  ];

  if (failures.length === 0) {
    lines.push('No unexpected or flaky test failures found in `results.json`.');
    return { failureCount: 0, failures: [], markdown: lines.join('\n') + '\n' };
  }

  lines.push(`Total Failing / Flaky Specs: **${failures.length}**`, '');
  const diagnosedFailures = [];

  failures.forEach((f, idx) => {
    const lastResult = f.results[f.results.length - 1] || {};
    const rawErr =
      lastResult.error?.stack ||
      lastResult.error?.message ||
      (lastResult.errors || []).map((e) => e.message).join('\n') ||
      'No error message recorded';
    const cleanErr = redactSecrets(rawErr);
    const { tracePath, errorContextText, traceIds, injectedTraceId, timeWindow, guardSignals } =
      extractAttachmentsAndErrorContext(lastResult, qaDir);
    const triage = suggestFailureCategory(cleanErr, guardSignals);
    const codeCorr = loadCodeMapCorrelations(qaDir, f.file);
    const queryTraceId = injectedTraceId || (traceIds[0] ? extractQueryableTraceId(traceIds[0]) : '<trace-id>');
    const normFile = String(f.file || '').replace(/\\/g, '/');
    const testId = `${normFile}::${f.title}`;

    diagnosedFailures.push({
      testId,
      title: redactSecrets(f.title),
      file: normFile,
      line: f.line,
      projectName: f.projectName,
      status: f.status,
      categoryCode: triage.categoryCode,
      category: triage.category,
      confidence: triage.confidence,
      candidates: triage.candidates,
      guidance: triage.guidance,
      traceId: queryTraceId === '<trace-id>' ? null : queryTraceId,
      traceIds: traceIds.map((id) => extractQueryableTraceId(id)),
      traceZipPath: tracePath,
      timeWindow,
      errorSnippet: cleanErr.slice(0, 800),
      codeCorrelation: codeCorr,
    });

    lines.push(`## ${idx + 1}. ${redactSecrets(f.title)}`);
    lines.push(`- **Test ID**: \`${redactSecrets(testId)}\``);
    lines.push(`- **Location**: \`${normFile}:${f.line}\` (project: \`${f.projectName}\`, status: \`${f.status}\`)`);
    lines.push(
      `- **Suggested Category**: **${triage.category}** *(confidence: ${triage.confidence}, candidates: ${triage.candidates.join('/')})*`
    );
    lines.push(`- **Action Guidance**: ${triage.guidance}`);
    if (timeWindow) {
      lines.push(`- **Test Time Window**: \`${timeWindow.startedAt}\` → \`${timeWindow.finishedAt}\``);
    }
    if (traceIds.length > 0 || injectedTraceId) {
      lines.push(`- **Queryable 32-char Trace ID**: \`${queryTraceId}\``);
      lines.push(
        `- **Captured Trace Headers**: ${traceIds
          .slice(0, 6)
          .map((id) => `\`${redactSecrets(id)}\``)
          .join(', ')}`
      );
    }
    if (tracePath) {
      lines.push(`- **Trace Replay**: \`npx playwright show-trace "${tracePath}"\``);
    }

    if (codeCorr || traceIds.length > 0 || injectedTraceId || timeWindow) {
      lines.push('', '### Full-Link Code Map & Multi-MCP Root-Cause Playbook');
      if (codeCorr) {
        if (codeCorr.routes.length > 0) lines.push(`- **CodeMap Routes**: ${codeCorr.routes.map((r) => `\`${r}\``).join(', ')}`);
        if (codeCorr.frontendFiles.length > 0)
          lines.push(`- **Frontend Source**: ${codeCorr.frontendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.backendFiles.length > 0)
          lines.push(`- **Backend Controllers**: ${codeCorr.backendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.dbTables.length > 0)
          lines.push(`- **Linked DB Entities**: ${codeCorr.dbTables.map((t) => `\`${t}\``).join(', ')}`);
      }
      lines.push(
        `- **Loki / Tempo MCP Query**: \`{env=~"staging|test"} |= "${queryTraceId}"\``,
        `- **Prometheus MCP Query**: \`sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))\``,
        `- **Sentry MCP**: filter unresolved issues within \`${timeWindow?.startedAt || 'last 15m'}\` to \`${timeWindow?.finishedAt || 'now'}\``
      );
      if (codeCorr?.dbTables && codeCorr.dbTables.length > 0 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(codeCorr.dbTables[0])) {
        lines.push(`- **Read-Only DB MCP Check**: \`SELECT COUNT(*) FROM ${codeCorr.dbTables[0]} LIMIT 1;\``);
      }
    }

    lines.push('', '### Error Snippet (Redacted)', '```text', cleanErr.slice(0, 2500), '```', '');

    if (errorContextText) {
      lines.push(
        '### Official Playwright `error-context.md` (Redacted ARIA Snapshot)',
        '```markdown',
        redactSecrets(errorContextText).slice(0, 3500),
        '```',
        ''
      );
    }
  });

  return { failureCount: failures.length, failures: diagnosedFailures, markdown: lines.join('\n') + '\n' };
}

export async function runDiagnoseCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未在 ${options.target} 找到 QA 目录` : `QA directory not found under ${options.target}`);
    return 1;
  }

  const resultsPath = options.results
    ? path.resolve(qaDir, options.results)
    : path.join(qaDir, 'reports', 'results.json');
  const outPath = options.output
    ? path.resolve(qaDir, options.output)
    : path.join(qaDir, 'reports', 'ai-diagnostics.md');

  if (!fs.existsSync(resultsPath)) {
    console.error(lang === 'zh' ? `未找到测试结果文件: ${resultsPath}` : `Results JSON not found: ${resultsPath}`);
    return 1;
  }

  const { failureCount, failures, markdown } = generateDiagnosticsMarkdown(qaDir, resultsPath);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          failureCount,
          failures,
          resultsPath,
          outputPath: options.dryRun ? null : outPath,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(
    lang === 'zh'
      ? `[Diagnose] 已生成脱敏诊断简报 (${failureCount} 条异常/波动): ${outPath}`
      : `[Diagnose] Wrote redacted diagnostics report (${failureCount} failing/flaky): ${outPath}`
  );
  return 0;
}
