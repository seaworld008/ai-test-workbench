# Architecture & Trustworthy Security Boundaries (`ai-test-workbench` v6.0)

> [简体中文 (默认)](./ARCHITECTURE.md) · [Governance & 4-Layer Gate Guide](./docs/governance.en.md) · [ADRs 0001..0005](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [Upgrade Guide](./docs/upgrade.en.md) · [English README](./README.en.md)

## 1. Layered Architecture & Acyclic Dependency Boundaries

`ai-test-workbench v6.0` enforces a strictly acyclic four-layer architecture (verified by `test/unit/architecture-boundaries.test.mjs`: `0` `src/scripts -> templates` inversions, `0` `src/**` circular imports, `0` strict `checkJs` errors):

1. **Layer 1 Core Leaf Utilities (`src/core/` + `src/types/`)**: Zero-dependency primitives (`version`, `outcome`, schema-validated `config`, `glob`, `redact`, `playwright-results`, `playwright-resolve`, `proc`, `i18n`).
2. **Layer 2 Authoritative Verification Kernel (`src/kernel/`)**: Single source of truth exported via `package.json#exports` (`.`, `./kernel`, `./target-guard`, `./schema-validator`) and deterministically mirrored one-way into `templates/playwright-qa/support/` via `scripts/sync-template-vendor.mjs` (byte-identity enforced in CI; see [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.en.md)).
3. **Layer 3 Domain Subsystems (`src/{trust,explore,codemap,perf,mcp-hub}/` & `src/{init,upgrade,doctor,governance,ledger,runner,audit,verdict,heal,diagnose,impact,flaky,traceability,report,auth-login,jobs}.mjs`)**: Cohesive `<= 500`-line modules separated by domain.
4. **Layer 4 Interface Surface (`src/cli/` + `src/mcp/`)**: Per-command strict CLI option registry (22 subcommands) and zero-runtime-dependency multi-protocol MCP server (17 canonical tools + 6 deprecated v5 aliases; see [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) and [ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.en.md)).

## 2. Project Isolation (`<repo>/qa/`) & Safe Upgrades

Each repository receives an isolated `<repo>/qa/` subproject with exact-pinned dependencies, `.aitest/template-manifest.json`, `.aitest/governance.lock`, `.aitest/runs/` ledgers, `.aitest/quarantine.json`, `specs/`, `tests/`, `knowledge/`, `impact-map.json`, `waivers.json`, and `reports/`. Host kernels upgrade safely via 3-way hash diffing in `npx ai-test-workbench@6.0.0 upgrade --target <repo>`.

## 3. Default-Deny Security Guardrails (`src/kernel/target-guard.mjs` + `base.ts`)

1. **Production & Egress Hard Blocks**: Rejects `TEST_ENV=production|prod|live|online` and malformed/unallowlisted URLs, enforces `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`, and supports strict `TEST_EGRESS_MODE=allowlist`.
2. **Full-Channel Request Interception**: `tests/fixtures/base.ts` wraps `context.route`, `APIRequestContext`, `context.request`, and `page.request`, blocks Service Workers, bans raw `request.newContext()` via ESLint, and blocks GraphQL mutations.
3. **Default-Deny Read-Only Explorer (`src/explore/`)**: Blocks all non-`GET/HEAD/OPTIONS` HTTP requests, non-allowlisted WebSockets, and `navigator.sendBeacon`.
4. **Redaction v2 & Supply-Chain Pinning (`src/core/redact.mjs` + `src/mcp-hub/`)**: Strips JSON secrets, JWTs, cloud tokens, PEM keys, and DB credentials (`35/35` = `100%` adversarial recall); pins all 7-pillar external MCP presets with `.aitest/mcp.lock` drift and prompt-poisoning checks.
5. **MCP HTTP Security Boundary**: Defaults to `127.0.0.1`, enforces `Origin` (`403`), creates sessions only on `initialize`, returns `404` on unknown sessions, verifies Bearer tokens via `crypto.timingSafeEqual`, and intersects server `--workspace-root` with client `roots`.

## 4. Four-Layer Fail-Closed Anti-Fake-Green Gate Kernel (`src/kernel/gate/`)

- **Layer 0 Governance Lock & Config Schema**: Verifies SHA-256 + T1 MAC across 17 protected path patterns in `.aitest/governance.lock` and JSON-Schema-validates `aitest.config.json`.
- **Layer 1 Static Gate**: Runs `tsc --noEmit` + `eslint-plugin-playwright` (banning skips, `.only`, `waitForTimeout`, `{ force: true }`, `test.fail()`, raw `request.newContext()`); fails closed (`blocked`) in CI if compilers are missing.
- **Layer 2 Run Ledger & Waiver Gate**: Binds `results.json` to ULID `runId` and workspace input fingerprint (custom `--results` without `--expected-run-id` blocks); enforces `maxSkipped=0` default and human-approved waivers (`<= 5`, `<= 14d` TTL).
- **Layer 3 Pluggable AST Lattice & Changeset Semantic Diff Guard**: Evaluates 15 standalone rules (`AITEST-G101..G115`) using TypeScript AST + lexical scope stack + commit-level cross-file test pooling + fault-injection/honeypot awareness (see [ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.en.md)); fails closed (`blocked`) if TypeScript compiler is missing.

## 5. Living Code Map v4, Reverse Import-Graph Impact, Stateful Heal & Web Vitals

- **Living Code Map v4 & Import-Graph Impact (`src/codemap/` + `src/impact.mjs`)**: Modular framework adapters index frontend/backend/DB entities, preserve `:id`/`[id]` dynamic routes, prune deleted entries, and trace reverse static `import` chains with `why` provenance.
- **Stateful Heal & Traceability (`src/heal.mjs` + `src/traceability.mjs`)**: Hard-blocks test edits for Class B/C/D (`0.0%` mis-heal rate), emits Class-C defect tickets with 32-char W3C `Trace-ID`, and generates bidirectional `REQ-xxx` traceability matrices.
- **PerformanceObserver Web Vitals & Contract Validation (`src/perf/` + `src/kernel/schema-validator.mjs`)**: Captures buffered `LCP / CLS / INP` median and P75 alongside zero-dependency JSON Schema / OpenAPI 3.x contract validation and WCAG 2.0/2.1/2.2 AA scans.
