// @ts-check
/**
 * Re-exports the single-source-of-truth target & request safety guard from src/kernel/target-guard.mjs
 * so CLI preflight checks, unit tests, and vendored Playwright runtime share one authoritative implementation.
 */
export * from './kernel/target-guard.mjs';
export { parseEnvText as parseDotEnv } from './kernel/target-guard.mjs';
