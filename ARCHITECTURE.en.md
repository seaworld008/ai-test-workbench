# Architecture & Trustworthy Security Boundaries (`ai-test-workbench` v6.2)

> [简体中文 (默认)](./ARCHITECTURE.md) · [Governance & 4-Layer Gate Guide](./docs/governance.en.md) · [ADRs 0001..0005](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [Upgrade Guide](./docs/upgrade.en.md) · [English README](./README.en.md)

## 1. Layered Architecture & Acyclic Dependency Boundaries

`ai-test-workbench v6.2` enforces a strictly acyclic four-layer architecture (verified by `test/unit/architecture-boundaries.test.mjs`: `0` `src/scripts -> templates` inversions, `0` `src/**` circular imports, every `src/**/*.mjs <= 500` LOC, `0` strict `checkJs` errors):

1. **Layer 1 Core Leaf Utilities (`src/core/` + `src/types/`)**: Zero-dependency primitives (`version`, `outcome` with `CommandResult v2`, schema-validated `config`, `glob`, `redact` v3 with VT ANSI stripping, `playwright-results`, `playwright-resolve`, `proc`, `i18n`).
2. **Layer 2 Authoritative Verification Kernel (`src/kernel/`)**: Single source of truth exported via `package.json#exports` (`.`, `./kernel`, `./target-guard`, `./schema-validator`), housing immutable `TrustContext` (`src/kernel/gate/trust-context.mjs`), `SymbolTable`, and `AITEST-G101..G117`, deterministically mirrored by transitive closure into `templates/playwright-qa/support/` via `scripts/sync-template-vendor.mjs` (byte-identity enforced in CI; see [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.en.md)).
3. **Layer 3 App Facade & Domain Subsystems (`src/app/index.mjs`, `src/{trust,explore,codemap,perf,mcp-hub}/` & `src/{init,upgrade,doctor,bootstrap,governance,ledger,runner,audit,verdict,heal,diagnose,impact,flaky,traceability,report,auth-login,jobs}.mjs`)**: Stable application facade isolating `scripts/` / `bench/` from internal modules, atomic hard-link disk locks, `AITEST_RESULT_FILE` framed subprocess IPC, and cohesive `<= 500`-line modules.
4. **Layer 4 Interface Surface (`src/cli/` + `src/mcp/`)**: Per-command strict CLI option registry (unified `--json` envelopes even on usage errors, exit codes `0/1/2/64`) and zero-runtime-dependency multi-protocol MCP server (16 canonical tools + 8 deprecated v5/v6.1 forwarding aliases; see [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) and [ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.en.md)).

## 2. Project Isolation (`<repo>/qa/`) & Safe Upgrades

Each repository receives an isolated `<repo>/qa/` subproject with exact-pinned dependencies, `.aitest/template-manifest.json`, `.aitest/governance.lock`, `.aitest/runs/` ledgers, `.aitest/quarantine.json`, `specs/`, `tests/`, `knowledge/`, `impact-map.json`, `waivers.json`, and `reports/`. Host kernels upgrade safely via 3-way hash diffing in `npx ai-test-workbench@6.2.0 upgrade --target <repo>`.

## 3. Default-Deny Security Guardrails (`src/kernel/target-guard.mjs` + `base.ts`)

1. **Production, Egress & 10-Hop Redirect Firewall**: Rejects `TEST_ENV=production|prod|live|online`, malformed URLs, and invalid `TEST_EGRESS_MODE` values fail-closed; Playwright `context.route`, `APIRequestContext`, `perf`, and `explore` enforce `maxRedirects: 0` with per-hop re-validation (up to 10 hops) against `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS` / egress allowlists.
2. **Full-Channel Request Interception & Subprocess Env Isolation**: `tests/fixtures/base.ts` wraps `context.route`, `APIRequestContext`, `context.request`, and `page.request`, blocks Service Workers, distinguishes loopback sandbox default CRUD from strict shared-host read-only defaults, and `src/runner.mjs` applies an explicit env allowlist stripping `AITEST_HMAC_KEY*` / OIDC credentials from Playwright/target subprocesses.
3. **Default-Deny Explorer & Schema Inference (`src/explore/`)**: Blocks all non-`GET/HEAD/OPTIONS` HTTP requests, non-allowlisted WebSockets, and `navigator.sendBeacon`, while synthesizing candidate JSON Schemas from read-only GET responses (`specs/api-schemas.json`).
4. **Redaction v3 & Supply-Chain Pinning (`src/core/redact.mjs` + `src/mcp-hub/`)**: Strips JSON secrets, JWTs, cloud tokens, PEM keys, DB credentials, and VT ANSI sequences; pins all 7-pillar external MCP presets with `.aitest/mcp.lock` drift and prompt-poisoning checks.
5. **MCP HTTP Security Boundary**: Defaults to `127.0.0.1`, validates exact `Host` (`421`/`403`), `Origin` (`403`), and `Content-Type: application/json` (`415`), creates sessions only on `initialize`, returns `404` on unknown sessions, bounds JSON-RPC batches, verifies Bearer tokens via `crypto.timingSafeEqual`, and intersects `--workspace-root` with client `roots`.

## 4. Four-Layer Fail-Closed Anti-Fake-Green Gate Kernel (`src/kernel/gate/`)

- **Layer 0 Governance Lock, Sticky T1 & Config Schema**: Opens a single frozen `TrustContext`; supports multi-machine `macs: { [keyId]: hmac }` and sticky T1 anti-strip markers; `aitest_init` only seals fresh unmodified templates; verifies SHA-256 across protected paths and JSON-Schema-validates `aitest.config.json`.
- **Layer 1 Static Gate**: Runs `tsc --noEmit` + `eslint-plugin-playwright` (banning skips, `.only`, `waitForTimeout`, `{ force: true }`, `test.fail()`, raw `request.newContext()`); fails closed (`blocked`) in CI or whenever `governance.lock && node_modules` exist without compilers.
- **Layer 2 Run Ledger & Waiver Gate**: Binds `results.json` to ULID `runId` and workspace input fingerprint (custom `--results` without `--expected-run-id` blocks); enforces `maxSkipped=0` default and human-approved waivers (`<= 5`, `<= 14d` TTL).
- **Layer 3 SymbolTable, Lattice & Dieselgate Guard**: Evaluates **17 standalone rules (`AITEST-G101..G117`)** using TypeScript AST, lexical scope stack, and `SymbolTable` (adding `G116` HTTP status equivalence, `G117` product-side Dieselgate detection, `G-08` `git mv` out-of-tests guard, and `.aitest/baseline-ref` branch-new draft exemption); see [ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.en.md).

## 5. Living Code Map v4, Reverse Import-Graph Impact, Stateful Heal & Web Vitals

- **Living Code Map v4 & Import-Graph Impact (`src/codemap/` + `src/impact.mjs`)**: Modular framework adapters index frontend/backend/DB entities, preserve `:id`/`[id]` dynamic routes, prune deleted entries, and trace reverse static `import` chains with `why` provenance.
- **Stateful Heal & Traceability (`src/heal.mjs` + `src/traceability.mjs`)**: Hard-blocks test edits for Class B/C/D (`0.0%` mis-heal rate), emits Class-C defect tickets with 32-char W3C `Trace-ID`, and generates bidirectional `REQ-xxx` traceability matrices.
- **PerformanceObserver Web Vitals & Contract Validation (`src/perf/` + `src/kernel/schema-validator.mjs`)**: Captures buffered `LCP / CLS / INP` median and P75 alongside zero-dependency JSON Schema / OpenAPI 3.x contract validation and WCAG 2.0/2.1/2.2 AA scans.
