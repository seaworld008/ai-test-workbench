# ADR-0002: Kernel Single Source of Truth (`src/kernel/`), Deterministic Vendor Mirror & `upgrade` Workflow

> [简体中文 (默认)](./0002-kernel-ssot-vendor-mirror-and-upgrade.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md)

- **Status**: Accepted (Implemented in `v6.0.0`)
- **Date**: `2026-11-24`

---

## 1. Context & Problem Statement

In `v5.x`, the 4-layer gate kernel, target guard, and schema validator lived inside `templates/playwright-qa/support/`, and 14 `src/` and `scripts/` files imported upward into `templates/`. This inverted dependency direction caused two issues:

1. Core CLI/MCP logic depended on scaffold template files meant to be copied into user repos;
2. Copied `<repo>/qa/support/` files had no per-file manifest or safe upgrade command, while `doctor.mjs` failed to detect kernel drift after the v5 split.

---

## 2. Alternatives Considered

| Option | Pros | Cons & Tradeoffs |
|---|---|---|
| **Option A (Adopted): Authoritative `src/kernel/` + `package.json#exports` + deterministic vendor mirror + `aitw upgrade`** | Eliminates all `src -> templates` inversions; preserves standalone offline `<repo>/qa/` execution without breaking template lockfiles; CI enforces byte-identical mirror; 3-way hash-safe `upgrade` | Keeps a generated read-only mirror in `templates/playwright-qa/support/`, strictly enforced by `npm run check:vendor` |
| **Option B: Depend on `ai-test-workbench` from `templates/playwright-qa/package.json`** | Removes `support/` from templates | Creates an unpublished-version lockfile chicken-and-egg deadlock and forces offline/air-gapped `qa/` installs to fetch the workbench package from npm |

---

## 3. Decision

1. **Kernel SSoT in `src/kernel/`**: Home `gate-kernel.mjs`, `target-guard.mjs`, `schema-validator.mjs`, and `gate/**` under `src/kernel/` and export `.`, `./kernel`, `./target-guard`, and `./schema-validator` via `package.json#exports`.
2. **Deterministic One-Way Mirror (`scripts/sync-template-vendor.mjs`)**: Mirror `src/kernel/**` and shared `src/core/{config,glob,outcome,playwright-results,version}.mjs` to `templates/playwright-qa/support/` stamped with `@generated`, `@source-sha256`, and `@workbench-version`. `test/unit/architecture-boundaries.test.mjs` and CI enforce `0` template inversions and byte identity.
3. **Manifest & 3-Way Safe `upgrade`**: `init` writes `<repo>/qa/.aitest/template-manifest.json`; `npx ai-test-workbench@6.2.0 upgrade --target <repo>` updates unmodified managed files cleanly, writes `.aitest-new` on user conflicts, and **never** auto-approves `governance.lock`.
4. **Accurate Drift Detection**: `detectHostGateKernelVersion()` checks `.aitest/template-manifest.json`, `support/core/version.mjs`, `support/gate/engine.mjs`, and legacy single-file kernels.

---

## 4. Consequences & Verification

- `src/scripts -> templates` dependency inversions dropped from `14` to `0`;
- `npm run check:vendor` and `test/unit/kernel-and-upgrade.test.mjs` enforce mirror parity and upgrade safety.
