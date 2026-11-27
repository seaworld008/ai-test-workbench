export type EgressMode = 'permissive' | 'allowlist';

export type RuleSeverity = 'error' | 'off';

export type WorkbenchCaller = 'human-cli' | 'mcp-child' | 'ci';

export interface AitestRuleConfig {
  enabled?: boolean;
  severity?: RuleSeverity;
}

export interface AitestParityConfig {
  normalizePaths?: string[];
  strictByteEscape?: boolean;
  maxLatencyRatio?: number;
  maxTtftRatio?: number;
  privacyMode?: 'redacted' | 'shape-only';
  authStorageKeys?: string[];
  failOnAuthError?: boolean;
}

export interface AitestObservabilityConfig {
  logsBackend?: 'loki' | 'victorialogs' | 'elk';
  traceProtocol?: 'w3c' | 'sw8' | 'all';
}

export type CodeMapEngineMode = 'auto' | 'builtin' | 'codebase-memory-mcp';

export interface AitestCodeMapExternalEngineConfig {
  pinnedVersion?: string;
  binarySha256?: string;
  binaryPath?: string;
  strictChecksum?: boolean;
  timeoutMs?: number;
  maxRssMb?: number;
  runtimeDir?: string;
  cacheDir?: string;
}

export interface AitestCodeMapConfig {
  engine?: CodeMapEngineMode;
  externalEngine?: AitestCodeMapExternalEngineConfig;
}

export interface LockstepRuleConfig {
  id: string;
  whenModified: string[];
  requireModified: string[];
  allowWaiver?: boolean;
}

export interface DeclarativeMemoryRuleSpec {
  id?: string;
  code?: string;
  title?: string;
  description?: string;
  pattern: string;
  flags?: string;
  scope?: 'all' | 'product' | 'specs';
  fileGlobs?: string[];
  remediation?: string;
}

export interface AitestConfig {
  assertFunctionNames?: string[];
  criticalTags?: string[];
  requireMutationTests?: boolean;
  allowSkipTags?: string[];
  maxSkipped?: number;
  maxFlaky?: number;
  maxWaivers?: number;
  maxWaiverDays?: number;
  sourceRepos?: string[];
  maxScanFiles?: number;
  apiPrefixes?: string[];
  observability?: AitestObservabilityConfig;
  codeMap?: AitestCodeMapConfig;
  protectedGlobs?: string[];
  governance?: { protected?: string[] };
  waiversFile?: string;
  allowedEnvNames?: string[];
  requireGovernanceLock?: boolean;
  rules?: Record<string, boolean | AitestRuleConfig>;
  customMatchers?: Record<string, number>;
  parity?: AitestParityConfig;
  replayAllowedUpstreamHosts?: string[];
  lockstepRules?: LockstepRuleConfig[];
  memoryPatterns?: DeclarativeMemoryRuleSpec[];
}

export interface TargetSafetyConfig {
  testEnv: string;
  baseUrl: string;
  allowedHosts: string[];
  allowMutation: boolean;
  egressMode: EgressMode;
  extraAllowedHosts: string[];
  abortThirdPartyHosts: string[];
}

export interface WorkbenchConfig {
  ok: boolean;
  errors: string[];
  caller: WorkbenchCaller;
  qaDir: string;
  repoDir: string;
  aitestConfig: AitestConfig;
  target: TargetSafetyConfig;
  ci: boolean;
  lang: 'zh' | 'en';
  env: Record<string, string | undefined>;
}
