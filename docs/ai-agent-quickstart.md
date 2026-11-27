# AI Test Workbench — AI Agent 优先接入与首次使用指南 (v6.4.0)

> [English Version](./ai-agent-quickstart.en.md) · [中文操作规范 AGENTS.md](../AGENTS.md) · [MCP 协议参考](../skills/ai-test-workbench/references/mcp-server-protocol.md)

`ai-test-workbench` v6.4.0 内置 **零依赖原生全协议 MCP 服务端**，兼容所有主流 AI 编码 Agent 与全部 MCP 传输及协议版本：

- **传输模式**：`stdio`（默认）、`Streamable HTTP`（`/mcp`）、`Legacy HTTP+SSE`（`/sse` + `/messages`）。
- **协议协商**：完整支持 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。
- **结构化返参**：全部 **17 个权威工具**（含新增双目标差分先知 `aitest_parity` 及 `aitest_report(view="lessons")` 经验与阻塞单只读查询）同时返回人类可读 `content`、机器可校验 `structuredContent`（含 `outputSchema`、`outcome`、`recoverable`、`blockerKind` 与 `nextRecommendedActions`）及 `ToolAnnotations` 安全标注。

---

## 一、第一次使用的复制即用提示词（3 大高频场景）

### 场景 1：首次在任意新/老项目零阻塞启用自动化测试工作台

```text
请通过 ai-test-workbench MCP 工具为当前仓库初始化并验证自动化测试工作台：
1. 调用 `aitest_doctor` 核验 Node >= 22.12 与 Chromium 环境；
2. 本地回环开发项目直接调用 `aitest_bootstrap(target=".")`（或先 `aitest_init(dryRun=true)` 预览再初始化隔离的 `qa/` 子工程与 `aitest.runtime.json`）；
3. 调用 `aitest_explore(target=".", maxPages=20)` 发现页面与 API Schema，再调用 `aitest_verify_change(target=".", mode="impact")` 跑通四层 fail-closed 防假绿基线；
4. 调用 `aitest_map_sync` 生成活体代码知识地图 `knowledge/SYSTEM_MAP.md`，并将本机测试工作台状态与后续业务 E2E 测试计划汇报给我。
```

### 场景 2：面对陌生多租户 SaaS 系统（需人工登录/短信验证码 -> 0 到 1 自动探索建图 -> 深度测试）

```text
请对目标系统执行从 0 到 1 的只读探索与深度测试设计：
1. 如需短信验证码或企业 SSO，请先提醒我在终端运行：
   `npx ai-test-workbench@6.6.0 auth-login --target . --base-url <测试服URL>`
2. 登录态就绪后，调用 `aitest_explore(target=".", baseUrl="<测试服URL>", maxPages=30)`，严格在只读模式下探索全部门户切换器、菜单路由、表格筛选项及异常接口；
3. 调用 `aitest_map_sync` 融合源代码与运行态生成 `knowledge/SYSTEM_MAP.md`，并读取 `system-overview` 与 `system-map` 资源；
4. 在 `qa/specs/` 输出按 P0/P1 分层的深度功能测试计划，覆盖空态 0/1 边界、分页一致性、多租户隔离与已发现问题，严禁把线上/测试服原有缺陷当成正确预期。
```

### 场景 3：接入全链路只读 MCP（可观测/日志/数据库/k6）排查失败与性能瓶颈

```text
请协助接入全链路 MCP 并排查最近一次测试失败与性能问题：
1. 调用 `aitest_mcp_hub(action="add", target=".", profile="full-link")`，再调用 `aitest_mcp_hub(action="doctor", target=".")` 确认所有写入危险项已被阻断且无明文密码；
2. 调用 `aitest_perf(target=".", concurrency=4, iterations=12, enforceBudget=true)` 获取浏览器 CDP Web Vitals（TTFB/FCP/LCP/CLS）与接口 P95/RPS；
3. 调用 `aitest_diagnose(target=".")` 并严格按 A/B/C/D 分类定责（C 类产品缺陷绝不允许标 `test.skip`/`test.fixme` 或删减 `expect()`），结合捕获到的 Trace-ID 联动 Grafana/Loki/Prometheus/Sentry/只读 DB 给出代码级根因。
```

---

## 二、主流 AI Agent 客户端 MCP 安装配置案例

### 1. Claude Code（一键命令或 `.mcp.json`）

```bash
# CLI 一键注册（项目级，推荐本地源码直连或精确锁版本）
claude mcp add ai-test-workbench -- node /path/to/ai-test-workbench/tools/aitest.mjs mcp-serve --workspace-root /path/to/your-repo

# 发布到 npm 后如需通过 npx 拉起，请始终锁定精确版本：
claude mcp add ai-test-workbench -- npx --package=ai-test-workbench@6.6.0 ai-test-workbench mcp-serve --target /path/to/your-repo --workspace-root /path/to/your-repo
```

或直接在项目根目录写入 `.mcp.json`：

```json
{
  "mcpServers": {
    "ai-test-workbench": {
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.6.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

### 2. OpenAI Codex CLI（`~/.codex/config.toml` 或 `.codex/config.toml`）

```toml
[mcp_servers.ai-test-workbench]
command = "npx"
args = ["--package=ai-test-workbench@6.6.0", "ai-test-workbench", "mcp-serve"]
```

*(也可在目标项目直接运行 `node tools/aitest.mjs mcp add --target . --profile minimal`，自动同时写入 `.mcp.json` 与 `.codex/config.toml`。)*

### 3. Cursor / Windsurf / VS Code Copilot / Gemini CLI / Antigravity

- **Cursor** (`.cursor/mcp.json`) / **Claude Desktop** / **Antigravity**:

```json
{
  "mcpServers": {
    "ai-test-workbench": {
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.6.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

- **VS Code GitHub Copilot** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "ai-test-workbench": {
      "type": "stdio",
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.6.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

- **Gemini CLI** (`.gemini/settings.json`):

```json
{
  "mcpServers": {
    "ai-test-workbench": {
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.6.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

### 4. Streamable HTTP（`/mcp`）与兼容旧版 HTTP+SSE（`/sse`）远程/本地服务模式

当需要在 Docker、CI 调试机、Web IDE 或多客户端间共享 MCP 服务时：

```bash
# 启动双协议 HTTP 服务（默认绑定 127.0.0.1:3847，防 DNS 重绑定校验 Origin）
npx ai-test-workbench@6.6.0 mcp-serve --transport http --port 3847 --target /path/to/your-repo

# 如需绑定非回环地址（0.0.0.0），强制要求配置 Bearer Token：
npx ai-test-workbench@6.6.0 mcp-serve --transport http --host 0.0.0.0 --port 3847 --auth-token "$AITEST_MCP_TOKEN"
```

客户端连接配置：

```json
{
  "mcpServers": {
    "ai-test-workbench-http": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer ${AITEST_MCP_TOKEN}"
      }
    },
    "ai-test-workbench-legacy-sse": {
      "type": "sse",
      "url": "http://127.0.0.1:3847/sse"
    }
  }
}
```
