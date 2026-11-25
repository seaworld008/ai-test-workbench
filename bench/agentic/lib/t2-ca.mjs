// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  INTOTO_STATEMENT_TYPE,
  VERDICT_PREDICATE_TYPE,
  computeDssePae,
} from '../../../src/app/index.mjs';

/**
 * Pure zero-dependency ASN.1 DER X.509 v3 Ephemeral Fulcio CA & Sigstore v0.3 DSSE Bundle builder.
 *
 * Used strictly inside the Trusted Evaluator process (private keys NEVER enter the agent sandbox)
 * so CI T2 verification executes real cryptographic X.509 chain + Fulcio OIDC Issuer + GitHub Actions
 * Workflow SAN URI + raw-byte SHA-256 subject checks via `src/trust/verifier.mjs`.
 */

const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_FULCIO_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';

/**
 * Encodes an ASN.1 DER length field.
 * @param {number} len
 * @returns {Buffer}
 */
function encodeDerLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  /** @type {number[]} */
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Encodes a DER TLV element.
 * @param {number} tag
 * @param {Buffer} value
 * @returns {Buffer}
 */
function derTlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(value.length), value]);
}

/** @param {Buffer[]} parts */
function derSeq(parts) {
  return derTlv(0x30, Buffer.concat(parts));
}

/** @param {Buffer[]} parts */
function derSet(parts) {
  return derTlv(0x31, Buffer.concat(parts));
}

/** @param {Buffer} bytes */
function derInt(bytes) {
  let buf = Buffer.from(bytes);
  while (buf.length > 1 && buf[0] === 0x00 && (buf[1] & 0x80) === 0) {
    buf = buf.subarray(1);
  }
  if (buf.length === 0 || (buf[0] & 0x80) !== 0) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTlv(0x02, buf);
}

/** @param {boolean} val */
function derBool(val) {
  return derTlv(0x01, Buffer.from([val ? 0xff : 0x00]));
}

/** @param {Buffer} bytes @param {number} [unusedBits] */
function derBitString(bytes, unusedBits = 0) {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

/** @param {Buffer} bytes */
function derOctetString(bytes) {
  return derTlv(0x04, bytes);
}

/** @param {string} str */
function derUtf8String(str) {
  return derTlv(0x0c, Buffer.from(str, 'utf8'));
}

/** @param {string} oidStr */
function derOid(oidStr) {
  const parts = oidStr.split('.').map((s) => Number(s));
  if (parts.length < 2) throw new Error(`Invalid OID: ${oidStr}`);
  /** @type {number[]} */
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let val = parts[i];
    if (val === 0) {
      out.push(0);
      continue;
    }
    /** @type {number[]} */
    const enc = [];
    while (val > 0) {
      enc.unshift(val & 0x7f);
      val >>>= 7;
    }
    for (let j = 0; j < enc.length - 1; j += 1) {
      enc[j] |= 0x80;
    }
    out.push(...enc);
  }
  return derTlv(0x06, Buffer.from(out));
}

/** @param {string} cn */
function derNameCn(cn) {
  return derSeq([derSet([derSeq([derOid(OID_COMMON_NAME), derUtf8String(cn)])])]);
}

