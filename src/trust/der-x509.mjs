// @ts-check
import crypto from 'node:crypto';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

const FULCIO_OID_ISSUER_V1 = '1.3.6.1.4.1.57264.1.1';
const FULCIO_OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';

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
 * Verifies an X.509 leaf certificate and optional intermediate chain against a pinned trusted root PEM.
 * @param {crypto.X509Certificate} leafCert
 * @param {crypto.X509Certificate[]} chainCerts
 * @param {string | Buffer} trustedRootPem
 */
export function verifyCertChainToTrustedRoot(leafCert, chainCerts, trustedRootPem) {
  const trustedRoot = new crypto.X509Certificate(trustedRootPem);
  if (leafCert.verify(trustedRoot.publicKey)) {
    return { ok: true, issuerSubject: trustedRoot.subject };
  }
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
