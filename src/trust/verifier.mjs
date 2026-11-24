// @ts-check
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeJson, sha256Hex, verifyPayloadT1 } from '../kernel/gate-kernel.mjs';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  computeDssePae,
  extractFulcioOidcIssuerFromDer,
  extractSanUris,
  normalizeExpectedWorkflowPath,
  parseGithubWorkflowSanUri,
  verifyCertChainToTrustedRoot,
} from './der-x509.mjs';
import {
  INTOTO_STATEMENT_TYPE,
  LEGACY_VERDICT_PREDICATE_TYPES,
  TRUST_LEVEL_DEFINITIONS,
  VERDICT_PREDICATE_TYPE,
} from './intoto.mjs';

/**
 * Cryptographically verifies a Sigstore Bundle (`.sigstore.json`) against an `attestation.json` subject file.
 * @param {string} absAttestationPath
 * @param {string} absBundlePath
 * @param {{
 *   certificateOidcIssuer?: string,
 *   expectWorkflow?: string,
 *   expectRepo?: string,
 *   expectRef?: string,
 *   certificateIdentityRegexp?: string,
 *   trustedRootCertPath?: string,
 *   trustedRootCertPem?: string,
 * }} [options]
 * @returns {{
 *   ok: true,
 *   reasonCode: string,
 *   identity: { oidcIssuer: string, sanUri: string, repo: string, workflow: string, ref: string },
 *   signedPredicateType: string | null,
 * } | {
 *   ok: false,
 *   reasonCode: string,
 *   error: string,
 *   identity?: Record<string, any>,
 * }}
 */
