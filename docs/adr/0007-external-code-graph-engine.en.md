# ADR-0007: Decoupled Pinned Sidecar Code Graph Engine (`codebase-memory-mcp`), CodeMap v5 & Diff-Impact v3

> [简体中文 (默认)](./0007-external-code-graph-engine.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md) · [Governance Guide](../governance.en.md) · [Upgrade Guide](../upgrade.en.md)

- **Status**: Accepted (shipped in `v6.6.0`, verified on an enterprise 1.01M-LOC multi-repo SaaS benchmark and live 8/8 conformance suite)
- **Date**: `2026-11-27`

---

## 1. Context & Architectural Tradeoffs (Pinned Sidecar vs Hard-Fork vs Source Vendoring)

In million-LOC enterprise multi-repo microservice systems (e.g., an enterprise 1.01M-LOC Vue 2 + Spring Cloud multi-tenant SaaS benchmark spanning 12,889 files, 12 microservices, 692 controllers, 360 MyBatis XMLs, and 129 Feign clients), regex-only static indexing hits four structural limits:

1. **Symbol-Level Call-Graph Blind Spots**: When a commit modifies a deep Service implementation (`ServiceImpl#method`), cross-service Feign contract, or MyBatis XML statement, file-level reverse graphs hit the `>= 8` fan-in fallback cliff and drop back to full-suite execution instead of narrowing precisely to affected Controller → Vue View → Playwright Spec chains.
2. **Cross-Portal Route Collisions & Unguarded Global Infrastructure**: Unresolved Spring `WebProperties` Java constants and Ant/regex path prefixes cause cross-portal `@RequestMapping` collisions; edits to Spring `META-INF/spring.factories` / `WebFilter` / `Interceptor` / `ControllerAdvice` or Vue global guards/components risk missed regressions without an explicit fail-closed infra guard.
3. **Framework & E2E Semantic Gap**: Generic AST call-graph tools do not natively understand Playwright E2E routes, backend-driven dynamic permission menus, Vue `crudFactory` / template component bindings, Spring gateway prefixes, or MyBatis `<mapper namespace>` wiring.
4. **Maintenance & Supply-Chain Cost**: **Hard-forking** or **source-vendoring** a native multi-language Tree-sitter/C/Go graph engine would break `ai-test-workbench`'s **zero runtime npm dependencies** invariant, introduce native build-chain maintenance overhead, and block continuous upstream adoption.

We evaluated three integration options:

| Option | Zero Runtime Deps | Upstream Tracking | Supply-Chain Integrity | Decision |
|---|---|---|---|---|
| **Hard-Fork** | Broken | Poor (perpetual merge drift) | Medium | Rejected |
| **Source Vendoring** | Broken (native toolchain/bloat) | Poor | Medium | Rejected |
| **Decoupled Pinned Sidecar + SPI** | **Preserved (`dependencies` absent)** | **High (manifest bump + 8/8 conformance)** | **Highest (SHA-256 + Governance Lock + air-gapped install)** | **Accepted** |

---

## 2. L0 + L1 + L2 Three-Tier Fusion Architecture (CodeMap v5)

`src/codemap/` and `src/codemap/providers/` establish a clean anti-corruption three-tier architecture:

1. **L0 Zero-Dependency Full-Stack / E2E Extractors (Always Available, Never Blocking)**:
   - `src/codemap/spring-prefix-resolver.mjs`: Resolves Java `static final String` constants, Ant/regex path matchers, and most-specific prefixes—reducing cross-portal `@RequestMapping` collisions to `0%`.
   - `src/codemap/rpc-mybatis-extractor.mjs`: Extracts OpenFeign / Dubbo cross-service bridges, RocketMQ producers, XXL-Job handlers, MyBatis XML `<select|insert|update|delete>` statements, and `BaseMapper<DO>` direct table chains (skipping Feign annotations such as `@ApiOperation` and isolating `BaseMapperX` / framework hubs).
   - `src/codemap/vue-template-factory.mjs` & `src/codemap/vue-api-extractor.mjs`: Resolves chained Axios clients, `crudFactory` generated endpoints, Vue template custom tags, global component registrations (e.g., `<right-toolbar>`), and backend-driven dynamic routes (`Layout` shell & runtime route matching).
2. **L1 Decoupled Pinned Sidecar Graph Engine (`src/codemap/providers/`)**:
   - Integrates official **`DeusData/codebase-memory-mcp@0.12.1`** (MIT license, read-only `stdio` JSON-RPC sidecar with `--ui=false` strictly enforced) behind a pluggable Graph Provider SPI (`registry.mjs`).
   - `cbm-client.mjs` enforces strict subprocess environment scrubbing (never leaking `AITEST_HMAC_KEY*`, cloud credentials, or OIDC tokens), UTF-8 CJK stdin/path safety, hard timeouts with cross-platform `killProcessTree`, and an `8 MB` stdout ceiling.
   - When the sidecar is absent, times out, or fails, `syncLivingCodeMap` gracefully degrades to L0 `builtin` mode and `doctor` reports `WARN` rather than `FAIL`.
