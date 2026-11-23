# Zero-to-One System Exploration Protocol (0 → 1 Atlas Before Testing)

Follow this 4-stage workflow whenever onboarding a complex or multi-tenant web application (such as an enterprise SaaS console, ERP, or campus platform):

## Stage 1: Authenticate Safely (`auth-login` or Password Setup)
- Never bypass CAPTCHAs or SMS gates.
- For interactive SMS/SSO/QR systems, run `aitest auth-login --target <repo> --base-url <url>` to persist `playwright/.auth/user.json` and `session.json`.
- For dedicated QA password accounts, configure `E2E_USERNAME`, `E2E_PASSWORD`, and `E2E_AUTH_LOGIN_PATH` in `<repo>/qa/.env`.

## Stage 2: Read-Only 0 → 1 Full System Exploration (`aitest explore`)
- Execute `aitest explore --target <repo> --base-url <url> --max-pages 30`.
- Strict safety rules during exploration:
  - Block all `DELETE`/`PUT`/`PATCH` requests and mutating `POST` routes (`create/add/save/update/delete/import/pay/sms/approve/submit`).
  - Only trigger UI controls classified as **read-only** (`搜索`, `查询`, `重置`, `查看`, `详情`, tab switches, pagination). Never click `新增`, `编辑`, `删除`, `审核`, `导出写入`, or status switches.
  - **Multi-Portal / Multi-Tenant Switcher Check (Critical for SaaS!)**: Do not stop at the default landing portal (often a high-level Platform Admin view). Actively inspect top navbars, sidebars, drawers, and router/store state for **Tenant / Organization / Workspace switchers**. Switch into daily operational portals and explore their domain menus as well.
  - Redact tokens, query secrets, phones, ID cards, and personal names before writing `reports/system-topology.json` and `specs/system-overview.md`.

## Stage 3: Summarize System Panorama -> Deep Functional Plan (`specs/*.md`)
- Review `specs/system-overview.md` with stakeholders or the Planner agent to confirm:
  1. All user roles and operational portals (`Platform` vs `Tenant/Workspace`).
  2. Core business workflows (`crud-table`, `form-config`, `dashboard`, `auth-portal`).
  3. Pre-existing runtime errors (Vue/React warnings, 5xx APIs, missing landmarks, unlabeled controls).
- Write structured deep test plans in `specs/` covering:
  - **Search + 0-Row Empty Boundary + Reset Restoration**
  - **Pagination State Consistency (Page 1 -> Page 2 -> Page 1)**
  - **Multi-Tab Business Filter Views**
  - **Read-Only Detail Drill-Down & Safe Back Navigation**
  - **Cross-Tenant Data Isolation & Unauthenticated Redirect Guards**

## Stage 4: Deterministic Generation, Execution & 3-Layer Audit
- Generate typed TypeScript specs in `tests/e2e/` and `tests/api/`. Keep conditional/loop helpers in `tests/fixtures/` so spec files comply with `eslint-plugin-playwright` (`no-conditional-in-test`).
- Run `aitest run --target <repo> --suite all --workers 1 --audit` and `aitest audit --target <repo> --check-specs --require-e2e`.
