// @ts-check
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKBENCH_VERSION } from './core/version.mjs';
import {
  canonicalizeJson,
  sha256Hex,
  signPayloadT1,
  verifyPayloadT1,
} from './kernel/gate-kernel.mjs';

export { canonicalizeJson, signPayloadT1, verifyPayloadT1 };

export const INTOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const VERDICT_PREDICATE_TYPE = 'https://github.com/seaworld008/ai-test-workbench/verdict/v1';
export const LEGACY_VERDICT_PREDICATE_TYPES = new Set([
  VERDICT_PREDICATE_TYPE,
  'https://ai-test-workbench.dev/verdict/v2',
]);
export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Canonical T0 / T1 / T2 Trust Level Definitions (single source of truth shared by
 * `src/trust.mjs`, `verdict-summary.md`, `verdict.sarif.json`, `README*.md`, and `docs/governance*.md`).
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
  const entry = TRUST_LEVEL_DEFINITIONS[level] || TRUST_LEVEL_DEFINITIONS.T0;
  return `${entry.level} — ${lang === 'zh' ? entry.zh : entry.en}`;
}

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
      workflow: process.env.GITHUB_WORKFLOW_REF || process.env.GITHUB_WORKFLOW || null,
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
 * Resolves the honest Trust Level (`T0 | T1 | T2`) for a verdict:
 * - `T2`: ONLY when re-run on GitHub-hosted runner AND keylessly signed with Sigstore (`ciSignedBundle === true`).
 * - `T1`: Local Run Ledger + out-of-workspace MAC (proves integrity, not provenance).
 * - `T0`: Unverified local run (or failed/blocked/downgraded scope).
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

  const trustLevel = verdictPayload.trustLevel || verdictPayload.trustTier || 'T0';
  const trustDef = TRUST_LEVEL_DEFINITIONS[trustLevel] || TRUST_LEVEL_DEFINITIONS.T0;

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
    return { signed: false, bundlePath: null, reason: `Failed to prepare predicate: ${err?.message || err}` };
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

/* -------------------------------------------------------------------------- */
/*  Minimal Zero-Dependency ASN.1 DER & DSSE PAE Verification Helpers (T2)    */
/* -------------------------------------------------------------------------- */

/**
 * Reads a single ASN.1 DER TLV element at `offset`.
 * @param {Buffer} buf
 * @param {number} offset
 */
function readDerTlv(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  let lenByte = buf[offset + 1];
  if (lenByte === undefined) return null;
  let length = 0;
  let headerLen = 2;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
  } else {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0 || numOctets > 4 || offset + 2 + numOctets > buf.length) return null;
    for (let i = 0; i < numOctets; i += 1) {
      length = (length << 8) | buf[offset + 2 + i];
    }
    headerLen = 2 + numOctets;
  }
  const valueStart = offset + headerLen;
  const end = valueStart + length;
  if (end > buf.length) return null;
  return { tag, headerLen, length, valueStart, end, value: buf.subarray(valueStart, end) };
}

/**
 * Lists child DER TLV elements inside a constructed value buffer.
 * @param {Buffer} valueBuf
 */
function listDerChildren(valueBuf) {
  const items = [];
  let pos = 0;
  while (pos < valueBuf.length) {
    const el = readDerTlv(valueBuf, pos);
    if (!el) break;
    items.push(el);
    pos = el.end;
  }
  return items;
}

/**
 * Decodes a DER OID value buffer into dotted decimal string (e.g., `1.3.6.1.4.1.57264.1.1`).
 * @param {Buffer} oidBytes
 */
function decodeDerOid(oidBytes) {
  if (!oidBytes || oidBytes.length === 0) return '';
  const first = oidBytes[0];
  const parts = [Math.floor(first / 40), first % 40];
  let val = 0;
  for (let i = 1; i < oidBytes.length; i += 1) {
    const b = oidBytes[i];
    val = (val << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(val);
      val = 0;
    }
  }
  return parts.join('.');
}

const FULCIO_OID_ISSUER_V1 = '1.3.6.1.4.1.57264.1.1';
const FULCIO_OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';

