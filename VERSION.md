# Version & Compatibility Matrix

> **Template Version**: `2.0.0`  
> **Verified Date**: `2026-11-23`

## 1. Runtime & Engine Requirements

| Component | Minimum Supported | Recommended | Verified Locally |
|---|---|---|---|
| **Node.js** | `>= 22.12.0` (Node 20 is EOL) | `24 Maintenance LTS` / `26 Active LTS` | `v26.11.0` |
| **npm** | `>= 10.0.0` | `>= 11.0.0` | `11.20.0` |
| **Git** | `>= 2.35` | `>= 2.45` | `2.51.1.windows.1` |
| **Codex CLI** *(optional)* | `>= 0.150.0` | Latest | `0.171.0` |
| **Claude Code** *(optional)* | `>= 2.0.0` | Latest | `2.1.322` |

## 2. Locked Template QA Dependencies (`templates/playwright-qa/package.json`)

Exact versions are pinned (without `^` ranges) to guarantee parity between local machines, lockfiles, and official CI Docker images:

| Package | Exact Version | Purpose |
|---|---|---|
| `@playwright/test` | `1.65.1` | Test runner, browsers, `init-agents`, and built-in `run-test-mcp-server` |
| `@axe-core/playwright` | `4.14.0` | Automated machine-detectable WCAG 2.0/2.1/2.2 A & AA scans |
| `eslint` | `10.15.0` | Static anti-fake-green spec linting |
| `eslint-plugin-playwright` | `2.12.2` | Enforces `expect-expect`, `no-skipped-test`, `no-wait-for-timeout`, `no-force-option` |
| `typescript-eslint` | `8.73.0` | TypeScript parser for ESLint flat config |
| `typescript` | `6.0.3` | Static `tsc --noEmit` verification (peer-compatible with `typescript-eslint@8.73.0`) |
| `@types/node` | `26.6.6` | Node.js type definitions |

> **Note on `@playwright/mcp`**: Official Playwright Test Agents (`Planner`, `Generator`, `Healer`) use `npx playwright run-test-mcp-server` bundled inside `@playwright/test`. Installing the separate `@playwright/mcp` package is **not** required.

## 3. Official Docker Image Alignment

| `@playwright/test` Version | Official Docker Image | Chromium Build |
|---|---|---|
| `1.65.1` | `mcr.microsoft.com/playwright:v1.65.1-noble` | `chromium-1255` (`Chrome for Testing 159.0.8154.6`) |