3. **L2 Anti-Corruption Normalization & Fusion (`cbm-normalizer.mjs` + `v5-fusion.mjs` + `sync.mjs`)**:
   - Passes every external symbol name, path, and annotation through `sanitizeUntrustedCodeMetadata` (neutralizing triple-backtick fences, stripping ANSI/control/bidi characters, redacting prompt-poisoning payloads) plus secret redaction.
   - Confines indexing to configured `sourceRepos`, rejects `BaseMapperX` / `Object.*` / non-app script and POJO noise, and enforces cross-service Feign/RPC stop-boundaries to prevent cross-microservice DB table bleed.
   - Produces deterministic **`knowledge/code-map.json` (`schemaVersion: 5`)**, **`knowledge/SYSTEM_MAP.md`**, and pre-projected **`knowledge/graph-impact-index.json`**, powering fast cached `map --query <symbol>` composite queries and `diagnose` service-chain + tenant/auth filter hints.

---

## 3. Cross-Platform Short-Path Cohort Isolation & Windows NTFS ACL Defense

`codebase-memory-mcp` enforces strict OS path and permission invariants that fail if runtime/cache directories reside inside `<repo>/qa/.aitest/` (Windows `MAX_PATH` 260-char limit, CJK repo paths, shared ancestor ACLs). `src/codemap/providers/engine-manifest.mjs` isolates the workbench cohort from any developer-global install:

