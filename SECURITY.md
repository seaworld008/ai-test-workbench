# 安全策略与测试目标防护 (`SECURITY.md`)

> [English Version](./SECURITY.en.md) · [安全与防注入深潜指南](./docs/security.md)

## 漏洞上报

如你在 `ai-test-workbench` 中发现安全漏洞（例如 CLI/MCP 子进程参数注入、诊断日志脱敏遗漏、MCP HTTP Origin/Token 校验绕过或目标域名白名单绕过），请**不要**在公开 Issue 中直接披露利用细节。请通过 GitHub Security Advisories 私有联系维护者，附上受影响版本、复现步骤及修复建议。

## 内置默认拒绝安全边界

1. **禁止面向生产环境**：`TEST_ENV=production|prod|live|online` 与通配符域名在配置加载与执行阶段会被直接阻断；`TEST_BASE_URL` 必须匹配 `TEST_ALLOWED_HOSTS`；`TEST_DENIED_ORIGINS` 在加载阶段与 `page.route` 双重生效。
2. **写操作防护 (`TEST_ALLOW_MUTATION`)**：`explore` 与默认回归禁止破坏性写操作，`TEST_BLOCKED_ENDPOINTS` 同时约束浏览器流量与 `APIRequestContext`。
3. **MCP HTTP 安全边界**：`npx ai-test-workbench@6.2.1 mcp-serve --transport http` 默认仅绑定 `127.0.0.1` 并严格校验 `Origin` 防止 DNS 重绑定（`403`）；绑定非回环地址时强制要求 `--auth-token` / `AITEST_MCP_TOKEN` Bearer 鉴权（`401`）。
4. **凭据与资产脱敏**：`.env` 与 `playwright/.auth/` 均被 Git 忽略；诊断与 MCP 返回结果经过 `redactSecrets` 自动脱敏，且禁止使用 shell 字符串拼接。