/**
 * Extracts the Sigstore Fulcio OIDC Issuer (`1.3.6.1.4.1.57264.1.8` or `.1.1`) from an X.509 DER buffer.
 * @param {Buffer} certDer
 * @returns {string | null}
 */
export function extractFulcioOidcIssuerFromDer(certDer) {
  const root = readDerTlv(certDer, 0);
  if (!root || root.tag !== 0x30) return null;
  const certChildren = listDerChildren(root.value);
  const tbs = certChildren[0];
  if (!tbs || tbs.tag !== 0x30) return null;
  const tbsChildren = listDerChildren(tbs.value);

  // Locate explicit `[3]` context-specific Extensions container (tag 0xa3)
  const extWrapper = tbsChildren.find((c) => c.tag === 0xa3);
  if (!extWrapper) return null;
  const extSeq = readDerTlv(extWrapper.value, 0);
  if (!extSeq || extSeq.tag !== 0x30) return null;

  let v1Issuer = null;
  let v2Issuer = null;

  for (const ext of listDerChildren(extSeq.value)) {
    if (ext.tag !== 0x30) continue;
    const fields = listDerChildren(ext.value);
    if (fields.length < 2 || fields[0].tag !== 0x06) continue;
    const oid = decodeDerOid(fields[0].value);
    const extnValue = fields[fields.length - 1];
    if (!extnValue || extnValue.tag !== 0x04) continue;

    if (oid === FULCIO_OID_ISSUER_V2) {
      // V2 wraps a DER UTF8String (0x0c) inside the OCTET STRING
      const inner = readDerTlv(extnValue.value, 0);
      if (inner && (inner.tag === 0x0c || inner.tag === 0x16)) {
        v2Issuer = inner.value.toString('utf8').trim();
      } else {
        v2Issuer = extnValue.value.toString('utf8').trim();
      }
    } else if (oid === FULCIO_OID_ISSUER_V1) {
      const inner = readDerTlv(extnValue.value, 0);
      if (inner && (inner.tag === 0x0c || inner.tag === 0x16) && inner.end === extnValue.value.length) {
        v1Issuer = inner.value.toString('utf8').trim();
      } else {
        v1Issuer = extnValue.value.toString('utf8').trim();
      }
    }
  }

  return v2Issuer || v1Issuer || null;
}

/**
 * Extracts URI Subject Alternative Names from `crypto.X509Certificate.subjectAltName`.
 * @param {string | undefined} san
 * @returns {string[]}
 */
function extractSanUris(san) {
  if (!san || typeof san !== 'string') return [];
  const uris = [];
  for (const part of san.split(/,\s*/)) {
    if (part.startsWith('URI:')) {
      uris.push(part.slice(4).trim());
    }
  }
  return uris;
}

/**
 * Parses a GitHub Actions workflow SAN URI:
 * `https://github.com/<owner>/<repo>/.github/workflows/<workflow>.yml@<ref>`
 * @param {string} uri
 */
export function parseGithubWorkflowSanUri(uri) {
  const raw = String(uri || '').trim();
  const atIdx = raw.lastIndexOf('@');
  if (atIdx <= 0) return null;
  const left = raw.slice(0, atIdx);
  const gitRef = raw.slice(atIdx + 1);
  let parsedUrl;
  try {
    parsedUrl = new URL(left);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname.toLowerCase() !== 'github.com') {
    return null;
  }
  const segs = parsedUrl.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segs.length < 5) return null;
  const repo = `${segs[0]}/${segs[1]}`;
  const workflowPath = segs.slice(2).join('/');
  if (!workflowPath.startsWith('.github/workflows/')) return null;
  return { uri: raw, repo, workflowPath, gitRef };
}

