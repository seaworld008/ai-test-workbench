# Local Self-Contained Demo Target (`examples/demo-webapp`)

> [简体中文 (默认)](./README.md) · [English README](../../README.en.md)

A zero-dependency localhost **Smart Campus Course Enrollment** web app allowing contributors and CI to verify Playwright E2E, API contracts, `storageState` auth, RBAC (`403`), duplicate submission (`409`), and concurrent 1-seat race protection (`201 + 409`) without an external staging server.

## Start Locally

```bash
node examples/demo-webapp/server.mjs
node examples/demo-webapp/server.mjs --port 0
```

## Endpoints

| Method & Path | Purpose |
|---|---|
| `GET /` | Semantic WCAG-friendly course catalog with search filter & disabled sold-out buttons |
| `GET /login` | Semantic sign-in page |
| `POST /api/login` | Issues Bearer session token for `student_*` or `admin_qa` |
| `GET /api/courses` | Returns courses JSON (`10`-seat, `1`-seat, and `0`-seat boundary items) |
| `POST /api/enroll` | Enrolls authenticated student; blocks duplicates (`409`) and overselling (`409`) |
| `GET /admin`, `GET /api/admin/audit` | Returns `403 Forbidden` for student tokens |
| `POST /__test__/reset` | Loopback-only (`127.0.0.1`) fixture reset |
