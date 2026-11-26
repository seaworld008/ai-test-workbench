# Security Policy & Test-Target Safety Controls

> [简体中文 (默认)](./SECURITY.md) · [Security Deep-Dive](./docs/security.en.md)

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories with affected version, reproduction steps, and suggested mitigation rather than opening a public issue.

## Built-In Safety Controls

1. **No Production Targets**: `TEST_ENV=production|prod|live|online` and wildcard hosts are hard-blocked; `TEST_BASE_URL` must match `TEST_ALLOWED_HOSTS`, and `TEST_DENIED_ORIGINS` / `TEST_BLOCKED_ENDPOINTS` are enforced on both browser `page.route` and `APIRequestContext`.
2. **Mutation Guard (`TEST_ALLOW_MUTATION`)**: State-changing routes are blocked during read-only exploration and excluded by default unless explicitly unlocked in isolated staging environments.
3. **MCP HTTP Security**: `npx ai-test-workbench@6.5.0 mcp-serve --transport http` validates `Origin` against DNS rebinding (`403 Forbidden`) and rejects non-loopback bindings unless Bearer `--auth-token` / `AITEST_MCP_TOKEN` (`401 Unauthorized`) is set.
4. **Secret Redaction & Safe Subprocesses**: `.env` and `playwright/.auth/` are gitignored; diagnostic and MCP payloads pass through `redactSecrets`; all subprocesses enforce `shell: false`.
