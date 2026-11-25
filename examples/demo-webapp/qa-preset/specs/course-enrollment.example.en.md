# Smart Campus Course Catalog, RBAC & Race Test Plan (`course-enrollment.example.en.md`)

> [简体中文 (默认)](./course-enrollment.example.md)

- **Project**: `__PROJECT_NAME__`
- **Target**: Smart Campus loopback or staging target (`TEST_BASE_URL`)
- **Seed**: `tests/seed.spec.ts` (`--project=seed`)

## Scenarios

### 1. [REQ-CATALOG-001] Course Search, Sold-Out State & Automated Accessibility (`@critical @a11y`, Read-Only)
- Navigate to `/` and verify `GET /api/courses` against its JSON Schema contract (including `seatsLeft === 0`), run `expectAccessible(page)` (WCAG 2.0/2.1/2.2 A/AA), filter courses, and assert sold-out buttons stay `toBeDisabled()` with zero `pageerror` or `5xx` responses.

### 2. [REQ-RBAC-001] Student RBAC Access Isolation (`@critical`, Read-Only)
- Visit `/admin` and request `GET /api/admin/audit` with a student Bearer token; assert HTTP `403` with zero privileged data leakage.

### 3. [REQ-ENROLL-001] Duplicate Enrollment Idempotency & 1-Seat Concurrency Race (`@mutation`, Isolated Sandbox)
- Reset sandbox via `/__test__/reset`; submit duplicate `POST /api/enroll` (`409`) and race two `Promise.all` enrollments for the final seat (strict `[201, 409]`, zero overselling).
