# Project Onboarding Prompt

Onboard the following repository into `ai-test-workbench`:

- **Target Repository**: `<repo-path>`
- **Tech Stack**: `<Vue/H5 | React | Java/Spring | PHP/ThinkPHP>`
- **Authorized Staging/Local URL**: `<url or leave blank for offline mode>`

## Required Steps

1. Inspect `<repo-path>` git status and existing Playwright/QA directories without altering source files.
2. Preview initialization:
   `npx ai-test-workbench init --name <slug> --target "<repo-path>" --loop codex --dry-run`
3. Apply initialization, install isolated `qa/` dependencies, and verify Chromium.
4. Customize `<repo-path>/qa/impact-map.json` for the repository's routes/controllers/views.
5. Run offline smoke and quality gate:
   `npx ai-test-workbench run --target "<repo-path>" --suite smoke --audit`
6. Report separate conclusions for **Local Workbench Readiness** vs **Business E2E Readiness**.
