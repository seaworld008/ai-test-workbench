<div align="center">

# 🛡️ AI Test Workbench (`v5.0`)

**AI 编码 Agent 的独立可信验证内核、原生多协议 MCP 服务端与活体代码知识图谱**

支持 **一键变更判决 (`verify_change` · in-toto v1 + T0/T1/T2 信任分级)** · **四层 fail-closed AST 防假绿门禁 (`S0–S5` + `AITEST-G101..G115`)** · **原生 MCP v2 (`stdio` / `/mcp` / `/sse` · 21 Tools · 异步 Jobs)** · **防篡改自愈状态机** · **Import-Graph 精准回归** · **真实 `PerformanceObserver` Web Vitals**

[English README](./README.en.md) · [四层门禁与治理指南](./docs/governance.md) · [v5.0 验证评分卡](./docs/review/v5-verification-scorecard.md) · [AI Agent 快速上手](./docs/ai-agent-quickstart.md) · [AGENTS.md](./AGENTS.md) · [架构与安全边界](./ARCHITECTURE.md) · [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [更新日志](./CHANGELOG.md)

[![CI](https://img.shields.io/github/actions/workflow/status/seaworld008/ai-test-workbench/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/seaworld008/ai-test-workbench/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/seaworld008/ai-test-workbench?style=flat-square&color=0ea5e9&label=Release)](https://github.com/seaworld008/ai-test-workbench/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](./VERSION.md)
[![Internal Corpus](https://img.shields.io/badge/Gate%20Corpus-Internal%20%2B%20Red--Team%20Holdout-16a34a?style=flat-square)](./docs/review/v5-verification-scorecard.md)
[![Gate FPR Pilot](https://img.shields.io/badge/Gate%20FPR%20(real--world%20pilot%2C%20n%3D50)-20.8%25%20%5B11.7%25--34.3%25%5D-d97706?style=flat-square)](./bench/real-world/results/SUMMARY.md)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05%20..%202025--11--25+-0284c7?style=flat-square)](./skills/ai-test-workbench/references/mcp-server-protocol.md)
[![Playwright](https://img.shields.io/badge/Playwright-1.65.1-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)

</div>

---

## ✨ 为什么升级到 AI Test Workbench v5.0？

当 Claude Code、Codex CLI、Antigravity、Cursor、VS Code Copilot、Gemini CLI 大幅提速编码后，最大的工程风险不再是“写不出测试”，而是 **“测试结果不可信（假绿）”**：
1. **AI 自愈作弊套路极深**：把精确断言 `toHaveText('49/50')` 偷偷换成 `toBeVisible()` 或 `expect(true).toBe(true)`、加 `test.fail()`、`.catch(() => null)`、`expect.soft()`、改 `playwright.config.ts` 加 `testIgnore`、关掉 ESLint 规则，甚至拿上次绿色的旧 `results.json` 交差。
2. **治理规则仅停留在提示词里**：缺少防篡改锁与状态机强执，Agent 容易把真实后端 `500` 缺陷当成脚本问题强行“修绿”。
3. **长耗时工具易超时阻塞**：单把全局锁阻塞只读查询，缺少进度心跳与子进程树取消信号。
4. **性能与安全存在盲区**：传统 `getEntriesByType` 测不出真实 `LCP/CLS`；探索爬虫默认放行写请求或漏脱敏 JSON 密码与 JWT。

**AI Test Workbench v5.0** 将定位彻底收敛为 **“AI 编码 Agent 的独立可信验证内核（Trustworthy Verification Kernel）”**——不比谁“修得多”，只确保每一次绿灯 **“修得可信”**：

| 北极星可信度指标 | 本机可复现基准实测 (`npm run bench`，标明语料范围) | 核心保障机制 |
|---|---|---|
| **假绿逃逸率 (`FGER-internal` / `FGER-holdout`)** | 内部回归语料 **`0.0%` (`26/26`)** · 红队留出集 **`0.0%` (`24/24`)** | 四层 fail-closed AST 门禁 (`AITEST-G101..G115`) + T1 MAC 治理锁 |
| **良性重构误报率 (`Gate FPR`, 内部良性语料)** | 内部良性重构语料 **`0.0%`**（零误拦 Prettier 换行 / 合法抽提 / ARIA 合并） | TypeScript Compiler API 全文件 AST 比对 |
| **Gate FPR (real-world pilot, n=50)** | 审核后误报率 **`20.8%` (`10/48` 正常提交，Wilson 95% CI `[11.7%, 34.3%]`)** · 原始告警率 `24.0%` (`12/50`，CI `[14.3%, 37.4%]`，含 `2` 个真报) · **`>=200` 正式评测：`pending`（不外推）** | 5 个宽松许可开源仓离线静态/AST 试跑（`seed=20261124`），见 [预登记方案](./bench/real-world/PREREGISTRATION.md) 与 [试跑汇总](./bench/real-world/results/SUMMARY.md) |
| **自治红队假绿逃逸率 (`FGER-agentic`)** | **`design only`（尚未实现，无评测数值）** | 威胁模型、4 类攻击与 T2 关系见 [红队设计文档](./bench/agentic/DESIGN.md) |
| **种子缺陷检出率 (`SDDR`)** | 单应用靶场 **`100.0%` (`7/7`)** | 零依赖 JSON Schema 契约校验 + RBAC/并发竞态 + WCAG 2.1/2.2 |
| **诊断分类准确率 / C→A 误判率 / 误修率** | 内部语料 + 真实 Playwright 堆栈 **`100%` · C→A `0.0%` · 误修率 `0.0%`** | 结构化运行时守卫 + C 优先于 A 值断言规则 + 防篡改自愈状态机 |
| **凭据脱敏召回率** | 内部对抗语料 **`100.0%` (`35/35`)** | Redaction v2（结构化先解析后脱敏，保留内部 `heal_*`/`job_*` ID） |
| **判决信任分级 (`T0 / T1 / T2`)** | **T0** = 未经验证的本地运行 · **T1** = 本地 Run Ledger + MAC（证明完整性，不证明来源）· **T2** = 在 GitHub 托管的 runner 上从干净 checkout 重跑，用 Sigstore 免密钥签名，并且校验通过签发者身份 | **只有 T2 是合入级绿灯**；详见 [可复用工作流示例](./examples/workflows/use-aitest-verify.yml) 与 `attest verify` |

### 🔒 信任分级与 CI 可复用工作流（仅 T2 为合入级绿灯）

- **T0**：未经验证的本地运行（非合入级绿灯）。
- **T1**：本地 Run Ledger + MAC（证明完整性，不证明来源；非合入级绿灯）。
- **T2**：在 GitHub 托管的 runner 上从干净 checkout 重跑，用 Sigstore 免密钥签名，并且校验通过签发者身份。**只有 T2 是合入级绿灯**。

在业务仓库一行接入 T2 可复用工作流（详见 [examples/workflows/use-aitest-verify.yml](./examples/workflows/use-aitest-verify.yml)）：

```yaml
jobs:
  aitest-t2-verdict:
    uses: seaworld008/ai-test-workbench/.github/workflows/aitest-verify.yml@v5.1.1
    permissions:
      id-token: write
      attestations: write
      contents: read
      security-events: write
    with:
      qa-dir: qa
      suite: impact
      node-version: '22'
      signer: github-attest # 默认值；可选 cosign
```

离线校验 T2 证书身份与防篡改（默认 fail-closed，缺签名 / 仅 T1 / 身份不符 / 改 1 字节一律非 0 退出且 `trustLevel <= T1`）：

```bash
npx ai-test-workbench@5.1.1 attest verify \
  --file attestation.json \
  --bundle attestation.sigstore.json \
  --expect-repo owner/repo \
  --expect-workflow .github/workflows/aitest-verify.yml \
  --expect-ref refs/heads/main
```

> **私有仓库签名方式说明**：默认 `signer: github-attest` 使用 GitHub Artifact Attestations（`actions/attest`），私有仓库需 **GitHub Enterprise Cloud**；若切换 `signer: cosign`，公共 Sigstore 会将仓库与工作流身份写入**公开透明日志（Rekor）**，私有项目须自行评估后再决定是否启用。

---

## 🏗️ v5.0 可信验证内核架构

```mermaid
flowchart TB
    subgraph AGENT["AI Agent 原生接入层 (Claude Code / Codex / Cursor / Copilot / Gemini / Antigravity)"]
        A1["stdio · Streamable HTTP (/mcp) · Legacy SSE (/sse)"]
        A2["MCP v2 执行器: 21 Tools · 子进程隔离 · progressToken 进度流 · 进程树取消"]
    end

    subgraph BRAIN["默认禁写探索 · 活体代码地图 v4 · 反向依赖精选"]
        K1["aitest_explore: 仅放行 GET/HEAD/OPTIONS · 禁 sendBeacon · 输出 specs/pages/*.md"]
        K2["aitest_map_sync & aitest_impact: 保留 :id/[id] 动态路由 · 反向 import 图精准选测"]
        K1 --> K2
    end

    subgraph KERNEL["四层可信 AST 防假绿门禁内核 (support/gate/*) & 一键终审"]
        G0["Layer 0: fail-closed .aitest/governance.lock (T1 MAC · 人类专属 CLI approve)"]
        G1["Layer 1: tsc --noEmit + eslint-plugin-playwright (禁裸 request / fetch / test.fail)"]
        G2["Layer 2: T1 签名 ULID Run Ledger 源码输入指纹 + 严格豁免/隔离校验"]
        G3["Layer 3: TypeScript AST S0–S5 断言强度格全文件语义 Diff 守卫 (AITEST-G101..G115)"]
        G0 --> G1 --> G2 --> G3
    end

    subgraph VERDICT["防篡改自愈 · 真实 Web Vitals · in-toto v1 判决证书"]
        V1["aitest_heal_begin/attempt/conclude: 硬阻断 B/C/D · 跨会话 3 轮上限 · C 类缺陷单"]
        V2["aitest_perf: PerformanceObserver LCP/CLS/INP (Median+P75) + 出站守卫 API SLO"]
        V3["aitest_verify_change: T0/T1/T2 三态判决 + in-toto attestation.json + SARIF"]
    end

    AGENT --> BRAIN --> KERNEL --> VERDICT
```

---

## 🚀 30 秒接入 AI Agent（零运行时第三方依赖）

### 方式一：一键注册原生 MCP Server（锁版本或本地源码直连）

> **CLI 命令与供应链安全**：可使用锁版本 `npx ai-test-workbench@5.1.1 <cmd>`、全局安装后的短命令 `aitw <cmd>`（`npm i -g ai-test-workbench@5.1.1`），或本地源码直连 `node tools/aitest.mjs <cmd>`；请始终锁定精确版本号，避免无锁版本拉取。

- **Claude Code**：
  ```bash
  claude mcp add ai-test-workbench -- node /path/to/ai-test-workbench/tools/aitest.mjs mcp-serve --workspace-root /path/to/your-repo
  ```
- **Codex CLI**（`.codex/config.toml`）：
  ```toml
  [mcp_servers.ai-test-workbench]
  command = "npx"
  args = ["--package=ai-test-workbench@5.1.1", "ai-test-workbench", "mcp-serve"]
  ```
- **Cursor / Windsurf / Antigravity / Gemini CLI**（`.mcp.json`）：
  ```json
  {
    "mcpServers": {
      "ai-test-workbench": {
        "command": "npx",
        "args": ["--package=ai-test-workbench@5.1.1", "ai-test-workbench", "mcp-serve"]
      }
    }
  }
  ```
- **Streamable HTTP (`/mcp`) + Legacy SSE (`/sse`) 远程服务模式**：
  ```bash
  node tools/aitest.mjs mcp-serve --transport http --port 3847 --target /path/to/your-repo --workspace-root /path/to/your-repo
  ```

### 官方 MCP 协议合规性与三传输互操作验证

- **零运行时依赖决策**：根包 `package.json` 保持零运行时 `dependencies`，不发布额外的 SDK 封装包；详细决策与重新评估触发条件（合规缺口、OAuth / Elicitation / Tasks 等）见 [ADR：MCP 协议层零依赖](./docs/adr/mcp-zero-dependency.md)。
- **已通过官方 conformance 套件（`@modelcontextprotocol/conformance@0.1.16`）与官方 SDK 客户端（`@modelcontextprotocol/sdk@1.32.2`）验证**（隔离于 `conformance/`，不随 npm 包发布，由 CI `mcp-conformance` job 强制回归）：
  - **官方 `conformance server`（Streamable HTTP `/mcp`，`active` 套件 30 场景）**：`8/8` 协议通用场景全部通过（`server-initialize`、`logging-set-level`、`ping`、`tools-list`、`server-sse-multiple-streams`、`resources-list`、`prompts-list`、`dns-rebinding-protection`，共 `9/9` checks 通过）；`22` 项已登记于 [`conformance/expected-failures.json`](./conformance/expected-failures.json)（3 项未声明的可选能力、4 项按 ADR-001 暂缓的 Sampling/Elicitation 能力、15 项上游 Everything Server 硬编码 `test_*` 夹具名场景），**`0` 项未登记失败、`0` 项过时基线**（注：官方 `conformance server` 仅支持 HTTP）。
  - **官方 `@modelcontextprotocol/sdk@1.32.2` 参考 `Client`（`5/5` 通过）**：覆盖 **`stdio`**、**Streamable HTTP (`/mcp`)** 与 **Legacy SSE (`/sse` + `/messages`)** 三种传输，实测验证 `2024-11-05` 至 `2025-11-25` 协议版本协商、`tools/list` 精确 21 个工具与合法 JSON Schema、只读 `tools/call`（`aitest_doctor` / `aitest_mcp_hub`）返回 `structuredContent`、`notifications/progress` 实时进度通知与 `AbortController` 取消请求（`notifications/cancelled`）。
  - 本机复现：`cd conformance && npm ci && npm test`。

### 方式二：复制即用的首次提示词

> ```text
> 请使用 ai-test-workbench MCP 工具为当前仓库建立可信自动化测试闭环：
> 1. 调用 aitest_doctor 检查 Node >= 22.12、Chromium 与 Gate Kernel 状态；
> 2. 先传 dryRun=true 调用 aitest_init 预览，再正式初始化 qa/ 与 governance.lock；
> 3. 调用 aitest_verify_change(base="origin/main") 跑通一键可信验证并生成 in-toto attestation.json（默认自动解析 merge-base，绝不跳过已提交变更）；
> 4. 调用 aitest_map_sync 构建活体代码地图，严格区分「本机工作台验收 (T0/T1)」与「CI 签名业务 E2E 验收 (T2)」向我汇报。
> ```

---

## 💻 CLI 极速工作流与本地基准复现

### 环境要求
- **Node.js**：`>= 22.12.0`（推荐 **Node 24 LTS** 或 **Node 26 LTS**）
- **操作系统**：Windows 11 PowerShell (`pwsh`)、macOS、Linux

### 标准业务接入与一键终审

```bash
# 1. 体检与幂等初始化（自动创建 <repo>/qa/.aitest/governance.lock）
npx ai-test-workbench@5.1.1 doctor
npx ai-test-workbench@5.1.1 init --name my-app --target "/path/to/your-repo" --loop codex

# 2. 登录态捕获 -> 0→1 默认禁写探索 -> 活体代码地图 v4 -> 锁版本全链路 MCP
npx ai-test-workbench@5.1.1 auth-login --target "/path/to/your-repo" --base-url https://staging.example.internal
npx ai-test-workbench@5.1.1 explore --target "/path/to/your-repo" --base-url https://staging.example.internal --max-pages 30
npx ai-test-workbench@5.1.1 map --target "/path/to/your-repo"
npx ai-test-workbench@5.1.1 mcp add --target "/path/to/your-repo" --profile full-link && npx ai-test-workbench@5.1.1 mcp doctor --target "/path/to/your-repo" --lock

# 3. 性能 SLO 评测与提交前一键可信变更判决（产出 attestation + SARIF）
npx ai-test-workbench@5.1.1 perf --target "/path/to/your-repo" --concurrency 4 --iterations 12 --enforce-budget
npx ai-test-workbench@5.1.1 verify-change --target "/path/to/your-repo" --base origin/main
```

### 本机全量自检与公开基准复现（零外部服务器）

```bash
git clone https://github.com/seaworld008/ai-test-workbench.git
cd ai-test-workbench
cd templates/playwright-qa && npm ci && npx playwright install chromium && cd ../..

npm run lint:docs
npm run typecheck
npm test
npm run smoke
npm run demo:verify
npm run bench
```

---

## 🧰 完整 CLI 命令与 21 个 MCP 工具矩阵

| CLI 命令 | 对应 MCP 工具 | 核心职责与可信治理能力 |
|---|---|---|
| `verify-change` | `aitest_verify_change` | **一键终审闭环**：治理锁 → 反向依赖选测 → 账本运行 → 四层门禁 → 产出 `attestation.json` & `verdict.sarif.json` |
| `doctor` | `aitest_doctor` | 探测 Node/npm、Git、Codex/Claude、Chromium 缓存与 Gate Kernel 版本一致性 |
| `init` | `aitest_init` | 幂等初始化 `<repo>/qa` 并签发初始 `.aitest/governance.lock` |
| `governance` | *(人类专属 CLI)* | `verify \| status \| approve`；全部治理锁操作**仅限人类本地 CLI 执行，永不暴露给 MCP** |
| `attest` | *(CLI 验签命令)* | `attest verify --file <attestation.json>` 离线验证 in-toto Statement v1 证书与 SHA-256 绑定 |
| `auth-login` | *(交互式 CLI)* | 有头浏览器人工完成短信验证码 / SSO（绝不绕过门禁），`0o600` 权限保存会话状态 |
| `explore` | `aitest_explore` | 默认禁写 0→1 探索（禁 POST/变更/sendBeacon/WS），产出 `system-overview.md` 与 `<untrusted-data>` 脱敏 `specs/pages/*.md` |
| `map` | `aitest_map_sync` | 融合静态/动态路由（`:id`/`[id]`）、Controller、DB 表并自动收敛历史缺陷（Schema v4） |
| `impact` | `aitest_impact` | 基于 Git Diff + 静态 `import` 反向依赖图精选传递受影响测试并附 `why` 证据链（映射缺口自动降级全量） |
| `run` | `aitest_run` | 运行确定性套件并写入 T1 签名 ULID `Run Ledger`，注入/捕获 W3C `Trace-ID` |
| `audit` | `aitest_audit` | fail-closed 四层 AST 门禁：`governance.lock` + `tsc/eslint` + `Run Ledger/waivers` + `S0–S5` AST Diff 守卫 (`AITEST-G101..G115`) |
| `heal` | `aitest_heal_begin` / `attempt` / `conclude` | 防篡改自愈状态机：B/C/D 类硬阻断改测试（`0%` 误修率），跨会话 A 类限 3 轮，C 类自动产缺陷工单 |
| `diagnose` | `aitest_diagnose` | 结构化守卫 + C 优先于 A 规则定责、Redaction v2 脱敏与可观测查询生成 |
| `perf` | `aitest_perf` | 预注入 `PerformanceObserver` 采集真实 `LCP/CLS/INP`（Median+P75）与并发 GET API P95/RPS |
| `trace-matrix` | `aitest_trace_matrix` | 审计 `specs/*.md` ↔ `tests/**/*.spec.ts` ↔ 运行结果的 `REQ-xxx` 需求追溯覆盖率 |
| `flaky` | `aitest_flaky_report` | 统计近 20 次运行历史抖动率与 `.aitest/quarantine.json`（`<= 7 天` TTL + 真实抖动证据）隔离状态 |
| `mcp` | `aitest_mcp_hub` | 7 大支柱锁版本 MCP 配置、`.aitest/mcp.lock` 哈希漂移与提示词投毒审计 |
| `mcp-serve` | `aitest_job_status` / `result` / `cancel` | 启动全协议 MCP v2 服务端，支持子进程异步后台作业状态查询、结果拉取与进程树强杀 |
| `report` | `aitest_report` | 索引 HTML、JUnit、JSON、Attestation、SARIF、全景图、代码地图与 `.zip` Trace |
| `update-agents` | *(CLI 同步命令)* | 基于 SHA-256 清单安全更新官方 Test Agents，保护手改文件 |
| `skill-install` | `aitest_skill_install` | 安装标准 `SKILL.md` 到 `.codex` / `.claude` / `.gemini` / `.github` / `.agents` / `qa` |

---

## 📚 全站双语文档导航（默认中文，均配英文 `.en.md`）

| 文档主题 | 简体中文（默认） | English |
|---|---|---|
| **四层防假绿门禁与治理指南 (v5.0)** | [docs/governance.md](./docs/governance.md) | [docs/governance.en.md](./docs/governance.en.md) |
| **v5.0 验证评分卡与公开基准** | [scorecard](./docs/review/v5-verification-scorecard.md) · [真实提交 FPR 预登记](./bench/real-world/PREREGISTRATION.md) · [试跑汇总 (n=50)](./bench/real-world/results/SUMMARY.md) · [FGER-agentic 设计](./bench/agentic/DESIGN.md) | [scorecard.en](./docs/review/v5-verification-scorecard.en.md) · [FPR Pre-Reg (EN)](./bench/real-world/PREREGISTRATION.en.md) · [Pilot Summary (EN)](./bench/real-world/results/SUMMARY.en.md) · [Agentic Design (EN)](./bench/agentic/DESIGN.en.md) |
| **架构决策记录 (ADR)** | [MCP 协议层零依赖](./docs/adr/mcp-zero-dependency.md) · [ADR-0001 内核演进](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) | [MCP Zero-Dep ADR (EN)](./docs/adr/mcp-zero-dependency.en.md) · [ADR-0001 (EN)](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) |
| **AI Agent 快速上手与规范** | [quickstart](./docs/ai-agent-quickstart.md) · [AGENTS.md](./AGENTS.md) · [CLAUDE.md](./CLAUDE.md) · [llms.txt](./llms.txt) | [quickstart.en](./docs/ai-agent-quickstart.en.md) · [AGENTS.en.md](./AGENTS.en.md) |
| **系统架构、版本矩阵与蓝图** | [ARCHITECTURE.md](./ARCHITECTURE.md) · [VERSION.md](./VERSION.md) · [架构蓝图](./Playwright%20Test%20Agents%20+%20Codex%20%E5%8F%AF%E5%A4%8D%E7%94%A8%E6%9C%AC%E6%9C%BA%20AI%20%E8%87%AA%E5%8A%A8%E5%8C%96%E6%B5%8B%E8%AF%95%E5%B7%A5%E4%BD%9C%E5%8F%B0%E2%80%94%E2%80%94%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1%E4%B8%8E%E5%AE%9E%E6%96%BD%E6%8F%90%E7%A4%BA%E8%AF%8D.md) | [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) · [VERSION.en.md](./VERSION.en.md) · [Blueprint (EN)](./docs/architecture-and-prompts-blueprint.en.md) |
| **适配 / 安全 / 排查 / 升级 / 靶场** | [adapter](./docs/project-adapter.md) · [security](./docs/security.md) · [troubleshooting](./docs/troubleshooting.md) · [upgrade](./docs/upgrade.md) · [demo](./examples/demo-webapp/README.md) | [adapter.en](./docs/project-adapter.en.md) · [security.en](./docs/security.en.md) · [troubleshooting.en](./docs/troubleshooting.en.md) · [upgrade.en](./docs/upgrade.en.md) · [demo.en](./examples/demo-webapp/README.en.md) |
| **社区规范与安全策略** | [CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | [CONTRIBUTING.en.md](./CONTRIBUTING.en.md) · [SECURITY.en.md](./SECURITY.en.md) · [CODE_OF_CONDUCT.en.md](./CODE_OF_CONDUCT.en.md) |

## 📄 License

[MIT License](./LICENSE)
