// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import {
  BOT_APPROVER_RE,
  GATE_KERNEL_VERSION,
  PROTECTED_GOVERNANCE_REL_FILES,
  computeProtectedFileHashes,
  computeTemplateManifestDigest,
  isBotApprover,
  loadAitestConfig,
  loadAndValidateWaivers,
  openTrustContext,
  recordWorkspaceStickyKey,
  resolveGitIdentity,
  signPayloadT1,
  verifyGovernanceLockInQaDir,
} from './kernel/gate-kernel.mjs';

export { PROTECTED_GOVERNANCE_REL_FILES, computeProtectedFileHashes, hasWorkspaceGovernanceTrace, verifyGovernanceLockInQaDir };

const AGENT_SESSION_ENV_VARS = Object.freeze([
  'AITEST_MCP_CHILD',
  'AITEST_MCP_CAPTURED_STDIO',
  'ANTIGRAVITY_CONVERSATION_ID',
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CURSOR_TRACE_ID',
  'AIDER_MODEL',
]);

/**
 * Detects whether the current process environment indicates an AI coding agent session.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function detectAgentSessionEnvVar(env) {
  for (const key of AGENT_SESSION_ENV_VARS) {
    const val = env?.[key];
    if (typeof val === 'string' && val.trim() !== '' && val.trim() !== '0' && val.trim().toLowerCase() !== 'false') {
      return key;
    }
  }
  return null;
}

/**
 * @param {string} qaDir
 * @returns {boolean}
 */
function hasWorkspaceGovernanceTrace(qaDir) {
  const aitestDir = path.join(qaDir, '.aitest');
  if (!fs.existsSync(aitestDir)) return false;
  if (fs.existsSync(path.join(aitestDir, 'governance.lock'))) return true;
  if (fs.existsSync(path.join(aitestDir, 'governance-audit.jsonl'))) return true;
  for (const sub of ['runs', 'heals']) {
    const dir = path.join(aitestDir, sub);
    if (fs.existsSync(dir)) {
      try {
        if (fs.readdirSync(dir).length > 0) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Writes `.aitest/governance.lock` inside `<qaDir>` with T1 out-of-workspace HMAC tamper-evidence,
 * multi-key `macs: { [keyId]: hmac }` support, and Git user identity attribution.
 * @param {string} qaDir
 * @param {{
 *   approvedBy: string;
 *   reason: string;
 *   source?: string;
 *   trustContext?: import('./kernel/gate/trust-context.mjs').TrustContext;
 *   templateManifestDigest?: string | null;
 * }} meta
 */
export function writeGovernanceLock(qaDir, meta) {
  const approvedBy = String(meta?.approvedBy || '').trim();
  const reason = String(meta?.reason || '').trim();
  const source = meta.source || 'human-cli';

  if (!approvedBy) {
    throw new Error('Missing mandatory human approver (--by <identifier>).');
  }
  if (source !== 'aitest-init' && isBotApprover(approvedBy)) {
    throw new Error(`Approver "${approvedBy}" matches a reserved AI agent/bot identifier; human approval is required.`);
  }
  if (!reason) {
    throw new Error('Missing mandatory approval reason (--reason <text>).');
  }

  const aitestDir = path.join(qaDir, '.aitest');
  fs.mkdirSync(aitestDir, { recursive: true });
  const lockPath = path.join(aitestDir, 'governance.lock');

  /** @type {Record<string, string>} */
  let existingMacs = {};
  if (source !== 'aitest-init' && fs.existsSync(lockPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (prev?.macs && typeof prev.macs === 'object' && !Array.isArray(prev.macs)) {
        existingMacs = { ...prev.macs };
      }
    } catch {
      // ignore corrupted previous lock when human explicitly re-approves
    }
  }

  const approvedAt = new Date().toISOString();
  const files = computeProtectedFileHashes(qaDir);
  const gitIdentity = resolveGitIdentity(qaDir);

  const trustContext =
    meta.trustContext ||
    openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });

  /** @type {Record<string, any>} */
  const corePayload = {
    schemaVersion: SCHEMA_VERSIONS.governanceLock,
    gateKernelVersion: GATE_KERNEL_VERSION,
    approvedBy,
    approvedAt,
    gitUserEmail: gitIdentity.email,
    gitUserName: gitIdentity.name,
    reason,
    source,
    ...(meta.templateManifestDigest ? { templateManifestDigest: meta.templateManifestDigest } : {}),
    files,
  };

  const sig = signPayloadT1('governance.lock', corePayload, {
    qaDir,
    repoDir: path.dirname(qaDir),
    trustContext,
  });

  const macs = sig.signed && sig.keyId && sig.mac ? { ...existingMacs, [sig.keyId]: sig.mac } : existingMacs;
  /** @type {Record<string, any>} */
  const lockPayload = {
    ...corePayload,
    ...(sig.signed ? { mac: sig.mac, macKeyId: sig.keyId, macs } : {}),
  };

  fs.writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2) + '\n', 'utf8');
  if (sig.signed && sig.keyId) {
    recordWorkspaceStickyKey(trustContext, qaDir);
  }

  const auditLogPath = path.join(aitestDir, 'governance-audit.jsonl');
  fs.appendFileSync(
    auditLogPath,
    JSON.stringify({
      approvedAt,
      approvedBy,
      gitUserEmail: gitIdentity.email,
      reason,
      source: lockPayload.source,
      fileCount: Object.keys(files).length,
      trustTier: sig.trustTier,
      keyId: sig.keyId || null,
    }) + '\n',
    'utf8'
  );

  return { lockPath, lock: lockPayload, trustTier: sig.trustTier };
}

