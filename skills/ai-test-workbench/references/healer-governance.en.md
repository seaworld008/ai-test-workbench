# Healer Governance & Anti-Fake-Green Protocol

> [简体中文 (默认)](./healer-governance.md) · [SKILL.md](../SKILL.md)

> **Critical Override**: Playwright's default generated healer prompt suggests marking persistent failures with `test.fixme()`. **In `ai-test-workbench`, adding `test.fixme()` or `test.skip()` without an approved, time-bounded entry in `waivers.json` is strictly forbidden and blocked by CI.**

## 1. Mandatory 4-Way Failure Classification

| Class | Root Cause | Allowed Action | Forbidden Action |
|---|---|---|---|
| **A** | Test locator drift or web-first sync issue | Fix test locator/wait (max 3 rounds); verify via `aitest audit --check-specs --diff-base HEAD` | Deleting `expect()`, adding `{ force: true }`, adding `waitForTimeout()` |
| **B** | Unreachable `TEST_BASE_URL`, expired auth, or allowlist mismatch | Report infra fix; keep red | Pointing at production or mocking away integration targets |
| **C** | Product/API regression (`5xx`, `pageerror`, broken RBAC, overselling) | Output Bug Report with steps & trace IDs for application repair | Weakening assertions or adding `test.fixme()` / `test.skip()` |
| **D** | Requirement ambiguity | Pause and clarify with the user | Guessing rules |

## 2. 3-Attempt Circuit Breaker & Healer Diff Guard

- Max **3 repair attempts** per test. All patches must pass `aitest audit --check-specs --diff-base HEAD` (blocks net assertion drops, added `skip/fixme/.only`, `{ force: true }`, empty `.catch(() => {})`, and `>= 60000ms` timeout inflation).
