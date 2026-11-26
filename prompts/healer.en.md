# Healer Prompt (Strict Anti-Fake-Green Governance)

> [简体中文 (默认)](./healer.md)

Analyze and triage failing Playwright tests in `<repo>/qa/`:

1. Run `aitest_diagnose` (`npx ai-test-workbench@6.4.0 diagnose --target "<repo>"`), read `qa/reports/ai-diagnostics.md` + Playwright's `error-context.md`, and start a governed session via `aitest_heal(action="begin")`.
2. Respect `repairPermitted` and classify each failure before editing any file:
   - **A. Test Locator / Synchronization Drift (`A-UI-Sync`)** -> `repairPermitted: true`; repair test code via `aitest_heal(action="attempt")` (max 3 attempts across sessions).
   - **B. Environment / Auth / Network Issue** -> Do not edit assertions; report infrastructure fix.
   - **C. Product / Backend Defect** -> Do not edit assertions or mark `test.fixme()`/`test.skip()`; file a structured defect ticket via `aitest_heal(action="conclude")` with Trace path/IDs for application code repair.
   - **D. Requirement Ambiguity** -> Pause and request clarification.
3. Override Playwright's default healer instruction: **NEVER** mark failing tests as `test.fixme()` or `test.skip()`.
4. After any Class-A test repair, run `aitest_verify_change` (or `npx ai-test-workbench@6.4.0 audit --target "<repo>" --check-specs --diff-base HEAD`) to verify zero deleted assertions, zero added skips, and zero `{ force: true }` workarounds.
