# Zero-to-One System Exploration Protocol (0 → 1 Atlas Before Testing)

> [简体中文 (默认)](./zero-to-one-exploration.md) · [SKILL.md](../SKILL.md)

Follow this 4-stage workflow whenever onboarding a complex or multi-tenant web/SaaS application:

## Stage 1: Authenticate Safely (`auth-login` or Dedicated QA Credentials)
- Never bypass CAPTCHAs or SMS gates; use `npx ai-test-workbench@6.0.0 auth-login` to persist `playwright/.auth/user.json` and `session.json`.

## Stage 2: Read-Only 0 → 1 Exploration (`npx ai-test-workbench@6.0.0 explore` / `aitest_explore`)
- Blocks all `DELETE`/`PUT`/`PATCH` and mutating `POST` paths (`create/add/save/update/delete/import/pay/sms/approve/submit`).
- Triggers only read-only UI controls; inspects navbars/drawers/store state for **Tenant / Organization / Workspace switchers** (`Platform` vs `Tenant/Workspace`).
- Redacts tokens/PII query params and generates `reports/system-topology.json`, `specs/system-overview.md`, and Living Code Map `knowledge/SYSTEM_MAP.md`.

## Stage 3: Deep Functional Plan (`specs/*.md`)
- Cover search + 0-row empty boundaries + reset, pagination consistency, multi-tab business views, read-only detail navigation, and cross-tenant isolation.

## Stage 4: Deterministic Generation & 3-Layer Audit
- Keep loop helpers inside `tests/fixtures/` so specs comply with `no-conditional-in-test`; run `npx ai-test-workbench@6.0.0 run --suite all --audit` and `npx ai-test-workbench@6.0.0 audit --check-specs --require-e2e`.
