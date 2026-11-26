// @ts-check
/**
 * Public Application Service Facade (`src/app/index.mjs`, `WU-02`).
 * External consumers, benchmarks, and verification scripts should import from this stable entry
 * rather than reaching into internal domain implementations directly.
 */
export { loadWorkbenchConfig } from '../core/config.mjs';
export { buildCommandResult, emitCommandResult, EXIT_CODES, outcomeToExitCode } from '../core/outcome.mjs';
export { redactSecrets } from '../core/redact.mjs';
export { measureSseEndpoint, parseSseStreamText } from '../core/stream-sse.mjs';
export { REPO_ROOT, SCHEMA_VERSIONS, WORKBENCH_VERSION } from '../core/version.mjs';
export { resolveQaDirectory, resolveWorkspace } from '../domains/workspace/resolve.mjs';
export { analyzeHealerDiffText, runAuditCommand, runAuditForQaDir } from '../audit.mjs';
export { bootstrapWorkspaceCore, inferRuntimeConfigForRepo, runBootstrapCommand } from '../bootstrap.mjs';
export { runCli } from '../cli.mjs';
export { CLI_COMMANDS } from '../cli/commands.mjs';
export {
  createRoutePatternMatcher,
  listCodeMapAdapters,
  registerCodeMapAdapter,
  runMapCommand,
  syncLivingCodeMap,
  unregisterCodeMapAdapter,
} from '../codemap.mjs';
export {
  detectCorpusFormat,
  extractFeatureCohort,
  importTrafficCorpus,
  runCorpusCommand,
  stripExternalOriginToRelativePath,
} from '../corpus.mjs';
export {
  clusterDiagnosedFailures,
  computeDiagnosticFingerprint,
  generateDiagnosticsMarkdown,
  runDiagnoseCommand,
  suggestFailureCategory,
} from '../diagnose.mjs';
export { collectDoctorReport, runDoctor } from '../doctor.mjs';
export {
  detectEncodingTraits,
  inferJsonSchemaFromSample,
  inferUnionSchemaFromSamples,
  mergeInferredSchemas,
  writeInferredApiSchemas,
} from '../explore/schema-inferrer.mjs';
export { computeFlakyReport, runFlakyCommand, syncQuarantineFromLedger } from '../flaky.mjs';
export { ensureInitialGovernanceLock, runGovernanceCommand, writeGovernanceLock } from '../governance.mjs';
export {
  attemptHealRepair,
  autoCloseStaleClassBSessions,
  beginHealSession,
  concludeHealSession,
  discardHealSession,
  runHealCommand,
} from '../heal.mjs';
export { computeImpact, evaluateImpactForFiles, runImpactCommand } from '../impact.mjs';
export {
  STACK_DESCRIPTORS,
  detectPackageManager,
  registerStackDescriptor,
  runInit,
  unregisterStackDescriptor,
} from '../init.mjs';
export { beginRunLedger, finalizeRunLedger, readJsonlTail, readLedgerHistory, resolveGitHeadSha } from '../ledger.mjs';
export { TOOL_REGISTRY } from '../mcp/registry.mjs';
export { handleMcpJsonRpcMessage } from '../mcp-server.mjs';
export { evaluateTargetSafety, checkOutgoingRequestSafety, loadMergedQaEnv } from '../origin-guard.mjs';
export { runParityCommand, runParityCore } from '../parity.mjs';
export { evaluatePerfBudget, runPerfCommand, runSseStreamBenchmark } from '../perf.mjs';
export {
  computeRequestShapeHash,
  loadVerifiedUpstreamCassette,
  startCassetteReplayServer,
} from '../replay/cassette.mjs';
export { runReportCommand } from '../report.mjs';
export { executeSuiteCore, runSuiteCommand } from '../runner.mjs';
export { buildRequirementTraceMatrix, runTraceMatrixCommand } from '../traceability.mjs';
export { buildInTotoVerdictAttestation, runAttestCommand, verifyAttestationFile } from '../trust.mjs';
export { computeDssePae, GITHUB_ACTIONS_OIDC_ISSUER } from '../trust/der-x509.mjs';
export { INTOTO_STATEMENT_TYPE, VERDICT_PREDICATE_TYPE } from '../trust/intoto.mjs';
export { runUpgradeCommand, upgradeQaWorkspace } from '../upgrade.mjs';
export { checkHealSessionConflicts, runVerifyChangeCommand, verifyChangeCore } from '../verdict.mjs';
export {
  DEFAULT_NORMALIZE_PATHS,
  GATE_KERNEL_VERSION,
  clearGitRootCache,
  compareChangesetAst,
  compareParityCheckpoints,
  compareSpecSourcesAst,
  computeByteDiffMetrics,
  computeDomainHmac,
  computeShapeFingerprint,
  computeWorkspaceInputHash,
  openTrustContext,
  resolveDefaultDiffBase,
  resolveGitHeadAndTreeSha,
  resolveGitTreeSha,
  resolveTypeScriptCompiler,
  scanSpecFilesFallback,
  sha256Hex,
  stripSignatureFields,
  verifyGovernanceLockInQaDir,
} from '../kernel/gate-kernel.mjs';