/**
 * Initializes default `.aitest/governance.lock` during `aitest init` ONLY when:
 * 1) Workspace has ZERO prior governance/ledger/heal traces, AND
 * 2) Every protected file on disk 100% matches the factory template hashes.
 * @param {string} qaDir
 * @param {{
 *   trustContext?: import('./kernel/gate/trust-context.mjs').TrustContext;
 *   factoryProtectedHashes?: Record<string, string>;
 * }} [options]
 */
export function ensureInitialGovernanceLock(qaDir, options = {}) {
  const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
  if (fs.existsSync(lockPath)) {
    return { created: false, blocked: false, lockPath };
  }

  if (hasWorkspaceGovernanceTrace(qaDir)) {
    return {
      created: false,
      blocked: true,
      lockPath,
      reason: 'HISTORICAL_WORKSPACE_TRACE',
      error:
        '[Governance Tamper Blocked] Refusing to auto-issue aitest-init governance.lock in a workspace with prior governance/run/heal history. A human must run "governance approve".',
    };
  }

  const currentHashes = computeProtectedFileHashes(qaDir);
  let expectedHashes = options.factoryProtectedHashes || null;
  const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
  let templateManifestDigest = null;

  if (fs.existsSync(manifestPath)) {
    try {
      const rawManifest = fs.readFileSync(manifestPath, 'utf8');
      const parsedManifest = JSON.parse(rawManifest);
      templateManifestDigest = computeTemplateManifestDigest(parsedManifest);
      if (!expectedHashes) {
        if (parsedManifest?.files && typeof parsedManifest.files === 'object') {
          expectedHashes = parsedManifest.files;
        }
      }
    } catch {
      return {
        created: false,
        blocked: true,
        lockPath,
        reason: 'CORRUPTED_TEMPLATE_MANIFEST',
        error: '[Governance Tamper Blocked] Corrupted .aitest/template-manifest.json; refusing to issue aitest-init lock.',
      };
    }
  }

  if (expectedHashes) {
    /** @type {string[]} */
    const mismatchedFiles = [];
    for (const [rel, curHash] of Object.entries(currentHashes)) {
      if (expectedHashes[rel] !== curHash) {
        mismatchedFiles.push(rel);
      }
    }
    for (const rel of Object.keys(expectedHashes)) {
      if (!(rel in currentHashes)) {
        mismatchedFiles.push(rel);
      }
    }
    if (mismatchedFiles.length > 0) {
      return {
        created: false,
        blocked: true,
        lockPath,
        reason: 'PROTECTED_FILE_MISMATCH_FACTORY',
        mismatchedFiles: [...new Set(mismatchedFiles)].sort(),
        error: `[Governance Tamper Blocked] Protected file(s) [${[...new Set(mismatchedFiles)].sort().join(', ')}] do not match factory template hashes; refusing aitest-init lock auto-signing.`,
      };
    }
  }

  const res = writeGovernanceLock(qaDir, {
    approvedBy: 'aitest-scaffold',
    reason: 'Initial isolated QA workspace baseline',
    source: 'aitest-init',
    trustContext: options.trustContext,
    templateManifestDigest,
  });
  return { created: true, blocked: false, lockPath: res.lockPath };
}