/** @param {Date} date */
function derUtcTime(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return derTlv(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

/**
 * Encodes an X.509 v3 Extension (`SEQUENCE { extnID, [critical], extnValue }`).
 * @param {string} oid
 * @param {Buffer} valueDer
 * @param {boolean} [critical]
 */
function derExtension(oid, valueDer, critical = false) {
  const parts = [derOid(oid)];
  if (critical) parts.push(derBool(true));
  parts.push(derOctetString(valueDer));
  return derSeq(parts);
}

/** @param {Buffer} der */
function derToCertPem(der) {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Builds and signs an X.509 v3 certificate with ECDSA-with-SHA256.
 * @param {{
 *   subjectCn: string;
 *   issuerCn: string;
 *   subjectPublicKey: crypto.KeyObject;
 *   issuerPrivateKey: crypto.KeyObject;
 *   extensions: Buffer[];
 *   notBefore?: Date;
 *   notAfter?: Date;
 * }} opts
 */
function buildSignedX509Cert(opts) {
  const notBefore = opts.notBefore || new Date(Date.now() - 60_000);
  const notAfter = opts.notAfter || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01; // strictly positive non-zero serial

  const sigAlg = derSeq([derOid(OID_ECDSA_WITH_SHA256)]);
  const spkiDer = /** @type {Buffer} */ (opts.subjectPublicKey.export({ type: 'spki', format: 'der' }));
  const versionField = derTlv(0xa0, derInt(Buffer.from([2]))); // v3
  const extensionsField = derTlv(0xa3, derSeq(opts.extensions));

  const tbs = derSeq([
    versionField,
    derInt(serial),
    sigAlg,
    derNameCn(opts.issuerCn),
    derSeq([derUtcTime(notBefore), derUtcTime(notAfter)]),
    derNameCn(opts.subjectCn),
    spkiDer,
    extensionsField,
  ]);

  const signature = crypto.sign('sha256', tbs, opts.issuerPrivateKey);
  const certDer = derSeq([tbs, sigAlg, derBitString(signature, 0)]);
  return {
    der: certDer,
    pem: derToCertPem(certDer),
  };
}

/**
 * Creates an in-memory ephemeral Fulcio-compatible Root CA for isolated T2 CI evaluation.
 * Its private key stays strictly inside the evaluator process and is NEVER written into agent workspaces.
 * @param {string} [rootCn]
 */
export function createEphemeralFulcioCa(rootCn = 'AI-Test-Workbench Ephemeral Fulcio T2 Root CA') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rootExtensions = [
    derExtension(OID_BASIC_CONSTRAINTS, derSeq([derBool(true)]), true),
    derExtension(OID_KEY_USAGE, derBitString(Buffer.from([0x06]), 1), true), // keyCertSign + cRLSign
  ];
  const rootCert = buildSignedX509Cert({
    subjectCn: rootCn,
    issuerCn: rootCn,
    subjectPublicKey: publicKey,
    issuerPrivateKey: privateKey,
    extensions: rootExtensions,
  });

  /**
   * Issues a short-lived leaf certificate carrying Fulcio OIDC Issuer v2 and GitHub Actions workflow SAN URI.
   * @param {{
   *   repo?: string;
   *   workflow?: string;
   *   ref?: string;
   *   oidcIssuer?: string;
   *   subjectCn?: string;
   * }} [claims]
   */
  function issueLeafCert(claims = {}) {
    const repo = claims.repo || 'seaworld008/ai-test-workbench';
    const workflowRaw = claims.workflow || '.github/workflows/aitest-verify.yml';
    const workflow = workflowRaw.startsWith('.github/workflows/') ? workflowRaw : `.github/workflows/${workflowRaw}`;
    const ref = claims.ref || 'refs/heads/main';
    const oidcIssuer = claims.oidcIssuer || GITHUB_ACTIONS_OIDC_ISSUER;
    const sanUri = `https://github.com/${repo}/${workflow}@${ref}`;

    const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const leafExtensions = [
      derExtension(OID_BASIC_CONSTRAINTS, derSeq([]), true),
      derExtension(OID_SUBJECT_ALT_NAME, derSeq([derTlv(0x86, Buffer.from(sanUri, 'ascii'))]), false),
      derExtension(OID_FULCIO_ISSUER_V2, derUtf8String(oidcIssuer), false),
    ];

    const leafCert = buildSignedX509Cert({
      subjectCn: claims.subjectCn || 'github-actions-oidc-leaf',
      issuerCn: rootCn,
      subjectPublicKey: leafKeys.publicKey,
      issuerPrivateKey: privateKey,
      extensions: leafExtensions,
    });

    return {
      der: leafCert.der,
      pem: leafCert.pem,
      privateKey: leafKeys.privateKey,
      publicKey: leafKeys.publicKey,
      sanUri,
      oidcIssuer,
      repo,
      workflow,
      ref,
    };
  }

  /**
   * Signs an `attestation.json` file into a Sigstore v0.3 DSSE bundle verifiable by `verifyAttestationFile()`.
   * @param {string} attestationPath
   * @param {{
   *   repo?: string;
   *   workflow?: string;
   *   ref?: string;
   *   oidcIssuer?: string;
   *   bundleOutPath?: string;
   *   attestedBy?: string;
   * }} [options]
   */
  function signAttestationFile(attestationPath, options = {}) {
    const rawBytes = fs.readFileSync(attestationPath);
    const sha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const leaf = issueLeafCert(options);

    const payloadType = 'application/vnd.in-toto+json';
    const dsseStatement = {
      _type: INTOTO_STATEMENT_TYPE,
      subject: [
        {
          name: 'attestation.json',
          digest: { sha256 },
        },
      ],
      predicateType: VERDICT_PREDICATE_TYPE,
      predicate: {
        attestedBy: options.attestedBy || 'fger-agentic-ci-t2-runner',
        repo: leaf.repo,
        workflow: leaf.workflow,
        ref: leaf.ref,
      },
    };
    const payloadBytes = Buffer.from(JSON.stringify(dsseStatement), 'utf8');
    const pae = computeDssePae(payloadType, payloadBytes);
    const sigBytes = crypto.sign('sha256', pae, leaf.privateKey);

    const bundle = {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        certificate: {
          rawBytes: leaf.der.toString('base64'),
        },
        tlogEntries: [],
      },
      dsseEnvelope: {
        payloadType,
        payload: payloadBytes.toString('base64'),
        signatures: [
          {
            sig: sigBytes.toString('base64'),
          },
        ],
      },
    };

    if (options.bundleOutPath) {
      fs.writeFileSync(options.bundleOutPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    }

    return {
      bundle,
      bundlePath: options.bundleOutPath || null,
      identity: {
        oidcIssuer: leaf.oidcIssuer,
        sanUri: leaf.sanUri,
        repo: leaf.repo,
        workflow: leaf.workflow,
        ref: leaf.ref,
      },
    };
  }

  const rootCertSha256 = crypto.createHash('sha256').update(rootCert.der).digest('hex').toLowerCase();
  return {
    rootCn,
    rootCertDer: rootCert.der,
    rootCertPem: rootCert.pem,
    rootCertSha256,
    issueLeafCert,
    signAttestationFile,
  };
}
