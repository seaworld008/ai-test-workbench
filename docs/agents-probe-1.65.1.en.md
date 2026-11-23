# Empirical Probe Report: `@playwright/test@1.65.1` Test Agents & CLI Capabilities

> [简体中文 (默认)](./agents-probe-1.65.1.md) · **Date**: 2026-11-23 · **Environment**: Windows (`pwsh`), Node.js `v26.11.0`, npm `11.20.0`, `@playwright/test@1.65.1`

This document records the empirical behavior of `@playwright/test@1.65.1` verified prior to building agent sync and quality gates:

1. **Working Directory (`cwd`) Resolution**: `init-agents` writes `.codex/`, `.claude/`, `.mcp.json`, and `specs/README.md` relative to `process.cwd()`. `src/agents.mjs` isolates execution and scrubs temporary paths before copying into `qa/`.
2. **File Overwrite Behavior**: Existing `tests/seed.spec.ts` is preserved, whereas agent definitions are unconditionally overwritten unless guarded by `qa/.aitest/agents-manifest.json` SHA-256 hashing and `*.aitest-new` sidecars. `codex` and `claude` write to disjoint directories and can be enabled together cleanly.
3. **Built-in Healer `test.fixme()` Risk**: Official `playwright_test_healer.toml` instructs models to mark persistent failures with `test.fixme()`, proving why `eslint-plugin-playwright`, `audit-results.mjs`, and `--diff-base` are mandatory.
4. **Native MCP & Runner Flags**: `@playwright/test` bundles `run-test-mcp-server` (`-c/--config`, `--headless`) so `@playwright/mcp` is unnecessary, and natively supports `--only-changed [ref]`, `--last-failed`, `--fail-on-flaky-tests`, `--grep-invert <grep>`, and `--tsconfig <path>`.
