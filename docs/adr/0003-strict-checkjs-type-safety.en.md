# ADR-0003: Type Safety Strategy — Zero-Build Strict `JSDoc + checkJs + .d.ts`

> [简体中文 (默认)](./0003-strict-checkjs-type-safety.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md)

- **Status**: Accepted (Implemented in `v6.0.0`)
- **Date**: `2026-11-24`

---

## 1. Context & Problem Statement

In `v5.1.1`, `tsconfig.check.json` disabled `strict`, `noImplicitAny`, and `useUnknownInCatchVariables`, pointed `typeRoots` into `templates/playwright-qa/node_modules/@types`, and `scripts/run-typecheck.mjs` silently exited `0` locally when `tsc` was absent. Enabling strict checks exposed over 1,000 untyped parameters, implicit `any` bindings, and unnarrowed `catch (err)` accesses.

---

## 2. Binary Tradeoff Evaluation

| Criterion | Option A (Adopted): Strict `JSDoc + checkJs + src/types/*.d.ts` (Zero Build) | Option B (Rejected): Migrate `src/` to `.ts` and emit `dist/` |
|---|---|---|
| **Build step & direct execution** | **Zero build step** — `node tools/aitest.mjs` executes directly from source on Node `>= 22.12` | Requires compilation to `dist/`, sourcemaps, and entrypoint rewrites |
| **Vendor mirror alignment** | 1:1 readable ESM source mirror into `templates/playwright-qa/support/` | Requires transpilation step to feed template mirror |
| **Root runtime dependencies** | Zero runtime `dependencies`; only exact-pinned `devDependencies` (`typescript@6.0.3`, `@types/node@26.6.6`) | Same dev tooling plus 14k-line mechanical syntax churn |
| **Compile-time guarantees** | Full `strict: true`, `noImplicitAny: true`, `useUnknownInCatchVariables: true` with `0` errors and `0` suppression directives | Equivalent compile-time checks |

---

## 3. Decision

1. **Adopt Zero-Build Strict `checkJs`**: Pin `typescript@6.0.3` and `@types/node@26.6.6` in root `devDependencies` (keeping runtime `dependencies` empty) and remove the reverse dependency on template `node_modules`.
2. **Enable Strict Mode Everywhere**: Switch `tsconfig.check.json` to `strict: true`, `noImplicitAny: true`, `useUnknownInCatchVariables: true` with `typeRoots: ["./node_modules/@types"]`.
3. **Fail-Closed Enforcement**: `scripts/run-typecheck.mjs` exits `2` in all environments if root `tsc` is absent; `test/unit/architecture-boundaries.test.mjs` bans `@ts-nocheck`, `@ts-ignore`, and `@ts-expect-error` across `src/**`.

---

## 4. Consequences & Verification

- All `1,151` strict TypeScript diagnostics across `58` modules were resolved to `0` errors with `0` suppressions;
- `npm run typecheck` runs strictly in both local development and CI.
