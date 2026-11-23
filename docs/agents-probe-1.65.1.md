# Empirical Probe Report: `@playwright/test@1.65.1` Test Agents & CLI Capabilities

> **Date**: 2026-11-23  
> **Environment**: Windows (`pwsh`), Node.js `v26.11.0`, npm `11.20.0`, `@playwright/test@1.65.1`  
> **Probe Sandbox**: `.sandbox/agent-probe/` (gitignored)

This document records the exact empirical behavior of `@playwright/test@1.65.1` before implementing agent synchronization, project configuration, and quality gates.

---

## 1. `playwright init-agents --help`

```text
Usage: npx playwright init-agents [options]

Initialize repository agents

Options:
  --loop <loop>        Agentic loop provider (choices: "claude", "codex",
                       "copilot", "opencode", "vscode", "vscode-legacy")
  -c, --config <file>  Configuration file to find a project to use for seed test
  --project <project>  Project to use for seed test
  --prompts            Whether to include prompts in the agent initialization
  -h, --help           display help for command
```

### Key Behavioral Findings
1. **Working Directory (`cwd`) Resolution**: `init-agents` writes `.codex/`, `.claude/`, `.mcp.json`, and `specs/README.md` relative to **`process.cwd()`**. Invoking `cli.js` from a parent directory causes files to land in the parent directory. `agents.mjs` must always set `cwd` to the target `qa/` (or isolated staging directory).
2. **`--project=seed` Selection**: Passing `-c playwright.config.ts --project=seed` outputs `🎭 Using project "seed" as a primary project` and places `seed.spec.ts` in the `seed` project's `testDir` (`./tests/seed.spec.ts`).
3. **Existing `seed.spec.ts` Preservation**: When `tests/seed.spec.ts` already exists, `init-agents` does **not** overwrite it; however, it **does** unconditionally overwrite `.codex/agents/*.toml`, `.claude/agents/*.md`, and `.mcp.json` on every run.
4. **Generated File Inventory & Overlap**:
   - `--loop=codex`:
     - `.codex/agents/playwright_test_planner.toml`
     - `.codex/agents/playwright_test_generator.toml`
     - `.codex/agents/playwright_test_healer.toml`
     - `specs/README.md` (if absent)
     - `tests/seed.spec.ts` (if absent)
   - `--loop=claude`:
     - `.claude/agents/playwright-test-planner.md`
     - `.claude/agents/playwright-test-generator.md`
     - `.claude/agents/playwright-test-planner.md`
     - `.mcp.json`
     - `specs/README.md` & `tests/seed.spec.ts` (if absent)
   - `codex` and `claude` agent files live in disjoint directories, so sequential initialization does not collide on agent definitions, **provided** user edits to existing agent files are guarded by a SHA-256 manifest (`qa/.aitest/agents-manifest.json`).
5. **Absolute Path Check**: None of the generated `.toml`, `.md`, or `.mcp.json` files embed absolute paths (`hasAbsPath=False`). On Windows, Playwright writes `command = "cmd"` with `args = ["/c", "npx", "playwright", "run-test-mcp-server"]`. Nevertheless, staging-to-target path sanitization (`tempDir` -> `qaDir` for both `/` and `\`) and post-copy assertion (`!content.includes('aitest-agents-')`) are enforced as defense-in-depth.
6. **Built-in Healer `test.fixme()` Risk**: Official `.codex/agents/playwright_test_healer.toml` contains the instruction:
   > *"If the error persists and you have high level of confidence that the test is correct, mark this test as test.fixme() so that it is skipped during the execution."*
   This confirms why independent CI gates (`eslint-plugin-playwright` `no-skipped-test`, `audit-results.mjs` critical-skip blocking, and `aitest audit --diff-base` Healer diff guard) are mandatory.

---

## 2. `playwright run-test-mcp-server --help`

```text
Usage: npx playwright run-test-mcp-server [options]

Interact with the test runner over MCP

Options:
  --headless           run browser in headless mode, headed by default
  -c, --config <file>  Configuration file, or a test directory with optional
                       "playwright.config.{m,c}?{js,ts}"
  --host <host>        host to bind server to. Default is localhost. Use 0.0.0.0
                       to bind to all interfaces.
  --port <port>        port to listen on for SSE transport.
  -h, --help           display help for command
```

- **Conclusion**: `-c, --config <file>` is officially supported. Default workflow starts the coding agent inside `<repo>/qa/`. Optional `--bridge-root` (with `--dry-run` support) can safely wire `<repo>/.mcp.json` using `node` + `qa/node_modules/@playwright/test/cli.js run-test-mcp-server --config qa/playwright.config.ts` (never `npx` from root).

---

## 3. `playwright test --help` Verified Flags

All five candidate flags were verified present in `@playwright/test@1.65.1`:
- `--only-changed [ref]` — Supported (used for `qa/` internal test dependency diffing).
- `--last-failed` & `--last-failed-file <file>` — Supported.
- `--fail-on-flaky-tests` — Supported (wired into strict CI/audit runs alongside `--max-flaky`).
- `-G, --grep-invert <grep>` — Supported (used to exclude `@mutation` when `TEST_ALLOW_MUTATION=0`).
- `--tsconfig <path>` — Supported.