| Platform | Binary Dir (`binDir`) | Runtime Dir (`runtimeDir`) | Cache Dir (`cacheDir`) | Enforced Safety Checks |
|---|---|---|---|---|
| **Windows** | `%LOCALAPPDATA%\aitw\bin\cbm\<ver>\` | `%LOCALAPPDATA%\aitw\rt` (auto-falls back to `%SystemDrive%\aitw-rt` hardened via owner-only `icacls /inheritance:r` when untrusted ancestor ACEs are detected) | `%LOCALAPPDATA%\aitw\cbm` (fallback `%SystemDrive%\aitw-cbm`) | Path length `< 185` chars, no symlinks/junctions/system dirs, detects untrusted `CodexSandboxUsers` / `Everyone` ancestor mutation ACEs |
| **macOS** | `~/Library/Caches/aitw/bin/cbm/<ver>/` | `/private/tmp/aitw-rt-<uid>` | `~/Library/Caches/aitw/cbm` | Runtime path strictly `<= 60` bytes (preserving the `104B` `AF_UNIX` socket budget) |
| **Linux / WSL2** | `$XDG_CACHE_HOME/aitw/bin/cbm/<ver>/` | `$XDG_RUNTIME_DIR/aitw-rt-<uid>` or `/tmp/aitw-rt-<uid>` | `$XDG_CACHE_HOME/aitw/cbm` | Forbids WSL2 DrvFs (`/mnt/*`) for runtime/cache storage |

No platform permits placing `runtimeDir` or `cacheDir` inside `<qaDir>/.aitest/`.

---

## 4. `pipe-sharded-v1` `<20ms` Read-Only Projection & Additive-Only Fail-Closed Diff-Impact v3

To keep read-only `aitest_impact` fast without spawning external graph daemons on every Git diff, `v6.6.0` separates write-time projection (`map`) from read-time selection (`impact`) behind three safety barriers:

1. **`pipe-sharded-v1` Zero-Escape 16-Shard Lazy Hydration (`src/impact/graph-index-codec.mjs` + `graph-index.mjs`)**:
   - Compiles file symbols, reverse callers, controller chains, and Vue component parents into a string-interned (`_ft`), pipe/semicolon-encoded 16-shard deterministic JSON artifact (`_fmt: 'pipe-sharded-v1'`), pruning POJO/VO/DTO/DO/Enum/Test files and builtin pseudo-nodes.
   - `loadGraphImpactIndex` wraps shards in a read-only lazy `Proxy`, hydrating only touched shards on demand: on the 1.01M-LOC enterprise benchmark, the CBM index drops from `6.46 MB` to **`4.11 MB`** with **`8.76 ms`** median load latency over 15 runs (Builtin: `1.29 MB` / **`2.17 ms`** median), well within the `< 20 ms` budget.
   - High-fan-in hubs exceeding `65` callers (e.g., `CommonResult#success` with 3,595 callers) are encoded with the **`*HIGH_FAN_IN*`** sentinel so edits fail closed to full-suite execution without bloating the index.
2. **Global Infra Guard (`src/impact/global-infra-guard.mjs`)**:
   - Before any narrowing runs, edits to Spring `META-INF/spring.factories`, `AutoConfiguration.imports`, `WebFilter`, `GlobalFilter`, `OncePerRequestFilter`, `HandlerInterceptor`, `ControllerAdvice`, `WebConfigurer`, `WebProperties`, `RequestInterceptor`, MyBatis `@Intercepts`, or Vue `src/utils/{request,platformRequest,crudFactory}`, `src/main`, `src/permission`, and unmapped global components **unconditionally fail closed to `mode: "full"`**.
3. **Additive-Only Fail-Closed Symbol Narrowing & Attestation Provenance (`src/impact.mjs` + `src/verdict.mjs`)**:
   - Narrowing beyond the `>= 8` fan-in cliff activates ONLY when coverage thresholds pass, diff hunks match innermost callable symbols (preferring Method/Function/MyBatis Statement over enclosing classes), and reverse traversal reaches Controller → Prefixed Route → Vue View → Playwright Spec cleanly; any coverage gap, unmapped hunk, or high-fan-in sentinel fails closed to full suite.
   - `verify-change` binds `scope.graphEngine` (`{ provider, version, binarySha256, mode, usedForNarrowing }`) directly into the `in-toto Statement v1` attestation for offline auditability.

---

## 5. Governance Lock Expansion, 8-Pillar MCP Hub & Supply-Chain Controls

1. **Governance Lock Sealing (`src/core/config-schema.mjs` + `src/kernel/gate/policy.mjs`)**:
   - **`.aitest/mcp.lock`** and **`.aitest/engine-manifest.json`** are explicitly included in `PROTECTED_AITEST_LOCK_FILES` and sealed inside `.aitest/governance.lock` (even though generic `.aitest/` runtime folders are skipped). Any agent modification trips Layer 0 until a human runs local `governance approve`.
2. **8-Pillar MCP Hub (`src/mcp-hub/catalog.mjs` + `auditor.mjs`)**:
   - Adds Pillar #8 **`code-intelligence`** with the pinned `codebase-memory-mcp@0.12.1` preset (included in `enterprise-selfhosted` and `full-link` profiles).
   - `mcp doctor` enforces native sidecar guardrails: `--ui=false`, ban on mutating `update/self-update/install` args, exact semver pinning, and local binary SHA-256 verification (with fail-closed `strictChecksum` support).
3. **17-Tool Canonical MCP Surface Invariant & New Resource**:
   - Following [ADR-0005](./0005-mcp-surface-outcome-and-config.en.md), zero new top-level MCP tools are added: `aitest_map_sync` gains `engine` / `query`, `aitest_mcp_hub` gains read-only `action="engine-status"`, and MCP resources expose `aitest://project/{target}/graph-summary` (plus `aitest://current/graph-summary`).

---

## 6. Continuous Upstream Upgrade Loop & Enterprise Benchmark Results

1. **Human-CLI Installer & Air-Gapped Mirror Support (`src/codemap/providers/engine-installer.mjs`)**:
   - `npx ai-test-workbench@6.6.0 mcp install-engine --engine codebase-memory-mcp` is human-CLI-only (never exposed as an MCP tool), embeds official 6-platform `v0.12.1` SHA-256 digests, blocks Zip-Slip archive traversal, supports offline `--from-file`, `--mirror-url`, and `--expected-sha256`, and retains `N-1` versions for instant rollback.
   - `npx ai-test-workbench@6.6.0 upgrade --scope engines` compares installed engine manifests against the workbench pin without auto-downloading binaries or auto-resigning `governance.lock`.
2. **Conformance Harness & Scheduled CI Gate (`conformance/graph-engine/` + `.github/workflows/ci.yml`)**:
   - Ships a CJK-path multi-repo conformance fixture and 8-check verifier (`run-conformance.mjs`) that must pass `8/8` live with byte-identical repeatability before any upstream pin bump; PR CI runs `--allow-skip-missing` while scheduled and `workflow_dispatch` CI runs the live `graph-engine-conformance` job.
3. **Enterprise 1.01M-LOC Multi-Repo Benchmark Scorecard** (Vue 2 + Spring Cloud multi-tenant SaaS: 12,889 files, 12 microservices, 692 controllers, 360 MyBatis XMLs, 129 Feign clients; zero modifications to target repos):
   - Cross-portal `@RequestMapping` collisions: `46/46 (100%)` → **`0 / 3,512 (0%)`**.
   - Controller-scoped DB table convergence: `262` → **`10` (Builtin, -96.2%) / `11` (CBM, -95.8%)**.
   - Deep symbol-level Diff-Impact v3 narrowing: Service method **`-99.78%`** (`1,366 → 3` Java files → `5` Vue views → `5` specs); cross-service Feign API **`-98.98%`** (`1,667 → 17` Java files, zero `Object.getClass` noise); MyBatis XML statement **`-98.78%`** (`410 → 5` files).
   - Global infra edits (`TenantSecurityWebFilter`, `CommonResult#success`, global `RightToolbar`) fail closed 100%; dynamic runtime route `frontendFile` hit rate reaches **`79/80 (98.75%)`** with deterministic `FP1 === FP2` across incremental runs.
