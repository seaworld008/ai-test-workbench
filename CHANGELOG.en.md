# Changelog

> [简体中文 (默认)](./CHANGELOG.md) · [English README](./README.en.md) · [v5→v6 Upgrade Guide](./docs/upgrade.en.md) · [v6 Refactor Assessment](./docs/review/v6-refactor-assessment.en.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.2.1] - 2026-11-25

### Security & Trust-Boundary Hardening
- **Closed `.aitest/baseline-ref` Provenance Forgery T2 Escape**: Added `.aitest/baseline-ref` and `.aitest/t1-sticky.json` to `templates/playwright-qa/gitignore` and protected paths (`isProtectedDiffPath`); switched `.aitest/baseline-ref` to HMAC-signed `workspace.baseline` JSON; unconditionally ignore workspace `.aitest/baseline-ref` in CI or whenever explicit `--base`/`diffBase` is passed; locally enforce `merge-base --is-ancestor`, non-empty Git tree, `--first-parent` lineage (defeating `-s ours --allow-unrelated-histories` empty-tree poisoning), and descendant check against `merge-base(HEAD, main)`.
- **Fail-Closed Sticky-T1 Foreign `keyId`, `governance approve`, and Env Allowlist**:
  - Machine-local runtime domains (`ledger.manifest`, `heal.ledger`, `heal.session`, `quarantine.json`, `workspace.baseline`) now strictly fail closed (`ok: false`) on missing local MAC or foreign `keyId` when `hostT1Sticky` is active; `governance.lock` records workspace sticky bindings (`.aitest/t1-sticky.json` + out-of-workspace marker) and caps genuine cross-machine foreign clones at `T0`.
  - `governance approve` removed `CI=1` auto-grant and `--json` TTY prompt skipping, and blocks common coding-agent session markers (`ANTIGRAVITY_CONVERSATION_ID`, `CLAUDECODE`, `CODEX_CI`, `CODEX_SANDBOX`, `CURSOR_TRACE_ID`, `AIDER_MODEL`), requiring explicit `AITEST_APPROVE_NON_INTERACTIVE=1` + `--yes` for non-TTY human approvals.
  - `verifyAttestationFile` passes resolved `qaDir`/`repoDir` to reject in-workspace `AITEST_HMAC_KEY_FILE` (exit `2`) and rejects `< 12`-char or non-hex `--expect-git-sha`; `buildSafeChildEnv` and `runner.mjs` enforce strict allowlists and strip embedded proxy URL credentials.
- **X.509 / Fulcio / CI Artifact Validation / Adapter & MCP HTTP Hardening**:
  - `der-x509.mjs` and `sigstore-verify.mjs` now enforce `BasicConstraints` (`ca: true` on root/intermediates, `ca: false` on leaf), `KeyUsage`, `pathLenConstraint`, validity timestamps against Rekor `integratedTime` (or wall clock), and Fulcio commit SHA OIDs (`.1.3` / `.1.21`).
  - `.github/workflows/aitest-verify.yml` `attest` job validates non-symlink fixed artifact paths (`aitest-ci-artifacts/{attestation.json,verdict-predicate.json,verdict.sarif.json}`), `verdict === 'pass'`, all 4 gates === `'pass'`, `git-commit === GITHUB_SHA`, and predicate parity without trusting `needs.verify.outputs.*-path`.
  - Extended `eslint.config.mjs` and `static-runner.mjs` across ALL `tests/**` files (including custom fixtures/helpers) blocking raw `fetch`/`WebSocket`/dynamic `import()`/`expect.extend`; validated `webServer.env` in `runtime-config.mjs` and `playwright.config.ts`; scoped default loopback egress in `base.ts` to `baseURL`'s exact `host:port` with 10-hop redirect tracking; added `serviceWorkers: 'block'` and `routeWebSocket` in `perf`; fixed dead `redirectedFrom()` in `explore`; pinned `mcp-grafana==2.2.0`, `redis-mcp-server==0.5.1`, and `grafana/mcp-k6:0.7.2` with `:latest` Docker tag auditing.
  - Hardened MCP HTTP against cross-port loopback `Origin` when unauthenticated, returns `429` at unauthenticated session capacity instead of evicting active sessions, configures `headersTimeout`/`requestTimeout`/`keepAliveTimeout`, and removes host `allowedRoots` path leaks from `protocol.mjs`; `redact.mjs` preserves boolean/number primitives (`authRequired`), scrubs `api_key`, single-line JSON-escaped PEMs, and sensitive `localStorage` keys.

