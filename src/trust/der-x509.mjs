// @ts-check
import crypto from 'node:crypto';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

const FULCIO_OID_ISSUER_V1 = '1.3.6.1.4.1.57264.1.1';
const FULCIO_OID_BUILD_SIGNER_DIGEST = '1.3.6.1.4.1.57264.1.3';
const FULCIO_OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';
const FULCIO_OID_SOURCE_REPO_DIGEST = '1.3.6.1.4.1.57264.1.21';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';

/**
 * Reads a single ASN.1 DER TLV element at `offset`.
 * @param {Buffer} buf
 * @param {number} offset
 */
export function readDerTlv(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  const lenByte = buf[offset + 1];
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
export function listDerChildren(valueBuf) {
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
export function decodeDerOid(oidBytes) {
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

/**
 * Extracts all X.509 v3 extension entries `(oid -> extnValue Buffer)` from a DER certificate.
 * @param {Buffer} certDer
 * @returns {Map<string, Buffer>}
 */
function extractCertExtensionsMap(certDer) {
  /** @type {Map<string, Buffer>} */
  const map = new Map();
  const root = readDerTlv(certDer, 0);
  if (!root || root.tag !== 0x30) return map;
  const certChildren = listDerChildren(root.value);
  const tbs = certChildren[0];
  if (!tbs || tbs.tag !== 0x30) return map;
  const tbsChildren = listDerChildren(tbs.value);
  const extWrapper = tbsChildren.find((c) => c.tag === 0xa3);
  if (!extWrapper) return map;
  const extSeq = readDerTlv(extWrapper.value, 0);
  if (!extSeq || extSeq.tag !== 0x30) return map;

  for (const ext of listDerChildren(extSeq.value)) {
    if (ext.tag !== 0x30) continue;
    const fields = listDerChildren(ext.value);
    if (fields.length < 2 || fields[0].tag !== 0x06) continue;
    const oid = decodeDerOid(fields[0].value);
    const extnValue = fields[fields.length - 1];
    if (!extnValue || extnValue.tag !== 0x04) continue;
    map.set(oid, extnValue.value);
  }
  return map;
}

/**
 * Decodes an ASN.1 UTF8String/IA5String or raw UTF-8 octet buffer for Fulcio extensions.
 * @param {Buffer | undefined} buf
 * @returns {string | null}
 */
function decodeFulcioStringExtension(buf) {
  if (!buf || buf.length === 0) return null;
  const inner = readDerTlv(buf, 0);
  if (inner && (inner.tag === 0x0c || inner.tag === 0x16) && inner.end === buf.length) {
    return inner.value.toString('utf8').trim() || null;
  }
  return buf.toString('utf8').trim() || null;
}

/**
 * Extracts Sigstore Fulcio X.509 extensions: OIDC Issuer (`.1.8`/`.1.1`),
 * Build Signer Digest / Commit SHA (`.1.3`), and Source Repo Digest (`.1.21`).
 * @param {Buffer} certDer
 * @returns {{ oidcIssuer: string | null, buildSignerDigest: string | null, sourceRepoDigest: string | null }}
 */
export function extractFulcioExtensionsFromDer(certDer) {
  const exts = extractCertExtensionsMap(certDer);
  const v2Issuer = decodeFulcioStringExtension(exts.get(FULCIO_OID_ISSUER_V2));
  const v1Issuer = decodeFulcioStringExtension(exts.get(FULCIO_OID_ISSUER_V1));
  const buildSignerDigest = decodeFulcioStringExtension(exts.get(FULCIO_OID_BUILD_SIGNER_DIGEST));
  const sourceRepoDigest = decodeFulcioStringExtension(exts.get(FULCIO_OID_SOURCE_REPO_DIGEST));
  return {
    oidcIssuer: v2Issuer || v1Issuer || null,
    buildSignerDigest,
    sourceRepoDigest,
  };
}

/**
 * Extracts the Sigstore Fulcio OIDC Issuer (`1.3.6.1.4.1.57264.1.8` or `.1.1`) from an X.509 DER buffer.
 * @param {Buffer} certDer
 * @returns {string | null}
 */
export function extractFulcioOidcIssuerFromDer(certDer) {
  return extractFulcioExtensionsFromDer(certDer).oidcIssuer;
}

/**
 * Parses DER BasicConstraints (`2.5.29.19`) and KeyUsage (`2.5.29.15`) from an X.509 certificate.
 * @param {Buffer} certDer
 * @returns {{
 *   hasBasicConstraints: boolean,
 *   ca: boolean,
 *   pathLenConstraint: number | null,
 *   hasKeyUsage: boolean,
 *   digitalSignature: boolean,
 *   keyCertSign: boolean,
 * }}
 */
export function parseCertConstraintsFromDer(certDer) {
  const exts = extractCertExtensionsMap(certDer);
  let hasBasicConstraints = false;
  let ca = false;
  /** @type {number | null} */
  let pathLenConstraint = null;

  const bcBuf = exts.get(OID_BASIC_CONSTRAINTS);
  if (bcBuf) {
    hasBasicConstraints = true;
    const seq = readDerTlv(bcBuf, 0);
    if (seq && seq.tag === 0x30) {
      for (const child of listDerChildren(seq.value)) {
        if (child.tag === 0x01 && child.value.length > 0) {
          ca = child.value[0] !== 0x00;
        } else if (child.tag === 0x02 && child.value.length > 0) {
          let n = 0;
          for (let i = 0; i < child.value.length; i += 1) {
            n = (n << 8) | child.value[i];
          }
          pathLenConstraint = n;
        }
      }
    }
  }

  let hasKeyUsage = false;
  let digitalSignature = false;
  let keyCertSign = false;
  const kuBuf = exts.get(OID_KEY_USAGE);
  if (kuBuf) {
    hasKeyUsage = true;
    const bs = readDerTlv(kuBuf, 0);
    if (bs && bs.tag === 0x03 && bs.value.length >= 2) {
      const firstOctet = bs.value[1];
      digitalSignature = (firstOctet & 0x80) !== 0; // bit 0
      keyCertSign = (firstOctet & 0x04) !== 0; // bit 5
    }
  }

  return { hasBasicConstraints, ca, pathLenConstraint, hasKeyUsage, digitalSignature, keyCertSign };
}

/**
 * Extracts URI Subject Alternative Names from `crypto.X509Certificate.subjectAltName`.
 * @param {string | undefined} san
 * @returns {string[]}
 */
export function extractSanUris(san) {
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

/**
 * @param {string} wf
 */
export function normalizeExpectedWorkflowPath(wf) {
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

/**
 * Validates X.509 certificate validity window against `referenceTimeMs`.
 * @param {crypto.X509Certificate} cert
 * @param {number} referenceTimeMs
 * @param {string} roleLabel
 * @returns {string | null}
 */
function checkCertValidityWindow(cert, referenceTimeMs, roleLabel) {
  const notBefore = cert.validFromDate.getTime();
  const notAfter = cert.validToDate.getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return `${roleLabel} certificate has invalid validity timestamps.`;
  }
  if (referenceTimeMs < notBefore || referenceTimeMs > notAfter) {
    return `${roleLabel} certificate is expired or not yet valid at ${new Date(referenceTimeMs).toISOString()} (valid ${cert.validFrom} .. ${cert.validTo}).`;
  }
  return null;
}

/**
 * Verifies an X.509 leaf certificate and optional intermediate chain against a pinned trusted root PEM,
 * strictly enforcing RFC 5280 BasicConstraints (`cA: TRUE`, `pathLenConstraint`), KeyUsage
 * (`keyCertSign` on CAs, `digitalSignature` on leaf), and validity timestamps (`VULN-03`, v6.2.1).
 * @param {crypto.X509Certificate} leafCert
 * @param {crypto.X509Certificate[]} chainCerts
 * @param {string | Buffer} trustedRootPem
 * @param {{ referenceTimeMs?: number }} [options]
 */
export function verifyCertChainToTrustedRoot(leafCert, chainCerts, trustedRootPem, options = {}) {
  const refTimeMs =
    typeof options.referenceTimeMs === 'number' && Number.isFinite(options.referenceTimeMs)
      ? options.referenceTimeMs
      : Date.now();
  const trustedRoot = new crypto.X509Certificate(trustedRootPem);

  // 1. Validate trusted root CA constraints & validity
  const rootConstraints = parseCertConstraintsFromDer(trustedRoot.raw);
  if (!trustedRoot.ca || !rootConstraints.ca) {
    return { ok: false, reason: 'Trusted root certificate is missing BasicConstraints cA=TRUE.' };
  }
  if (rootConstraints.hasKeyUsage && !rootConstraints.keyCertSign) {
    return { ok: false, reason: 'Trusted root certificate KeyUsage lacks keyCertSign.' };
  }
  const rootTimeErr = checkCertValidityWindow(trustedRoot, refTimeMs, 'Trusted root');
  if (rootTimeErr) return { ok: false, reason: rootTimeErr };

  // 2. Validate leaf certificate constraints & validity
  const leafConstraints = parseCertConstraintsFromDer(leafCert.raw);
  if (leafCert.ca || leafConstraints.ca) {
    return { ok: false, reason: 'Leaf signing certificate must not carry BasicConstraints cA=TRUE.' };
  }
  if (leafConstraints.hasKeyUsage && (!leafConstraints.digitalSignature || leafConstraints.keyCertSign)) {
    return { ok: false, reason: 'Leaf signing certificate KeyUsage must include digitalSignature and must not include keyCertSign.' };
  }
  const leafTimeErr = checkCertValidityWindow(leafCert, refTimeMs, 'Leaf');
  if (leafTimeErr) return { ok: false, reason: leafTimeErr };

  // Direct issuance by trusted root
  if (leafCert.verify(trustedRoot.publicKey)) {
    return { ok: true, issuerSubject: trustedRoot.subject };
  }

  // 3. Walk intermediate CA chain enforcing cA=TRUE, keyCertSign, pathLenConstraint, and validity window
  let current = leafCert;
  const remaining = [...chainCerts];
  /** @type {Array<{ cert: crypto.X509Certificate, constraints: ReturnType<typeof parseCertConstraintsFromDer> }>} */
  const usedIntermediates = [];

  for (let depth = 0; depth < 6; depth += 1) {
    let advanced = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (candidate.fingerprint256 === current.fingerprint256) continue;
      if (!current.verify(candidate.publicKey)) continue;

      const candConstraints = parseCertConstraintsFromDer(candidate.raw);
      if (!candidate.ca || !candConstraints.ca) {
        return {
          ok: false,
          reason: `Intermediate certificate "${candidate.subject}" is NOT a CA (BasicConstraints cA=FALSE); refusing forged chain.`,
        };
      }
      if (candConstraints.hasKeyUsage && !candConstraints.keyCertSign) {
        return {
          ok: false,
          reason: `Intermediate CA certificate "${candidate.subject}" KeyUsage lacks keyCertSign.`,
        };
      }
      const candTimeErr = checkCertValidityWindow(candidate, refTimeMs, `Intermediate CA "${candidate.subject}"`);
      if (candTimeErr) return { ok: false, reason: candTimeErr };

      // Check pathLenConstraint: number of non-root intermediate CAs below this CA must not exceed pathLenConstraint
      const intermediatesBelow = usedIntermediates.length;
      if (candConstraints.pathLenConstraint !== null && intermediatesBelow > candConstraints.pathLenConstraint) {
        return {
          ok: false,
          reason: `Intermediate CA "${candidate.subject}" violates pathLenConstraint=${candConstraints.pathLenConstraint} (depth=${intermediatesBelow}).`,
        };
      }

      usedIntermediates.push({ cert: candidate, constraints: candConstraints });
      current = candidate;
      remaining.splice(i, 1);
      advanced = true;

      if (current.fingerprint256 === trustedRoot.fingerprint256 || current.verify(trustedRoot.publicKey)) {
        if (
          rootConstraints.pathLenConstraint !== null &&
          usedIntermediates.length > rootConstraints.pathLenConstraint
        ) {
          return {
            ok: false,
            reason: `Root CA violates pathLenConstraint=${rootConstraints.pathLenConstraint} (intermediates=${usedIntermediates.length}).`,
          };
        }
        return { ok: true, issuerSubject: trustedRoot.subject };
      }
      break;
    }
    if (!advanced) break;
  }
  return { ok: false, reason: 'Certificate chain does not verify against the configured trusted root certificate.' };
}
