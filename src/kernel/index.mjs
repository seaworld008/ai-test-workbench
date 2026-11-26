// @ts-check
/**
 * AI Test Workbench — Authoritative Verification Kernel Entrypoint (`ai-test-workbench/kernel`).
 *
 * Single source of truth for the 4-layer anti-fake-green gate engine, target/egress firewall,
 * and JSON Schema / OpenAPI contract validator. Vendored copies inside `templates/playwright-qa/support/`
 * are generated deterministically from this directory via `scripts/sync-template-vendor.mjs`.
 */

export * from './gate-kernel.mjs';
export * from './target-guard.mjs';
export * from './schema-validator.mjs';
export * from './diff-oracle.mjs';
