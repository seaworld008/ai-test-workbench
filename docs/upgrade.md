# Upgrade & Agent Maintenance Guide

## Upgrading `@playwright/test` Safely

1. Check the current locked version in `qa/package.json` and `qa/package-lock.json`, and review official Playwright release notes.
2. Update `@playwright/test` to an **exact** stable version (e.g., `"1.65.1"`, no `^`) so Docker images (`mcr.microsoft.com/playwright:v<version>-noble`) stay matched.
3. Run `npm install` inside `qa/` to regenerate `package-lock.json`, then install matching browser binaries:
   ```bash
   npx playwright install chromium
   ```
4. Preview official Test Agent updates before applying:
   ```bash
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude
   ```
5. **Handling Conflicts (`*.aitest-new`)**:
   - `ai-test-workbench` tracks generated agent file hashes in `qa/.aitest/agents-manifest.json`.
   - Any agent file you customized locally is preserved untouched, while the new upstream file is written next to it as `<file>.aitest-new` and reported as `CONFLICT` (exit code `2`).
   - Review the diff, merge desired upstream tool changes, keep anti-fake-green rules intact, and delete `*.aitest-new` (or pass `--force` to accept upstream templates).
6. Run `npm run typecheck`, `npm run lint`, offline `smoke`, and staging `e2e`/`api` suites. If regressions occur, revert `package.json` and `package-lock.json` via Git.
