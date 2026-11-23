# Architecture & Security Boundaries (`ai-test-workbench` v4.0)

> [简体中文 (默认)](./ARCHITECTURE.md) · [English README](./README.en.md) · [AGENTS.en.md](./AGENTS.en.md)

## 1. Two-Phase Execution Model: AI Authoring vs. Deterministic Regression

`ai-test-workbench` strictly decouples **test authoring/triage** from **deterministic regression execution**:

1. **Authoring & Repair Phase (AI-Agent-First via Native Multi-Protocol MCP Server)**:
   - Exposes `ai-test-workbench mcp-serve` supporting **`stdio`**, **Streamable HTTP (`/mcp`)**, and **Legacy HTTP+SSE (`/sse` + `/messages`)** across MCP protocol revisions `2024-11-05` through `2025-11-25+`, cooperating alongside Playwright's built-in `run-test-mcp-server`.
   - Exposes **12 strongly typed MCP tools** with `outputSchema`, `ToolAnnotations`, machine-readable `structuredContent` (`{ ok, exitCode, tool, summary, data, nextRecommendedActions }`), Resources/Templates, and bilingual Prompts. In `stdio` mode, `AITEST_MCP_CAPTURED_STDIO=1` plus an async console mutex isolate OS `stdout` (FD 1) strictly to valid NDJSON JSON-RPC frames even during subprocess execution (`playwright test` / `npm`).
2. **Regression Phase (Deterministic Runner)**:
   - CI pipelines and local pre-push hooks run compiled TypeScript tests with `@playwright/test`. Zero LLM calls or model credentials are needed in CI.

## 2. Multi-Project Isolation (`<repo>/qa/`)

Each business repository gets an isolated `<repo>/qa/` workspace with its own locked dependencies, `.env`, `storageState`, `specs/`, `tests/`, `knowledge/`, `impact-map.json`, `waivers.json`, and `reports/`, plus host `tsconfig.json` / `eslint.config.*` overlap warnings during `init`.

## 3. Single-Source-of-Truth Safety Guards (`support/target-guard.mjs`)

1. **Origin & Environment Guards**: Shared across `playwright.config.ts`, `tests/fixtures/base.ts`, and CLI (`src/origin-guard.mjs`). Hard-blocks `TEST_ENV=production|prod|live|online`, rejects wildcard hosts, and enforces `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`.
2. **Dual-Surface Endpoint & SW Blocking**: `TEST_BLOCKED_ENDPOINTS` blocks dangerous endpoints on both `page.route` and `Proxy`-wrapped `APIRequestContext`, with `serviceWorkers: 'block'`.
3. **Mutation Isolation (`@mutation`)**: Excluded by default (`TEST_ALLOW_MUTATION=0`) and tracked separately under `policyExcludedMutation`.
4. **MCP HTTP Security**: Validates `Origin` headers against DNS rebinding (`403 Forbidden`) and rejects non-loopback binds (`0.0.0.0`) unless `--auth-token` / `AITEST_MCP_TOKEN` Bearer auth (`401 Unauthorized`) is configured.

## 4. 3-Layer Anti-Fake-Green Gate (`scripts/audit-results.mjs`)

- **Static Gate**: `tsc --noEmit` + `eslint-plugin-playwright` (`expect-expect`, `no-skipped-test`, `no-focused-test`, `no-wait-for-timeout`, `no-force-option`, `prefer-web-first-assertions`, `no-conditional-in-test`).
- **Runtime Gate**: Separates `passed`, `failed`, `flaky`, `skipped`, `policyExcludedMutation`, enforces unexpired `waivers.json`, and checks `--require-e2e`.
- **Healer Diff Guard (`--diff-base`)**: Blocks assertion deletions, added `skip/fixme/only`, `{ force: true }`, empty `.catch(() => {})`, and inflated timeouts (`>= 60000ms`).

## 5. Living Code Map, 7-Pillar MCP Hub & Trace-Correlated Perf/RCA (v4.0)

- **Living Code Map (`src/codemap.mjs` → `knowledge/SYSTEM_MAP.md`)**: Fuses host routes, broken lazy imports, backend controllers, and DB tables with runtime exploration, test results, and perf baselines while non-destructively updating `impact-map.json`.
- **7-Pillar MCP Hub (`src/mcp-hub.mjs`)**: Connects `orchestrator` (`ai-test-workbench`), `browser`, `observability`, `database`, `middleware`, `performance`, and `api-contract` presets audited by `aitest mcp doctor`.
- **CDP Perf SLOs & Trace RCA (`src/perf.mjs`, `base.ts`, `src/diagnose.mjs`)**: Captures distributed trace headers, validates `perf-budget.json` SLOs, and outputs sanitized CodeMap + Loki/PromQL/Sentry/SQL queries.
