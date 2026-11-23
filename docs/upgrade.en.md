# Upgrade & Agent Maintenance Guide

> [简体中文 (默认)](./upgrade.md) · [Version Matrix](../VERSION.en.md)

## Upgrading `@playwright/test` Safely

1. Check pinned versions in `qa/package.json` and `qa/package-lock.json`.
2. Update `@playwright/test` to an exact version (no `^`) matched to `mcr.microsoft.com/playwright:v<version>-noble`.
3. Run `npm install` inside `qa/` and `npx playwright install chromium`.
4. Preview & apply Test Agents sync:
   ```bash
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude
   ```
5. Custom agent edits are preserved via `qa/.aitest/agents-manifest.json`; review generated `*.aitest-new` files or pass `--force`.
6. Verify with `npm run typecheck`, `npm run lint`, offline `smoke`, and online `e2e`/`api`.
