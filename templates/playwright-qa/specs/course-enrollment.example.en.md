# Test Plan Example: Core Workflow, RBAC & Concurrency Idempotency (`course-enrollment.example.en.md`)

> [简体中文 (默认)](./course-enrollment.example.md)

- **Project**: `__PROJECT_NAME__`
- **Target**: Allowlisted local or staging environment (`TEST_BASE_URL`)
- **Seed**: `tests/seed.spec.ts` (`--project=seed`)
- **Note**: Replace placeholder `REQ-*` IDs, routes, and assertions below with your actual domain flows.

## Scenarios

### 1. [REQ-CORE-001] Primary Listing, Control Constraints & Automated Accessibility (`@critical @a11y`, Read-Only)
- Navigate to the primary route, invoke `expectAccessible(page)` (WCAG 2.0/2.1/2.2 A/AA), exercise read-only filtering, and verify unavailable action controls remain disabled (`toBeDisabled()`) with zero `pageerror` or `5xx` responses.

### 2. [REQ-RBAC-001] Role-Based Access Control Isolation (`@critical`, Read-Only)
- Request a privileged admin page and admin API endpoint using standard non-privileged user credentials; expect HTTP `403` and zero privileged data leakage.

### 3. [REQ-MUTATE-001] Duplicate Submission & Concurrent Race Guard (`@mutation`, Loopback / Write-Enabled Only)
- Require loopback sandbox default or `TEST_ALLOW_MUTATION=1`; verify duplicate write returns `409` (conflict) and concurrent `Promise.all` quota requests allow at most one `201` without oversubscription.
