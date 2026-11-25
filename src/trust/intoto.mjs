// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { WORKBENCH_VERSION } from '../core/version.mjs';
import { canonicalizeJson, openTrustContext, sha256Hex, signPayloadT1 } from '../kernel/gate-kernel.mjs';

export const INTOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const VERDICT_PREDICATE_TYPE = 'https://github.com/seaworld008/ai-test-workbench/verdict/v1';
export const LEGACY_VERDICT_PREDICATE_TYPES = new Set([
  VERDICT_PREDICATE_TYPE,
  'https://ai-test-workbench.dev/verdict/v2',
]);

/**
 * Canonical T0 / T1 / T2 Trust Level Definitions (single source of truth).
 */
export const TRUST_LEVEL_DEFINITIONS = Object.freeze({
  T0: Object.freeze({
    level: 'T0',
    mergeGradeGreen: false,
    zh: '未经验证的本地运行（非合入级绿灯）',
    en: 'Unverified local run (not a merge-grade green)',
  }),
  T1: Object.freeze({
    level: 'T1',
    mergeGradeGreen: false,
    zh: '本地 Run Ledger + MAC（证明完整性，不证明来源；非合入级绿灯）',
    en: 'Local Run Ledger + MAC (proves integrity, not provenance; not a merge-grade green)',
  }),
  T2: Object.freeze({
    level: 'T2',
    mergeGradeGreen: true,
    zh: '在 GitHub 托管的 runner 上从干净 checkout 重跑，用 Sigstore 免密钥签名，并且校验通过签发者身份（合入级绿灯）',
    en: 'Re-run from a clean checkout on a GitHub-hosted runner, keylessly signed with Sigstore, and verified for issuer identity (merge-grade green)',
  }),
});

/**
 * Formats a canonical trust-level description string.
 * @param {'T0' | 'T1' | 'T2' | string} level
 * @param {'zh' | 'en'} [lang]
 */
export function describeTrustLevel(level, lang = 'zh') {
  const key = level === 'T1' || level === 'T2' ? level : 'T0';
  const entry = TRUST_LEVEL_DEFINITIONS[key];
  return `${entry.level} — ${lang === 'zh' ? entry.zh : entry.en}`;
}

/**
 * Determines whether the current process is executing inside a recognized CI environment.
 */
export function detectCiContext(env = process.env) {
  const isGithubActions = env.GITHUB_ACTIONS === 'true';
  const isGitlabCi = env.GITLAB_CI === 'true';
  const isGenericCi = env.CI === 'true' || env.CI === '1';

  if (isGithubActions) {
    return {
      isCi: true,
      provider: 'github-actions',
      repository: env.GITHUB_REPOSITORY || null,
      workflow: env.GITHUB_WORKFLOW_REF || env.GITHUB_WORKFLOW || null,
      runId: env.GITHUB_RUN_ID || null,
      ref: env.GITHUB_REF || null,
      sha: env.GITHUB_SHA || null,
    };
  }
  if (isGitlabCi) {
    return {
      isCi: true,
      provider: 'gitlab-ci',
      repository: env.CI_PROJECT_PATH || null,
      workflow: env.CI_PIPELINE_ID || null,
      runId: env.CI_JOB_ID || null,
      ref: env.CI_COMMIT_REF_NAME || null,
      sha: env.CI_COMMIT_SHA || null,
    };
  }
  return {
    isCi: isGenericCi,
    provider: isGenericCi ? 'generic-ci' : 'local',
    repository: null,
    workflow: null,
    runId: null,
    ref: null,
    sha: null,
  };
}

/**
 * Resolves the honest Trust Level (`T0 | T1 | T2`) for a verdict.
 * @param {{
 *   verdict: string,
 *   auditTrustTier?: string,
 *   scopeDowngraded?: boolean,
 *   hasAllFourGates?: boolean,
 *   ciSignedBundle?: boolean,
 * }} input
 * @returns {'T0' | 'T1' | 'T2'}
 */
export function resolveVerdictTrustTier(input) {
  if (input.verdict !== 'pass') return 'T0';
  if (input.scopeDowngraded || !input.hasAllFourGates) return 'T0';

  const ci = detectCiContext();
  if (ci.isCi && ci.provider === 'github-actions' && input.ciSignedBundle === true) {
    return 'T2';
  }
  if (input.auditTrustTier === 'T1') {
    return 'T1';
  }
  return 'T0';
}

