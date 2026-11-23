# Changelog

All notable changes to `ai-test-workbench` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-11-23

### Added
- **Self-Evolving Living Code & System Knowledge Map (`aitest map` / `src/codemap.mjs`)**: Scans host repository frontend views/routers (including broken lazy-import detection), API calls, Spring/Node/Python/PHP controllers, and Prisma/SQL/ORM DB tables; incrementally fuses runtime `system-topology.json`, Playwright `results.json`, and `perf-report.json` into persistent `knowledge/code-map.json` + `knowledge/SYSTEM_MAP.md`; non-destructively auto-syncs `impact-map.json` while preserving manual rules.
- **6-Pillar Read-Only Full-Link System MCP Hub (`aitest mcp` / `src/mcp-hub.mjs`)**: Built-in catalog and config merger (`.mcp.json` + `.codex/config.toml` + `.env.mcp.example`) across 11 presets (`playwright-test`, `chrome-devtools`, `grafana --disable-write`, `prometheus`, `loki`, `sentry`, `postgres-readonly`, `mysql-readonly`, `redis-readonly --readonly`, `k6`, `openapi-contract`) plus `aitest mcp doctor` write/secret guardrail enforcement.
- **CDP Web Vitals & Concurrent API SLO Engine (`aitest perf` / `src/perf.mjs` + `perf-budget.json`)**: Captures real Chromium CDP/Navigation metrics (`TTFB`, `FCP`, `LCP`, `CLS`, `DOMNodes`, `JSHeapMB`, duplicate API waterfalls) and read-only concurrent API `P50/P90/P95/P99` + `RPS`, plus `expectPerformanceBudget()` in `tests/fixtures/base.ts`.
- **Full-Link Trace Correlation (`base.ts` + `src/diagnose.mjs`)**: Passively records distributed trace headers (`traceparent`, `x-trace-id`, `x-request-id`, `sw8`, `eagleeye-traceid`) and exact test time windows, enriching `reports/ai-diagnostics.md` with linked source files from `code-map.json` and ready-to-run Loki/PromQL/Sentry/SQL queries.
- **Autonomous Explorer v3.0 (`src/explore.mjs`)**: Added Vue 2 Vuex/Vue 3 dynamic route extraction, multi-portal/tenant workspace switcher detection, duplicate GET API waterfall tracking, malformed query parameter detection (`detectUrlQueryAnomalies`), and automatic Code Map sync.

## [2.1.0] - 2026-11-23

### Added
- **Zero-to-One Read-Only Exploration Engine (`aitest explore`)**: Added `src/explore.mjs` and `aitest explore --target <repo> [--entry-path /] [--max-pages 25]` to crawl authenticated applications under strict zero-mutation guards (`DELETE`/`PUT`/`PATCH` and mutating `POST` paths aborted), auto-discover DOM/menu/Vue-Router routes, classify UI action safety (`readonly` vs `mutation`), redact sensitive API query parameters, detect page archetypes (`auth-portal`, `dashboard`, `crud-table`, `form-config`, `content-page`), and generate `reports/system-topology.json` + `specs/system-overview.md`.
- **Multi-Portal 0→1 Exploration Guidance**: Added `skills/ai-test-workbench/references/zero-to-one-exploration.md` and `prompts/00-explore-and-atlas.md` covering the 4-stage flow: Login -> Multi-Portal 0-to-1 Exploration -> System Panorama (`system-overview.md`) -> Deep Functional Testing & Isolation Audits.
- **Unit & Integration Tests (`test/explore.test.mjs`)**: Verified action safety classification, API query secret redaction, Markdown atlas generation, production blocking, and live `explore` execution against the local demo server.

## [2.0.0] - 2026-11-23

### Added
- **Reusable Open-Source CLI (`ai-test-workbench` / `aitest`)**: `doctor`, `init`, `auth-login`, `run`, `impact`, `audit`, `diagnose`, `report`, `update-agents`, and `skill-install` built on zero-dependency Node.js ESM (`>=22.12.0`) with strict `shell: false` process execution.
- **Official Playwright Test Agents Multi-Loop Orchestration**: Wraps `playwright init-agents` (`codex`, `claude`, `vscode`, `opencode`, `copilot`, `vscode-legacy`) with staging path sanitization, `qa/.aitest/agents-manifest.json` SHA-256 tracking, `.aitest-new` conflict sidecars, and optional `--bridge-root` MCP wiring.
- **3-Layer Anti-Fake-Green Quality Gate (`scripts/audit-results.mjs`)**:
  - Static: `tsc --noEmit` + `eslint-plugin-playwright` (`expect-expect`, `no-skipped-test`, `no-wait-for-timeout`, `no-focused-test`, `no-force-option`, `prefer-web-first-assertions`, `no-conditional-in-test`).
  - Runtime: Separates `passed`, `failed`, `flaky`, `skipped`, and policy-excluded `@mutation` specs with owner-attributed, time-bounded `waivers.json`.
  - Healer Diff Guard (`--diff-base`): Blocks assertion deletions, added `skip`/`fixme`/`.only`, `{ force: true }`, empty `.catch(() => {})`, and inflated timeouts (`>= 60000ms`).
- **4-Layer Runtime Stability Fixture (`tests/fixtures/base.ts`)**: `auto` fixture with per-test `failOnPageError` / `failOnServerError` options, same-origin `5xx` detection, dual-surface (`page.route` + `Proxy`-wrapped `APIRequestContext`) endpoint/origin guards, `serviceWorkers: 'block'`, `expectAccessible` (`@axe-core/playwright`), `expectApiContract`, and `sessionStorage` state restoration (`playwright/.auth/session.json`).
- **Interactive SMS/SSO Session Capture (`auth-login`)**: Headed Chromium flow with optional non-destructive account pre-fill and floating Save Session helper (zero CAPTCHA bypass).
- **Diff-Impact Test Selection (`impact`)**: Combines `git diff`, uncommitted changes, untracked files, `impact-map.json`, and Playwright `--only-changed`, with automatic full-suite fallback on shared infra or unknown blast radius.
- **Portable Agent Skill (`skills/ai-test-workbench/SKILL.md`)**: Ready for `.codex/skills/`, `.claude/skills/`, and `.agents/skills/`, including prompt-injection boundaries and A/B/C/D Healer triage.
- **Self-Contained Local Demo Target (`examples/demo-webapp/server.mjs`)**: Zero-dependency Smart Campus portal (`--preset demo-campus`, `npm run demo:verify`) demonstrating UI search, RBAC `403`, duplicate enrollment `409`, and concurrent `1`-seat race protection (`201 + 409`).
- **Host Tooling Isolation Inspector**: Warns during `init` when host repository `tsconfig.json` or `eslint.config.*` globs overlap `<repo>/qa/**`.
