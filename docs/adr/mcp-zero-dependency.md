# ADR-001：MCP 协议层保持零运行时依赖并以官方合规测试保障互操作性

> [English Version](./mcp-zero-dependency.en.md) · [架构总览](../../ARCHITECTURE.md) · [主文档 README](../../README.md)

- **状态**：已采纳（Accepted）
- **决策日期**：2026-11-24
- **适用范围**：`ai-test-workbench` 根包（`package.json`）及 `src/mcp/` 协议与传输层实现

---

## 1. 背景（Context）

`ai-test-workbench` 是一个面向 AI 编程 Agent（Codex / Claude Code / Gemini CLI / Cursor / VS Code 等）的独立可信验证内核与多协议 MCP 服务端，提供 `stdio`、Streamable HTTP (`/mcp`) 与 Legacy SSE (`/sse` + `/messages`) 三种传输方式，并暴露 21 个强类型工具、Resources 与 Prompts。

在 v5 架构评审中，关于 MCP 协议层的演进存在两种方案：

1. **方案 A（零运行时依赖 + 隔离合规测试）**：根包继续保持零运行时依赖（`dependencies` 为空），保留自研轻量协议层（`src/mcp/`），不发布单独封装 `@modelcontextprotocol/sdk` 的派生包；同时在仓库内建立与发布包隔离的 `conformance/` 目录，锁定官方 `@modelcontextprotocol/conformance` 套件与 `@modelcontextprotocol/sdk` 参考客户端作为 CI 强制回归门禁。
2. **方案 B（引入官方 SDK 或额外发布封装包）**：在根包引入 `@modelcontextprotocol/sdk` 作为运行时依赖，或另行维护一个基于官方 SDK 的平行封装包。

---

## 2. 决策（Decision）

**采纳方案 A**：

1. **根包保持零运行时依赖**：`package.json` 不声明任何运行时 `dependencies`，也不发布额外的 SDK 封装包，避免维护双轨实现、依赖树膨胀与供应链攻击面扩大。
2. **以官方工具链做客观互操作门禁**：在仓库内设立独立的 `conformance/` 目录（不纳入 `package.json#files`，不会随 `npm publish` 下发给用户），锁定以下 `devDependencies`：
   - `@modelcontextprotocol/conformance`（官方 MCP 一致性测试套件）
   - `@modelcontextprotocol/sdk`（仅作为测试端参考 `Client`，跨 `stdio`、Streamable HTTP 与 Legacy SSE 校验协议握手、工具发现、结构化输出、进度通知与取消语义）
3. **透明跟踪已知缺口**：官方一致性套件中的已知未支持场景（如有）必须显式登记在 `conformance/expected-failures.json` 中，且每一项必须注明原因与追踪 Issue 链接；任何未登记的失败都会使 CI `mcp-conformance` job 红灯失败。

---

## 3. 决策依据（Rationale）

- **零依赖交付与供应链最小化**：`ai-test-workbench` 的核心定位是“可信验证内核”。零运行时依赖意味着用户通过 `npx ai-test-workbench@5.1.1 ...` 或在 CI runner 中运行时，无需拉取数十个传递依赖，大幅降低供应链投毒风险与冷启动时间。
- **能力边界高度清晰**：本工作台当前仅使用 MCP 的核心稳定子集——`initialize` 版本协商（`2024-11-05` 至 `2025-11-25`）、`ping`、`logging/setLevel`、`tools/list`、`tools/call`（含 `structuredContent`）、`resources/*`、`prompts/*`、`notifications/progress` 与 `notifications/cancelled`。该子集规范清晰，且由模块化代码（`protocol.mjs`、`registry.mjs`、`resources.mjs`、`security.mjs`、`transport-http.mjs`、`transport-stdio.mjs`）清晰分层。
- **避免维护双轨分叉**：维护独立的 SDK 封装包会带来双份工具注册表、安全边界（Workspace Root 交集、DNS Rebinding 防护、常量时间 Bearer 校验、子进程进程树取消）与文档同步成本。
- **可证伪的互操作保障**：过去仅靠自研单测容易陷入“自写自测”盲区；引入官方 `@modelcontextprotocol/conformance` 与官方 `@modelcontextprotocol/sdk` 客户端后，协议合规性由上游规范测试而非主观判断决定。

---

## 4. 权衡与后果（Consequences）

### 正面影响
- 发布的 npm tarball 保持极小体积与零第三方运行时依赖。
- 所有安全护栏（路径越界拦截、Origin 校验、Session LRU 与 TTL、子进程树级取消）与协议层紧耦合但无黑盒框架抽象开销。
- CI 中的 `mcp-conformance` job 会在每次 PR 上同时运行官方 conformance 套件与官方 SDK 客户端三传输端到端验证。

### 负面影响与缓解措施
- MCP 规范新增特性不会通过升级 SDK 自动获得，必须人工跟进实现。
- **缓解**：通过锁版本定期更新 `conformance/` 中的官方测试套件，任何协议回归或偏离都会在 CI 中立即暴露。

---

## 5. 触发重新评估的条件（Re-evaluation Triggers）

一旦出现以下任一条件，必须正式重新评估本 ADR，考虑在根包引入 `@modelcontextprotocol/sdk` 或拆分适配层：

1. **长期无法修复的合规测试缺口**：官方 `@modelcontextprotocol/conformance` 核心必选场景出现持续超过两个发布周期无法低成本修复的失败项，或 `conformance/expected-failures.json` 中非可选能力的缺口不断增长。
2. **需要重型新协议能力**：产品路线图明确要求支持以下任意一项高复杂度 MCP 扩展能力时，不再自行从零实现：
   - **MCP OAuth 2.1 / Protected Resource Metadata 授权流**（动态客户端注册、PKCE、Token 刷新与多租户鉴权）
   - **Elicitation（交互式服务端向客户端表单追问）**
   - **MCP Tasks（规范原生异步长任务协议，取代或桥接当前自定义 `aitest_job_*` 工具）**
   - **Sampling / 双向服务端发起请求与复杂流式 Resumability（`Last-Event-ID` 断点续传重放）**
3. **主流客户端兼容性成本飙升**：当 Codex、Claude Code、VS Code、Cursor 等主流宿主升级传输层导致自研层维护工时超过验证内核本身研发投入时。
