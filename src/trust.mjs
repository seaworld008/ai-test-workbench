// @ts-check
/**
 * Trust & Cryptographic Attestation Subsystem Facade (`T0 | T1 | T2`, in-toto v1, Sigstore DSSE/X.509).
 */
export { canonicalizeJson, signPayloadT1, verifyPayloadT1 } from './kernel/gate-kernel.mjs';
export {
  GITHUB_ACTIONS_OIDC_ISSUER,
  computeDssePae,
  extractFulcioOidcIssuerFromDer,
  parseGithubWorkflowSanUri,
} from './trust/der-x509.mjs';
export {
  INTOTO_STATEMENT_TYPE,
  LEGACY_VERDICT_PREDICATE_TYPES,
  TRUST_LEVEL_DEFINITIONS,
  VERDICT_PREDICATE_TYPE,
  buildInTotoVerdictAttestation,
  describeTrustLevel,
  detectCiContext,
  resolveVerdictTrustTier,
  tryCosignKeylessSign,
} from './trust/intoto.mjs';
export { runAttestCommand, verifyAttestationFile } from './trust/verifier.mjs';
