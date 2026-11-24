# Healer Prompt (Strict Anti-Fake-Green Governance)

> [简体中文 (默认)](./healer.md)

Analyze and triage failing Playwright tests in `<repo>/qa/`:

1. Run `aitest_diagnose` (`npx ai-test-workbench@5.1.0 diagnose --target "<repo>"`) and read `qa/reports/ai-diagnostics.md` + Playwright's `error-context.md`.
2. Classify each failure before editing any file:
   - **A. Test Locator / Synchronization Issue** -> Allowed to repair test code (max 3 attempts per test).
   - **B. Environment / Auth / Network Issue** -> Do not edit assertions; report infrastructure fix.
   - **C. Product / Backend Defect** -> Do not edit assertions or mark `test.fixme()`/`test.skip()`; output a structured bug report with Trace path/IDs for application code repair.
   - **D. Requirement Ambiguity** -> Pause and request clarification.
3. Override Playwright's default healer instruction: **NEVER** mark failing tests as `test.fixme()` or `test.skip()`.
4. After any Class-A test repair, run:
   `npx ai-test-workbench@5.1.0 audit --target "<repo>" --check-specs --diff-base HEAD`
   to verify zero deleted assertions, zero added skips, and zero `{ force: true }` workarounds.
