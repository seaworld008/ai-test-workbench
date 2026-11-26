# ADR-0006：双目标五级检查点差分先知（`aitest_parity`）与零明文形状指纹协议

> [English Version](./0006-differential-parity-oracle-and-shape-fingerprints.en.md) · [简体中文主文档](../../README.md) · [系统架构](../../ARCHITECTURE.md) · [演进路线图](../review/v6.4-differential-verification-and-memory-loop-roadmap.md)

- **状态**：已采纳（Accepted，Round 1 内核与工具面已落地）
- **决策日期**：`2026-11-26`

---

## 1. 背景与问题陈述

在跨语言重写、核心框架迁移与 AI 原生流式服务演进中，单纯依赖合成测试用例和静态 AST 门禁存在四项结构性盲区：

1. **静态 AST 对 `S5 -> S5` 字面量同阶篡改存在天然盲区**：当 Agent 把业务断言字面量从 `409` 改为 `201` 或把金额从 `"$49.00"` 改为 `"$0.00"` 以迎合缺陷候选版时，断言强度仍为 `S5`，仅靠静态语法检查无法替代活体基准（Baseline）行为仲裁；
2. **组合爆炸与字符编码字节级分歧**：合成用例难以覆盖真实流量长尾组合（如 Python `json.dumps` 默认转义 Emoji 为 `\uXXXX` 而 Rust 原样输出 UTF-8 字节），且流式 SSE 接口缺乏 `text` / `thinking` / `toolCalls` / `usage` 重组与 `TTFT` 门禁；
3. **大规模失败时的排障风暴与隐私边界**：当共享序列化或鉴权缺陷触发数十条用例/请求同时失败时，线性平铺报错消耗大量上下文，且生产侧流量不能暴露明文载荷给 Agent；
4. **外部非确定性上游与被测服务（SUT）边界混淆**：直接放开 `route.fulfill(2xx)` 会导致假绿伪造，但外部大模型/第三方 RPC 又需要跨双端一致的确定性重放能力。

---

## 2. 最终决策

1. **双目标五级检查点差分先知（`src/kernel/diff-oracle.mjs` + `src/parity/`）**：
   - 确立确定性五级检查点：`CP1-Status-Headers`（状态码精确相等与关键响应头）、`CP2-Body-Shape-And-Value`（键序无关递归 JSON 结构/值比对 + 可选 `strictByteEscape` 字节级转义检测）、`CP3-Stream-Frames`（基于零依赖 `src/core/stream-sse.mjs` 的 Anthropic/OpenAI 双格式 SSE 语义重组、错误帧与闭合终止比对）、`CP4-DOM-ARIA-And-Runtime`（双端 ARIA 快照与新增运行时异常拦截）、`CP5-Perf-Ratio`（耗时与 `TTFT` 比值退化告警）。
   - **明确禁止盲目去噪**：绝不通过“跑两遍旧服务自动忽略波动字段”来抹除差异，仅对显式声明的 `normalizePaths`（默认 `headers.date`、`headers.etag`、`headers.x-request-id`、`headers.traceparent` 及受治理锁保护的 `aitest.config.json#parity.normalizePaths`）做确定性剥离。
2. **零明文形状指纹与根因聚类（`computeShapeFingerprint` + `src/diagnose/{fingerprint,cluster}.mjs`）**：
   - 计算确定性 SHA-256 截断指纹 `fp_<12hex>`，仅包含 `{ checkpoint, routePattern, pieceOrJsonPath, firstDiffByteOffset, baselineByteLen, candidateByteLen, diffKind, featureCohort }`。
   - 在 `--privacy-mode shape-only` 下，产物与报告强制擦除业务载荷预览（`baselinePreview: null`, `candidatePreview: null`），实现零明文排障闭环；`aitest_diagnose` 同步输出去重根因簇 `clusters[]`、最快最小复现 `minimalReproducerSpec` 与跨运行级联掩蔽标记 `unmaskedAfterFixOf`。
3. **离线脱敏流量语料与多样本联合 Schema（`src/corpus/` + `src/explore/schema-inferrer.mjs`）**：
   - 严守非生产环境红线，仅支持离线导入 HAR 1.2 / JSONL / OTel HTTP Span，强制脱敏凭据、剥离外部生产域名为相对路径、默认过滤删除与支付等高危路径，并自动提取无明文 `featureCohort` 分群标签。
   - 升级 Schema 推断器为多样本联合推断（遍历数组前 50 项、保留空数组合并 `items`、支持 `nullable` 与 `oneOf` 异构联合、识别 Emoji/Unicode 编码特征）。
4. **受治理锁保护的外部上游 Replay 磁带与流式 `TTFT` 门禁（`src/replay/cassette.mjs` + `src/perf/streaming.mjs`）**：
   - 将 `corpus/**` 与 `fixtures/upstream-cassettes/**` 纳入 `DEFAULT_CONFIG_PROTECTED_GLOBS`，要求由人类在本地终端执行 `governance approve` 封签。
   - `AITEST-G114` 继续 100% 硬阻断针对相对路径、`TEST_BASE_URL` 与回环地址的 `route.fulfill(2xx)`，仅放行明确指向受锁 `replayAllowedUpstreamHosts`（严格禁止回环与通配符）且未伪造被断言状态码的外部上游回放。
   - 扩展 `perf`（`--mode sse`、`--sse-endpoint`）与 `perf-budget.json#streaming`，提供 `ttftMedianMs`、`ttftP95Ms`、`streamTotalP95Ms` 与干净终止率硬门禁。

---

## 3. MCP 工具面与 CLI 边界收敛（`16 -> 17`）

遵循 [ADR-0005](./0005-mcp-surface-outcome-and-config.md) 的克制收敛原则：

1. 权威 MCP 工具面仅增量注册 **1 个**新工具 **`aitest_parity`**（总计 `17` 个权威工具），其余能力内聚融入既有 `aitest_verify_change`（新增 `mode="parity"` 与 `baselineUrl`）、`aitest_diagnose`（输出 `clusters[]`）与 `aitest_perf`（新增 `mode="sse"` 与 `sseEndpoint`）。
2. 离线语料导入保留为本地 CLI 子命令 `corpus`（写入受治理锁保护的 `qa/corpus/sanitized-requests.jsonl`，需人类审批封签），绝不削弱人类审批边界。
3. 所有新增源码模块严格遵守零运行时第三方依赖、无循环四层依赖、`strict: true` `checkJs` 零错误与单文件 `<= 435` 行硬约束，`src/kernel/diff-oracle.mjs` 与 `src/core/stream-sse.mjs` 经 `npm run sync:vendor` 确定性镜像至模板。

---

## 4. 安全边界与向后兼容

1. **双端默认拒绝防火墙**：`parity` 与 `verify-change --mode parity` 对 `baselineUrl` 和 `candidateUrl` 双端强制执行 `evaluateTargetSafety` 与 10 跳 `maxRedirects: 0` 逐跳出站校验，任一端命中生产环境或未授权域名立即返回 `blocked`（退出码 `2`）。
2. **完全向后兼容**：所有新增配置字段（`parity`、`replayAllowedUpstreamHosts`、`perf-budget.json#streaming`）与输出字段（`clusters`、`paritySummary`、`sseBenchmark`）均为纯增量可选，未启用时存量工作流行为 100% 保持不变。
