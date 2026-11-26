// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { WORKBENCH_VERSION } from '../core/version.mjs';
import {
  listChangedFilesUnderDir,
  openTrustContext,
  verifyPayloadT1,
} from '../kernel/gate-kernel.mjs';
import {
  TRUST_LEVEL_DEFINITIONS,
  buildInTotoVerdictAttestation,
  describeTrustLevel,
  tryCosignKeylessSign,
} from '../trust.mjs';
import { buildSeamGatekeeperCard, renderSeamGatekeeperMarkdown } from './seam-card.mjs';

/**
 * @param {Record<string, any>} verdictObj
 */
export function buildSarifReport(verdictObj) {
  const results = [];
  for (const errMsg of verdictObj.gateErrors || []) {
    const codeMatch = /\[(AITEST-G\d+|Governance Tamper Blocked|Stale Results Blocked|Run Ledger Blocked|Heal Governance Blocked|Static Check)\]/.exec(
      errMsg
    );
    results.push({
      ruleId: codeMatch ? codeMatch[1].replace(/\s+/g, '-') : 'AITEST-GATE-FAILURE',
      level: 'error',
      message: { text: errMsg },
    });
  }
  for (const f of verdictObj.failures || []) {
    results.push({
      ruleId: `AITEST-TEST-CLASS-${f.categoryCode || 'U'}`,
      level: 'error',
      message: { text: `[${f.category}] ${f.title}: ${f.errorSnippet || ''}`.slice(0, 500) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region: { startLine: Math.max(1, Number(f.line || 1)) },
          },
        },
      ],
    });
  }

  const trustLevel = verdictObj.trustLevel || verdictObj.trustTier || 'T0';
  const trustDef =
    trustLevel === 'T2'
      ? TRUST_LEVEL_DEFINITIONS.T2
      : trustLevel === 'T1'
        ? TRUST_LEVEL_DEFINITIONS.T1
        : TRUST_LEVEL_DEFINITIONS.T0;

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ai-test-workbench',
            version: WORKBENCH_VERSION,
            informationUri: 'https://github.com/seaworld008/ai-test-workbench',
          },
        },
        properties: {
          verdict: verdictObj.verdict,
          trustLevel,
          mergeGradeGreen: trustDef.mergeGradeGreen && verdictObj.verdict === 'pass',
          trustLevelDefinition: {
            zh: trustDef.zh,
            en: trustDef.en,
          },
          acceptanceScope: verdictObj.acceptanceScope,
          runId: verdictObj.runId || null,
        },
        results,
      },
    ],
  };
}

/**
 * @param {Record<string, any>} verdict
 * @param {'zh' | 'en' | string} [lang]
 * @returns {string}
 */
