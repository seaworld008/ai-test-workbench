// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDefaultDiffBase } from '../audit.mjs';
import {
  execGitSync,
  getFileAtGitRef,
  openTrustContext,
  sha256Hex,
  signPayloadT1,
  verifyPayloadT1,
} from '../kernel/gate-kernel.mjs';

export const MAX_HEAL_ATTEMPTS = 3;

/**
 * Computes a deterministic hash of non-`qa/` product application code in `repoDir` so
 * product-code fixes reset the per-(testId, appCodeTreeHash) heal attempt quota (`WU-04`).
 * @param {string} repoDir
 * @returns {string}
 */
export function computeAppCodeTreeHash(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return 'noapp';
  const baseRes = resolveDefaultDiffBase(repoDir);
  if (baseRes.isGitRepo && baseRes.gitRoot) {
    const ls = execGitSync(baseRes.gitRoot, ['ls-files', '--stage', '-z']);
    const wt = execGitSync(baseRes.gitRoot, ['status', '--porcelain', '-z']);
    const h = crypto.createHash('sha256');
    for (const row of String(ls.stdout || '').split('\0')) {
      if (!row) continue;
      const tabIdx = row.indexOf('\t');
      const fileRel = tabIdx >= 0 ? row.slice(tabIdx + 1) : row;
      if (fileRel === 'qa' || fileRel.startsWith('qa/') || fileRel.includes('/qa/')) continue;
      h.update(row).update('\0');
    }
    const wtRows = String(wt.stdout || '').split('\0');
    for (let i = 0; i < wtRows.length; i += 1) {
      const wrow = wtRows[i];
      if (!wrow || wrow.length < 4) continue;
      const xy = wrow.slice(0, 2);
      const fileRel = wrow.slice(3).replace(/\\/g, '/');
      let origRel = '';
      if (xy.includes('R') || xy.includes('C')) {
        i += 1;
        origRel = String(wtRows[i] || '').replace(/\\/g, '/');
      }
      const isQa = (/** @type {string} */ p) => p === 'qa' || p.startsWith('qa/') || p.includes('/qa/');
      if (isQa(fileRel) && (!origRel || isQa(origRel))) continue;
      const abs = path.join(baseRes.gitRoot, fileRel);
      h.update(wrow).update('\0');
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        h.update(fs.readFileSync(abs));
      }
      h.update('\0');
    }
    return `sha256:${h.digest('hex').slice(0, 24)}`;
  }

  // Fallback for non-git workspaces: hash regular files outside `qa/` and `node_modules`
  /** @type {string[]} */
  const entries = [];
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth = 0) => {
    if (depth > 4 || entries.length > 200) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === 'qa' || ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) {
        const rel = path.relative(repoDir, full).replace(/\\/g, '/');
        entries.push(`${rel}:${sha256Hex(fs.readFileSync(full, 'utf8')).slice(0, 12)}`);
      }
    }
  };
  walk(repoDir);
  return `sha256:${sha256Hex(entries.join('\n')).slice(0, 24)}`;
}

/**
 * @typedef {{ attemptsUsed: number, appCodeTreeHash?: string | null, lastSessionId: string, updatedAt: string }} HealLedgerEntry
 * @typedef {{
 *   schemaVersion: number,
 *   sessionId: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   state: string,
 *   testId: string,
 *   appCodeTreeHash?: string | null,
 *   title: string,
 *   specFile: string,
 *   line: number,
 *   categoryCode: string,
 *   category: string,
 *   confidence: string,
 *   candidates: string[],
 *   traceId: string | null,
 *   errorSnippet: string,
 *   codeCorrelation: Record<string, any> | null,
 *   repairPermitted: boolean,
 *   maxAttempts: number,
 *   attemptsUsed: number,
 *   remainingAttempts: number,
 *   baselineSource: string,
 *   baselineSha: string | null,
 *   allowedActions: string[],
 *   baselineSpecContent: string,
 *   attempts: Array<Record<string, any>>,
 *   conclusion: Record<string, any> | null,
 *   mac?: string | Record<string, any> | null,
 *   macKeyId?: string | null,
 *   macs?: Record<string, string> | null,
 * }} HealSession
 */

/** @param {string} qaDir */
export function getHealsDir(qaDir) {
  return path.join(qaDir, '.aitest', 'heals');
}

/** @param {string} qaDir @param {string | undefined} sessionId */
export function getSessionPath(qaDir, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(getHealsDir(qaDir), `${safeId}.json`);
}