function normalizeExpectedWorkflowPath(wf) {
  const clean = String(wf || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return '';
  if (clean.startsWith('.github/workflows/')) return clean;
  return `.github/workflows/${clean}`;
}

/**
 * Computes DSSE Pre-Authentication Encoding (PAE):
 * `DSSEv1 <len(type)> <type> <len(body)> <body>`
 * @param {string} payloadType
 * @param {Buffer} payloadBytes
 */
export function computeDssePae(payloadType, payloadBytes) {
  const typeBuf = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBuf.length} `, 'utf8'),
    typeBuf,
    Buffer.from(` ${payloadBytes.length} `, 'utf8'),
    payloadBytes,
  ]);
}

function verifyCertChainToTrustedRoot(leafCert, chainCerts, trustedRootPem) {
  const trustedRoot = new crypto.X509Certificate(trustedRootPem);
  // Direct issuance by trusted root
  if (leafCert.verify(trustedRoot.publicKey)) {
    return { ok: true, issuerSubject: trustedRoot.subject };
  }
  // Walk intermediate chain (leaf -> intermediate -> ... -> trustedRoot)
  let current = leafCert;
  const remaining = [...chainCerts];
  for (let depth = 0; depth < 6; depth += 1) {
    let advanced = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (candidate.fingerprint256 === current.fingerprint256) continue;
      if (current.verify(candidate.publicKey)) {
        current = candidate;
        remaining.splice(i, 1);
        advanced = true;
        if (current.fingerprint256 === trustedRoot.fingerprint256 || current.verify(trustedRoot.publicKey)) {
          return { ok: true, issuerSubject: trustedRoot.subject };
        }
        break;
      }
    }
    if (!advanced) break;
  }
  return { ok: false, reason: 'Certificate chain does not verify against the configured trusted root certificate.' };
}

/**
 * Cryptographically verifies a Sigstore Bundle (`.sigstore.json` from `actions/attest` or `cosign attest-blob`)
 * against an `attestation.json` subject file, checking:
 *  1. DSSE PAE signature validity
 *  2. Subject SHA-256 digest matches the exact raw bytes of `attestation.json`
 *  3. Fulcio OIDC Issuer === `https://token.actions.githubusercontent.com`
 *  4. SAN URI matches `--expect-repo`, `--expect-workflow`, and `--expect-ref`
 *  5. Certificate chain trusts `--trusted-root-cert` (offline) or `cosign verify-blob-attestation` (online/local cosign)
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
      error: `Invalid Sigstore bundle JSON: ${err?.message || err}`,
    };
  }

  const envelope = bundle.dsseEnvelope;
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.payloadType !== 'string') {
    return {
      ok: false,
      reasonCode: 'INVALID_DSSE_ENVELOPE',
      error: 'Sigstore bundle is missing a valid dsseEnvelope.',
    };
  }

  const sigEntry = Array.isArray(envelope.signatures) ? envelope.signatures[0] : null;
  if (!sigEntry || typeof sigEntry.sig !== 'string') {
    return {
      ok: false,
      reasonCode: 'MISSING_DSSE_SIGNATURE',
      error: 'Sigstore bundle dsseEnvelope contains no signature.',
    };
  }

  // Extract leaf certificate (Sigstore v0.3 `certificate` or v0.1/v0.2 `x509CertificateChain`)
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
    return {
      ok: false,
      reasonCode: 'MISSING_SIGNING_CERTIFICATE',
      error: 'Sigstore bundle contains no X.509 signing certificate.',
    };
  }

  let certs;
  try {
    certs = chainRawList.map((der) => new crypto.X509Certificate(der));
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'INVALID_SIGNING_CERTIFICATE',
      error: `Failed to parse X.509 certificate in Sigstore bundle: ${err?.message || err}`,
    };
  }
  const leafCert = certs[0];

  // 1. Verify DSSE PAE cryptographic signature using leaf certificate public key
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  const sigBytes = Buffer.from(sigEntry.sig, 'base64');
  const pae = computeDssePae(envelope.payloadType, payloadBytes);

  let sigValid = false;
  try {
    const keyType = leafCert.publicKey.asymmetricKeyType;
    if (keyType === 'ed25519' || keyType === 'ed448') {
      sigValid = crypto.verify(null, pae, leafCert.publicKey, sigBytes);
    } else {
      sigValid = crypto.verify('sha256', pae, leafCert.publicKey, sigBytes);
    }
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    return {
      ok: false,
      reasonCode: 'INVALID_DSSE_SIGNATURE',
      error: 'DSSE envelope cryptographic signature verification failed.',
    };
  }

  // 2. Verify signed in-toto payload subject SHA-256 matches exact attestation.json file bytes
  let signedStatement;
  try {
    signedStatement = JSON.parse(payloadBytes.toString('utf8'));
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'INVALID_DSSE_PAYLOAD',
      error: `DSSE payload is not valid JSON: ${err?.message || err}`,
    };
  }

  const subjects = Array.isArray(signedStatement.subject) ? signedStatement.subject : [];
  const digestMatched = subjects.some(
    (s) => String(s?.digest?.sha256 || '').toLowerCase() === actualFileSha256
  );
  if (!digestMatched) {
    return {
      ok: false,
      reasonCode: 'DIGEST_MISMATCH',
      error: `Signed bundle subject SHA-256 does not match attestation file digest (${actualFileSha256}). File was modified after signing.`,
    };
  }

  // 3. Verify Fulcio OIDC Issuer MUST be https://token.actions.githubusercontent.com
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

  // 4. Verify SAN URI matches GitHub Actions workflow path + expected repo / workflow / ref
  const sanUris = extractSanUris(leafCert.subjectAltName);
  const parsedSans = sanUris.map(parseGithubWorkflowSanUri).filter(Boolean);
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
    if (options.expectRepo && p.repo.toLowerCase() !== String(options.expectRepo).trim().toLowerCase()) {
      return false;
    }
    if (expectedWorkflowNorm && p.workflowPath !== expectedWorkflowNorm) {
      return false;
    }
    if (options.expectRef && p.gitRef !== String(options.expectRef).trim()) {
      return false;
    }
    if (options.certificateIdentityRegexp) {
      const re = new RegExp(options.certificateIdentityRegexp);
      if (!re.test(p.uri)) return false;
    }
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

  // 5. Verify certificate trust chain (offline pinned trusted root OR live cosign verify-blob-attestation)
  if (options.trustedRootCertPath || options.trustedRootCertPem) {
    try {
      const rootPem =
        options.trustedRootCertPem || fs.readFileSync(path.resolve(options.trustedRootCertPath), 'utf8');
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
        error: `Failed to verify certificate against trusted root: ${err?.message || err}`,
      };
    }
  } else {
    // Production mode without explicit offline root: delegate full Sigstore TUF/Rekor chain verification to cosign
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
 * Verifies an in-toto Statement v1 attestation file (`attest verify`).
 *
 * Fail-closed security invariant:
 * - Defaults to requiring full T2 verification (valid Sigstore keyless bundle + OIDC issuer
 *   `https://token.actions.githubusercontent.com` + matching GitHub workflow SAN + intact digest + passing verdict).
 * - Missing bundle, T1-only MAC, digest mismatch, identity mismatch, untrusted certificate chain,
 *   or non-passing verdict ALWAYS yields `ok: false`, `trustLevel <= 'T1'`, and an explicit `reasonCode`
 *   (CLI returns non-zero exit code). Never upgrades to T2 by default.
 * - Programmatic callers explicitly verifying local T1 integrity may pass `{ allowT1: true }`.
 *
 * @param {string} attestationPath
 * @param {{
 *   bundlePath?: string,
 *   expectRepo?: string,
 *   expectWorkflow?: string,
 *   expectRef?: string,
 *   certificateIdentityRegexp?: string,
 *   certificateOidcIssuer?: string,
 *   trustedRootCertPath?: string,
 *   trustedRootCertPem?: string,
 *   requireT1Mac?: boolean,
 *   allowT1?: boolean,
 * }} [options]
 */
export function verifyAttestationFile(attestationPath, options = {}) {
  const errors = [];
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
      errors: [`Invalid JSON in attestation: ${err?.message || err}`],
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

  // Verify T1 HMAC if present or required
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

  // T2 Sigstore Keyless Bundle Verification
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
    // Fail-closed: T1-only or unsigned attestation MUST NEVER pass default T2 verification!
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
    trustLevelDefinition: {
      zh: def.zh,
      en: def.en,
    },
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
 * CLI command:
 * `npx ai-test-workbench@5.1.1 attest verify --file <attestation.json> --bundle <bundle.sigstore.json> --expect-repo <owner/repo> --expect-workflow <path> --expect-ref <ref>`
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