export function buildPrVerdictMarkdown(verdict, lang = 'zh') {
  const isZh = lang === 'zh';
  const badge =
    verdict.verdict === 'pass'
      ? 'PASS'
      : verdict.verdict === 'blocked'
        ? 'BLOCKED'
        : 'FAIL';
  const trustLevel = verdict.trustLevel || verdict.trustTier || 'T0';
  const trustLabel = describeTrustLevel(trustLevel, isZh ? 'zh' : 'en');
  const scopeLabel =
    verdict.acceptanceScope === 'business-e2e'
      ? isZh
        ? '真实业务 E2E 验收'
        : 'Business E2E Verified'
      : isZh
        ? '本机工作台离线验收（非远端业务 E2E）'
        : 'Local Workbench Verified (Offline Smoke Only)';

  const lines = [
    isZh
      ? `## AI Test Workbench 变更验证判决：**${badge}**（\`${trustLevel}\`）`
      : `## AI Test Workbench Change Verdict: **${badge}** (\`${trustLevel}\`)`,
    '',
    `- **Trust Level**: **${trustLabel}**`,
    `- **合入级绿灯 (\`mergeGradeGreen\`)**: \`${trustLevel === 'T2' && verdict.verdict === 'pass'}\`（${isZh ? '仅 T2 可作为合入级绿灯' : 'Only T2 is a merge-grade green'}）`,
    `- **Run ID**: \`${verdict.runId || 'none'}\` · **Git SHA**: \`${verdict.gitSha}\` · **Diff Base**: \`${verdict.base?.resolved || 'none'}\` (${verdict.base?.strategy || 'unknown'})`,
    `- **验收口径 (\`acceptanceScope\`)**: **${scopeLabel}** (\`${verdict.acceptanceScope}\`)`,
    `- **测试范围**: requested=\`${verdict.scope.requested}\`, actual=\`${verdict.scope.actual}\`${verdict.scope.downgraded ? ' **(DOWNGRADED -> T0)**' : ''}, executed=\`${verdict.counts?.executed ?? 0}\` (passed=\`${verdict.counts?.passed ?? 0}\`, failed=\`${verdict.counts?.failed ?? 0}\`, flaky=\`${verdict.counts?.flaky ?? 0}\`)`,
    `- **四层门禁**: governance=\`${verdict.gates.governance}\` · static=\`${verdict.gates.static}\` · runtime=\`${verdict.gates.runtime}\` · semanticDiff=\`${verdict.gates.semanticDiff}\``,
    `- **需求追溯**: \`${verdict.traceability.coveredRequirements}/${verdict.traceability.totalRequirements}\` (${verdict.traceability.coveragePct}%)`,
    `- **AI-BOM**: llmCalls=\`${verdict.ai?.llmCalls ?? 0}\``,
    '',
  ];

  if (verdict.seamReview) {
    lines.push(...renderSeamGatekeeperMarkdown(verdict.seamReview, lang));
  }

  if (verdict.failures.length > 0) {
    lines.push(isZh ? '### 失败定责与根因证据' : '### Failure Triage & Trace Evidence');
    for (const f of verdict.failures) {
      lines.push(
        `- **[${f.categoryCode}]** \`${f.file}:${f.line}\` — ${f.title} (traceId=\`${f.traceId || 'n/a'}\`, confidence=\`${f.confidence}\`)`
      );
    }
    lines.push('');
  }

  if (verdict.gateErrors.length > 0) {
    lines.push(isZh ? '### 门禁拦截明细' : '### Quality Gate Violations');
    for (const e of verdict.gateErrors) lines.push(`- ${e}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Canonicalizes a filesystem path via `realpathSync.native` so Windows short paths
 * and macOS symlinks match `git rev-parse --show-toplevel` cleanly.
 * @param {string} p
 * @returns {string}
 */
function canonicalizeFsPath(p) {
  const resolved = path.resolve(p);
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Checks `.aitest/heals/*.json` against modified specs in the current diff (`T-07`).
 * @param {string} qaDir
 * @param {{ isGitRepo?: boolean, gitRoot?: string | null, resolved?: string | null }} baseResolution
 * @param {import('../kernel/gate/trust-context.mjs').TrustContext | null} [trustContext]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkHealSessionConflicts(qaDir, baseResolution, trustContext = null) {
  const healsDir = path.join(qaDir, '.aitest', 'heals');
  if (!fs.existsSync(healsDir)) return { ok: true, errors: [] };

  const repoDir = path.dirname(qaDir);
  const ctx = trustContext || openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  /** @type {string[]} */
  const errors = [];
  /** @type {Set<string>} */
  const changedInsideQa = new Set();

  if (baseResolution?.isGitRepo && baseResolution.gitRoot && baseResolution.resolved) {
    const realQaDir = canonicalizeFsPath(qaDir);
    const realGitRoot = canonicalizeFsPath(baseResolution.gitRoot);
    const ch = listChangedFilesUnderDir(realGitRoot, baseResolution.resolved, realQaDir);
    if (ch.ok) {
      for (const item of ch.changed) {
        const rel = path.relative(realQaDir, path.join(realGitRoot, item.path)).replace(/\\/g, '/');
        changedInsideQa.add(rel);
        if (item.oldPath) {
          const oldRel = path.relative(realQaDir, path.join(realGitRoot, item.oldPath)).replace(/\\/g, '/');
          changedInsideQa.add(oldRel);
        }
      }
      for (const u of ch.untracked) {
        const rel = path.relative(realQaDir, path.join(realGitRoot, u)).replace(/\\/g, '/');
        changedInsideQa.add(rel);
      }
    }
  }

  const allEntries = fs.readdirSync(healsDir).filter((name) => name.endsWith('.json'));
  const sessionFiles = allEntries.filter((name) => name !== 'ledger.json');
  const ledgerPath = path.join(healsDir, 'ledger.json');
  if (sessionFiles.length > 0 && !fs.existsSync(ledgerPath)) {
    errors.push(
      `[Heal Governance Blocked] Heal ledger "${ledgerPath}" is missing while heal session file(s) exist (T1 sticky tampering detected).`
    );
  } else if (fs.existsSync(ledgerPath)) {
    try {
      const ledgerObj = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const ledgerMac = verifyPayloadT1('heal.ledger', ledgerObj, ledgerObj.mac, {
        qaDir,
        repoDir,
        macs: ledgerObj.macs || null,
        trustContext: ctx,
      });
      if (!ledgerMac.ok) {
        errors.push(`[Heal Governance Blocked] Tampered heal ledger: ${ledgerMac.reason}`);
      } else if (Array.isArray(ledgerObj.activeSessionIds)) {
        const presentSet = new Set(sessionFiles.map((n) => n.replace(/\.json$/, '')));
        for (const sid of ledgerObj.activeSessionIds) {
          if (!presentSet.has(sid)) {
            errors.push(
              `[Heal Governance Blocked] Active heal session "${sid}" missing from .aitest/heals/ (session file deletion tampering detected).`
            );
          }
        }
      }
    } catch {
      errors.push('[Heal Governance Blocked] Corrupted heal ledger file "ledger.json".');
    }
  }

  for (const name of sessionFiles) {
    const full = path.join(healsDir, name);
    try {
      const session = JSON.parse(fs.readFileSync(full, 'utf8'));
      const macCheck = verifyPayloadT1('heal.session', session, session.mac, {
        qaDir,
        repoDir,
        macs: session.macs || null,
        trustContext: ctx,
      });
      if (!macCheck.ok) {
        errors.push(`[Heal Governance Blocked] Tampered heal session "${session.sessionId || name}": ${macCheck.reason}`);
        continue;
      }

      const isNonA = session.categoryCode && session.categoryCode !== 'A';
      const isOpen = session.state !== 'concluded' && session.state !== 'verified' && session.state !== 'discarded';
      const specFile = String(session.specFile || '').replace(/\\/g, '/');
      if (isNonA && isOpen && specFile && changedInsideQa.has(specFile)) {
        errors.push(
          `[Heal Governance Blocked] Spec "${specFile}" was modified while non-repairable Class-${session.categoryCode} heal session "${session.sessionId}" is open. Revert spec edit and conclude as defect/escalation.`
        );
      }
    } catch {
      errors.push(`[Heal Governance Blocked] Corrupted heal session file "${name}".`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Persists PR Markdown summary, SARIF 2.1.0 report, CI step summary, and in-toto attestation artifacts.
 * @param {{
 *   qaDir: string,
 *   repoDir: string,
 *   lang: string,
 *   baseResolution?: { isGitRepo?: boolean, gitRoot?: string | null, resolved?: string | null } | null,
 *   verdictPayload: Record<string, any>,
 *   treeDigest: string | null,
 *   auditOut: Record<string, any>,
 *   gateKernelVersion: string,
 * }} params
 */
export function writeVerdictArtifacts({
  qaDir,
  repoDir,
  lang,
  baseResolution,
  verdictPayload,
  treeDigest,
  auditOut,
  gateKernelVersion,
}) {
  if (!verdictPayload.seamReview) {
    verdictPayload.seamReview = buildSeamGatekeeperCard({
      qaDir,
      repoDir,
      baseResolution: baseResolution || null,
      verdictPayload,
    });
  }
  const reportsDir = path.join(qaDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const mdSummary = buildPrVerdictMarkdown(verdictPayload, lang);
  const sarifObj = buildSarifReport(verdictPayload);
  const summaryMdPath = path.join(reportsDir, 'verdict-summary.md');
  const sarifPath = path.join(reportsDir, 'verdict.sarif.json');
  fs.writeFileSync(summaryMdPath, mdSummary, 'utf8');
  fs.writeFileSync(sarifPath, JSON.stringify(sarifObj, null, 2) + '\n', 'utf8');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${mdSummary}\n`, 'utf8');
    } catch {
      // ignore CI step summary write failure
    }
  }

  let attestationPath = null;
  let predicatePath = null;
  let sigstoreBundlePath = null;
  if (verdictPayload.runId) {
    const runDir = path.join(qaDir, '.aitest', 'runs', verdictPayload.runId);
    fs.mkdirSync(runDir, { recursive: true });
    attestationPath = path.join(runDir, 'attestation.json');
    predicatePath = path.join(runDir, 'verdict-predicate.json');
    const statement = buildInTotoVerdictAttestation({
      verdictPayload,
      qaDir,
      repoDir,
      treeDigest,
      resultsDigest: auditOut.evidence?.resultsDigest,
      lockDigest: auditOut.evidence?.lockDigest,
      gateKernelVersion,
    });
    fs.writeFileSync(attestationPath, JSON.stringify(statement, null, 2) + '\n', 'utf8');
    fs.writeFileSync(predicatePath, JSON.stringify(statement.predicate, null, 2) + '\n', 'utf8');

    const cosignRes = tryCosignKeylessSign(attestationPath);
    if (cosignRes.signed) {
      sigstoreBundlePath = cosignRes.bundlePath;
    }
  }

  return {
    summaryMdPath,
    sarifPath,
    attestationPath,
    predicatePath,
    sigstoreBundlePath,
    seamReview: verdictPayload.seamReview,
  };
}
