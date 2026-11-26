import type { ExitCode, GateOutcome } from './outcome.d.ts';

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpStructuredContent<T = Record<string, unknown>> {
  schemaVersion: number;
  ok: boolean;
  exitCode: ExitCode | number;
  outcome?: GateOutcome;
  tool: string;
  summary: string;
  recoverable: boolean;
  blockerKind: string | null;
  recoverySteps: string[];
  data: T;
  nextRecommendedActions: string[];
}

export interface McpToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  deprecated?: boolean;
  deprecatedReplacement?: string;
  cliCommand?: string;
  toCliArgs?: (args: Record<string, unknown>) => string[];
  execute?: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  nextActions?: (ok: boolean, args: Record<string, unknown>, data: Record<string, unknown>) => string[];
  longRunning?: boolean;
  defaultSyncBudgetMs?: number;
}
