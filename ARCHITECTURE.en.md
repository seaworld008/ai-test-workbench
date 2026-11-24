# Architecture & Trustworthy Security Boundaries (`ai-test-workbench` v5.0)

> [简体中文 (默认)](./ARCHITECTURE.md) · [4-Layer Gate & Governance Guide](./docs/governance.en.md) · [ADR-0001 MCP Kernel Decision](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [English README](./README.en.md)

## 1. Core Positioning: Independent Trustworthy Verification Kernel

`ai-test-workbench v5.0` strictly separates **AI agent exploration/authoring/governed healing** from **deterministic verification**:

1. **Governed Agent Layer (MCP Execution Model v2: `src/mcp-server.mjs` + `src/jobs.mjs`)**:
   - Native zero-dependency support for `stdio`, **Streamable HTTP (`/mcp`)**, and **Legacy HTTP+SSE (`/sse`)** across MCP `2024-11-05`..`2025-11-25+` (see [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md)).
   - Exposes **21 strongly typed MCP tools**. Read-only tools run concurrently with zero global mutex; mutating and long-running tools execute in isolated child processes (`AITEST_MCP_CHILD=1`) under per-workspace write locks with `_meta.progressToken` heartbeats, `notifications/cancelled` process-tree termination, and `syncBudgetMs` async backgrounding.
   - **Privilege Isolation**: Human-only `aitest governance approve` is never registered on MCP and hard-fails inside MCP child processes.
2. **Deterministic Regression & One-Call Verdict Layer (`verifyChangeCore`)**:
   - Local pre-push hooks, PR checks, and CI execute compiled TypeScript suites and `aitest verify-change` with **zero LLM calls**, producing ULID-bound `attestation.json` and `verdict.sarif.json`.

## 2. Multi-Project Isolation (`<repo>/qa/`)

Each host repository receives an isolated `<repo>/qa/` workspace containing exact-pinned dependencies, `.aitest/governance.lock`, `.aitest/runs/` ledger manifests, `.aitest/quarantine.json`, `specs/`, `tests/`, `knowledge/`, `impact-map.json`, `waivers.json`, and `reports/`.

## 3. Default-Deny Multi-Surface Security Guards (`support/target-guard.mjs` + `base.ts`)

1. **Origin & Allowlist Egress Guards**: Hard-blocks `TEST_ENV=production|prod|live|online` and wildcards, enforces `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`, and supports `TEST_EGRESS_MODE=allowlist`.
2. **All-Channel Request Interception**: Wraps `context.route`, `APIRequestContext`, `context.request`, and `page.request` in `tests/fixtures/base.ts` with `serviceWorkers: 'block'`, bans raw `request.newContext()` via ESLint, and blocks GraphQL `mutation` payloads.
3. **Default-Deny Read-Only Explorer (`src/explore.mjs`)**: Rejects all non-`GET/HEAD/OPTIONS` requests, disables `navigator.sendBeacon`, and removes `/graphql` from default write allowlists.
4. **Redaction v2 & Supply-Chain Pinning (`src/proc.mjs` + `src/mcp-hub.mjs`)**: Scrubs JSON passwords/tokens, JWTs, cloud API keys, PEM keys, and DB URLs (`100%` recall on 35 adversarial cases); exact-pins all external MCP presets and audits `.aitest/mcp.lock` drift and prompt-poisoning patterns.
5. **Hardened MCP HTTP**: Loopback-default bind, `Origin` validation (`403`), `initialize`-only session creation, `404` on unknown sessions, TTL + `maxSessions` eviction, `crypto.timingSafeEqual` Bearer comparison, and `--workspace-root` server ceiling intersected with client roots.

## 4. 4-Layer Anti-Fake-Green Gate Kernel (`support/gate-kernel.mjs`)

- **Layer 0 Governance Lock**: Verifies SHA-256 hashes of 11 protected files against `.aitest/governance.lock`.
- **Layer 1 Static Gate**: `tsc --noEmit` + `eslint-plugin-playwright` (blocking skips, `.only`, hard sleeps, `{ force: true }`, `test.fail()`, and raw `request.newContext()`).
- **Layer 2 Run Ledger & Waiver Gate**: Binds `results.json` to current workspace source/spec hashes via `src/ledger.mjs`, deduplicates `@mutation` by `file:line`, and enforces human-approved, `<= 14d`, `<= 5` `waivers.json` limits.
- **Layer 3 `S0–S5` Assertion Lattice & Semantic Diff Guard**: Scans the entire `qa/` workspace (including untracked files) across rules `AITEST-G101..G113` (`0.0%` Fake-Green Escape Rate across `26/26` cheating patches).

## 5. Living Code Map v4, Import-Graph Impact v2, Stateful Healer & Real Web Vitals

- **Living Code Map v4 & Transitive Impact (`src/codemap.mjs` + `src/impact.mjs`)**: Preserves `:id` / `[id]` dynamic routes, prunes deleted files, converges defects, and traces transitive `import` reverse dependencies with `why` explanations.
- **Stateful Healer & Traceability (`src/heal.mjs` + `src/traceability.mjs`)**: Hard-blocks Class B/C/D test edits (`0%` mis-heal rate), emits W3C `Trace-ID` defect tickets for Class C, and audits `REQ-xxx` requirement coverage.
- **Buffered `PerformanceObserver` Web Vitals & Schema Contracts (`src/perf.mjs` + `schema-validator.mjs`)**: Measures real `LCP / CLS / INP` median & P75, validates JSON Schema / OpenAPI 3.x responses, and scans WCAG 2.0/2.1/2.2 AA.
