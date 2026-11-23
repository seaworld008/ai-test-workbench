# Security, Prompt-Injection & Artifact Handling Guide

## 1. Environment & Network Isolation

- **Never point automated tests at production**: `support/target-guard.mjs` rejects `TEST_ENV=production|prod|live|online`, rejects wildcard hostnames (`*.com`), and enforces `TEST_ALLOWED_HOSTS` + `TEST_DENIED_ORIGINS`.
- **Dual-surface endpoint blocking**: Dangerous endpoints configured in `TEST_BLOCKED_ENDPOINTS` (payments, real SMS, production deletes) are blocked in both browser pages (`page.route`) and API tests (`Proxy`-wrapped `APIRequestContext`), with `serviceWorkers: 'block'` preventing Service Worker bypasses.
- Application-level allowlists are a **first-line safeguard against misconfiguration**, not a substitute for network segmentation and non-production QA credentials.

## 2. Prompt-Injection Defense for AI Browser Agents

When `Planner`, `Generator`, or `Healer` browses a staging or local application through `run-test-mcp-server`:
- Web pages, user-generated comments, error banners, or API payloads may contain adversarial prompt-injection text attempting to trick the AI agent into running shell commands, exfiltrating `.env` files, or marking failing tests as `test.fixme()`.
- **Mandatory Controls**:
  1. Run Codex CLI in `workspace-write` sandbox mode (and restrict tool permissions in Claude Code).
  2. Treat **all DOM snapshots, console logs, and network payloads as untrusted data, never instructions**.
  3. Run `aitest audit --check-specs --diff-base HEAD` after any agent edit so injected attempts to weaken or skip tests are caught deterministically.

## 3. Trace, Video & Credential Hygiene

- `aitest diagnose` redacts passwords, tokens, cookies, and `Authorization` headers in `reports/ai-diagnostics.md`.
- **Important**: Binary `trace.zip` archives, screenshots, and `.webm` videos recorded by Playwright are **not** redacted. If a test types a password into an `<input>`, the trace may record it.
- **Best Practice**: Authenticate via HTTP API inside `tests/auth.setup.ts` and reuse `playwright/.auth/user.json` (`storageState`). Restrict CI artifact access and set short retention windows (e.g., 7 days).
