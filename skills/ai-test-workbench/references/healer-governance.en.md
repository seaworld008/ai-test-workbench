# Stateful Healer Governance & `S0–S5` Zero-Fake-Green Protocol (`v5.0`)

> [简体中文 (默认)](./healer-governance.md) · [SKILL.md](../SKILL.md) · [4-Layer Gate Kernel](../../../docs/governance.en.md)

> **Tool-Enforced Override**: Playwright's default healer prompt suggests marking persistent failures with `test.fixme()`. In `ai-test-workbench v5.0`, **weakening assertion strength, editing protected configs, adding `test.fail()` / `expect.soft()`, or editing tests on Class B/C/D failures are hard-blocked by the tool state machine (`FGER = 0.0%`)**.

## 1. Mandatory Stateful Healer Workflow (`npx ai-test-workbench@5.1.0 heal` / `aitest_heal_*`)

| Class | Root Cause | `aitest_heal_begin` Verdict | Allowed Action | Tool-Blocked Forbidden Action |
|---|---|---|---|---|
| **A** | Locator drift or web-first sync issue | `allowedToEditTests: true` (max **3 attempts** via `aitest_heal_attempt`) | Update semantic locator/wait while preserving `S0–S5` assertion strength | Lowering assertion rank, deleting `expect()`, `{ force: true }`, `waitForTimeout()`, `expect.soft()` |
| **B** | Unreachable target, expired auth, or guard block | **Hard-blocks spec edits** (exit `2`) | Keep red; surface infra or `auth-login` instructions | Pointing at production or calling raw `request.newContext()` |
| **C** | Product/API regression (`5xx`, `pageerror`, schema drift, RBAC leak, overselling) | **Hard-blocks spec edits** (exit `2`) & writes `reports/defects/<id>.md` | Hand W3C `Trace-ID` defect ticket to app engineers | Flipping `200` to `500`, `test.fixme()`/`test.fail()`, `.catch(() => null)` |
| **D** | Requirement ambiguity | **Hard-blocks spec edits** (exit `2`) | Pause and clarify with the user | Guessing business rules |

## 2. `S0–S5` Assertion Strength Lattice & Semantic Diff Guard (`AITEST-G101..G113`)

Every `aitest_heal_attempt` and `aitest_audit --diff-base HEAD` inspects the entire `qa/` workspace (including untracked files and protected governance files):
- **`S5` exact value assertions** (`toHaveText('exact')`, `toEqual`, `toBe(200)`) cannot be downgraded to **`S3` partial**, **`S2` visibility (`toBeVisible()`)**, **`S1` truthy**, or **`S0` tautologies (`expect(true).toBe(true)`)**.
- Protected files sealed in `.aitest/governance.lock` cannot be altered without human `npx ai-test-workbench@5.1.0 governance approve`.
