# Multi-Stack Project Adapter Guide

## 1. Vue / React / Modern H5 (`<repo>/qa/`)

- Keep Playwright dependencies isolated inside `<repo>/qa/package.json` unless the repository already maintains a root Playwright setup.
- Point `TEST_BASE_URL` to an already running local dev server or deployed staging URL; do not alter existing Vite/Webpack production build scripts.
- Configure `qa/impact-map.json` to map `src/views/**`, `src/pages/**`, and `src/api/**` to corresponding specs in `tests/e2e/` and `tests/api/`.

## 2. Java / Spring Cloud (`<repo>/qa/` or Dedicated QA Repo)

- Playwright covers cross-service UI journeys and HTTP API contract checks (`tests/api/`); it complements—not replaces—JUnit, MockMvc, and consumer-driven contract tests.
- Never place high-privilege database credentials inside `qa/.env`. Validate backend state via controlled QA endpoints or read-only APIs.
- High-concurrency overselling or distributed transaction guarantees require dedicated load/concurrency tools (such as k6 or backend concurrency harnesses) beyond browser UI tests.

## 3. PHP / ThinkPHP (`<repo>/qa/`)

- Playwright communicates with PHP applications purely over HTTP(S), so Node.js (`>=22.12`) in `qa/` has zero runtime coupling with the server's PHP version.
- Keep existing PHPUnit suites intact on the project's compatible PHP version.
- If `<repo>/qa` already exists for manual scripts, initialize into `--qa-dir e2e-qa`.

## 4. Mobile Web vs. Native / Mini-Program Boundary

- Playwright device descriptors (such as `Pixel 7` or `iPhone 14`) emulate **mobile browser viewports and user agents** for H5 web apps.
- They do **not** test WeChat Mini-Program native containers or native iOS/Android binaries. Evaluate dedicated mobile/mini-program frameworks separately when native container coverage is required.
