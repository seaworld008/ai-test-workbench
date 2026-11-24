# Generator Prompt (`tests/e2e/*.spec.ts` & `tests/api/*.spec.ts`)

> [简体中文 (默认)](./generator.md)

Start inside `<repo>/qa/` (`cd qa`). Invoke the official Playwright **Generator** agent using:

- **Approved Plan**: `specs/<module>.md`
- **Seed Test**: `tests/seed.spec.ts`

## Rules
1. Import `{ test, expect, expectAccessible, expectApiContract, expectPerformanceBudget } from '../fixtures/base'`.
2. Prefer `getByRole`, `getByLabel`, `getByTestId`, `toMatchAriaSnapshot`, and web-first assertions.
3. Forbidden: `waitForTimeout()`, `.only()`, `test.skip()`, `test.fixme()`, `{ force: true }`, or empty assertions.
4. Tag any state-modifying spec with `@mutation` and isolate data per worker.
5. Verify with `npm run typecheck`, `npm run lint`, and `npx ai-test-workbench@5.1.0 run --target .. --suite e2e --audit`.
