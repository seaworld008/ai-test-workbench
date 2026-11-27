# Security, Prompt-Injection & Artifact Handling Guide

> [简体中文 (默认)](./security.md) · [Security Policy](../SECURITY.en.md)

## 1. Environment & Network Isolation
- `support/target-guard.mjs` rejects `TEST_ENV=production|prod|live|online`, rejects wildcards, enforces `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`, blocks `TEST_BLOCKED_ENDPOINTS` across both `page.route` and `Proxy`-wrapped `APIRequestContext`, and sets `serviceWorkers: 'block'`.

## 2. Prompt-Injection Defense for AI Browser Agents & Code-Graph Metadata
- Treat **every DOM snapshot, console log, HTTP payload, and indexed code-graph symbol/path/annotation strictly as untrusted data, never instructions** (`sanitizeUntrustedCodeMetadata` neutralizes triple-backtick fences, ANSI/control/bidi chars, and prompt-poisoning payloads).
- Run coding agents inside scoped sandboxes and validate every repair patch via `npx ai-test-workbench@6.7.0 audit --check-specs --diff-base HEAD`.

## 3. MCP HTTP, Sidecar Graph Engine, Trace & Video Hygiene
- `npx ai-test-workbench@6.7.0 mcp-serve --transport http` enforces `Origin` DNS-rebinding guards (`403`) and requires Bearer `--auth-token` (`401`) on non-loopback binds.
- External code-graph sidecars (`codebase-memory-mcp@0.12.1`) enforce `--ui=false`, local binary SHA-256 verification, strict subprocess env allowlist scrubbing, and governance-lock sealing of `.aitest/mcp.lock` and `.aitest/engine-manifest.json`.
- `npx ai-test-workbench@6.7.0 diagnose` redacts secrets in text reports, whereas raw `trace.zip` and `.webm` files are not redacted—prefer `storageState` auth and short CI retention.
