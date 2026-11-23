/**
 * Re-exports the single-source-of-truth target & request safety guard from templates/playwright-qa/support/target-guard.mjs
 * so CLI preflight checks, unit tests, and Playwright runtime use the exact same implementation.
 */
export * from '../templates/playwright-qa/support/target-guard.mjs';
export { parseEnvText as parseDotEnv } from '../templates/playwright-qa/support/target-guard.mjs';
