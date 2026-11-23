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
      if (testItem.status === 'unexpected' || testItem.status === 'flaky') {
        failures.push({
          title,
          file: spec.file || currentFile || 'unknown',
          line: spec.line || 0,
          projectName: testItem.projectName || '',
          status: testItem.status,
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
 * Advisory A/B/C/D classification heuristic with explicit confidence level.
 * Never presented as ground truth — Healer must verify against live DOM/spec.
 */
export function suggestFailureCategory(errorText) {
  const txt = (errorText || '').toLowerCase();

  if (
    /econnrefused|enotfound|err_name_not_resolved|err_connection|401 unauthorized|403 forbidden|target guard|test_allowed_hosts|storageState/i.test(
      txt
    )
  ) {
    return {
      category: 'B (Environment / Auth / Network)',
      confidence: 'medium-high',
      guidance: 'Do NOT rewrite business assertions. Verify server reachability, .env allowlist, and storageState credentials first.',
    };
  }

  if (
    /strict mode violation|resolved to \d+ elements|waiting for getby|waiting for locator|locator\(|timeout \d+ms exceeded.*locator/i.test(
      txt
    )
  ) {
    return {
      category: 'A (Test Script / Locator / Synchronization)',
      confidence: 'medium',
      guidance: 'Inspect ARIA snapshot in error-context.md. If UI changed legitimately, update semantic locator; max 3 repair attempts.',
    };
  }

  if (/server 5xx|status 50\d|pageerror|uncaught|expect\(received\)\.(tobe|toequal|tohavetext|tohaveurl|tocontain)/i.test(txt)) {
    return {
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'medium',
      guidance: 'Do NOT weaken assertions or add test.skip/fixme. File a bug report with reproduction steps and Trace path.',
    };
  }

  return {
    category: 'D (Needs Requirement / Spec Clarification)',
    confidence: 'low',
    guidance: 'Ambiguous failure signature. Compare actual app behavior against specs/*.md and confirm expected behavior with user.',
  };
}

function extractAttachmentsAndErrorContext(resultObj, qaDir) {
  let tracePath = null;
  let errorContextText = null;
  let traceIds = [];
  let timeWindow = null;

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
        if (parsedGuard.timeWindow) timeWindow = parsedGuard.timeWindow;
      }
    }

    if (!att.path) continue;
    const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
    if (att.name === 'trace' || resolved.endsWith('trace.zip')) {
      tracePath = resolved;
    }
    if (
      (att.name === 'error-context' || resolved.endsWith('error-context.md')) &&
      fs.existsSync(resolved)
    ) {
      errorContextText = fs.readFileSync(resolved, 'utf8');
    }
  }

  // Also check sibling error-context.md next to trace/attachment directory if Playwright placed it in outputDir
  if (!errorContextText && tracePath) {
    const candidate = path.join(path.dirname(tracePath), 'error-context.md');
    if (fs.existsSync(candidate)) {
      errorContextText = fs.readFileSync(candidate, 'utf8');
    }
  }

  return { tracePath, errorContextText, traceIds: [...new Set(traceIds)], timeWindow };
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
    '> **Triage Notice**: Categories below are **advisory suggestions with confidence levels**, NOT final verdicts. Never use `test.skip`, `test.fixme`, or assertion deletion to force a green build.',
    '',
  ];

  if (failures.length === 0) {
    lines.push('No unexpected or flaky test failures found in `results.json`.');
    return { failureCount: 0, markdown: lines.join('\n') + '\n' };
  }

  lines.push(`Total Failing / Flaky Specs: **${failures.length}**`, '');

  failures.forEach((f, idx) => {
    const lastResult = f.results[f.results.length - 1] || {};
    const rawErr =
      lastResult.error?.stack ||
      lastResult.error?.message ||
      (lastResult.errors || []).map((e) => e.message).join('\n') ||
      'No error message recorded';
    const cleanErr = redactSecrets(rawErr);
    const { tracePath, errorContextText, traceIds, timeWindow } = extractAttachmentsAndErrorContext(lastResult, qaDir);
    const triage = suggestFailureCategory(cleanErr);
    const codeCorr = loadCodeMapCorrelations(qaDir, f.file);

    lines.push(`## ${idx + 1}. ${redactSecrets(f.title)}`);
    lines.push(`- **Location**: \`${f.file}:${f.line}\` (project: \`${f.projectName}\`, status: \`${f.status}\`)`);
    lines.push(`- **Suggested Category**: **${triage.category}** *(confidence: ${triage.confidence})*`);
    lines.push(`- **Action Guidance**: ${triage.guidance}`);
    if (timeWindow) {
      lines.push(`- **Test Time Window**: \`${timeWindow.startedAt}\` → \`${timeWindow.finishedAt}\``);
    }
    if (traceIds.length > 0) {
      lines.push(`- **Captured Distributed Trace IDs**: ${traceIds.slice(0, 6).map((id) => `\`${redactSecrets(id)}\``).join(', ')}`);
    }
    if (tracePath) {
      lines.push(`- **Trace Replay**: \`npx playwright show-trace "${tracePath}"\``);
    }

    if (codeCorr || traceIds.length > 0 || timeWindow) {
      lines.push('', '### Full-Link Code Map & Multi-MCP Root-Cause Playbook');
      if (codeCorr) {
        if (codeCorr.routes.length > 0) lines.push(`- **CodeMap Routes**: ${codeCorr.routes.map((r) => `\`${r}\``).join(', ')}`);
        if (codeCorr.frontendFiles.length > 0) lines.push(`- **Frontend Source**: ${codeCorr.frontendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.backendFiles.length > 0) lines.push(`- **Backend Controllers**: ${codeCorr.backendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.dbTables.length > 0) lines.push(`- **Linked DB Entities**: ${codeCorr.dbTables.map((t) => `\`${t}\``).join(', ')}`);
      }
      const primaryTrace = traceIds[0] ? redactSecrets(traceIds[0].split(':').slice(1).join(':')) : '<trace-id>';
      lines.push(
        `- **Loki MCP Query**: \`{env=~"staging|test"} |= "${primaryTrace}"\``,
        `- **Prometheus MCP Query**: \`sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))\``,
        `- **Sentry MCP**: filter unresolved issues within \`${timeWindow?.startedAt || 'last 15m'}\` to \`${timeWindow?.finishedAt || 'now'}\``
      );
      if (codeCorr?.dbTables?.length > 0) {
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

  return { failureCount: failures.length, markdown: lines.join('\n') + '\n' };
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

  const { failureCount, markdown } = generateDiagnosticsMarkdown(qaDir, resultsPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');

  console.log(
    lang === 'zh'
      ? `[Diagnose] 已生成脱敏诊断简报 (${failureCount} 条异常/波动): ${outPath}`
      : `[Diagnose] Wrote redacted diagnostics report (${failureCount} failing/flaky): ${outPath}`
  );
  return 0;
}
