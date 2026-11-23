# Healer Governance & Anti-Fake-Green Protocol

> **Critical Override**: Playwright's default generated healer prompt suggests marking persistent failures with `test.fixme()`. **In `ai-test-workbench`, adding `test.fixme()` or `test.skip()` without an approved, time-bounded entry in `waivers.json` is strictly forbidden and blocked by CI.**

## 1. Mandatory 4-Way Failure Classification

Before modifying any file in `tests/**`, classify every failing spec using `reports/ai-diagnostics.md`, `error-context.md` (ARIA snapshot), and Trace evidence:

| Class | Root Cause | Allowed Action | Forbidden Action |
|---|---|---|---|
| **A** | Test locator drift after intentional UI update, or missing web-first synchronization | Update locator/wait in `tests/**`; verify via `aitest run` + `aitest audit --check-specs --diff-base HEAD` | Deleting `expect()`, adding `{ force: true }`, adding `waitForTimeout()` |
| **B** | Unreachable `TEST_BASE_URL`, expired credentials, dirty environment state, or allowlist mismatch | Report exact environment fix needed; keep test red | Changing `TEST_BASE_URL` to production or mocking away real integration targets |
| **C** | Application regression (`5xx`, uncaught `pageerror`, wrong calculation, broken RBAC, overselling) | Output structured Bug Report (steps, expected vs actual, Trace path) for application fix | Rewriting test expectations to match buggy output, or marking `test.fixme()` / `test.skip()` |
| **D** | Requirement or acceptance criteria unclear | Stop and ask the user for clarification | Guessing business rules |

## 2. Three-Attempt Circuit Breaker

- Maximum **3 repair iterations** per failing test in a single session.
- Record the diff and failure reason for each attempt.
- If still failing after 3 attempts, revert speculative test hacks and escalate to human review with `reports/ai-diagnostics.md`.

## 3. Healer Diff Guard (`--diff-base`)

Every automated test repair must pass:

```bash
npx ai-test-workbench audit --target <repo> --check-specs --diff-base HEAD
```

The diff guard fails automatically if a repair patch:
1. Reduces the total number of assertion calls (`expect*`, `assert*`, `verify*`) in a spec file;
2. Introduces `test.skip(`, `test.fixme(`, or `.only(`;
3. Introduces `{ force: true }` to bypass actionability checks;
4. Swallows errors via `.catch(() => {})`;
5. Inflates timeouts to `>= 60000` ms to mask performance hangs.
