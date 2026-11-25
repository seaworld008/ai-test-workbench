# Contributing to AI Test Workbench

> [简体中文 (默认)](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.en.md) · [Security Policy](./SECURITY.en.md)

Thank you for helping build an open, reliable, AI-Agent-First testing foundation!

## Core Engineering Principles

1. **Deterministic Foundation, AI Acceleration**: Never trade test determinism for AI convenience. Specs must use semantic locators, web-first assertions, and strict data isolation.
2. **Zero Fake-Green Tolerance**: Never use `test.skip`, `test.fixme`, or weakened assertions to mask product regressions. Every spec must pass `npx ai-test-workbench@6.2.0 audit --check-specs`.
3. **Cross-Platform Safe Execution**: Keep core CLI & MCP server modules zero-dependency Node.js ESM (`>=22.12`), never spawn child processes with `shell: true`, and never leak non-JSON-RPC logs to `stdout` in `stdio` MCP mode.
4. **Bilingual Docs & Desensitization**: Default Markdown docs are Simplified Chinese (`.md`) paired with `.en.md` English docs. Zero internal domains, secrets, or local machine paths allowed.

## Local Development & Verification

```bash
node tools/aitest.mjs doctor
npm run lint:docs
npm test
npm run smoke
npm run demo:verify
```

## Pull Request Checklist

- [ ] `npm run lint:docs`, `npm test`, and `npm run smoke` pass with 0 failures.
- [ ] New CLI/MCP capabilities update `--help`, `src/i18n.mjs` (`zh` + `en`), and paired bilingual docs.
- [ ] No hardcoded paths, secrets, internal staging URLs, or `.env` files committed.
