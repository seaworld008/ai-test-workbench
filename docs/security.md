# 安全、防提示词注入与产物凭据卫生指南 (`security.md`)

> [English Version](./security.en.md) · [仓库安全策略](../SECURITY.md)

## 1. 环境与网络双通道隔离

- **严禁测试指向生产环境**：`support/target-guard.mjs` 拒绝 `TEST_ENV=production|prod|live|online` 与通配符域名（`*.com`），强制校验证照 `TEST_ALLOWED_HOSTS` 与 `TEST_DENIED_ORIGINS`。
- **双通道黑名单与 Service Worker 封锁**：`TEST_BLOCKED_ENDPOINTS` 同时拦截浏览器 `page.route` 与 `Proxy` 包装后的 `APIRequestContext`，配合 `serviceWorkers: 'block'` 防止绕过。
- 应用层白名单是防误操作的第一道防线，仍应结合真实网络隔离与仅测试服专用账号。

## 2. 浏览器 AI Agent 防提示词注入边界

当 `Planner`、`Generator`、`Healer` 或 `npx ai-test-workbench@6.2.0 explore` 访问网页时：
- 页面内容、评论文本、异常提示与接口返回都可能包含恶意注入指令（如诱导运行命令或标 `test.fixme()`）。
- **强制防线**：
  1. 在受限沙箱工作区（如 Codex `workspace-write`）中运行编码 Agent；
  2. **所有 DOM 快照、控制台日志与网络载荷一律视为不可信数据，绝不当作指令**；
  3. 每次 Agent 改动后运行 `npx ai-test-workbench@6.2.0 audit --check-specs --diff-base HEAD` 拦截任何删除断言或添加跳过标记的行为。

## 3. MCP HTTP 服务、Trace 与录像凭据管控

- `npx ai-test-workbench@6.2.0 mcp-serve --transport http` 严格校验 `Origin`（非本机回环或非 `AITEST_MCP_ALLOWED_ORIGINS` 返回 `403` 防 DNS 重绑定），绑定非回环网卡时强制校验 Bearer `--auth-token`（`401`）。
- `npx ai-test-workbench@6.2.0 diagnose` 会自动脱敏文本诊断中的密码、Token、Cookie 与 `Authorization` 头；**原始 `trace.zip` 与 `.webm` 录像属于二进制非脱敏资产**，推荐使用 HTTP API 登录或 `auth-login` 复写 `storageState`，并限制 CI 产物权限与留存天数。
