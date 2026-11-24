# Changelog

> [简体中文 (默认)](./CHANGELOG.md) · [English README](./README.en.md) · [v5→v6 Upgrade Guide](./docs/upgrade.en.md) · [v6 Refactor Assessment](./docs/review/v6-refactor-assessment.en.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.0] - 2026-11-24

### Breaking Changes (see [docs/upgrade.en.md](./docs/upgrade.en.md))
- **MCP Tool Surface Consolidation (21 → 17 Canonical Tools)**: Merged `aitest_heal_begin` / `aitest_heal_attempt` / `aitest_heal_conclude` into `aitest_heal(action: "begin"|"attempt"|"conclude")`, and `aitest_job_status` / `aitest_job_result` / `aitest_job_cancel` into `aitest_job(action: "status"|"result"|"cancel")`. All 6 legacy tool names continue forwarding via `tools/call` throughout `v6.x` with `data._deprecation` metadata and summary warnings.
- **Per-Command Strict CLI Flag Validation**: `src/cli/commands.mjs` validates allowed flags per subcommand and exits `1` with typo suggestions on unrelated flags (`governance approve` retains a deprecated `--approver` → `--by` alias for one major release).
- **Unified `--json` Envelopes & Exit Codes**: All CLI `--json` outputs include `ok` and `exitCode` (plus `outcome` for gates); added `init --json`; all `blocked` outcomes (including `run --audit`) exit `2`.
- **6 Fail-Closed Tightening Changes**: Missing TypeScript compiler, missing `tsc`/`eslint` in CI, custom `--results` bypassing Run Ledger, uninitialized workspaces, malformed target URLs, and corrupt `aitest.config.json` now return `outcome: 'blocked'` (exit `2`) instead of silently passing or falling back to defaults. Offline manual debugging can explicitly pass CLI-only `--allow-unbound-results` (downgraded to T0).
- **Authoritative Kernel Relocation (`src/kernel/`) & Package Exports**: Moved the authoritative gate kernel from `templates/playwright-qa/support/` to `src/kernel/` and exposed `.`, `./kernel`, `./target-guard`, and `./schema-validator` in `package.json#exports`; `templates/playwright-qa/support/` is now a one-way deterministic vendor mirror (`npm run sync:vendor` / `check:vendor`).

### Added & Refactored
- **Pluggable AST Gate Engine & Real-World FPR Reduction ([ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.en.md))**:
  - Decomposed the 1,649-line `ast-analyzer.mjs` into `ts-loader`, `constant-eval`, `lattice`, `parser-inspectors`, `parser` (lexical scope stack), `diff-parser`, `changeset`, `static-runner`, and 15 standalone toggleable rule modules `AITEST-G101..G115` configurable via `aitest.config.json#rules` (sealed by `governance.lock`).
  - Shipped 5 systematic FPR fixes: cross-file title pooling, lexical scope reset with `browser-evaluate`/negative `catch` awareness, structured `skip` accounting & runtime-capability guards, calibrated web-first lattice ranks, and fault-injection/honeypot-aware `G114`.
  - **Blind Unseen Holdout Evaluation (`n=50`, `seed=20261125`, zero overlap)**: Reduced FPR from `12.2%` (`6/49`, CI `[5.7%, 24.2%]`) to **`6.1%` (`3/49`, Wilson 95% CI `[2.1%, 16.5%]`)** retaining `1/1` true positive; Pilot (`n=50`) dropped from `20.8%` to **`4.2%` (`2/48`, CI `[1.2%, 14.0%]`)**; Combined (`n=100`) is **`5.2%` (`5/97`, CI `[2.2%, 11.5%]`, `3/3` TP retained)** with zero regression on `FGER-internal = 0.0% (26/26)`, `FGER-holdout = 0.0% (24/24)`, and `Gate-FPR(internal) = 0.0% (12/12)`.
- **Template Manifest & `aitw upgrade` ([ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.en.md))**: `init` writes `.aitest/template-manifest.json`; new `upgrade [--dry-run] [--force]` performs 3-way hash-safe template upgrades preserving user edits; fixed `doctor` kernel version drift detection.
- **Centralized Config & Unified Outcome Model ([ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.en.md))**: Added schema-validated `src/core/config.mjs` and `src/core/outcome.mjs`; decomposed all 5 `> 900`-line god modules (max module dropped from `1,649` to `786` lines), eliminated all 4 circular dependencies (`0` cycles), and deduplicated `results.json`/Playwright/glob helpers.
- **Strict Type Safety ([ADR-0003](./docs/adr/0003-strict-checkjs-type-safety.en.md))**: Exact-pinned `typescript@6.0.3` and `@types/node@26.6.6` in root `devDependencies` (keeping zero runtime `dependencies`), enabled `strict: true, noImplicitAny: true, useUnknownInCatchVariables: true` in `tsconfig.check.json` with 0 errors and 0 suppression directives, and made `run-typecheck.mjs` fail-closed everywhere.
- **Three-Layer Test Suite & >=80% Coverage Gate**: Reorganized tests into `test/{unit,integration,adversarial}/` preserving every existing adversarial/red-team/E1–E6 case, expanded unit tests across CLI/workspace/verdict modules, and enforced `--test-coverage-lines=80` in `scripts/run-unit-tests.mjs` and CI.
- **Docs Convergence & Package Hygiene**: Archived historical reviews/blueprints to `docs/history/`, consolidated 5 numbered ADRs (`0001..0005`), added `scripts/generate-docs.mjs` to auto-sync the 17-tool MCP tables across 8 active docs, strengthened `lint:docs` (generated-table drift check, bilingual H2 parity, CLI flag validation), tightened `package.json#files` to exclude reviews/history/internal scripts, and added tarball hygiene tests.
- **Live Enterprise SaaS Dogfooding Hardening (`explore` / CLI / `governance` / Release Pipeline)**:
  - `explore` now derives default `entryPath` from non-root `--base-url` paths, deduplicates and short-circuits unauthenticated login redirect storms (`authRequired`, `loginRoute`, `authRedirectCount`, and `auth-login` guidance), filters self-inflicted Playwright read-only firewall `net::ERR_BLOCKED_BY_CLIENT` console noise into `firewallAbortedConsoleCount`, and accepts positive `--explore-portals` / `--explore-tabs` / `--explore-dialogs` flags.
  - Standardized `{ ok, exitCode }` across all CLI `--json` outputs (`doctor`, `explore`, `perf`, `report`, `map`, `flaky`, `impact`, `trace-matrix`, `mcp`, `skill-install`, `governance`), aligned `governance status|verify` `blocked` exit code to `2`, and added root `npm ci` + `npm run check:vendor` steps to `release.yml` (preserving OIDC publishing permissions).

