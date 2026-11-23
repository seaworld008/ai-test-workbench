# Test Plan Example: Smart Campus Course Enrollment

> [简体中文 (默认)](./course-enrollment.example.md)

- **Project**: `__PROJECT_NAME__`
- **Target**: Allowlisted local/staging environment (`TEST_BASE_URL`)
- **Seed**: `tests/seed.spec.ts` (`--project=seed`)

## Scenarios

### 1. Course Catalog Search & Accessibility (`@critical @a11y`, Read-Only)
- Navigate to `/`, run `expectAccessible(page)`, filter by `"Playwright"` and `"Sold Out"`, expect matching cards and disabled sold-out button (`toBeDisabled()`) with zero `pageerror` / `5xx`.

### 2. Student vs Admin RBAC Isolation (`@critical`, Read-Only)
- Request `/admin` and `GET /api/admin/audit` with student credentials; expect HTTP `403`.

### 3. Duplicate & Last-Seat Concurrent Enrollment (`@mutation`, Write-Enabled Staging Only)
- Require `TEST_ALLOW_MUTATION=1`; duplicate submission expects `409`, and `Promise.all` race on 1-seat `course-last-seat` strictly yields `[201, 409]`.
