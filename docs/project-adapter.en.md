# Multi-Stack Project Adapter Guide

> [简体中文 (默认)](./project-adapter.md) · [English README](../README.en.md)

## 1. Next.js / Vue / React / Modern H5 (`<repo>/qa/`)
- Keep Playwright dependencies isolated inside `<repo>/qa/package.json` without modifying host Vite/Next/Webpack builds.
- Exclude `qa/**` from host root `tsconfig.json` or `eslint.config.*` if `npx ai-test-workbench@6.3.0 init` reports overlap advisories.
- Run `npx ai-test-workbench@6.3.0 map` to auto-index routes into `impact-map.json` alongside manual mapping rules.

## 2. Java / Spring Cloud (`<repo>/qa/`)
- Playwright covers cross-service UI flows and HTTP API contracts alongside JUnit/MockMvc.
- Never store privileged write DB credentials in `qa/.env`; use read-only QA APIs or read-only DB MCP presets.

## 3. PHP / ThinkPHP (`<repo>/qa/`)
- Zero PHP runtime coupling; use `--qa-dir e2e-qa` if `qa/` already holds unrelated files.

## 4. Mobile Web vs. Native / Mini-Program Boundary
- Device presets emulate mobile H5 browsers, not native WeChat Mini-Programs or iOS/Android native binaries.