## [5.1.1] - 2026-11-24

### Changed & Hardened
- **Tokenless Native npm Trusted Publishing (OIDC) Activation**: Upgraded [.github/workflows/release.yml](./.github/workflows/release.yml) to **Node.js 24** (bundled `npm >= 11.5.1`), removed `registry-url` and `NODE_AUTH_TOKEN` to publish directly via GitHub Actions OIDC (`id-token: write`) with SLSA v1 Sigstore Provenance; updated reusable `aitest-verify.yml` default version and pinned CLI examples to `5.1.1`.

## [5.1.0] - 2026-11-24

### Removed / Breaking
- **Removed `aitest` CLI bin alias; added `aitw`**: The `aitest` binary name collided with an existing unrelated package on npm that also registers `aitest`. Because `ai-test-workbench` had not previously been published to npm, `bin.aitest` has been removed from `package.json`. Use pinned `npx ai-test-workbench@5.1.0 <cmd>`, global `aitw <cmd>`, or local `node tools/aitest.mjs <cmd>`. For backwards compatibility with existing clients, `tools/aitest.mjs`, MCP tool names (`aitest_*`), `.aitest/`, `AITEST-G*` rule codes, and `AITEST_*` environment variables remain unchanged.

### Added & Hardened
- **npm Provenance Release Workflow**: Added `publishConfig: { "access": "public", "provenance": true }` to `package.json` and tag-triggered [.github/workflows/release.yml](./.github/workflows/release.yml) (all Actions pinned to full commit SHAs, running all 7 verification gates prior to `npm publish --provenance --access public`, with Trusted Publisher migration guidance).
- **`T2` Trust Tiers & Reusable CI Verification Workflow**: Unified canonical `T0 / T1 / T2` wording across README, `trust.mjs`, verdict summaries, and SARIF (only CI-attested `T2` is a merge-grade green); added reusable [.github/workflows/aitest-verify.yml](./.github/workflows/aitest-verify.yml) (`github-attest` | `cosign`) and [examples/workflows/use-aitest-verify.yml](./examples/workflows/use-aitest-verify.yml); hardened `attest verify` with `--expect-repo` / `--expect-workflow` / `--expect-ref` and zero-dep offline Sigstore/Fulcio identity & digest checks (fail-closed by default).
- **Zero-Dep MCP ADR & Official Conformance Gate**: Added the zero-dependency MCP ADR (now consolidated into [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md)) and isolated `conformance/` harness pinned to `@modelcontextprotocol/conformance@0.1.16` and `@modelcontextprotocol/sdk@1.32.2` (CI `mcp-conformance` job verifying `stdio`, Streamable HTTP, and Legacy SSE), plus fixes for Legacy SSE async `202` dispatch and Streamable HTTP dual-`Accept` progress streaming.
- **Real-World Open-Source Gate FPR Pilot & Agentic Red-Team Design**: Pre-registered protocol [bench/real-world/PREREGISTRATION.en.md](./bench/real-world/PREREGISTRATION.en.md) committed prior to data collection; ran offline static/AST pilot across 5 permissive OSS repos (`n = 50`, adjudicated FPR `20.8%`, Wilson 95% CI `[11.7%, 34.3%]`; raw alert rate `24.0%`; `>=200` formal evaluation marked `pending`), and authored `FGER-agentic` design spec [bench/agentic/DESIGN.en.md](./bench/agentic/DESIGN.en.md).
- **Enterprise Multi-Portal SaaS Deep Exploration & Live Browser Auth Reuse (Distilled from Live SaaS Dogfooding)**:
  - Upgraded `explore` with **multi-portal / tenant switcher drawer discovery & cross-portal traversal** (`--explore-portals` / `--max-portals`), **domain-stratified round-robin BFS** (`maxPages` up to `500`), **Vue 2 `$router.getRoutes()` + Vuex permission route trees**, **collapsed submenu expansion**, **intra-page tab clicking** (`--explore-tabs`), **strictly read-only detail dialog/drawer probing & closing** (`--explore-dialogs`, protected by both label whitelist and default-deny network firewall), **broken SPA route detection** (`brokenRoutes`), **Element UI / AntD fixed-column row deduplication**, **HTTP 200 business-envelope error detection** (`code: 401/403/500`, also in `perf`), **percent-encoded query anomaly fix** (`%5B$L%5D`), and **separated API gateway host hints** (`blockedApiHosts`).
  - Added loopback-restricted `auth-login --cdp-url <http://127.0.0.1:9222>` to capture authenticated sessions from an already-logged-in Chrome browser without repeating SMS OTP / CAPTCHA or closing the user's browser.
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
