# Graph Engine Conformance Suite (`codebase-memory-mcp`)

> [中文版](./README.md)

This standalone CI conformance suite verifies a pinned `DeusData/codebase-memory-mcp` release binary
(`v0.12.1`) against a compact, multi-repo golden fixture containing:

- **Chinese directory & file paths** (`后端-spring-cloud/`, `前端-vue-admin/`, `订单管理/OrderList.vue`)
- **Spring Boot + Spring Cloud** (`OrderController -> OrderService -> OrderServiceImpl -> OrderMapper` + `@FeignClient PayFeignClient`)
- **MyBatis XML + Mapper** (`OrderMapper.xml` -> `trade_order`)
- **Vue 2/3 Frontend** (`src/api/order.js` + `src/views/订单管理/OrderList.vue`)

## Checks Performed

1. **Binary Identity & Checksum**: Validates executable presence, `--version` semver output, and SHA-256 digest (enforced against `--strict-sha256` when supplied).
2. **Cross-Platform Runtime/Cache Isolation**: Uses short, owner-only out-of-workspace `CBM_RUNTIME_DIR` + `CBM_CACHE_DIR` validated by `validateRuntimeDirSafety()`.
3. **Offline `--ui=false` Containment**: Invokes CBM exclusively with `--ui=false cli --quiet --json <tool>` and scrubbed `HTTP_PROXY`/`HTTPS_PROXY` + `NO_PROXY=*` (safe under Linux `docker run --network=none`).
4. **Incremental Indexing**: Executes two consecutive `index_repository` passes on the Chinese-path fixture and verifies both succeed.
5. **Coverage Telemetry**: Executes `check_index_coverage` and validates normalized `coverage` output.
6. **Java Call-Chain Fidelity & Snapshot Determinism**: Runs `syncRepos()` twice consecutively and asserts:
   - `OrderController` -> `OrderService` / `OrderServiceImpl` -> `OrderMapper` chain is resolved,
   - Zero raw source bodies or prompt-poisoning markers leak into `NormalizedGraphSnapshot`,
   - Both runs produce **byte-identical** canonical JSON.

## Usage

```bash
# Against an installed or explicitly supplied CBM v0.12.1 binary
node conformance/graph-engine/run-conformance.mjs --binary /path/to/codebase-memory-mcp --json

# Against AITEST_CBM_BIN or isolated workbench cache, enforcing exact binary SHA-256
AITEST_CBM_BIN="%LOCALAPPDATA%\aitw\bin\cbm\0.12.1\codebase-memory-mcp.exe" \
  node conformance/graph-engine/run-conformance.mjs --strict-sha256 <64-hex-sha256> --json

# Offline CI smoke when binary is optional in local dev
node conformance/graph-engine/run-conformance.mjs --allow-skip-missing --json
```

> Note: `conformance/` is intentionally excluded from the published npm tarball (`package.json#files` and `test/unit/package-hygiene.test.mjs`).
