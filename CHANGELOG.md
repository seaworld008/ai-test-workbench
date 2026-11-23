# Changelog

All notable changes to `ai-test-workbench` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