/** @param {string} qaDir */
export function getHealLedgerPath(qaDir) {
  return path.join(getHealsDir(qaDir), 'ledger.json');
}

/**
 * Reads cross-session per-`testId` attempt counters (`T-07`, `A-6`).
 * @param {string} qaDir
 * @param {import('../kernel/gate/trust-context.mjs').TrustContext | null} [trustContext]
 * @returns {{ ok: true, byTestId: Record<string, HealLedgerEntry>, activeSessionIds: string[] } | { ok: false, error: string, byTestId: Record<string, HealLedgerEntry>, activeSessionIds: string[] }}
 */
export function readHealAttemptLedger(qaDir, trustContext = null) {
  const healsDir = getHealsDir(qaDir);
  const lp = getHealLedgerPath(qaDir);
  const repoDir = path.dirname(qaDir);
  const ctx = trustContext || openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  if (!fs.existsSync(lp)) {
    const existingSessions = fs.existsSync(healsDir)
      ? fs.readdirSync(healsDir).filter((n) => n.endsWith('.json') && n !== 'ledger.json')
      : [];
    if (existingSessions.length > 0 && ctx.hostT1Sticky) {
      return {
        ok: false,
        error: '[Heal Governance Blocked] heals/ledger.json is missing while heal sessions exist on a T1-sticky host.',
        byTestId: {},
        activeSessionIds: [],
      };
    }
    return { ok: true, byTestId: {}, activeSessionIds: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lp, 'utf8'));
    const macCheck = verifyPayloadT1('heal.ledger', parsed, parsed.mac, {
      qaDir,
      repoDir,
      macs: parsed.macs || null,
      trustContext: ctx,
    });
    if (!macCheck.ok) {
      return { ok: false, error: `[Heal Governance Blocked] ${macCheck.reason}`, byTestId: {}, activeSessionIds: [] };
    }
    return {
      ok: true,
      byTestId: parsed.byTestId && typeof parsed.byTestId === 'object' ? parsed.byTestId : {},
      activeSessionIds: Array.isArray(parsed.activeSessionIds) ? parsed.activeSessionIds : [],
    };
  } catch (err) {
    return {
      ok: false,
      error: `[Heal Governance Blocked] Corrupted heal ledger: ${err instanceof Error ? err.message : String(err)}`,
      byTestId: {},
      activeSessionIds: [],
    };
  }
}

/**
 * Atomically writes signed `heals/ledger.json` tracking `byTestId` + `activeSessionIds` (`WU-04`).
 * @param {string} qaDir
 * @param {Record<string, any>} byTestId
 * @param {import('../kernel/gate/trust-context.mjs').TrustContext | null} [trustContext]
 * @param {string[]} [activeSessionIds]
 */
export function writeHealAttemptLedger(qaDir, byTestId, trustContext = null, activeSessionIds = undefined) {
  const healsDir = getHealsDir(qaDir);
  fs.mkdirSync(healsDir, { recursive: true });
  const repoDir = path.dirname(qaDir);
  const ctx = trustContext || openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  let resolvedActiveIds = activeSessionIds;
  if (!resolvedActiveIds) {
    const existing = readHealAttemptLedger(qaDir, ctx);
    resolvedActiveIds = existing.ok && Array.isArray(existing.activeSessionIds) ? existing.activeSessionIds : [];
  }
  const core = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    byTestId,
    activeSessionIds: [...new Set(resolvedActiveIds)],
  };
  const sig = signPayloadT1('heal.ledger', core, { qaDir, repoDir, createIfMissing: true, trustContext: ctx });
  const payload = { ...core, ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}) };
  const targetPath = getHealLedgerPath(qaDir);
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Closes open Class B environment-blocker heal sessions once the target server recovers (`WU-04`).
 * @param {string} qaDir
 * @param {boolean} serverReachable
 */
