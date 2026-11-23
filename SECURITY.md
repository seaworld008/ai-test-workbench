# Security Policy & Test-Target Safety Controls

## Reporting a Vulnerability

If you discover a security vulnerability in `ai-test-workbench` (for example, shell injection in CLI wrappers, secret leakage in diagnostic outputs, or bypasses in the origin allowlist/denylist guards), please **do not** open a public issue with exploit details before coordinating remediation.

Contact the maintainers privately via GitHub Security Advisories or repository security contact with:
1. Affected version / commit hash.
2. Reproduction steps and environment details.
3. Suggested mitigation if known.

## Built-in Testing Safety Boundaries

`ai-test-workbench` enforces strict default-deny guards designed for AI-assisted E2E testing:

1. **No Production Targets by Default**:
   - `TEST_ENV=production` or `prod` is hard-rejected at config load and CLI preflight.
   - `TEST_BASE_URL` must match `TEST_ALLOWED_HOSTS` (strict exact hostnames or `host:port`, no wildcards like `*.com`).
   - `TEST_DENIED_ORIGINS` is checked both at config load and during live browser traffic via `page.route` interception.
2. **Mutation Guard (`TEST_ALLOW_MUTATION`)**:
   - Destructive or state-mutating requests (such as `POST`, `PUT`, `PATCH`, `DELETE`) in protected flows are blocked by default when `TEST_ALLOW_MUTATION=0` unless explicitly unlocked for isolated staging/local environments.
3. **Secret & Credential Redaction**:
   - `.env`, `.env.*` (except `.env.example`), and `playwright/.auth/` are gitignored across both root and initialized templates.
   - CLI runners and `aitest diagnose` automatically redact common credential patterns (`password`, `passwd`, `secret`, `token`, `cookie`, `authorization`, `api_key`) before writing diagnostic summaries.
4. **No Shell String Concatenation**:
   - All subprocesses are invoked with argument arrays and `shell: false`.

> **Disclaimer**: Application-level origin guards are a defense-in-depth safety layer against accidental misconfiguration. Always enforce real network isolation, staging-only accounts, and RBAC on your target servers.
