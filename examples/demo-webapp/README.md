# Local Self-Contained Demo Target (`examples/demo-webapp`)

A zero-dependency localhost web application simulating the **Smart Campus Course Enrollment Portal** so contributors and CI pipelines can verify full-stack Playwright E2E, API contract, `storageState` authentication, RBAC (`403`), duplicate enrollment (`409`), and concurrent `1`-seat race protection (`201 + 409`) without any external staging server.

## Start Locally

```bash
# Default port 5899 (avoids Vite 4173/5173 collisions)
node examples/demo-webapp/server.mjs

# Or bind an ephemeral free port (--port 0) and read "READY http://127.0.0.1:<port>"
node examples/demo-webapp/server.mjs --port 0
```

## Endpoints

| Method & Path | Purpose |
|---|---|
| `GET /` | Semantic WCAG-friendly course catalog with search filter & disabled sold-out button |
| `GET /login` | Semantic sign-in page |
| `POST /api/login` | Issues Bearer token for `student_*` (`qa-pass-123`) or `admin_qa` (`admin-pass-123`) |
| `GET /api/courses` | Returns course catalog JSON including `10`-seat, `1`-seat, and `0`-seat boundary items |
| `POST /api/enroll` | Enrolls authenticated student; blocks duplicates (`409`) and overselling (`409`) |
| `GET /admin`, `GET /api/admin/audit` | Returns `403 Forbidden` for student tokens |
| `POST /__test__/reset` | Loopback-only (`127.0.0.1`) state reset for isolated parallel/sequential runs |