/**
 * Builds an in-toto Statement v1 verdict attestation binding Git tree, results.json,
 * governance.lock, and full verdict predicate.
 * @param {{
 *   verdictPayload: Record<string, any>,
 *   qaDir: string,
 *   repoDir: string,
 *   treeDigest?: string | null,
 *   resultsDigest?: string | null,
 *   lockDigest?: string | null,
 *   gateKernelVersion: string,
 * }} params
 */
export function buildInTotoVerdictAttestation(params) {
  const { verdictPayload, qaDir, repoDir, treeDigest, resultsDigest, lockDigest, gateKernelVersion } = params;
  const ci = detectCiContext();

  /** @type {Array<{ name: string, digest: Record<string, string> }>} */
  const subject = [];
  if (treeDigest) {
    subject.push({ name: 'git-tree', digest: { gitTree: String(treeDigest) } });
  }
  if (verdictPayload.gitSha && verdictPayload.gitSha !== 'nogit') {
    subject.push({ name: 'git-commit', digest: { gitCommit: String(verdictPayload.gitSha) } });
  }
  if (resultsDigest) {
    subject.push({ name: 'qa/reports/results.json', digest: { sha256: String(resultsDigest).replace(/^sha256:/, '') } });
  }
  if (lockDigest) {
    subject.push({ name: 'qa/.aitest/governance.lock', digest: { sha256: String(lockDigest).replace(/^sha256:/, '') } });
  }

  const trustLevel = verdictPayload.trustLevel || verdictPayload.trustTier || 'T0';
  const trustDef =
    trustLevel === 'T2'
      ? TRUST_LEVEL_DEFINITIONS.T2
      : trustLevel === 'T1'
        ? TRUST_LEVEL_DEFINITIONS.T1
        : TRUST_LEVEL_DEFINITIONS.T0;

  const statementCore = {
    _type: INTOTO_STATEMENT_TYPE,
    schemaVersion: 2,
    subject,
    predicateType: VERDICT_PREDICATE_TYPE,
    predicate: {
      attestedAt: new Date().toISOString(),
      tool: {
        name: 'ai-test-workbench',
        version: WORKBENCH_VERSION,
        gateKernelVersion,
      },
      environment: ci,
      runId: verdictPayload.runId,
      verdict: verdictPayload.verdict,
      trustTier: trustLevel,
      trustLevel,
      trustLevelDefinition: {
        zh: trustDef.zh,
        en: trustDef.en,
        mergeGradeGreen: trustDef.mergeGradeGreen,
      },
      acceptanceScope: verdictPayload.acceptanceScope,
      base: verdictPayload.base,
      scope: verdictPayload.scope,
      gates: verdictPayload.gates,
      counts: verdictPayload.counts,
      evidence: verdictPayload.evidence,
      ai: verdictPayload.ai,
    },
  };

  const statementDigest = `sha256:${sha256Hex(canonicalizeJson(statementCore))}`;
  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
  const macRes = signPayloadT1('verdict.attestation', { ...statementCore, statementDigest }, {
    qaDir,
    repoDir,
    createIfMissing: true,
    trustContext,
  });

  return {
    ...statementCore,
    statementDigest,
    attestationDigest: statementDigest,
    ...(macRes.signed ? { mac: macRes.mac, macKeyId: macRes.keyId } : {}),
  };
}

/**
 * Optionally signs an attestation file in CI using `cosign attest-blob --yes --bundle <path>` when enabled.
 * @param {string} attestationPath
 */
export function tryCosignKeylessSign(attestationPath) {
  if (process.env.AITEST_SIGN_COSIGN !== '1') {
    return { signed: false, bundlePath: null, reason: 'AITEST_SIGN_COSIGN not enabled' };
  }
  const bundlePath = `${attestationPath}.sigstore.json`;
  const predicatePath = `${attestationPath}.predicate.json`;
  try {
    const doc = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
    fs.writeFileSync(predicatePath, JSON.stringify(doc.predicate || doc, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { signed: false, bundlePath: null, reason: `Failed to prepare predicate: ${err instanceof Error ? err.message : String(err)}` };
  }
  const res = spawnSync(
    'cosign',
    [
      'attest-blob',
      attestationPath,
      '--predicate',
      predicatePath,
      '--type',
      VERDICT_PREDICATE_TYPE,
      '--bundle',
      bundlePath,
      '--yes',
    ],
    {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    }
  );
  if (res.status === 0 && fs.existsSync(bundlePath)) {
    return { signed: true, bundlePath, reason: 'Signed with Sigstore keyless cosign attest-blob' };
  }
  return {
    signed: false,
    bundlePath: null,
    reason: (res.stderr || res.stdout || 'cosign execution failed').trim(),
  };
}
