# 图谱引擎一致性测试套件 (`codebase-memory-mcp`)

> [English Version](./README.en.md)

本独立 CI 一致性套件用于验证锁版本的 `DeusData/codebase-memory-mcp` 发行版二进制（`v0.12.1`）在紧凑多仓黄金夹具上的真实表现，夹具涵盖：

- **中文目录与文件路径**（`后端-spring-cloud/`、`前端-vue-admin/`、`订单管理/OrderList.vue`）
- **Spring Boot + Spring Cloud**（`OrderController -> OrderService -> OrderServiceImpl -> OrderMapper` 以及 `@FeignClient PayFeignClient`）
- **MyBatis XML + Mapper**（`OrderMapper.xml` -> `trade_order`）
- **Vue 2/3 前端**（`src/api/order.js` + `src/views/订单管理/OrderList.vue`）

## 验证项

1. **二进制身份与校验和**：验证可执行文件存在性、`--version` 语义版本输出与 SHA-256 摘要（传入 `--strict-sha256` 时强制比对）。
2. **跨平台运行时/缓存隔离**：使用经 `validateRuntimeDirSafety()` 校验的短路径、独立于工作区外的 `CBM_RUNTIME_DIR` + `CBM_CACHE_DIR`。
3. **离线 `--ui=false` 隔离**：仅以 `--ui=false cli --quiet --json <tool>` 调用 CBM，剥离 `HTTP_PROXY`/`HTTPS_PROXY` 并注入 `NO_PROXY=*`（兼容 Linux `docker run --network=none`）。
4. **增量建图**：在中文路径夹具上连续执行两次 `index_repository` 并验证均成功。
5. **覆盖率遥测**：执行 `check_index_coverage` 并校验规范化后的 `coverage` 输出。
6. **Java 调用链保真度与快照确定性**：连续执行两次 `syncRepos()` 并断言：
   - 正确解析 `OrderController` -> `OrderService` / `OrderServiceImpl` -> `OrderMapper` 调用链；
   - 绝不向 `NormalizedGraphSnapshot` 泄露原始源码体或提示词注入片段；
   - 两次运行生成的规范 JSON **逐字节一致**。

## 使用方式

```bash
# 针对已安装或显式指定的 CBM v0.12.1 二进制运行
node conformance/graph-engine/run-conformance.mjs --binary /path/to/codebase-memory-mcp --json

# 针对 AITEST_CBM_BIN 或工作台隔离缓存目录，强制校验二进制 SHA-256
AITEST_CBM_BIN="%LOCALAPPDATA%\aitw\bin\cbm\0.12.1\codebase-memory-mcp.exe" \
  node conformance/graph-engine/run-conformance.mjs --strict-sha256 <64-hex-sha256> --json

# 本地开发可选安装场景下的离线 CI 冒烟检查
node conformance/graph-engine/run-conformance.mjs --allow-skip-missing --json
```

> 说明：`conformance/` 默认排除在发布的 npm tarball 之外（见 `package.json#files` 与 `test/unit/package-hygiene.test.mjs`）。
