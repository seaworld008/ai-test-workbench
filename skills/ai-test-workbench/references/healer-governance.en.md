# Stateful Healer Governance & `S0–S5` Zero-Fake-Green Protocol (`v6.4.0`)

> [简体中文 (默认)](./healer-governance.md) · [SKILL.md](../SKILL.md) · [4-Layer Gate Kernel](../../../docs/governance.en.md)

> **Tool-Enforced Override**: Playwright's default healer prompt suggests marking persistent failures with `test.fixme()`. In `ai-test-workbench v6.4.0`, **weakening assertion strength, editing protected configs, adding `test.fail()` / `expect.soft()`, or editing tests on Class B/C/D failures are hard-blocked by the tool state machine (`FGER = 0.0%`)**.

## 1. Mandatory Stateful Healer Workflow (`npx ai-test-workbench@6.4.0 heal` / `aitest_heal`)

Before modifying any `tests/**` file, start a governed heal session:

| Class | Root Cause | `aitest_heal(action="begin")` Verdict | Allowed Action | Tool-Blocked Forbidden Action |
|---|---|---|---|---|
| **A** | Locator drift or web-first sync issue | `repairPermitted: true` (max **3 attempts** via `aitest_heal(action="attempt")`) | Update semantic locator/wait while preserving `S0–S5` assertion strength | Lowering assertion rank, deleting `expect()`, `{ force: true }`, `waitForTimeout()`, `expect.soft()` |
| **B** | Unreachable target, expired auth, or guard block | **Hard-blocks spec edits** (exit `2`) | Keep red; surface infra or `auth-login` instructions | Pointing at production or calling raw `request.newContext()` |
| **C** | Product/API regression (`5xx`, `pageerror`, schema drift, RBAC leak, overselling) | **Hard-blocks spec edits** (exit `2`) & writes `reports/defects/<id>.md` | Hand W3C `Trace-ID` defect ticket to app engineers | Flipping `200` to `500`, `test.fixme()`/`test.fail()`, `.catch(() => null)` |
| **D** | Requirement ambiguity | **Hard-blocks spec edits** (exit `2`) | Pause and clarify with the user | Guessing business rules |

> **Known Blocker Deduplication (`qa/known-blockers.json`)**: If a failing test matches an `open` entry in governance-locked `qa/known-blockers.json`, `aitest_heal(action="begin")` immediately hard-blocks opening a duplicate heal session (`blockerLinked: true`, exit code `2`), preventing agents from masking tracked architectural or upstream blockers with static shortcuts.

## 2. `S0–S5` Assertion Strength Lattice & Semantic Diff Guard (`AITEST-G101..G118`)

Every `aitest_heal(action="attempt")` and `aitest_audit(diffBase="HEAD")` inspects the entire `qa/` workspace (including untracked files and protected governance files), product-side Dieselgate test-traffic checks (`AITEST-G117`), and cross-directory lockstep sync (`AITEST-G118`):
- **`S5` exact value assertions** (`toHaveText('exact')`, `toEqual`, `toBe(200)`) cannot be downgraded to **`S3` partial**, **`S2` visibility (`toBeVisible()`)**, **`S1` truthy**, or **`S0` tautologies (`expect(true).toBe(true)`)**.
- Protected files sealed in `.aitest/governance.lock` (`eslint.config.mjs`, `playwright.config.ts`, `aitest.config.json`, `waivers.json`, `known-blockers.json`, `corpus/**`, `fixtures/upstream-cassettes/**`, `support/**`, etc.) cannot be altered without human `npx ai-test-workbench@6.4.0 governance approve --by <name> --reason "<why>"`.