export function autoCloseStaleClassBSessions(qaDir, serverReachable) {
  if (!serverReachable) return { closedCount: 0, closedIds: [] };
  const healsDir = getHealsDir(qaDir);
  if (!fs.existsSync(healsDir)) return { closedCount: 0, closedIds: [] };
  const ctx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: false });
  const ledger = readHealAttemptLedger(qaDir, ctx);
  if (!ledger.ok) return { closedCount: 0, closedIds: [] };
  const closedIds = [];
  let activeIds = [...(ledger.activeSessionIds || [])];
  for (const name of fs.readdirSync(healsDir).filter((n) => n.endsWith('.json') && n !== 'ledger.json')) {
    const sid = name.replace(/\.json$/, '');
    const loaded = readAndVerifySession(qaDir, sid, ctx);
    if (!loaded.ok) continue;
    const s = loaded.session;
    if (s.categoryCode === 'B' && s.state !== 'concluded' && s.state !== 'discarded') {
      s.state = 'concluded';
      s.updatedAt = new Date().toISOString();
      s.conclusion = {
        outcome: 'auto-closed-server-recovered',
        summary: 'Target environment became reachable; stale Class B session closed automatically.',
        concludedAt: s.updatedAt,
      };
      writeSignedSession(qaDir, s, ctx);
      activeIds = activeIds.filter((x) => x !== sid);
      closedIds.push(sid);
    }
  }
  if (closedIds.length > 0 && ctx.tierCeiling === 'T1') {
    writeHealAttemptLedger(qaDir, ledger.byTestId, ctx, activeIds);
  }
  return { closedCount: closedIds.length, closedIds };
}

/**
 * @param {string} qaDir
 * @param {HealSession} session
 * @param {import('../kernel/gate/trust-context.mjs').TrustContext | null} [trustContext]
 * @returns {HealSession}
 */
export function writeSignedSession(qaDir, session, trustContext = null) {
  const healsDir = getHealsDir(qaDir);
  fs.mkdirSync(healsDir, { recursive: true });
  const repoDir = path.dirname(qaDir);
  const ctx = trustContext || openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  const core = { ...session };
  delete core.mac;
  delete core.macs;
  delete core.macKeyId;
  const sig = signPayloadT1('heal.session', core, { qaDir, repoDir, createIfMissing: true, trustContext: ctx });
  const signed = { ...core, ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId } : {}) };
  fs.writeFileSync(getSessionPath(qaDir, session.sessionId), JSON.stringify(signed, null, 2) + '\n', 'utf8');
  return signed;
}

/**
 * @param {string} qaDir
 * @param {string | undefined} sessionId
 * @param {import('../kernel/gate/trust-context.mjs').TrustContext | null} [trustContext]
 * @returns {{ ok: true, session: HealSession, sessionPath: string } | { ok: false, exitCode: number, error: string }}
 */
export function readAndVerifySession(qaDir, sessionId, trustContext = null) {
  const sessionPath = getSessionPath(qaDir, sessionId);
  if (!sessionId || !fs.existsSync(sessionPath)) {
    return { ok: false, exitCode: 1, error: `Unknown heal session "${sessionId}". Call aitest_heal(action="begin") first.` };
  }
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      exitCode: 2,
      error: `[Heal Governance Blocked] Corrupted heal session "${sessionId}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const repoDir = path.dirname(qaDir);
  const ctx = trustContext || openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  const macCheck = verifyPayloadT1('heal.session', session, session.mac, {
    qaDir,
    repoDir,
    macs: session.macs || null,
    trustContext: ctx,
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
 * Captures the authoritative baseline of `relSpec` from Git base ref (`T-07`) when available.
 * @param {string} qaDir
 * @param {string} absSpec
 * @returns {{ content: string, source: string, baseSha: string | null }}
 */
export function resolveSpecBaseline(qaDir, absSpec) {
  const baseRes = resolveDefaultDiffBase(qaDir);
  if (baseRes.isGitRepo && baseRes.gitRoot && baseRes.resolved) {
    let realAbsSpec = path.resolve(absSpec);
    try {
      realAbsSpec =
        typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(realAbsSpec) : fs.realpathSync(realAbsSpec);
    } catch {
      // fall back to resolved path when spec does not exist on disk yet
    }
    const relFromGitRoot = path.relative(baseRes.gitRoot, realAbsSpec).replace(/\\/g, '/');
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
 * Writes redacted JSON + Markdown defect ticket artifacts for Class C or reported heal sessions.
 * @param {string} qaDir
 * @param {HealSession} session
 * @param {string} summaryNote
 * @returns {string}
 */
export function writeDefectTicketFiles(qaDir, session, summaryNote) {
  const defectsDir = path.join(qaDir, 'reports', 'defects');
  fs.mkdirSync(defectsDir, { recursive: true });
  const defectTicketPath = path.join(defectsDir, `${session.sessionId}.md`);
  const ticketJsonPath = path.join(defectsDir, `${session.sessionId}.json`);
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
  return defectTicketPath;
}
