// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizeJson,
  sha256Hex,
  signPayloadT1,
  verifyPayloadT1,
} from '../templates/playwright-qa/support/gate-kernel.mjs';
import { WORKBENCH_VERSION } from './version.mjs';

export { canonicalizeJson, signPayloadT1, verifyPayloadT1 };

export const INTOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const VERDICT_PREDICATE_TYPE = 'https://ai-test-workbench.dev/verdict/v2';

/**
 * Determines whether the current process is executing inside a recognized CI environment.
 */
export function detectCiContext() {
  const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const isGitlabCi = process.env.GITLAB_CI === 'true';
  const isGenericCi = process.env.CI === 'true' || process.env.CI === '1';

  if (isGithubActions) {
    return {
      isCi: true,
      provider: 'github-actions',
      repository: process.env.GITHUB_REPOSITORY || null,
      workflow: process.env.GITHUB_WORKFLOW || null,
      runId: process.env.GITHUB_RUN_ID || null,
      ref: process.env.GITHUB_REF || null,
      sha: process.env.GITHUB_SHA || null,
    };
  }
  if (isGitlabCi) {
    return {
      isCi: true,
      provider: 'gitlab-ci',
      repository: process.env.CI_PROJECT_PATH || null,
      workflow: process.env.CI_PIPELINE_ID || null,
      runId: process.env.CI_JOB_ID || null,
      ref: process.env.CI_COMMIT_REF_NAME || null,
      sha: process.env.CI_COMMIT_SHA || null,
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
 * Resolves the honest Trust Tier (`T0 | T1 | T2`) for a verdict (`ADR-0002`).
 * - `T2`: Executed in CI (`CI=true`) with all required gates passing + clean scope (not downgraded) + signed/attested.
 * - `T1`: Local execution with valid out-of-workspace T1 HMAC on lock & ledger and no downgraded scope.
 * - `T0`: Advisory only (missing HMAC, non-git, downgraded scope, or unsigned local run).
 *
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
  if (ci.isCi && (input.ciSignedBundle || process.env.AITEST_CI_ATTEST === '1' || ci.provider === 'github-actions' || ci.provider === 'gitlab-ci')) {
    return 'T2';
  }
  if (input.auditTrustTier === 'T1') {
    return 'T1';
  }
  return 'T0';
}

/**
 * Builds an in-toto Statement v1 verdict attestation binding Git tree, results.json,
 * governance.lock, and full verdict v2 predicate (`T-04`).
 *
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
      trustTier: verdictPayload.trustTier,
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
  const macRes = signPayloadT1('verdict.attestation', { ...statementCore, statementDigest }, {
    qaDir,
    repoDir,
    createIfMissing: true,
  });

  return {
    ...statementCore,
    statementDigest,
    attestationDigest: statementDigest,
    ...(macRes.signed ? { mac: macRes.mac } : {}),
  };
}

/**
 * Optionally signs an attestation file in CI using `cosign sign-blob --yes --bundle <path>` when available.
 * @param {string} attestationPath
 */
export function tryCosignKeylessSign(attestationPath) {
  if (process.env.AITEST_SIGN_COSIGN !== '1') {
    return { signed: false, bundlePath: null, reason: 'AITEST_SIGN_COSIGN not enabled' };
  }
  const bundlePath = `${attestationPath}.sigstore.json`;
  const res = spawnSync('cosign', ['sign-blob', '--yes', '--bundle', bundlePath, attestationPath], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (res.status === 0 && fs.existsSync(bundlePath)) {
    return { signed: true, bundlePath, reason: 'Signed with Sigstore keyless cosign' };
  }
  return {
    signed: false,
    bundlePath: null,
    reason: (res.stderr || res.stdout || 'cosign execution failed').trim(),
  };
}

/**
 * Verifies an in-toto Statement v1 attestation file offline (`T-04`: `attest verify`).
 * Checks schema, canonical digest integrity, T1 HMAC (when present/available), and optional Sigstore bundle.
 *
 * @param {string} attestationPath
 * @param {{ bundlePath?: string, certificateIdentityRegexp?: string, certificateOidcIssuer?: string, requireT1Mac?: boolean }} [options]
 */
export function verifyAttestationFile(attestationPath, options = {}) {
  const errors = [];
  const warnings = [];
  const absPath = path.resolve(attestationPath);

  if (!fs.existsSync(absPath)) {
    return { ok: false, verifiedTier: 'T0', errors: [`Attestation file not found: ${absPath}`], warnings };
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    return { ok: false, verifiedTier: 'T0', errors: [`Invalid JSON in attestation: ${err.message}`], warnings };
  }

  if (doc._type !== INTOTO_STATEMENT_TYPE || doc.predicateType !== VERDICT_PREDICATE_TYPE) {
    errors.push(
      `Unsupported attestation format: expected _type="${INTOTO_STATEMENT_TYPE}" and predicateType="${VERDICT_PREDICATE_TYPE}".`
    );
    return { ok: false, verifiedTier: 'T0', errors, warnings };
  }

  if (!Array.isArray(doc.subject) || doc.subject.length === 0) {
    errors.push('Attestation subject array is empty; missing artifact digest bindings.');
  }

  const statementCore = {
    _type: doc._type,
    schemaVersion: doc.schemaVersion,
    subject: doc.subject,
    predicateType: doc.predicateType,
    predicate: doc.predicate,
  };
  const recomputedDigest = `sha256:${sha256Hex(canonicalizeJson(statementCore))}`;
  if (doc.statementDigest !== recomputedDigest) {
    errors.push(
      `[Attestation Digest Mismatch] Stored statementDigest (${doc.statementDigest}) != recomputed (${recomputedDigest}). File was tampered.`
    );
  }

  // Verify T1 HMAC if present or required
  const macCheck = verifyPayloadT1(
    'verdict.attestation',
    { ...statementCore, statementDigest: doc.statementDigest },
    doc.mac,
    { requireMac: Boolean(options.requireT1Mac) }
  );
  if (!macCheck.ok) {
    errors.push(macCheck.reason);
  } else if (!macCheck.verified) {
    warnings.push(macCheck.reason);
  }

  // Optional Sigstore cosign bundle verification for T2
  let cosignVerified = false;
  if (options.bundlePath) {
    const absBundle = path.resolve(options.bundlePath);
    if (!fs.existsSync(absBundle)) {
      errors.push(`Sigstore bundle not found: ${absBundle}`);
    } else {
      const cosignArgs = ['verify-blob', '--bundle', absBundle];
      if (options.certificateIdentityRegexp) {
        cosignArgs.push('--certificate-identity-regexp', options.certificateIdentityRegexp);
      }
      if (options.certificateOidcIssuer) {
        cosignArgs.push('--certificate-oidc-issuer', options.certificateOidcIssuer);
      }
      cosignArgs.push(absPath);
      const res = spawnSync('cosign', cosignArgs, {
        shell: false,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      if (res.status === 0) {
        cosignVerified = true;
      } else {
        errors.push(`Sigstore cosign verify-blob failed: ${(res.stderr || res.stdout || '').trim()}`);
      }
    }
  }

  const verifiedTier =
    errors.length === 0
      ? cosignVerified
        ? 'T2'
        : macCheck.verified
          ? 'T1'
          : 'T0'
      : 'T0';

  return {
    ok: errors.length === 0,
    verifiedTier,
    declaredTier: doc.predicate?.trustTier || 'T0',
    verdict: doc.predicate?.verdict || 'unknown',
    runId: doc.predicate?.runId || null,
    statementDigest: recomputedDigest,
    cosignVerified,
    t1MacVerified: macCheck.verified,
    errors,
    warnings,
  };
}

/**
 * CLI command: `ai-test-workbench attest verify --file <attestation.json> [--bundle <sigstore.json>]`
 */
export async function runAttestCommand(options = {}) {
  const action = String(options.action || 'verify').toLowerCase();
  if (action !== 'verify') {
    console.error(`Unknown attest action "${action}". Use: verify`);
    return 1;
  }
  const filePath = options.file || options.target;
  if (!filePath) {
    console.error('Missing --file <path/to/attestation.json>');
    return 1;
  }
  const res = verifyAttestationFile(filePath, {
    bundlePath: options.bundle,
    requireT1Mac: Boolean(options.requireMac),
  });
  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  for (const w of res.warnings) console.warn(`[WARN] ${w}`);
  if (!res.ok) {
    for (const e of res.errors) console.error(`[FAIL] ${e}`);
    return 1;
  }
  console.log(
    `[Attestation OK] verdict=${res.verdict} verifiedTier=${res.verifiedTier} declaredTier=${res.declaredTier} runId=${res.runId || 'none'}`
  );
  return 0;
}
