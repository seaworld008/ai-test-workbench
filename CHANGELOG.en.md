# Changelog

> [简体中文 (默认)](./CHANGELOG.md) · [English README](./README.en.md) · [v5.0 Verification Scorecard](./docs/review/v5-verification-scorecard.en.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.1.0] - 2026-11-24

### Removed / Breaking
- **Removed `aitest` CLI bin alias; added `aitw`**: The `aitest` binary name collided with an existing unrelated package on npm that also registers `aitest`. Because `ai-test-workbench` had not previously been published to npm, `bin.aitest` has been removed from `package.json`. Use pinned `npx ai-test-workbench@5.1.0 <cmd>`, global `aitw <cmd>`, or local `node tools/aitest.mjs <cmd>`. For backwards compatibility with existing clients, `tools/aitest.mjs`, MCP tool names (`aitest_*`), `.aitest/`, `AITEST-G*` rule codes, and `AITEST_*` environment variables remain unchanged.

### Added & Hardened
- **npm Provenance Release Workflow**: Added `publishConfig: { "access": "public", "provenance": true }` to `package.json` and tag-triggered [.github/workflows/release.yml](./.github/workflows/release.yml) (all Actions pinned to full commit SHAs, running all 7 verification gates prior to `npm publish --provenance --access public`, with Trusted Publisher migration guidance).
- **`lint:docs` CLI & Version Drift Enforcement**: Fails on unpinned `npx -y ai-test-workbench`, removed `aitest <cmd>` CLI examples, or version tags drifting from `package.json`.
- **Modular AST Gate Kernel v3, T1 Out-of-Workspace HMAC, Structured Redaction & Modular MCP Server**: Fail-closed 3-state gate blocks `24/24` red-team holdout cheats (`FGER-holdout = 0.0%`) at `0.0%` benign refactoring FPR, preserves typed `heal_*` `sessionId` across MCP calls, and eliminates real Playwright stack `C->A` misclassification.

## [5.0.0] - 2026-11-24

### Added
- **4-Layer Anti-Fake-Green Gate Kernel v2 (`templates/playwright-qa/support/gate-kernel.mjs`)**:
  - Introduced the **`S0–S5` Assertion Strength Lattice** and full-workspace Semantic Diff Guard (`AITEST-G101..G113`), blocking equal-count assertion downgrades, `expect(true).toBe(true)`, `test.fail()`, `.catch(() => null)`, inflated `retries`, `expect.soft()`, `testIgnore`, disabled ESLint rules, conditional `if (...) { expect(...) }`, and `200 -> 500` status flips (**`0.0%` Fake-Green Escape Rate across `26/26` cheating patches**).
- **Governance Tamper Lock & Human Approval Protocol (`src/governance.mjs` & `aitest governance`)**:
  - Maintains SHA-256 digests for 11 protected files in `.aitest/governance.lock` plus append-only `.aitest/governance-audit.jsonl`; `governance approve` is restricted to human local CLI execution and hard-blocks MCP child processes and bot identities.
- **Run Ledger Binding & Flaky Auto-Quarantine (`src/ledger.mjs` & `src/flaky.mjs`)**:
  - Binds each execution to a Crockford Base32 ULID `runId` and workspace input hash (`.aitest/runs/<runId>/manifest.json`), invalidating stale `results.json` files after edits; tracks rolling flaky rates with `<= 7d` TTL quarantine (`.aitest/quarantine.json`).
- **One-Call Change Verdict, Stateful Healer & Requirement Traceability (`src/verdict.mjs`, `src/heal.mjs`, `src/traceability.mjs`)**:
  - Added `aitest verify-change` / `aitest_verify_change` emitting `attestation.json`, `verdict-summary.md`, and `verdict.sarif.json`.
  - Added `aitest heal begin|attempt|conclude`: tool-enforces `0.0%` mis-heal rate on Class B/C/D failures and generates W3C `Trace-ID` defect tickets (`reports/defects/*.md`) for Class C bugs.
  - Added `aitest trace-matrix` / `aitest_trace_matrix` mapping `REQ-xxx` IDs across specs, tests, and run results.
- **MCP Execution Model v2 & Child-Process Job Runner (`src/jobs.mjs` & `src/mcp-server.mjs`)**:
  - Expanded to **21 typed MCP tools**; eliminated `globalThis.console` hijacking; added lock-free read concurrency, per-workspace write locks, `syncBudgetMs` async background jobs, `_meta.progressToken` heartbeats, and `notifications/cancelled` cross-platform process-tree termination (`killProcessTree`). Documented in [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md).
- **Zero-Dep JSON Schema / OpenAPI 3.x Validator & Seeded-Defect Benchmark (`support/schema-validator.mjs` & `scripts/run-bench.mjs`)**:
  - Added `npm run bench` verifying `7/7 (100%)` seeded full-stack defects and `26/26 (100%)` blocked cheating patches (`bench/scorecard.json`), plus `npm run typecheck` and `docs/claims.json` verification in `lint:docs`.

### Improved & Security Fixed
- **Fixed Real CDP Web Vitals & WCAG 2.1 (`src/perf.mjs` & `base.ts`)**: Switched to pre-injected buffered `PerformanceObserver` for real non-null `LCP`, `CLS`, and `INP` (median & P75); added `wcag21a` and `wcag21aa` to `expectAccessible`.
- **Multi-Surface Security & Redaction v2 (`target-guard.mjs`, `explore.mjs`, `proc.mjs`, `mcp-hub.mjs`)**:
  - Default-denied non-`GET/HEAD/OPTIONS` requests and blocked `sendBeacon` in `explore` while writing redacted `specs/pages/*.md` ARIA snapshots; removed `/graphql` from safe writes and blocked GraphQL `mutation` payloads; added `TEST_EGRESS_MODE=allowlist` and wrapped `page.request` / `context.request`.
  - Upgraded `redactSecrets` to 100% recall across 35 secret patterns (JSON passwords, JWTs, cloud tokens, PEM keys, DB URLs); exact-pinned all external MCP presets (`@bytebase/dbhub@0.15.0 --readonly`) and added `.aitest/mcp.lock` hash & prompt-poisoning checks.
  - Hardened Streamable HTTP (`initialize`-only session creation, `404` on unknown session, TTL + `maxSessions`, `crypto.timingSafeEqual` Bearer auth, protocol-aware batching).
- **Living Code Map v4, Import-Graph Impact v2 & Structured Triage (`codemap.mjs`, `impact.mjs`, `diagnose.mjs`)**:
  - Preserved `:id`/`[id]` dynamic routes, pruned deleted routes, converged defects, built static reverse `import` graphs with `why` provenance, achieved `45/45 (100%)` triage accuracy, and enabled strict CLI flag parsing with typo suggestions.

## [4.0.0] - 2026-11-23

### Added
- Native Multi-Protocol MCP Server (`stdio`, `/mcp`, `/sse`) with 12 tools and bilingual Chinese-default / `.en.md` docs.

## [3.0.0] - 2026-11-23

### Added
- Self-Evolving Living Code Map (`aitest map`), 6-Pillar Read-Only MCP Hub (`aitest mcp`), Perf Engine (`aitest perf`), and Trace-ID correlation.

## [2.1.0] - 2026-11-23

### Added
- Zero-to-One Read-Only Explorer (`aitest explore`).

## [2.0.0] - 2026-11-23

### Added
- Initial open-source release with `<repo>/qa/` isolation, Playwright Test Agents manifest sync, 3-layer gate, `auth-login`, and `demo-campus` target.