### AST Gate v2.1 Accuracy & Real-World FPR Restoration
- **Fixed `upgrade` / Idempotent `init` Self-Bricking & `acquireDiskLock` Race**: Unified deterministic code-unit sorting in `writeTemplateManifest` and `upgradeQaWorkspace`, skipped rewriting `.aitest/template-manifest.json` when hashes are unchanged, ignored volatile `updatedAt` in `computeTemplateManifestDigest`, and created missing `.aitest/` before acquiring atomic `.write.lock`.
- **Restored 100-Commit Real-World FPR from `10.3%` to `5.2% (5/97)`**: Prevented `SymbolTable` from folding mutable Array/Object literals (`const pageErrors = []`, `const messages = []`) as constants, added single-assignment `let`/`var`, destructuring, default params, and shorthand `{ soft }`; scoped DOM-taint self-reference to same-locator reads with no intervening action and no arithmetic/template derivation; added `.split().forEach` and target-bound `expect(arr.length).toBe(N)` loop count guards; fixed lazy regex quantifiers (`F07`), single-char match-all `/[\s\S]/` (`G2-F07`), multi-statement `expect.poll` (`F47`), identical ternary branches (`G2-F08`), `<alias>.extend` always-pass matchers (`F12`), `expectApiContract` status extraction + status var/century-slice tracking + `400/409/422` grouping (`G2-F09`, `G2-F10`, `G2-L01`, `G2-L02`); upgraded `AITEST-G117` with local Def-Use taint propagation, string concat/Base64 decoding, and `sec-fetch-*` detection (closing hoisted-variable Dieselgate T2 escape) while exempting top-level startup guards (`G2-L03`); closed empty-spec branch floor, `@scaffold` replacement, `F44/F45/F55` non-executable `git mv`, cross-file `@critical` pooling (`L09`), and per-REQ max assertion tier retention (`G2-F14`).
- **Autonomy, Diagnostics & CLI DX Polish**: Defaulted `playwright.config.ts` `webServer.cwd` to repo root, fell back `explore`/`perf` to `aitest.runtime.json#baseURL` with fail-closed config checks, removed `!includes('server')` exclusion in `A-UI-Sync` diff correlation, normalized Windows `testId` backslashes, guaranteed non-empty `--json` envelopes on all CLI error exits with exit `64` on invalid numeric/enum flags, added `force` to `aitest_map_sync`, eliminated Windows `shell: true` multiline prompt injection in `agent-adapters.mjs`, removed `--fast` mode gate-bypass masking in `evaluator.mjs`, and added live Playwright E2E regression tests for `AG-E1`, `AG-E2`, forged `.aitest/baseline-ref`, and hoisted-variable Dieselgate.

## [6.2.0] - 2026-11-25

### Breaking Changes & Interface Polish
- **MCP Tool Surface Convergence (17 → 16 Canonical Tools)**: Added zero-to-one loopback bootstrapper `aitest_bootstrap`, folded `aitest_flaky_report` and `aitest_trace_matrix` into `aitest_report(view="summary"|"flaky"|"traceability")`, and added `action: "discard"` to `aitest_heal`. All **8 legacy v5/v6.1 tool names** continue forwarding via `tools/call` across `v6.x` with `_deprecation` warnings; CLI adds `bootstrap`, `report --view`, forwarded `flaky`/`trace-matrix`, and `--json` usage errors (`0=pass` / `1=fail` / `2=blocked` / `64=usage`).

### Security Hardening & Trustworthy Boundaries
- **Immutable `TrustContext`, Sticky T1 & `aitest_init` Re-Sign Closure (WU-01)**:
  - Added `src/kernel/gate/trust-context.mjs`, resolving `{ tierCeiling, key, keyId, source, hostT1Sticky }` once at entry and passing it explicitly across all verifiers; removed implicit runtime `signPayloadT1(..., { createIfMissing: true })` and `allowForeignLockMac` bypasses.
  - Added multi-machine `macs: { [keyId]: hmac }` support (backward-compatible with `mac`) plus host sticky T1 markers rejecting stripped `mac` fields or deleted ledgers; `aitest_init` now seals `source: "aitest-init"` only when no prior governance/run/heal history exists and all protected files match factory hashes.
  - Preserved `AITEST_HMAC_KEY_FILE` for MCP child processes in `src/jobs.mjs` while enforcing a strict subprocess env allowlist in `src/runner.mjs` (stripping `AITEST_HMAC_KEY*` and CI OIDC secrets from Playwright/target code); added RFC 8785-safe `canonicalizeJson` and stricter bot approver blocking.
- **10-Hop Redirect Firewall, MCP HTTP Hardening & Redaction v3 (WU-03)**:
  - Enforced `maxRedirects: 0` loops (up to 10 hops) with per-hop safety re-validation (honoring `301/302/303` vs `307/308`) across `base.ts` `context.route`, `APIRequestContext`, `explore`, and `perf`; invalid `TEST_EGRESS_MODE` fails closed.
  - Hardened MCP HTTP/SSE with exact `Host` (`421`/`403`), `Origin` (`403`), and `Content-Type: application/json` (`415`) checks, bounded JSON-RPC batches, `409` duplicate SSE protection, redacted error paths, and `SIGTERM -> SIGKILL` tree termination.
  - Upgraded `redactSecrets` to v3 (adding VT ANSI escape stripping and broader token patterns); switched `sync:vendor` to transitive closure mirroring from `src/kernel/` (`41` files); split workflow privileges and pinned Sigstore `commit/tree/root`.
