export type AssertionStrength = 0 | 1 | 2 | 3 | 4 | 5;

export type GateRuleCode =
  | 'AITEST-G101'
  | 'AITEST-G102'
  | 'AITEST-G103'
  | 'AITEST-G104'
  | 'AITEST-G105'
  | 'AITEST-G106'
  | 'AITEST-G107'
  | 'AITEST-G108'
  | 'AITEST-G109'
  | 'AITEST-G110'
  | 'AITEST-G111'
  | 'AITEST-G112'
  | 'AITEST-G113'
  | 'AITEST-G114'
  | 'AITEST-G115'
  | 'AITEST-G116'
  | 'AITEST-G117';

export type AstScopeKind =
  | 'top-level'
  | 'describe'
  | 'hook'
  | 'test'
  | 'browser-evaluate'
  | 'catch';

export interface GateFinding {
  code: GateRuleCode | string;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  testTitle?: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface PlaywrightAttemptRecord {
  status?: string;
  duration?: number;
  error?: { message?: string; stack?: string; value?: unknown; matcherResult?: Record<string, unknown> };
  errors?: Array<{ message?: string; stack?: string; value?: unknown }>;
  attachments?: Array<{ name?: string; path?: string; contentType?: string; body?: string }>;
  stdout?: Array<{ text?: string } | string>;
  stderr?: Array<{ text?: string } | string>;
}

export interface PlaywrightTestRecord {
  testId: string;
  file: string;
  line: number;
  title: string;
  specTitle: string;
  projectName: string;
  rawStatus: string;
  status: string;
  retryPassed: boolean;
  durationMs: number;
  tags: string[];
  annotations: Array<{ type?: string; description?: string }>;
  results: PlaywrightAttemptRecord[];
  attachments: Array<{ name: string; path: string | null; contentType: string | null }>;
  errorSnippet: string | null;
}

export interface PlaywrightResultsCounts {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export interface PlaywrightResultsSummary {
  counts: PlaywrightResultsCounts;
  tests: PlaywrightTestRecord[];
}

export interface FlakyStats {
  totalRuns: number;
  passed: number;
  failed: number;
  flaky: number;
  flakyEvents: number;
  flakyRate: number;
  failRate: number;
  consecutivePasses: number;
}