function verifySigstoreBundleForAttestation(absAttestationPath, absBundlePath, options = {}) {
  const rawAttBytes = fs.readFileSync(absAttestationPath);
  const actualFileSha256 = crypto.createHash('sha256').update(rawAttBytes).digest('hex').toLowerCase();

  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(absBundlePath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'INVALID_BUNDLE_JSON',
      error: `Invalid Sigstore bundle JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const envelope = bundle.dsseEnvelope;
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.payloadType !== 'string') {
    return { ok: false, reasonCode: 'INVALID_DSSE_ENVELOPE', error: 'Sigstore bundle is missing a valid dsseEnvelope.' };
  }

  const sigEntry = Array.isArray(envelope.signatures) ? envelope.signatures[0] : null;
  if (!sigEntry || typeof sigEntry.sig !== 'string') {
    return { ok: false, reasonCode: 'MISSING_DSSE_SIGNATURE', error: 'Sigstore bundle dsseEnvelope contains no signature.' };
  }

  const vm = bundle.verificationMaterial || {};
  const chainRawList = [];
  if (vm.certificate?.rawBytes) {
    chainRawList.push(Buffer.from(vm.certificate.rawBytes, 'base64'));
  }
  if (Array.isArray(vm.x509CertificateChain?.certificates)) {
    for (const c of vm.x509CertificateChain.certificates) {
      if (c?.rawBytes) chainRawList.push(Buffer.from(c.rawBytes, 'base64'));
    }
  }
  if (chainRawList.length === 0) {
    return { ok: false, reasonCode: 'MISSING_SIGNING_CERTIFICATE', error: 'Sigstore bundle contains no X.509 signing certificate.' };
  }

  let certs;
  try {
    certs = chainRawList.map((der) => new crypto.X509Certificate(der));
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'INVALID_SIGNING_CERTIFICATE',
      error: `Failed to parse X.509 certificate in Sigstore bundle: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const leafCert = certs[0];

  // 1. Verify DSSE PAE cryptographic signature
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  const sigBytes = Buffer.from(sigEntry.sig, 'base64');
  const pae = computeDssePae(envelope.payloadType, payloadBytes);

  let sigValid = false;
  try {
    const keyType = leafCert.publicKey.asymmetricKeyType;
    sigValid =
      keyType === 'ed25519' || keyType === 'ed448'
        ? crypto.verify(null, pae, leafCert.publicKey, sigBytes)
        : crypto.verify('sha256', pae, leafCert.publicKey, sigBytes);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    return { ok: false, reasonCode: 'INVALID_DSSE_SIGNATURE', error: 'DSSE envelope cryptographic signature verification failed.' };
  }

  // 2. Verify signed in-toto payload subject SHA-256 matches exact attestation.json file bytes
  let signedStatement;
  try {
    signedStatement = JSON.parse(payloadBytes.toString('utf8'));
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'INVALID_DSSE_PAYLOAD',
      error: `DSSE payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const subjects = Array.isArray(signedStatement.subject) ? signedStatement.subject : [];
  const digestMatched = subjects.some(
    (/** @type {{ digest?: { sha256?: string } } | null} */ s) =>
      String(s?.digest?.sha256 || '').toLowerCase() === actualFileSha256
  );
  if (!digestMatched) {
    return {
      ok: false,
      reasonCode: 'DIGEST_MISMATCH',
      error: `Signed bundle subject SHA-256 does not match attestation file digest (${actualFileSha256}). File was modified after signing.`,
    };
  }

  // 3. Verify Fulcio OIDC Issuer
  const expectedIssuer = options.certificateOidcIssuer || GITHUB_ACTIONS_OIDC_ISSUER;
  const oidcIssuer = extractFulcioOidcIssuerFromDer(leafCert.raw);
  if (!oidcIssuer || oidcIssuer !== expectedIssuer) {
    return {
      ok: false,
      reasonCode: 'OIDC_ISSUER_MISMATCH',
      error: `Certificate OIDC issuer "${oidcIssuer || 'missing'}" does not match required "${expectedIssuer}".`,
      identity: { oidcIssuer, sanUris: extractSanUris(leafCert.subjectAltName) },
    };
  }

  // 4. Verify SAN URI workflow identity
  const sanUris = extractSanUris(leafCert.subjectAltName);
  const parsedSans = sanUris.map(parseGithubWorkflowSanUri).filter((p) => p !== null);
  if (parsedSans.length === 0) {
    return {
      ok: false,
      reasonCode: 'WORKFLOW_IDENTITY_MISMATCH',
      error: `Certificate SAN (${leafCert.subjectAltName || 'none'}) does not contain a valid GitHub Actions workflow URI.`,
      identity: { oidcIssuer, sanUris },
    };
  }

  const expectedWorkflowNorm = options.expectWorkflow ? normalizeExpectedWorkflowPath(options.expectWorkflow) : null;
  const matchedSan = parsedSans.find((p) => {
    if (options.expectRepo && p.repo.toLowerCase() !== String(options.expectRepo).trim().toLowerCase()) return false;
    if (expectedWorkflowNorm && p.workflowPath !== expectedWorkflowNorm) return false;
    if (options.expectRef && p.gitRef !== String(options.expectRef).trim()) return false;
    if (options.certificateIdentityRegexp && !new RegExp(options.certificateIdentityRegexp).test(p.uri)) return false;
    return true;
  });

  if (!matchedSan) {
    return {
      ok: false,
      reasonCode: 'WORKFLOW_IDENTITY_MISMATCH',
      error: `Certificate workflow identity [${sanUris.join(', ')}] does not match expected repo="${options.expectRepo || '*'}", workflow="${expectedWorkflowNorm || '*'}", ref="${options.expectRef || '*'}".`,
      identity: { oidcIssuer, sanUris },
    };
  }

  // 5. Verify certificate trust chain
  if (options.trustedRootCertPath || options.trustedRootCertPem) {
    try {
      const rootPem = options.trustedRootCertPem
        ? options.trustedRootCertPem
        : options.trustedRootCertPath
          ? fs.readFileSync(path.resolve(options.trustedRootCertPath), 'utf8')
          : '';
      const chainRes = verifyCertChainToTrustedRoot(leafCert, certs.slice(1), rootPem);
      if (!chainRes.ok) {
        return {
          ok: false,
          reasonCode: 'UNTRUSTED_CERT_CHAIN',
          error: chainRes.reason || 'Certificate chain failed offline trusted-root verification.',
          identity: { oidcIssuer, sanUri: matchedSan.uri, repo: matchedSan.repo, workflow: matchedSan.workflowPath, ref: matchedSan.gitRef },
        };
      }
    } catch (err) {
      return {
        ok: false,
        reasonCode: 'UNTRUSTED_CERT_CHAIN',
        error: `Failed to verify certificate against trusted root: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    const cosignArgs = [
      'verify-blob-attestation',
      '--bundle',
      absBundlePath,
      '--type',
      signedStatement.predicateType || VERDICT_PREDICATE_TYPE,
      '--certificate-oidc-issuer',
      expectedIssuer,
      '--certificate-identity',
      matchedSan.uri,
      absAttestationPath,
    ];
    const res = spawnSync('cosign', cosignArgs, {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    if (res.status !== 0) {
      return {
        ok: false,
        reasonCode: 'UNTRUSTED_CERT_CHAIN',
        error: `Sigstore trust-root verification failed (install cosign for online Sigstore root verification or pass --trusted-root-cert for offline verification): ${(res.stderr || res.stdout || 'cosign unavailable').trim()}`,
        identity: { oidcIssuer, sanUri: matchedSan.uri, repo: matchedSan.repo, workflow: matchedSan.workflowPath, ref: matchedSan.gitRef },
      };
    }
  }

  return {
    ok: true,
    reasonCode: 'T2_VERIFIED',
    identity: {
      oidcIssuer,
      sanUri: matchedSan.uri,
      repo: matchedSan.repo,
      workflow: matchedSan.workflowPath,
      ref: matchedSan.gitRef,
    },
    signedPredicateType: signedStatement.predicateType || null,
  };
}

/**
 * Verifies an in-toto Statement v1 attestation file (`attest verify`, fail-closed T2 default).
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

  const macCheck = verifyPayloadT1(
    'verdict.attestation',
    { ...statementCore, statementDigest: doc.statementDigest },
    doc.mac,
    { requireMac: Boolean(options.requireT1Mac) }
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

  if (options.bundlePath) {
    const absBundle = path.resolve(options.bundlePath);
    if (!fs.existsSync(absBundle)) {
      primaryReasonCode = primaryReasonCode || 'MISSING_SIGSTORE_BUNDLE';
      errors.push(`Sigstore bundle not found: ${absBundle}`);
    } else {
      const sigRes = verifySigstoreBundleForAttestation(absPath, absBundle, options);
      if (sigRes.ok) {
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
  const reasonCode = ok ? (sigstoreVerified ? 'T2_VERIFIED' : 'T1_INTEGRITY_VERIFIED') : primaryReasonCode || 'VERIFICATION_FAILED';
  const def = TRUST_LEVEL_DEFINITIONS[trustLevel] || TRUST_LEVEL_DEFINITIONS.T0;

  return {
    ok,
    trustLevel,
    verifiedTier: trustLevel,
    mergeGradeGreen: trustLevel === 'T2' && ok,
    trustLevelDefinition: { zh: def.zh, en: def.en },
    reasonCode,
    declaredTier: doc.predicate?.trustLevel || doc.predicate?.trustTier || 'T0',
    verdict: doc.predicate?.verdict || 'unknown',
    runId: doc.predicate?.runId || null,
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
 * CLI handler for `attest verify`.
 * @param {Record<string, any>} [options]
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
    expectRepo: options.expectRepo,
    expectWorkflow: options.expectWorkflow,
    expectRef: options.expectRef,
    trustedRootCertPath: options.trustedRootCert,
    requireT1Mac: Boolean(options.requireMac),
    allowT1: false,
  });
  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  for (const w of res.warnings) console.warn(`[WARN] ${w}`);
  if (!res.ok) {
    console.error(`[Attestation REJECTED] trustLevel=${res.trustLevel} reasonCode=${res.reasonCode} mergeGradeGreen=false`);
    for (const e of res.errors) console.error(`[FAIL] ${e}`);
    return 1;
  }
  console.log(
    `[Attestation OK] trustLevel=${res.trustLevel} reasonCode=${res.reasonCode} mergeGradeGreen=${res.mergeGradeGreen} verdict=${res.verdict} runId=${res.runId || 'none'}`
  );
  return 0;
}
