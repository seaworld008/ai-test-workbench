# Architecture & Security Boundaries (`ai-test-workbench`)

## 1. Two-Phase Execution Model: AI Authoring vs. Deterministic Regression

`ai-test-workbench` strictly separates **test authoring/maintenance** from **regression execution**:

1. **Authoring & Repair Phase (AI Agent Loop)**:
   - Driven by Codex CLI, Claude Code, VS Code Copilot, or OpenCode inside `<repo>/qa/`.
   - Connects to Playwright's built-in `run-test-mcp-server` (not `@playwright/mcp`), which exposes browser navigation, accessibility-tree snapshots, and test debug tools to `Planner`, `Generator`, and `Healer`.
2. **Regression Phase (Deterministic Runner)**:
   - Local pre-push hooks, PR checks, Jenkins, GitHub Actions, and GitLab CI run compiled TypeScript tests via `@playwright/test`.
   - Regression runs do **not** call LLMs, produce repeatable results, and require zero model API credentials in CI.

## 2. Multi-Project Isolation (`<repo>/qa/`)

Each business repository (Vue/H5, React, Java/Spring Cloud, PHP/ThinkPHP) receives an isolated `<repo>/qa/` subproject with its own:
- `package.json` and `package-lock.json`
- `.env` (gitignored) and `playwright/.auth/` (`storageState`, gitignored)
- `specs/*.md`, `tests/{smoke,e2e,api}/`, `impact-map.json`, and `waivers.json`
- `playwright-report/`, `reports/`, and `test-results/`

No mutable test state, accounts, or `node_modules` are shared across repositories.

## 3. Single-Source-of-Truth Safety Guards

1. **Shared Target & Request Guard (`support/target-guard.mjs`)**:
   - Imported directly by `playwright.config.ts`, `tests/fixtures/base.ts`, and CLI commands (`src/origin-guard.mjs`).
   - Blocks `TEST_ENV=production|prod|live|online`, rejects wildcard hosts (`*.com`), enforces `TEST_ALLOWED_HOSTS` / `TEST_ALLOWED_ORIGINS`, and blocks `TEST_DENIED_ORIGINS`.
   - Enforces dangerous endpoint denylists (`TEST_BLOCKED_ENDPOINTS`) across **both** browser `page.route` and a `Proxy`-wrapped `request` (`APIRequestContext`), with `serviceWorkers: 'block'` enabled in `playwright.config.ts`.
2. **Mutation Policy (`@mutation`)**:
   - Specs that modify server state carry the `@mutation` tag.
   - When `TEST_ALLOW_MUTATION=0` (default), `--grep-invert=@mutation` excludes them cleanly, and `audit-results.mjs` accounts for them separately under `policyExcludedMutation`—never inflating `passed` and never masking unauthorized `@critical` skips.
3. **3-Layer Anti-Fake-Green Gate**:
   - **Static Gate**: `tsc --noEmit` + `eslint-plugin-playwright` (`expect-expect`, `no-skipped-test`, `no-focused-test`, `no-wait-for-timeout`, `no-force-option`, `prefer-web-first-assertions`, `no-conditional-in-test`).
   - **Runtime Gate (`scripts/audit-results.mjs`)**: Separates `passed`, `failed`, `flaky`, `skipped`, and `policyExcludedMutation`; enforces non-expired `waivers.json` (`owner`, `reason`, `expiresAt`); fails on zero executed tests or missing E2E runs (`--require-e2e`).
   - **Healer Diff Guard (`--diff-base`)**: Inspects unified diffs on `tests/**` to block net assertion deletions, newly added `skip/fixme/only`, `{ force: true }`, empty `.catch(() => {})`, and excessive timeouts (`>= 60000` ms).

## 4. Safe Subprocess Model (`shell: false`)

All CLI subprocesses in `src/proc.mjs` use `child_process.spawn` / `execFile` with `shell: false` and explicit argument arrays:
- Invokes `npm` via `process.execPath` + resolved `npm-cli.js` (avoiding Windows Node 22+/26 `spawn EINVAL` on `.cmd` shims).
- Invokes Playwright via `process.execPath` + `<qaDir>/node_modules/@playwright/test/cli.js`.
- Probes Windows `.ps1` shims (`codex.ps1`, `claude.ps1`) via `pwsh -NoProfile -NonInteractive -File`.
