# Contributing to AI Test Workbench

Thank you for helping build an open, reliable, AI-native testing foundation!

## Core Engineering Principles

1. **Deterministic Foundation, AI Acceleration**: Never trade away test determinism for AI magic. Generated tests must rely on semantic locators (`getByRole`, `getByLabel`, `getByTestId`), web-first assertions, and strict data isolation.
2. **Zero Fake-Green Tolerance**:
   - Never use `test.skip`, `test.fixme`, or weakened assertions to mask product regressions.
   - All specs must contain real assertions and pass `aitest audit --check-specs`.
3. **Cross-Platform Safe Execution**:
   - All CLI modules use pure Node.js ESM (`>=20`) with zero external runtime dependencies at the CLI layer.
   - Never use `shell: true` or command string interpolation when spawning child processes. Support Windows (`pwsh`/PowerShell), macOS, and Linux natively.
4. **Protect Existing Repositories**:
   - `init` and `update-agents` must remain idempotent, support `--dry-run`, and never silently overwrite existing files or business configurations.

## Local Development & Verification

```bash
# 1. Check local environment
node tools/aitest.mjs doctor

# 2. Run unit & CLI integration tests
npm test

# 3. Verify template dependencies & offline smoke
cd templates/playwright-qa
npm ci
npx playwright test tests/smoke --project=chromium
```

## Pull Request Checklist

- [ ] `npm test` passes with 0 failures.
- [ ] New CLI flags/commands update `--help`, `src/i18n.mjs` (both `zh` and `en`), and documentation.
- [ ] No hardcoded paths, real credentials, or `.env` files are committed.
- [ ] Static & runtime quality gates (`aitest audit --check-specs`) pass on all template specs.
