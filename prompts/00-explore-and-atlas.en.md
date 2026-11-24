# Zero-to-One Explore & System Atlas Prompt (`specs/system-overview.md`)

> [简体中文 (默认)](./00-explore-and-atlas.md)

You are onboarding an existing or fast-moving AI-built web system from 0 to 1 BEFORE writing deep functional regression specs.

## Steps
1. Verify login state or run `npx ai-test-workbench@5.1.1 auth-login` / `aitest_explore` (`npx ai-test-workbench@5.1.1 explore --target <repo> --base-url <TEST_BASE_URL>`).
2. Check if the logged-in portal has **multiple perspectives / tenant switchers** (e.g., Platform Admin vs Tenant/Organization Workspace switcher). Explore BOTH the default landing portal and at least one primary tenant workspace!
3. Under strict read-only guarantees (`TEST_ALLOW_MUTATION=0` — zero create/update/delete/pay/sms/switch writes), catalog every discovered route:
   - Route path & breadcrumb
   - UI archetype (`auth-portal`, `dashboard`, `crud-table`, `form-config`)
   - Filter labels, table column headers, tabs, pagination totals
   - Pre-existing console `error`s, redundant/slow APIs, redacted query endpoints, and WCAG/landmark gaps
4. Write `reports/system-topology.json`, `specs/system-overview.md`, and sync `knowledge/SYSTEM_MAP.md` via `aitest_map_sync`.
5. Pause if switching portals invalidates the session, and report pre-existing product bugs objectively as findings — never normalize them as passing expectations.
