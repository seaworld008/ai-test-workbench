export type EgressMode = 'permissive' | 'allowlist';

export type RuleSeverity = 'error' | 'off';

export interface AitestRuleConfig {
  enabled?: boolean;
  severity?: RuleSeverity;
}

export interface AitestConfig {
  requireMutationTests?: boolean;
  allowSkipTags?: string[];
  maxSkipped?: number;
  maxFlaky?: number;
  protectedGlobs?: string[];
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
  qaDir: string;
  repoDir: string;
  aitestConfig: AitestConfig;
  target: TargetSafetyConfig;
  ci: boolean;
  lang: 'zh' | 'en';
  env: Record<string, string | undefined>;
}
