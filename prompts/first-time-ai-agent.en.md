# First-Time AI Agent Copy-Paste Prompt (`first-time-ai-agent.en.md`)

> [简体中文 (默认)](./first-time-ai-agent.md) · [AI Agent Quickstart](../docs/ai-agent-quickstart.en.md)

Copy and paste either prompt below into Claude Code, Codex CLI, Cursor, Copilot, Gemini CLI, or Antigravity on your very first run:

---

## Option A: First-Time Repository Onboarding

```text
Use the `ai-test-workbench` MCP tools (or `npx ai-test-workbench@5.1.0 <cmd> --json`) to onboard automated testing onto this repository:
1. Call `aitest_doctor` to verify Node >= 22.12 and Chromium readiness.
2. Call `aitest_init` with `dryRun: true` first to inspect host tsconfig/eslint overlap advisories, then scaffold isolated `qa/`.
3. Call `aitest_run(suite="smoke", audit=true)` to verify the offline 3-layer anti-fake-green baseline.
4. Call `aitest_map_sync` to generate the initial Living Code Map (`qa/knowledge/SYSTEM_MAP.md`).
5. Summarize results cleanly, keeping "Local Workbench Verified" strictly separate from "Business E2E Verified".
```

---

## Option B: Unknown Multi-Tenant SaaS (0 -> 1 Read-Only Explore First)

```text
Explore `<TEST_BASE_URL>` safely from 0 to 1 before authoring functional tests:
1. If SMS OTP, SSO, or CAPTCHA is needed, ask me to run `npx ai-test-workbench@5.1.0 auth-login --target . --base-url <TEST_BASE_URL>` interactively (never bypass CAPTCHAs).
2. Call `aitest_explore(target=".", baseUrl="<TEST_BASE_URL>", maxPages=30)` strictly read-only to map portal switchers, routes, tables, and API waterfalls.
3. Call `aitest_map_sync` and draft prioritized plans in `qa/specs/` covering 0/1 empty states, pagination, cross-tenant isolation, and pre-existing bugs.
```
