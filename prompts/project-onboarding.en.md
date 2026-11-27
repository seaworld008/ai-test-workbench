# Project Onboarding Prompt

> [简体中文 (默认)](./project-onboarding.md)

Onboard the following repository into `ai-test-workbench`:

- **Target Repository**: `<repo-path>`
- **Tech Stack**: `<Next.js | Vue/H5 | React | Java/Spring | PHP/ThinkPHP>`
- **Authorized Staging/Local URL**: `<url or leave blank for offline mode>`

## Required Steps
1. Inspect `<repo-path>` git status and existing Playwright/QA directories without altering source files.
2. Preview initialization:
   `npx ai-test-workbench@6.6.0 init --name <slug> --target "<repo-path>" --loop codex --dry-run`
3. Apply initialization, install isolated `qa/` dependencies, verify Chromium, and run `aitest_map_sync` to bootstrap `SYSTEM_MAP.md` and `impact-map.json`.
4. Run offline smoke and the 4-layer anti-fake-green gate (or call `aitest_verify_change`):
   `npx ai-test-workbench@6.6.0 run --target "<repo-path>" --suite smoke --audit`
5. Report separate conclusions for **Local Workbench Readiness** vs **Business E2E Readiness**.
