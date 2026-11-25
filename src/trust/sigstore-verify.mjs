// @ts-check
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  computeDssePae,
  extractFulcioOidcIssuerFromDer,
  extractSanUris,
  normalizeExpectedWorkflowPath,
  parseGithubWorkflowSanUri,
  verifyCertChainToTrustedRoot,
} from './der-x509.mjs';
import { VERDICT_PREDICATE_TYPE } from './intoto.mjs';

/**
 * Cryptographically verifies a Sigstore Bundle (`.sigstore.json`) against an `attestation.json` subject file.
 * Supports `--trusted-root-cert` SHA-256 fingerprint pinning (`trustRoot: 'sigstore' | 'pinned-custom' | 'custom'`).
 *
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
 *   trustedRootSha256?: string,
 * }} [options]
 * @returns {{
 *   ok: true,
 *   reasonCode: string,
 *   trustRoot: 'sigstore' | 'pinned-custom' | 'custom',
 *   trustedRootSha256: string | null,
 *   identity: { oidcIssuer: string, sanUri: string, repo: string, workflow: string, ref: string },
 *   signedPredicateType: string | null,
 * } | {
 *   ok: false,
 *   reasonCode: string,
 *   trustRoot?: 'sigstore' | 'pinned-custom' | 'custom',
 *   error: string,
 *   identity?: Record<string, any>,
 * }}
 */
export function verifySigstoreBundleForAttestation(absAttestationPath, absBundlePath, options = {}) {
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
  if (vm.certificate?.rawBytes) chainRawList.push(Buffer.from(vm.certificate.rawBytes, 'base64'));
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

  // 5. Verify certificate trust chain & pin status
  /** @type {'sigstore' | 'pinned-custom' | 'custom'} */
  let trustRoot = 'sigstore';
  /** @type {string | null} */
  let rootFingerprint = null;

  if (options.trustedRootCertPath || options.trustedRootCertPem) {
    try {
      const rootPem = options.trustedRootCertPem
        ? options.trustedRootCertPem
        : options.trustedRootCertPath
          ? fs.readFileSync(path.resolve(options.trustedRootCertPath), 'utf8')
          : '';
      const rootCert = new crypto.X509Certificate(rootPem);
      rootFingerprint = crypto.createHash('sha256').update(rootCert.raw).digest('hex').toLowerCase();
      if (options.trustedRootSha256) {
        const expectedRootFp = String(options.trustedRootSha256).replace(/^sha256:/i, '').trim().toLowerCase();
        if (rootFingerprint !== expectedRootFp) {
          return {
            ok: false,
            reasonCode: 'TRUSTED_ROOT_FINGERPRINT_MISMATCH',
            trustRoot: 'custom',
            error: `Custom trusted root SHA-256 fingerprint (${rootFingerprint}) != expected (${expectedRootFp}).`,
          };
        }
        trustRoot = 'pinned-custom';
      } else {
        trustRoot = 'custom';
      }

      const chainRes = verifyCertChainToTrustedRoot(leafCert, certs.slice(1), rootPem);
      if (!chainRes.ok) {
        return {
          ok: false,
          reasonCode: 'UNTRUSTED_CERT_CHAIN',
          trustRoot,
          error: chainRes.reason || 'Certificate chain failed offline trusted-root verification.',
          identity: { oidcIssuer, sanUri: matchedSan.uri, repo: matchedSan.repo, workflow: matchedSan.workflowPath, ref: matchedSan.gitRef },
        };
      }
    } catch (err) {
      return {
        ok: false,
        reasonCode: 'UNTRUSTED_CERT_CHAIN',
        trustRoot,
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
        trustRoot: 'sigstore',
        error: `Sigstore trust-root verification failed (install cosign for online Sigstore root verification or pass --trusted-root-cert for offline verification): ${(res.stderr || res.stdout || 'cosign unavailable').trim()}`,
        identity: { oidcIssuer, sanUri: matchedSan.uri, repo: matchedSan.repo, workflow: matchedSan.workflowPath, ref: matchedSan.gitRef },
      };
    }
  }

  return {
    ok: true,
    reasonCode: 'T2_VERIFIED',
    trustRoot,
    trustedRootSha256: rootFingerprint,
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