/**
 * Summarizes protected file differences compared to the previous `.aitest/governance.lock`.
 * @param {string} qaDir
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
function summarizeProtectedLockChanges(qaDir) {
  const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
  const current = computeProtectedFileHashes(qaDir);
  /** @type {Record<string, string>} */
  let prev = {};
  if (fs.existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (parsed?.files && typeof parsed.files === 'object') prev = parsed.files;
    } catch {
      prev = {};
    }
  }
  const added = Object.keys(current).filter((k) => !(k in prev)).sort();
  const modified = Object.keys(current).filter((k) => k in prev && current[k] !== prev[k]).sort();
  const removed = Object.keys(prev).filter((k) => !(k in current)).sort();
  return { added, modified, removed };
}

/**
 * CLI-only governance command (`ai-test-workbench governance status | verify | approve`).
 * Intentionally NEVER registered in MCP tool registry so AI Agents cannot invoke approval via MCP.
 * @param {Record<string, any>} [options]
 */
export async function runGovernanceCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const action = String(options.action || 'verify').toLowerCase();
  const env = options.env || process.env;
  const asJson = Boolean(options.json);

  /**
   * @param {number} exitCode
   * @param {string} message
   * @param {string | null} [blockerKind]
   * @param {Record<string, unknown>} [extraData]
   */
  const failGov = (exitCode, message, blockerKind = null, extraData = {}) => {
    if (!asJson) console.error(message);
    return emitCommandResult(
      buildCommandResult({
        tool: 'governance',
        outcome: exitCode === 64 ? 'usage' : exitCode === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode,
        summary: message,
        blockerKind: blockerKind || (exitCode === 2 ? 'GOVERNANCE_SECURITY_BLOCKED' : null),
        data: { action, error: message, ...extraData },
      }),
      { asJson }
    );
  };

  if (!options.target) {
    return failGov(64, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option', 'USAGE_ERROR');
  }

  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    return failGov(1, lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  if (action === 'status' || action === 'verify') {
    const trustContext = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), env, createKeyIfMissing: false });
    const check = verifyGovernanceLockInQaDir(qaDir, { trustContext });
    const exitCode = check.ok ? 0 : check.status === 'blocked' ? 2 : 1;
    if (!asJson) {
      for (const w of check.warnings || []) console.warn(`[WARN] ${w}`);
      if (!check.ok) {
        for (const e of check.errors) console.error(`[FAIL] ${e}`);
      } else {
        console.log(
          check.enforced
            ? `[Governance OK] All protected QA files match .aitest/governance.lock (approvedBy=${check.approvedBy}, trustTier=${check.trustTier}).`
            : '[Governance WARN] Workspace is not initialized yet.'
        );
      }
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'governance',
        outcome: exitCode === 0 ? 'pass' : exitCode === 2 ? 'blocked' : 'fail',
        ok: check.ok,
        exitCode,
        summary: check.ok
          ? `Governance lock verified (approvedBy=${check.approvedBy || 'none'}, trustTier=${check.trustTier})`
          : check.errors[0] || 'Governance lock verification failed',
        blockerKind: exitCode === 2 ? 'GOVERNANCE_LOCK_BLOCKED' : null,
        recoverySteps: exitCode === 0 ? [] : check.errors.slice(0, 3),
        data: check,
      }),
      { asJson }
    );
  }

  if (action === 'approve') {
    const agentEnvVar = detectAgentSessionEnvVar(env);
    if (agentEnvVar) {
      return failGov(
        2,
        `[Governance Security Blocked] "governance approve" cannot be invoked from an AI agent or MCP context (detected ${agentEnvVar}). A human must run it directly in an interactive terminal.`,
        'AGENT_SELF_APPROVAL_BLOCKED',
        { detectedEnvVar: agentEnvVar }
      );
    }

    const by = String(options.by || env.AITEST_GOVERNANCE_APPROVER || '').trim();
    const reason = String(options.reason || '').trim();
    if (!by || !reason) {
      return failGov(
        1,
        lang === 'zh'
          ? '审批治理变更必须显式传入人类审批人与原因：--by <姓名/工号> --reason "<审批原因>"'
          : 'Governance approval requires human attribution: --by <human-reviewer> --reason "<why>"'
      );
    }
    if (isBotApprover(by) || BOT_APPROVER_RE.test(by)) {
      return failGov(
        2,
        `[Governance Security Blocked] Approver "${by}" matches a reserved AI/bot identifier. Human reviewer required.`,
        'BOT_APPROVER_BLOCKED'
      );
    }

    const changes = summarizeProtectedLockChanges(qaDir);
    const isTty = options.isTTY !== undefined ? Boolean(options.isTTY) : Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const hasNonInteractiveGrant = Boolean(options.yes) && env.AITEST_APPROVE_NON_INTERACTIVE === '1';

    if (!isTty && !hasNonInteractiveGrant) {
      return failGov(
        2,
        '[Governance Confirmation Required] Non-interactive governance approve requires a human TTY (or explicit AITEST_APPROVE_NON_INTERACTIVE=1 with --yes outside agent sessions). CI=1 and --yes alone are rejected.',
        'GOVERNANCE_CONFIRMATION_REQUIRED'
      );
    }

    if (isTty && !options.yes) {
      const promptStream = asJson ? process.stderr : process.stdout;
      promptStream.write('\n[Governance Approval Preview]\n');
      promptStream.write(`  Approver : ${by}\n`);
      promptStream.write(`  Reason   : ${reason}\n`);
      promptStream.write(`  Added    : ${changes.added.length ? changes.added.join(', ') : '(none)'}\n`);
      promptStream.write(`  Modified : ${changes.modified.length ? changes.modified.join(', ') : '(none)'}\n`);
      promptStream.write(`  Removed  : ${changes.removed.length ? changes.removed.join(', ') : '(none)'}\n`);
      const rl = readline.createInterface({ input: process.stdin, output: promptStream });
      try {
        const answer = (await rl.question('Approve and re-sign .aitest/governance.lock? [y/N] ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          return failGov(2, '[Governance Approval Aborted] Cancelled by user.', 'GOVERNANCE_APPROVAL_ABORTED');
        }
      } finally {
        rl.close();
      }
    }

    const cfg = loadAitestConfig(qaDir);
    const waiverRes = loadAndValidateWaivers(path.join(qaDir, 'waivers.json'), Date.now(), {
      maxWaiverDays: cfg.maxWaiverDays,
      maxWaivers: cfg.maxWaivers,
    });
    if (!waiverRes.ok) {
      return failGov(
        1,
        waiverRes.errors.map((e) => `[Governance Waiver Validation Failed] ${e}`).join('\n'),
        null,
        { errors: waiverRes.errors }
      );
    }

    const trustContext = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), env, createKeyIfMissing: true });
    const written = writeGovernanceLock(qaDir, { approvedBy: by, reason, source: 'human-cli', trustContext });
    const out = {
      ok: true,
      exitCode: 0,
      lockPath: written.lockPath,
      approvedBy: written.lock.approvedBy,
      approvedAt: written.lock.approvedAt,
      gitUserEmail: written.lock.gitUserEmail,
      trustTier: written.trustTier,
      protectedCount: Object.keys(written.lock.files).length,
      changes,
    };
    if (!asJson) {
      console.log(
        `[Governance Approved] Locked ${out.protectedCount} protected QA file(s) by "${out.approvedBy}" (${out.trustTier}) -> ${out.lockPath}`
      );
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'governance',
        outcome: 'pass',
        ok: true,
        exitCode: 0,
        summary: `Governance lock approved by ${out.approvedBy} (${out.protectedCount} files, ${out.trustTier})`,
        data: out,
      }),
      { asJson }
    );
  }

  return failGov(64, `Unknown governance action "${action}". Use: verify | status | approve`, 'USAGE_ERROR');
}
