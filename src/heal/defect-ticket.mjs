// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../core/redact.mjs';

/**
 * Writes redacted JSON + Markdown defect ticket artifacts for Class C or reported heal sessions,
 * enriched with `codeCorrelation`, `traceIds`, run `timeWindow`, and Loki / VictoriaLogs queries.
 * @param {string} qaDir
 * @param {Record<string, any>} session
 * @param {string} summaryNote
 * @returns {string}
 */
export function writeDefectTicketFiles(qaDir, session, summaryNote) {
  const defectsDir = path.join(qaDir, 'reports', 'defects');
  fs.mkdirSync(defectsDir, { recursive: true });
  const defectTicketPath = path.join(defectsDir, `${session.sessionId}.md`);
  const ticketJsonPath = path.join(defectsDir, `${session.sessionId}.json`);
  const traceIds = Array.isArray(session.traceIds) && session.traceIds.length > 0
    ? session.traceIds
    : session.traceId
      ? [session.traceId]
      : [];
  const primaryTraceId = session.traceId || traceIds[0] || '<trace-id>';
  const timeWindow = session.timeWindow || null;
  const codeCorr = session.codeCorrelation || null;
  const observabilityQueries = {
    lokiLogQl: `{env=~"staging|test"} |= "${primaryTraceId}"`,
    victoriaLogsQl: [`_msg:"${primaryTraceId}"`, `_time:15m "${primaryTraceId}"`],
  };

  const ticketObj = {
    sessionId: session.sessionId,
    createdAt: new Date().toISOString(),
    category: session.category,
    testId: session.testId,
    specFile: session.specFile,
    line: session.line,
    traceId: session.traceId,
    traceIds,
    timeWindow,
    codeCorrelation: codeCorr,
    observabilityQueries,
    summary: summaryNote,
    errorSnippet: session.errorSnippet,
  };
  fs.writeFileSync(ticketJsonPath, JSON.stringify(ticketObj, null, 2) + '\n', 'utf8');

  const lines = [
    `# Defect Ticket (${session.sessionId}) — ${session.title}`,
    '',
    `- **Classification**: **${session.category}**`,
    `- **Failing Spec**: \`${session.specFile}:${session.line}\` *(Kept RED per Anti-Fake-Green Iron Rule)*`,
    `- **32-char Distributed Trace ID**: \`${session.traceId || 'n/a'}\``,
    ...(traceIds.length > 0
      ? [`- **Captured Trace IDs**: ${traceIds.map((id) => `\`${redactSecrets(String(id))}\``).join(', ')}`]
      : []),
    ...(timeWindow?.startedAt || timeWindow?.finishedAt
      ? [`- **Run Time Window**: \`${timeWindow.startedAt || 'unknown'}\` -> \`${timeWindow.finishedAt || 'unknown'}\``]
      : []),
    `- **Summary**: ${summaryNote}`,
    '',
  ];

  if (codeCorr) {
    lines.push('## Code Correlation');
    if (Array.isArray(codeCorr.routes) && codeCorr.routes.length > 0) {
      lines.push(`- **Routes**: ${codeCorr.routes.map((/** @type {string} */ r) => `\`${r}\``).join(', ')}`);
    }
    if (Array.isArray(codeCorr.frontendFiles) && codeCorr.frontendFiles.length > 0) {
      lines.push(`- **Frontend Files**: ${codeCorr.frontendFiles.map((/** @type {string} */ f) => `\`${f}\``).join(', ')}`);
    }
    if (Array.isArray(codeCorr.backendFiles) && codeCorr.backendFiles.length > 0) {
      lines.push(`- **Backend Files**: ${codeCorr.backendFiles.map((/** @type {string} */ f) => `\`${f}\``).join(', ')}`);
    }
    if (Array.isArray(codeCorr.dbTables) && codeCorr.dbTables.length > 0) {
      lines.push(`- **DB Tables**: ${codeCorr.dbTables.map((/** @type {string} */ t) => `\`${t}\``).join(', ')}`);
    }
    if (Array.isArray(codeCorr.apis) && codeCorr.apis.length > 0) {
      lines.push(`- **Linked APIs**: ${codeCorr.apis.map((/** @type {string} */ a) => `\`${a}\``).join(', ')}`);
    }
    lines.push('');
  }

  lines.push(
    '## Observability Queries',
    `- **Grafana Loki (LogQL)**: \`${observabilityQueries.lokiLogQl}\``,
    `- **VictoriaLogs (LogsQL)**: \`${observabilityQueries.victoriaLogsQl[0]}\` · \`${observabilityQueries.victoriaLogsQl[1]}\``,
    '',
    '## Error Evidence (Redacted)',
    '```text',
    session.errorSnippet || '',
    '```',
    ''
  );
  fs.writeFileSync(defectTicketPath, lines.join('\n'), 'utf8');
  return defectTicketPath;
}
