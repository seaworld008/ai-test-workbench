<div align="center">

# 🛡️ AI Test Workbench

**Reusable Local-First AI E2E Testing Workbench & Standard Agent Skill for the AI Coding Velocity Era**

Built on **Playwright Test** · **Official Playwright Test Agents (Planner / Generator / Healer)** · **Diff-Impact Selection** · **3-Layer Anti-Fake-Green Gate** · **Automated Axe Scans**

[简体中文文档 (默认)](./README.md) · [Architecture](./ARCHITECTURE.md) · [Security Policy](./SECURITY.md) · [Changelog](./CHANGELOG.md)

[![CI](https://img.shields.io/github/actions/workflow/status/seaworld008/ai-test-workbench/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/seaworld008/ai-test-workbench/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/seaworld008/ai-test-workbench?style=flat-square&color=0ea5e9&label=Release)](https://github.com/seaworld008/ai-test-workbench/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](./VERSION.md)
[![Playwright](https://img.shields.io/badge/Playwright-1.65.1-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)
[![Agent Skill](https://img.shields.io/badge/Agent_Skill-Codex%20%7C%20Claude%20%7C%20Gemini-6366f1?style=flat-square)](./skills/ai-test-workbench/SKILL.md)

</div>

---

## Why AI Test Workbench?

When coding assistants (`Codex CLI`, `Claude Code`, `Antigravity`, `Cursor`) multiply code generation speed, traditional E2E testing breaks down in three ways:
1. **CI Bottleneck**: Running full browser suites for every small diff slows rapid iteration.
2. **AI "Fake-Green" Drift**: Empirical inspection of `@playwright/test@1.65.1` confirms its default generated Healer prompt explicitly tells models to mark persistent failures as `test.fixme()`. Left unchecked, agents also delete `expect()` calls, insert `waitForTimeout()`, or pass `{ force: true }`.
3. **Repo Pollution & Target Misconfiguration**: Shared test state, missing `.gitignore` rules after `npm pack`, or accidental runs against production URLs.

**AI Test Workbench** packages official Playwright Test Agents with deterministic quality gates, cross-project isolation, and a portable `SKILL.md` so any team can adopt trustworthy AI-assisted QA in minutes.

---

## Core Architecture & Capabilities

- **Two-Phase Decoupling**: Use AI agents (`Codex CLI`, `Claude Code`, `VS Code Copilot`, `OpenCode`) via Playwright's bundled `run-test-mcp-server` (no extra `@playwright/mcp` needed) for **test planning, generation, and Class-A repair**; run **deterministic TypeScript tests** in CI without calling LLMs, producing repeatable results.
- **Zero-Pollution Isolation (`<repo>/qa/`)**: Idempotently scaffolds independent dependencies (`package-lock.json` matched to `mcr.microsoft.com/playwright:v1.65.1-noble`), `.env.example`, `storageState`, `impact-map.json`, and 5 isolated Playwright projects (`smoke`, `setup`, `e2e`, `api`, `seed`), plus host `tsconfig.json` / `eslint.config.*` overlap warnings.
- **3-Layer Anti-Fake-Green Gate (`scripts/audit-results.mjs`)**:
  1. **Static**: `tsc --noEmit` + `eslint-plugin-playwright` (`expect-expect`, `no-skipped-test`, `no-wait-for-timeout`, `no-focused-test`, `no-force-option`, `prefer-web-first-assertions`, `no-conditional-in-test`).
  2. **Runtime**: Separates `passed`, `failed`, `flaky`, `skipped`, and policy-excluded `@mutation` tests; enforces owner-attributed, unexpired entries in `waivers.json`.
  3. **Healer Diff Guard (`--diff-base`)**: Blocks test patches that delete net assertions, introduce `test.skip`/`test.fixme`/`.only`, add `{ force: true }`, swallow exceptions with `.catch(() => {})`, or inflate timeouts (`>= 60000ms`).
- **4-Layer Runtime Stability Fixture (`tests/fixtures/base.ts`)**: `auto` fixture with per-test overrides (`test.use({ failOnPageError: false, failOnServerError: false })`), same-origin `>= 500` server error detection, dual-surface blocking (`page.route` + `Proxy`-wrapped `APIRequestContext`) for `TEST_DENIED_ORIGINS` & `TEST_BLOCKED_ENDPOINTS`, `serviceWorkers: 'block'`, `expectAccessible()` (`@axe-core/playwright` — note: automated axe checks catch machine-detectable issues and do not constitute full WCAG compliance certification), and `expectApiContract()`.
- **Interactive SMS/SSO Session Capture (`auth-login`)**: Opens a headed Chromium window on allowlisted test/staging origins, optionally pre-fills `--account` (never bypassing CAPTCHAs), and saves both `playwright/.auth/user.json` (`storageState`) and `playwright/.auth/session.json` (`sessionStorage` restored automatically in `e2e` and `seed`).
- **Diff-Impact Selection (`impact`)**: Combines `git diff`, uncommitted edits, untracked files, `impact-map.json`, and Playwright `--only-changed` to narrow local/PR feedback loops, automatically falling back to the full suite whenever shared infra or unmapped files change. (Merge, nightly, and release gates still run the full suite.)
- **Manifest-Protected Multi-Loop Agents (`update-agents`)**: Tracks generated `.codex/` & `.claude/` agent files in `qa/.aitest/agents-manifest.json` using SHA-256 hashes, writing conflicting updates to `*.aitest-new` sidecars instead of silently overwriting local edits.

---

## Requirements

- **Node.js**: `>= 22.12.0` (`Node 24 Maintenance LTS` or `Node 26 Active LTS` recommended; Node 20 is EOL)
- **OS**: Windows 11 PowerShell (`pwsh`), macOS, or Linux (Windows native and WSL maintain separate Node and browser caches)

---

## Quick Start (3 Commands)

```bash
# 1. Check OS, Node, npm, Git, Codex/Claude, and browser cache readiness
npx ai-test-workbench doctor

# 2. Initialize isolated <repo>/qa (preview first with --dry-run)
npx ai-test-workbench init --name my-app --target "/path/to/your-repo" --loop codex

# 3. Run offline Chromium smoke tests + 3-layer quality gate
npx ai-test-workbench run --target "/path/to/your-repo" --suite smoke --audit
```

---

## Full-Link Autonomous Testing Loop (v3.0): Explore -> Living Code Map -> MCP Hub -> Perf

```bash
# 1. Capture session for SMS / SSO / CAPTCHA staging portals (no bypass)
npx ai-test-workbench auth-login --target "/path/to/your-repo" --base-url https://staging.example.internal

# 2. Explore all portals & routes read-only (0 -> 1) and fuse static source + runtime into Living Code Map
npx ai-test-workbench explore --target "/path/to/your-repo" --base-url https://staging.example.internal --max-pages 30
npx ai-test-workbench map --target "/path/to/your-repo"

# 3. Connect 6-Pillar Read-Only System MCPs (Grafana/Prometheus/Loki/Sentry/DB/Redis/k6) and verify safety
npx ai-test-workbench mcp add --target "/path/to/your-repo" --profile full-link
npx ai-test-workbench mcp doctor --target "/path/to/your-repo"

# 4. Run Chromium CDP Web Vitals + Concurrent GET API SLO benchmark + Deterministic Regression
npx ai-test-workbench perf --target "/path/to/your-repo" --concurrency 4 --iterations 12 --enforce-budget
npx ai-test-workbench run --target "/path/to/your-repo" --suite all --audit
```

---

## Self-Contained Local Full-Stack Demo

```bash
git clone https://github.com/seaworld008/ai-test-workbench.git
cd ai-test-workbench
cd templates/playwright-qa && npm ci && npx playwright install chromium && cd ../..

npm test
npm run smoke
npm run demo:verify
```

---

## Verification Scope Distinction

1. **Local Workbench Verified**: CLI, browser cache, multi-project isolation, offline smoke, 3-layer quality gates, and local demo/dev apps pass cleanly.
2. **Business E2E Verified**: Requires an explicit non-production staging URL, dedicated QA accounts, reviewed `specs/*.md`, and passing business assertions.

---

## License

[MIT](./LICENSE)
