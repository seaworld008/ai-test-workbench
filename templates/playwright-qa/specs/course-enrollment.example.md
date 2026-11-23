# Test Plan Example: Smart Campus Course Enrollment

- **Project**: `__PROJECT_NAME__`
- **Target**: Allowlisted local/staging environment (`TEST_BASE_URL`)
- **Seed**: `tests/seed.spec.ts` (`--project=seed`)

## Scenarios

### 1. Course Catalog Search & Accessibility (`@critical @a11y`, Read-Only)
- **Role**: Authenticated Student (`storageState` from `auth.setup.ts`)
- **Steps**:
  1. Navigate to `/`.
  2. Run `expectAccessible(page)` for automated WCAG 2.2 Level A/AA checks.
  3. Filter courses by `"Playwright"` using the `"Search courses"` input.
  4. Filter courses by `"Sold Out"`.
- **Expected**:
  - Matching course card is visible.
  - Sold-out course button renders disabled (`toBeDisabled()`).
  - Zero uncaught `pageerror` or same-origin `5xx` responses.

### 2. Student vs Admin RBAC Isolation (`@critical`, Read-Only)
- **Role**: Student
- **Steps**:
  1. Navigate to `/admin` in browser and request `GET /api/admin/audit` with student Bearer token.
- **Expected**:
  - Both return HTTP `403` and render `403 Forbidden` without leaking admin records.

### 3. Duplicate & Last-Seat Concurrent Enrollment (`@mutation`, Write-Enabled Staging Only)
- **Precondition**: `TEST_ALLOW_MUTATION=1` on isolated test environment.
- **Steps**:
  1. Reset isolated test fixture state and create two unique worker-scoped QA student tokens.
  2. Submit enrollment twice for the same user on `course-open-101`.
  3. Concurrently submit two `POST /api/enroll` requests via `Promise.all` against 1-seat `course-last-seat`.
- **Expected**:
  - Duplicate submission returns `409`.
  - Concurrent race returns `[201, 409]` sorted — zero overselling.
