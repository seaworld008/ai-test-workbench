export type EgressMode = 'permissive' | 'allowlist';

export type RuleSeverity = 'error' | 'off';

export type WorkbenchCaller = 'human-cli' | 'mcp-child' | 'ci';

export interface AitestRuleConfig {
  enabled?: boolean;
  severity?: RuleSeverity;
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
  protectedGlobs?: string[];
  governance?: { protected?: string[] };
  waiversFile?: string;
  allowedEnvNames?: string[];
  requireGovernanceLock?: boolean;
  rules?: Record<string, boolean | AitestRuleConfig>;
  customMatchers?: Record<string, number>;
}

export interface TargetSafetyConfig {
  testEnv: string;
  baseUrl: string;
  allowedHosts: string[];
  allowMutation: boolean;
  egressMode: EgressMode;
  extraAllowedHosts: string[];
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