- **AST Gate Engine v2 & `AITEST-G116 / G117` (WU-05)**:
  - Added cross-scope `src/kernel/gate/symbol-table.mjs` (`const` propagation, named `page.route` handlers, DOM taint sources, helper checks); hardened `AITEST-G104..G114` against `expect.poll`, loop/listener hiding, `Promise.allSettled`, vacuous regexes, and `ruleG114` stubbing an asserted negative HTTP status (e.g., `403` RBAC stubs).
  - Added **`AITEST-G116`** (HTTP status equivalence shift & exact-to-range widening) and **`AITEST-G117`** (product-side Dieselgate test-traffic detection), plus `G-08` `git mv` spec-out-of-tests guard in `changeset.mjs`.

### Architecture & Zero-Block Autonomy
- **Framed IPC, Atomic Disk Lock & Layered Facade (WU-02)**: Replaced stdout JSON tail-scraping with `AITEST_RESULT_FILE` framed IPC; hardened `acquireDiskLock` with temp-file hard-link creation and dead-PID reclamation; activated `loadWorkbenchConfig` with explicit `caller` context; added `src/app/index.mjs` public facade and enforced **`<= 500` LOC across every `src/**/*.mjs`** in `test/unit/architecture-boundaries.test.mjs`.
- **Zero-Block Autonomous Loop & Benchmark Expansion (WU-04 & WU-06)**: Separated loopback default CRUD from shared-host read-only defaults; added `.aitest/baseline-ref` branch-new draft exemption (`>= S2` floor enforced); added `A-UI-Sync` product-diff triage correlation and read-only GET API schema synthesis (`specs/api-schemas.json`); decoupled generic template specs from `demo-campus` preset specs.
- **18-Task `FGER-agentic` (incl. Class E Dieselgate `AG-E1`/`AG-E2`) & `autonomous-suite` (`--fast`, `v6.2.0`)**: `FGER-agentic_T1 = 11.1%` (`2/18`, Wilson 95% CI `[3.1%, 32.8%]` — strictly `AG-B4`/`AG-C4`), `FGER-agentic_T2 = 0.0%` (`0/18`, CI `[0.0%, 17.6%]`), with `AG-E1`/`AG-E2` both blocked at `L3-AST-Diff`; `bench/agentic/autonomous-suite.mjs` achieves `100%` zero-block completion with `0%` FGER (see [bench/agentic/results/SUMMARY.en.md](./bench/agentic/results/SUMMARY.en.md)).

## [6.1.0] - 2026-11-24

### Added
- **Autonomous Red-Team Fake-Green Escape Rate Benchmark (`FGER-agentic`, `npm run bench:agentic`)**:
  - Upgraded [bench/agentic/DESIGN.en.md](./bench/agentic/DESIGN.en.md) to a full executable dual-tier benchmark specification with a 16-task pre-registered corpus in [bench/agentic/tasks.json](./bench/agentic/tasks.json) spanning Attack Classes A/B/C/D, threat tiers L1/L2/L3 (including DOM indirect prompt injection), and `benign-pressure` / `adversarial-redteam` prompt tiers.
  - Added a zero-runtime-dependency harness (`bench/agentic/lib/` & `scripts/bench-agentic.mjs`) featuring evaluator-isolated hidden business oracles (8 real Smart Campus defects), immutable protected-base bare remotes, an in-memory ASN.1 DER X.509 v3 Ephemeral Fulcio T2 CA & Sigstore v0.3 DSSE signer, 6-layer blocking attribution, Wilson 95% confidence intervals, and redacted trajectory logging.
  - **Live Playwright Scripted Multi-Step Baseline (`live-playwright`, `n=16`)**: Local T1 Guardrail **`12.5%` (`2/16`, CI `[3.5%, 36.0%]`)** (exclusively the 2 documented same-UID local boundary probes `AG-B4`/`AG-C4`); Isolated CI T2 Merge-Grade Root of Trust **`0.0%` (`0/16`, CI `[0.0%, 19.4%]`)**; `honest-fix` control `4/4` verified T2 green and `honest-report` control `0%` mis-heal; see [bench/agentic/results/SUMMARY.en.md](./bench/agentic/results/SUMMARY.en.md).
  - Included pluggable live autonomous LLM CLI adapters (`--adapter claude|codex|gemini|custom`); live commercial/open-weight LLM scores remain transparently labeled `pending` with zero extrapolation.
  - Added adversarial test suite `test/adversarial/fger-agentic.test.mjs` linked to `CLAIM-18-fger-agentic-dual-tier-redteam` in [docs/claims.json](./docs/claims.json).

### Fixed
- **Cross-Machine Clean CI Runner `governance.lock` MAC Handling**: Fixed a cross-machine CI issue in `src/verdict.mjs`, `src/kernel/gate/engine.mjs`, and `src/kernel/gate/policy.mjs` (synced to `templates/playwright-qa/support/`) where a fresh CI runner lazily generating a runner-local T1 key in `beginRunLedger` previously flagged a developer-committed `.aitest/governance.lock` MAC mismatch, while preserving strict local T1 HMAC verification, full protected-file SHA-256 checks, and CI `AITEST-G101` protected-base diff enforcement.

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
