// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCommandResult, emitCommandResult } from '../core/outcome.mjs';
import {
  canonicalizeJson,
  openTrustContext,
  resolveGitRoot,
  sha256Hex,
  verifyPayloadT1,
} from '../kernel/gate-kernel.mjs';
import {
  INTOTO_STATEMENT_TYPE,
  LEGACY_VERDICT_PREDICATE_TYPES,
  TRUST_LEVEL_DEFINITIONS,
  VERDICT_PREDICATE_TYPE,
} from './intoto.mjs';
import { verifySigstoreBundleForAttestation } from './sigstore-verify.mjs';

/**
 * Infers `(qaDir, repoDir)` surrounding an attestation file so in-workspace `AITEST_HMAC_KEY_FILE`
 * cannot bypass trust-context isolation (`VULN-08`, v6.2.1).
 * @param {string} absAttestationPath
 * @param {Record<string, any>} options
 * @returns {{ qaDir: string, repoDir: string }}
 */
function resolveAttestationWorkspaceBounds(absAttestationPath, options) {
  let qaDir = options.qaDir ? path.resolve(options.qaDir) : '';
  if (!qaDir) {
    let cur = path.dirname(absAttestationPath);
    for (let depth = 0; depth < 6; depth += 1) {
      if (path.basename(cur) === '.aitest') {
        qaDir = path.dirname(cur);
        break;
      }
      if (
        fs.existsSync(path.join(cur, 'playwright.config.ts')) ||
        fs.existsSync(path.join(cur, 'aitest.config.json'))
      ) {
        qaDir = cur;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!qaDir) qaDir = path.dirname(absAttestationPath);
  }
  const repoDir = options.repoDir
    ? path.resolve(options.repoDir)
    : resolveGitRoot(qaDir) ||
      (fs.existsSync(path.join(path.dirname(qaDir), 'package.json')) ? path.dirname(qaDir) : qaDir);
  return { qaDir, repoDir };
}

/**
 * Extracts the attested Git commit SHA and Git tree digest from an in-toto Statement v1 document.
 * @param {Record<string, any>} doc
 */
function extractAttestedGitBindings(doc) {
  const subjects = Array.isArray(doc.subject) ? doc.subject : [];
  const treeSubj = subjects.find((s) => s?.name === 'git-tree');
  const commitSubj = subjects.find((s) => s?.name === 'git-commit');
  const gitCommitSha =
    commitSubj?.digest?.gitCommit ||
    commitSubj?.digest?.sha1 ||
    doc.predicate?.environment?.sha ||
    doc.predicate?.gitSha ||
    null;
  const treeDigest = treeSubj?.digest?.gitTree || treeSubj?.digest?.sha1 || treeSubj?.digest?.sha256 || null;
  return {
    gitCommitSha: gitCommitSha ? String(gitCommitSha).trim() : null,
    treeDigest: treeDigest ? String(treeDigest).trim() : null,
  };
}

/**
 * Verifies an in-toto Statement v1 attestation file (`attest verify`, fail-closed T2 default).
 * Enforces raw-byte digest integrity, T1 HMAC evidence when local, Sigstore bundle + trust root
 * pinning (`trustRoot: 'sigstore' | 'pinned-custom' | 'custom'`), and `--expect-git-sha` /
 * `--expect-tree-digest` bindings (`WU-03`).
 *
 * @param {string} attestationPath
 * @param {Record<string, any>} [options]
 */
export function verifyAttestationFile(attestationPath, options = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const absPath = path.resolve(attestationPath);

  if (!fs.existsSync(absPath)) {
    return {
      ok: false,
      trustLevel: 'T0',
      verifiedTier: 'T0',
      trustRoot: 'none',
      mergeGradeGreen: false,
      reasonCode: 'ATTESTATION_NOT_FOUND',
      errors: [`Attestation file not found: ${absPath}`],
      warnings,
    };
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      trustLevel: 'T0',
      verifiedTier: 'T0',
      trustRoot: 'none',
      mergeGradeGreen: false,
      reasonCode: 'INVALID_ATTESTATION_JSON',
      errors: [`Invalid JSON in attestation: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    };
  }

  if (doc._type !== INTOTO_STATEMENT_TYPE || !LEGACY_VERDICT_PREDICATE_TYPES.has(doc.predicateType)) {
    errors.push(
      `Unsupported attestation format: expected _type="${INTOTO_STATEMENT_TYPE}" and predicateType="${VERDICT_PREDICATE_TYPE}".`
    );
    return {
      ok: false,
      trustLevel: 'T0',
      verifiedTier: 'T0',
      trustRoot: 'none',
      mergeGradeGreen: false,
      reasonCode: 'UNSUPPORTED_FORMAT',
      errors,
      warnings,
    };
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
  let primaryReasonCode = null;

  if (doc.statementDigest !== recomputedDigest) {
    primaryReasonCode = 'DIGEST_MISMATCH';
    errors.push(
      `[Attestation Digest Mismatch] Stored statementDigest (${doc.statementDigest}) != recomputed (${recomputedDigest}). File was tampered.`
    );
  }

  let forcedExitCode = null;
  const gitBindings = extractAttestedGitBindings(doc);
  if (options.expectGitSha !== undefined && options.expectGitSha !== null && String(options.expectGitSha) !== '') {
    const expectedSha = String(options.expectGitSha).trim().toLowerCase();
    const actualSha = (gitBindings.gitCommitSha || '').toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(expectedSha)) {
      primaryReasonCode = primaryReasonCode || 'INVALID_GIT_SHA_EXPECTATION';
      forcedExitCode = 2;
      errors.push(
        `Invalid --expect-git-sha "${options.expectGitSha}": must be a hexadecimal Git commit SHA of at least 12 characters (40-char full SHA recommended).`
      );
    } else if (!actualSha || (actualSha !== expectedSha && !actualSha.startsWith(expectedSha))) {
      primaryReasonCode = primaryReasonCode || 'GIT_SHA_MISMATCH';
      errors.push(`Attested gitCommitSha "${gitBindings.gitCommitSha || 'missing'}" != expected "${options.expectGitSha}".`);
    }
  }
  if (options.expectTreeDigest) {
    const normalizeDigest = (/** @type {string} */ s) => s.replace(/^sha256:/i, '').trim().toLowerCase();
    const expectedTree = normalizeDigest(String(options.expectTreeDigest));
    const actualTree = gitBindings.treeDigest ? normalizeDigest(gitBindings.treeDigest) : '';
    if (!actualTree || actualTree !== expectedTree) {
      primaryReasonCode = primaryReasonCode || 'TREE_DIGEST_MISMATCH';
      errors.push(`Attested treeDigest "${gitBindings.treeDigest || 'missing'}" != expected "${options.expectTreeDigest}".`);
    }
  }

  const workspaceBounds = resolveAttestationWorkspaceBounds(absPath, options);
  const resolvedTrustContext =
    options.trustContext ||
    openTrustContext({
      qaDir: workspaceBounds.qaDir,
      repoDir: workspaceBounds.repoDir,
      env: options.env || process.env,
      createKeyIfMissing: false,
    });

  if (resolvedTrustContext.source === 'rejected-in-workspace') {
    primaryReasonCode = primaryReasonCode || 'IN_WORKSPACE_HMAC_KEY_REJECTED';
    forcedExitCode = 2;
    errors.push(resolvedTrustContext.error || 'Refusing to use AITEST_HMAC_KEY_FILE inside workspace directory.');
  }

  const hasLocalT1Sig =
    Boolean(doc.mac) ||
    Boolean(doc.macs && typeof doc.macs === 'object' && Object.keys(doc.macs).length > 0);
  const macCheck =
    options.bundlePath && !options.requireT1Mac && !hasLocalT1Sig
      ? {
          ok: true,
          verified: false,
          foreign: false,
          trustTier: /** @type {'T0' | 'T1'} */ ('T0'),
          reason: 'Sigstore bundle mode: skipping local T1 MAC check when no local T1 signature is attached.',
        }
      : verifyPayloadT1(
          'verdict.attestation',
          { ...statementCore, statementDigest: doc.statementDigest },
          doc.mac,
          {
            qaDir: workspaceBounds.qaDir,
            repoDir: workspaceBounds.repoDir,
            requireMac: Boolean(options.requireT1Mac),
            macs: doc.macs || null,
            trustContext: resolvedTrustContext,
            env: options.env || process.env,
          }
        );
  if (!macCheck.ok) {
    primaryReasonCode = primaryReasonCode || 'T1_MAC_INVALID';
    errors.push(macCheck.reason);
  } else if (!macCheck.verified) {
    warnings.push(macCheck.reason);
  }

  const localIntegrityLevel = errors.length === 0 && macCheck.verified ? 'T1' : 'T0';

  let sigstoreVerified = false;
  let verifiedIdentity = null;
  /** @type {'sigstore' | 'pinned-custom' | 'custom' | 'none'} */
  let trustRoot = 'none';
  /** @type {string | null} */
  let trustedRootFingerprint = null;

  if (options.bundlePath) {
    const absBundle = path.resolve(options.bundlePath);
    if (!fs.existsSync(absBundle)) {
      primaryReasonCode = primaryReasonCode || 'MISSING_SIGSTORE_BUNDLE';
      errors.push(`Sigstore bundle not found: ${absBundle}`);
    } else {
      const sigRes = verifySigstoreBundleForAttestation(absPath, absBundle, options);
      if (sigRes.trustRoot) trustRoot = sigRes.trustRoot;
      if (sigRes.ok) {
        trustedRootFingerprint = sigRes.trustedRootSha256;
        // Enforce Fulcio Commit SHA OID (1.3.6.1.4.1.57264.1.3 / .1.21) binding against doc subject & --expect-git-sha (`VULN-02`, v6.2.1)
        const fulcioCommit = sigRes.identity?.commitSha ? String(sigRes.identity.commitSha).trim().toLowerCase() : null;
        if (fulcioCommit) {
          const attestedCommit = (gitBindings.gitCommitSha || '').toLowerCase();
          if (!attestedCommit || (attestedCommit !== fulcioCommit && !fulcioCommit.startsWith(attestedCommit) && !attestedCommit.startsWith(fulcioCommit))) {
            primaryReasonCode = primaryReasonCode || 'FULCIO_COMMIT_SHA_MISMATCH';
            errors.push(
              `Fulcio certificate Build Signer Digest (${fulcioCommit}) does not match attested gitCommit (${gitBindings.gitCommitSha || 'missing'}).`
            );
          }
          if (options.expectGitSha) {
            const expectedSha = String(options.expectGitSha).trim().toLowerCase();
            if (/^[0-9a-f]{12,64}$/.test(expectedSha) && fulcioCommit !== expectedSha && !fulcioCommit.startsWith(expectedSha)) {
              primaryReasonCode = primaryReasonCode || 'FULCIO_COMMIT_SHA_MISMATCH';
              errors.push(
                `Fulcio certificate Build Signer Digest (${fulcioCommit}) does not match --expect-git-sha (${options.expectGitSha}).`
              );
            }
          }
        }
        if (doc.predicate?.verdict !== 'pass') {
          primaryReasonCode = primaryReasonCode || 'VERDICT_NOT_PASS';
          errors.push(`Signed verdict is "${doc.predicate?.verdict || 'unknown'}", not "pass"; cannot grant T2 green.`);
        } else if (errors.length === 0) {
          sigstoreVerified = true;
          verifiedIdentity = sigRes.identity;
          primaryReasonCode = 'T2_VERIFIED';
        }
      } else {
        primaryReasonCode = primaryReasonCode || sigRes.reasonCode;
        verifiedIdentity = sigRes.identity || null;
        errors.push(sigRes.error);
      }
    }
  } else if (!options.allowT1) {
    primaryReasonCode = primaryReasonCode || (macCheck.verified ? 'T1_ONLY_NOT_T2' : 'MISSING_SIGSTORE_BUNDLE');
    errors.push(
      macCheck.verified
        ? 'Only local T1 Run Ledger + MAC evidence is present (proves integrity, not provenance). A verified Sigstore T2 bundle from a GitHub-hosted runner is required for a merge-grade green.'
        : 'Missing Sigstore bundle (--bundle). Unverified local runs (T0) cannot pass T2 verification.'
    );
  }

  const trustLevel = sigstoreVerified && errors.length === 0 ? 'T2' : localIntegrityLevel;
  const ok = errors.length === 0 && (sigstoreVerified || Boolean(options.allowT1));
  const mergeGradeGreen = trustLevel === 'T2' && ok && trustRoot !== 'custom';
  if (trustRoot === 'custom' && sigstoreVerified && ok) {
    warnings.push(
      'Verified using unpinned custom --trusted-root-cert without --trusted-root-sha256; trustRoot="custom" cannot grant mergeGradeGreen=true.'
    );
  }
  const reasonCode = ok ? (sigstoreVerified ? 'T2_VERIFIED' : 'T1_INTEGRITY_VERIFIED') : primaryReasonCode || 'VERIFICATION_FAILED';
  const def = TRUST_LEVEL_DEFINITIONS[trustLevel] || TRUST_LEVEL_DEFINITIONS.T0;

  return {
    ok,
    exitCode: ok ? 0 : forcedExitCode || 1,
    trustLevel,
    verifiedTier: trustLevel,
    trustRoot,
    trustedRootSha256: trustedRootFingerprint,
    mergeGradeGreen,
    trustLevelDefinition: { zh: def.zh, en: def.en },
    reasonCode,
    declaredTier: doc.predicate?.trustLevel || doc.predicate?.trustTier || 'T0',
    verdict: doc.predicate?.verdict || 'unknown',
    runId: doc.predicate?.runId || null,
    gitCommitSha: gitBindings.gitCommitSha,
    treeDigest: gitBindings.treeDigest,
    statementDigest: recomputedDigest,
    cosignVerified: sigstoreVerified,
    sigstoreVerified,
    t1MacVerified: macCheck.verified,
    identity: verifiedIdentity,
    errors,
    warnings,
  };
}

/**
 * Computes SHA-256 fingerprint of a PEM X.509 certificate for pinning helpers.
 * @param {string} certPemOrPath
 */
export function computeCertPemSha256(certPemOrPath) {
  const pem = fs.existsSync(certPemOrPath) ? fs.readFileSync(certPemOrPath, 'utf8') : certPemOrPath;
  const cert = new crypto.X509Certificate(pem);
  return crypto.createHash('sha256').update(cert.raw).digest('hex').toLowerCase();
}

/**
 * CLI handler for `attest verify`.
 * @param {Record<string, any>} [options]
 */
export async function runAttestCommand(options = {}) {
  const action = String(options.action || 'verify').toLowerCase();
  const asJson = Boolean(options.json);
  /** @param {number} code @param {string} msg */
  const failAttest = (code, msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'attest',
        outcome: code === 64 ? 'usage' : code === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode: code,
        blockerKind: code === 64 ? 'USAGE_ERROR' : code === 2 ? 'ATTESTATION_SECURITY_BLOCKED' : null,
        summary: msg,
        data: { error: msg },
      }),
      { asJson }
    );
  };
  if (action !== 'verify') {
    return failAttest(64, `Unknown attest action "${action}". Use: verify`);
  }
  const filePath = options.file || options.target;
  if (!filePath) {
    return failAttest(64, 'Missing --file <path/to/attestation.json>');
  }
  const res = verifyAttestationFile(filePath, {
    bundlePath: options.bundle,
    expectRepo: options.expectRepo,
    expectWorkflow: options.expectWorkflow,
    expectRef: options.expectRef,
    expectGitSha: options.expectGitSha,
    expectTreeDigest: options.expectTreeDigest,
    trustedRootCertPath: options.trustedRootCert,
    trustedRootSha256: options.trustedRootSha256,
    requireT1Mac: Boolean(options.requireMac),
    allowT1: false,
  });
  if (!asJson) {
    for (const w of res.warnings) console.warn(`[WARN] ${w}`);
    if (!res.ok) {
      console.error(`[Attestation REJECTED] trustLevel=${res.trustLevel} reasonCode=${res.reasonCode} mergeGradeGreen=false`);
      for (const e of res.errors) console.error(`[FAIL] ${e}`);
    } else {
      console.log(
        `[Attestation OK] trustLevel=${res.trustLevel} trustRoot=${res.trustRoot} reasonCode=${res.reasonCode} mergeGradeGreen=${res.mergeGradeGreen} verdict=${res.verdict} runId=${res.runId || 'none'}`
      );
    }
  }
  const exitCode = res.ok ? 0 : res.exitCode || 1;
  return emitCommandResult(
    buildCommandResult({
      tool: 'attest',
      outcome: res.ok ? 'pass' : exitCode === 2 ? 'blocked' : 'fail',
      ok: res.ok,
      exitCode,
      blockerKind: exitCode === 2 ? res.reasonCode || 'ATTESTATION_SECURITY_BLOCKED' : null,
      summary: res.ok
        ? `Attestation verified (${res.trustLevel}, trustRoot=${res.trustRoot}, reasonCode=${res.reasonCode})`
        : res.errors[0] || `Attestation rejected (${res.reasonCode})`,
      data: res,
    }),
    { asJson }
  );
}
