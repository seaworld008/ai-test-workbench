# Version & Compatibility Matrix (v5.0)

> [简体中文 (默认)](./VERSION.md) · [English README](./README.en.md) · **Workbench & Gate Kernel Version**: `5.0.0` (single source: `src/version.mjs`) · **Verified Date**: `2026-11-24`

## 1. Runtime & Engine Requirements

| Component | Minimum Supported | Recommended | Verified Locally |
|---|---|---|---|
| **Node.js** | `>= 22.12.0` (Node 20 is EOL) | `24 Maintenance LTS` / `26 Active LTS` | `v26.11.0` |
| **npm** | `>= 10.0.0` | `>= 11.0.0` | `11.20.0` |
| **Git** | `>= 2.35` | `>= 2.45` | `2.51.1.windows.1` |
| **MCP Protocol** | `2024-11-05` | `2025-11-25` (Streamable HTTP / stdio / Jobs) | `2024-11-05`..`2025-11-25` verified |
| **Codex CLI** *(optional)* | `>= 0.150.0` | Latest | `0.171.0` |
| **Claude Code** *(optional)* | `>= 2.0.0` | Latest | `2.1.322` |

## 2. Schema Version Contracts (`src/version.mjs`)

| Artifact | Schema Version | Module |
|---|---|---|
| **Gate Kernel** | `5.0.0` | `templates/playwright-qa/support/gate-kernel.mjs` (drift-checked by `doctor`) |
| **Governance Lock** | `v1` | `src/governance.mjs` (`.aitest/governance.lock`) |
| **Run Ledger & Attestation** | `v1` | `src/ledger.mjs` / `src/verdict.mjs` (`.aitest/runs/<runId>/manifest.json` & `attestation.json`) |
| **Living Code Map** | `v4` | `src/codemap.mjs` (`knowledge/code-map.json`) |
| **Heal Session & Quarantine** | `v1` | `src/heal.mjs` / `src/flaky.mjs` |

## 3. Locked Template QA Dependencies (`templates/playwright-qa/package.json`)

Root `package.json` maintains **0 runtime third-party dependencies**; all `<repo>/qa` dependencies are exact-pinned (no `^` ranges):

| Package | Exact Version | Purpose |
|---|---|---|
| `@playwright/test` | `1.65.1` | Test runner, browsers, `init-agents`, and built-in `run-test-mcp-server` |
| `@axe-core/playwright` | `4.14.0` | Automated machine-detectable WCAG 2.0/2.1/2.2 A & AA scans |
| `eslint` | `10.15.0` | Static anti-fake-green linting & raw `request.newContext()` / `test.fail()` bans |
| `eslint-plugin-playwright` | `2.12.2` | Enforces `expect-expect`, `no-skipped-test`, `no-wait-for-timeout`, `no-force-option` |
| `typescript-eslint` | `8.73.0` | TypeScript parser for ESLint flat config |
| `typescript` | `6.0.3` | Root `npm run typecheck` (`checkJs`) & QA `tsc --noEmit` verification |
| `@types/node` | `26.6.6` | Node.js type definitions |

## 4. Official Docker Image Alignment

| `@playwright/test` Version | Official Docker Image | Chromium Build |
|---|---|---|
| `1.65.1` | `mcr.microsoft.com/playwright:v1.65.1-noble` | `chromium-1255` (`Chrome for Testing 159.0.8154.6`) |
