// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import {
  BOT_APPROVER_RE,
  GATE_KERNEL_VERSION,
  PROTECTED_GOVERNANCE_REL_FILES,
  computeProtectedFileHashes,
  loadAitestConfig,
  loadAndValidateWaivers,
  resolveGitIdentity,
  signPayloadT1,
  verifyGovernanceLockInQaDir,
} from './kernel/gate-kernel.mjs';

export { PROTECTED_GOVERNANCE_REL_FILES, computeProtectedFileHashes, verifyGovernanceLockInQaDir };

/**
 * Writes `.aitest/governance.lock` inside `<qaDir>` with T1 out-of-workspace HMAC tamper-evidence
 * and Git user identity attribution, plus appends an audit record to `.aitest/governance-audit.jsonl`.
 * @param {string} qaDir
 * @param {{ approvedBy: string, reason: string, source?: string }} meta
 */
export function writeGovernanceLock(qaDir, meta) {
  const approvedBy = String(meta?.approvedBy || '').trim();
  const reason = String(meta?.reason || '').trim();
  const source = meta.source || 'human-cli';

  if (!approvedBy) {
    throw new Error('Missing mandatory human approver (--by <identifier>).');
  }
  if (source !== 'aitest-init' && BOT_APPROVER_RE.test(approvedBy)) {
    throw new Error(`Approver "${approvedBy}" matches a reserved AI agent/bot identifier; human approval is required.`);
  }
  if (!reason) {
    throw new Error('Missing mandatory approval reason (--reason <text>).');
  }

  const aitestDir = path.join(qaDir, '.aitest');
  fs.mkdirSync(aitestDir, { recursive: true });

  const approvedAt = new Date().toISOString();
  const files = computeProtectedFileHashes(qaDir);
  const gitIdentity = resolveGitIdentity(qaDir);

  const corePayload = {
    schemaVersion: SCHEMA_VERSIONS.governanceLock,
    gateKernelVersion: GATE_KERNEL_VERSION,
    approvedBy,
    approvedAt,
    gitUserEmail: gitIdentity.email,
    gitUserName: gitIdentity.name,
    reason,
    source,
    files,
  };

  const sig = signPayloadT1('governance.lock', corePayload, {
    qaDir,
    repoDir: path.dirname(qaDir),
    createIfMissing: true,
  });

  const lockPayload = {
    ...corePayload,
    ...(sig.signed ? { mac: sig.mac } : {}),
  };

  const lockPath = path.join(aitestDir, 'governance.lock');
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2) + '\n', 'utf8');

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
    }) + '\n',
    'utf8'
  );

  return { lockPath, lock: lockPayload, trustTier: sig.trustTier };
}

/**
 * Initializes default `.aitest/governance.lock` during `aitest init` (only when created fresh).
 * @param {string} qaDir
 */
export function ensureInitialGovernanceLock(qaDir) {
  const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
  if (fs.existsSync(lockPath)) {
    return { created: false, lockPath };
  }
  const res = writeGovernanceLock(qaDir, {
    approvedBy: 'aitest-scaffold',
    reason: 'Initial isolated QA workspace baseline',
    source: 'aitest-init',
  });
  return { created: true, lockPath: res.lockPath };
}

/**
 * CLI-only governance command (`ai-test-workbench governance status | verify | approve`).
 * Intentionally NEVER registered in MCP tool registry so AI Agents cannot invoke approval via MCP.
 * @param {Record<string, any>} [options]
 */
export async function runGovernanceCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const action = String(options.action || 'verify').toLowerCase();

  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  if (action === 'status' || action === 'verify') {
    const check = verifyGovernanceLockInQaDir(qaDir);
    if (options.json) {
      console.log(JSON.stringify(check, null, 2));
      return check.ok ? 0 : 1;
    }
    for (const w of check.warnings || []) console.warn(`[WARN] ${w}`);
    if (!check.ok) {
      for (const e of check.errors) console.error(`[FAIL] ${e}`);
      return 1;
    }
    console.log(
      check.enforced
        ? `[Governance OK] All protected QA files match .aitest/governance.lock (approvedBy=${check.approvedBy}, trustTier=${check.trustTier}).`
        : '[Governance WARN] Workspace is not initialized yet.'
    );
    return 0;
  }

  if (action === 'approve') {
    if (process.env.AITEST_MCP_CHILD === '1' || process.env.AITEST_MCP_CAPTURED_STDIO === '1') {
      console.error(
        '[Governance Security Blocked] "governance approve" cannot be invoked from an MCP server context. A human must run it directly in terminal or CI.'
      );
      return 2;
    }

    const by = String(options.by || process.env.AITEST_GOVERNANCE_APPROVER || '').trim();
    const reason = String(options.reason || '').trim();
    if (!by || !reason) {
      console.error(
        lang === 'zh'
          ? '审批治理变更必须显式传入人类审批人与原因：--by <姓名/工号> --reason "<审批原因>"'
          : 'Governance approval requires human attribution: --by <human-reviewer> --reason "<why>"'
      );
      return 1;
    }
    if (BOT_APPROVER_RE.test(by)) {
      console.error(`[Governance Security Blocked] Approver "${by}" matches a reserved AI/bot identifier. Human reviewer required.`);
      return 2;
    }

    // Refuse to lock invalid/expired/self-approved waivers!
    const cfg = loadAitestConfig(qaDir);
    const waiverRes = loadAndValidateWaivers(path.join(qaDir, 'waivers.json'), Date.now(), {
      maxWaiverDays: cfg.maxWaiverDays,
      maxWaivers: cfg.maxWaivers,
    });
    if (!waiverRes.ok) {
      for (const err of waiverRes.errors) {
        console.error(`[Governance Waiver Validation Failed] ${err}`);
      }
      return 1;
    }

    const written = writeGovernanceLock(qaDir, { approvedBy: by, reason, source: 'human-cli' });
    const out = {
      ok: true,
      lockPath: written.lockPath,
      approvedBy: written.lock.approvedBy,
      approvedAt: written.lock.approvedAt,
      gitUserEmail: written.lock.gitUserEmail,
      trustTier: written.trustTier,
      protectedCount: Object.keys(written.lock.files).length,
    };
    if (options.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `[Governance Approved] Locked ${out.protectedCount} protected QA file(s) by "${out.approvedBy}" (${out.trustTier}) -> ${out.lockPath}`
      );
    }
    return 0;
  }

  console.error(`Unknown governance action "${action}". Use: verify | status | approve`);
  return 1;
}
