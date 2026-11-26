# Version & Compatibility Matrix (v6.4.0)

> [简体中文 (默认)](./VERSION.md) · [English README](./README.en.md) · **Workbench & Gate Kernel Version**: `6.4.0` (single source: `src/core/version.mjs`) · **Verified Date**: `2026-11-26`

## 1. Runtime & Engine Requirements

| Component | Minimum Supported | Recommended | Verified Locally |
|---|---|---|---|
| **Node.js** | `>= 22.12.0` (Node 20 is EOL) | `24 Maintenance LTS` / `26 Active LTS` | `v26.11.0` |
| **npm** | `>= 10.0.0` | `>= 11.0.0` | `11.20.0` |
| **Git** | `>= 2.35` | `>= 2.45` | `2.51.1.windows.1` |
| **MCP Protocol** | `2024-11-05` | `2025-11-25` (Streamable HTTP / stdio / Legacy SSE) | `2024-11-05`..`2025-11-25` verified |
| **Codex CLI** *(optional)* | `>= 0.150.0` | Latest | `0.171.0` |
| **Claude Code** *(optional)* | `>= 2.0.0` | Latest | `2.1.322` |

## 2. Schema Version Contracts (`src/core/version.mjs`)

| Artifact | Schema Version | Module |
|---|---|---|
| **Gate Kernel** | `6.4.0` | Authoritative `src/kernel/gate-kernel.mjs` (18 pluggable rules `AITEST-G101..G118` + governance-locked declarative `qa/support/project-rules.json`, AST Gate v2.2, one-way vendor mirror `templates/playwright-qa/support/gate-kernel.mjs`, drift-checked by `doctor` & `check:vendor`) |
| **Differential Parity Oracle** | `v1` | `src/kernel/diff-oracle.mjs` / `src/parity/` (5-checkpoint `CP1..CP5`, `shape-only` zero-plaintext fingerprints `fp_<12hex>`, and zero-dep SSE reassembly `src/core/stream-sse.mjs`) |
| **Memory Loop & Seam Card** | `v1` | `src/memory/` / `src/learn.mjs` / `src/verdict/seam-card.mjs` (sealed `qa/known-blockers.json`, staging-only `learn-proposals.{json,md}`, and Human Seam Gatekeeper Card) |
| **CommandResult & Verdict** | `v2` | `src/core/outcome.mjs` / `src/verdict.mjs` (Unified `CommandResult<T>` envelope & `AITEST_RESULT_FILE` framed IPC) |
| **Governance Lock** | `v1` | `src/governance.mjs` (`.aitest/governance.lock`) |
| **Template Manifest** | `v1` | `src/upgrade.mjs` / `src/init.mjs` (`.aitest/template-manifest.json`) |
| **Run Ledger & Attestation** | `v1` | `src/ledger.mjs` / `src/verdict.mjs` (`.aitest/runs/<runId>/manifest.json` & `attestation.json`) |
| **Living Code Map** | `v4` | `src/codemap.mjs` (`knowledge/code-map.json`) |
| **Heal Session & Quarantine** | `v1` | `src/heal.mjs` / `src/flaky.mjs` |

## 3. Root Dev Dependencies & Locked Template QA Dependencies

Root `package.json` keeps **0 runtime third-party dependencies** (`dependencies` absent) and exact-pins only `typescript@6.0.3` and `@types/node@26.6.6` in `devDependencies` for strict `npm run typecheck`. All `<repo>/qa` template dependencies are exact-pinned (no `^` ranges):

| Package | Exact Version | Purpose |
|---|---|---|
| `@playwright/test` | `1.65.1` | Test runner, browsers, `init-agents`, and built-in `run-test-mcp-server` |
| `@axe-core/playwright` | `4.14.0` | Automated machine-detectable WCAG 2.0/2.1/2.2 A & AA scans |
| `eslint` | `10.15.0` | Static anti-fake-green linting & raw `request.newContext()` / `test.fail()` bans |
| `eslint-plugin-playwright` | `2.12.2` | Enforces `expect-expect`, `no-skipped-test`, `no-wait-for-timeout`, `no-force-option` |
| `typescript-eslint` | `8.73.0` | TypeScript parser for ESLint flat config |
| `typescript` | `6.0.3` | Root strict `checkJs` (`strict: true`) & QA `tsc --noEmit` verification |
| `@types/node` | `26.6.6` | Node.js type definitions |

## 4. Official Docker Image Alignment

| `@playwright/test` Version | Official Docker Image | Chromium Build |
|---|---|---|
| `1.65.1` | `mcr.microsoft.com/playwright:v1.65.1-noble` | `chromium-1255` (`Chrome for Testing 159.0.8154.6`) |
