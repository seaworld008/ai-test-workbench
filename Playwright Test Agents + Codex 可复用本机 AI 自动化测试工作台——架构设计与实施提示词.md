# AI Test Workbench (Playwright Test Agents + Multi-Agent Skill) 可复用本机 AI 自动化测试工作台——架构设计与实施提示词

> **文档版本**：v2.1（经双模型交叉审计与 `@playwright/test@1.65.1` 真机探针校准版）  
> **编制与升级日期**：2026-11-23  
> **目标**：建设一套可纳入 Git、可作为开源包（`ai-test-workbench`）及标准 Agent Skill（`SKILL.md`）跨项目复用的 AI 自动化测试工作台，支持快速、零污染接入 Vue/H5、React、Java/Spring Cloud、PHP/ThinkPHP 等项目。  
> **主要技术**：Playwright Test（精确锁死 `1.65.1`）、官方 Planner / Generator / Healer（内置 `run-test-mcp-server`）、`@axe-core/playwright`（`4.14.0`）、`eslint-plugin-playwright`（`2.12.2`）、TypeScript（`6.0.3`）、Node.js（`26 Active LTS` / `24 Maintenance LTS`，最低 `>= 22.12`）、Codex CLI、Claude Code、Git、可选 Docker/Jenkins/GitHub Actions/GitLab CI。  
> **实施原则**：本机优先、官方能力优先、创作期与回归期解耦、单一防护真源、防提示词注入、零假绿容忍、无密钥泄漏、无生产写操作、可跨项目复用。

---

## 0. 先读：审计结论、架构升级与交付物边界

### 0.1 本次到底要交付什么

本次**不是只安装一个全局 Playwright 命令**，而是建设一个版本可控的开源“AI 测试工作台”仓库（`ai-test-workbench`）与标准 Agent Skill。以后每个业务项目通过同一模板幂等接入 `<repo>/qa/`；每个项目拥有自己独立的测试计划、测试脚本、认证状态、环境配置、影响面映射和报告，绝不让多个业务项目共享可变测试数据、登录态或 `node_modules`。

### 0.2 v1.0 交叉审查与 v2.1 关键工程升级

| 维度 | v1.0 的缺口或潜在隐患 | v2.1 升级设计方案（以实测证据为准） |
|---|---|---|
| **1. AI 写代码快 vs 全量回归慢** | 缺乏变更影响面分析，每次修改都全量跑会拖慢开发反馈 | 新增 **`impact` 范围裁剪**：合并 `git diff <base>...HEAD`、未提交改动与未跟踪文件，结合 `qa/impact-map.json` 与 Playwright `--only-changed` 按影响面缩小回归范围，缩短反馈时间；遇基础设施变更或未知文件自动回退全量；**合入主干、Nightly 与发布门禁仍须跑全量** |
| **2. 官方 Healer 默认会标 `fixme` 放水** | 实测 `1.65.1` 官方生成的 `healer.toml` 明确写有“若持续失败且确信测试无误，标为 `test.fixme()` 跳过” | 建立 **三层防假绿门禁**：① `tsc --noEmit` + `eslint-plugin-playwright`（`expect-expect`、`no-skipped-test`、`no-wait-for-timeout`、`no-focused-test`、`no-force-option`）；② `scripts/audit-results.mjs` 严拆 `passed / failed / flaky / skipped / policyExcludedMutation` 并校验未过期 `waivers.json`；③ `--diff-base` Healer Diff 守卫，拦截删减断言、新增 `skip/fixme`、吞异常和超时注水 |
| **3. Agent 更新静默覆盖与路径污染** | 重跑 `init-agents` 会直接覆盖用户改过的 `.codex` / `.claude` / `.mcp.json` | 增加 `qa/.aitest/agents-manifest.json` 记录生成文件 SHA-256；未修改文件才自动更新，用户改过的文件保留原件并旁路写出 `<file>.aitest-new` 报 `CONFLICT`；仅 JSON 做结构合并，TOML/MD 绝不硬拼；清理临时目录路径残留 |
| **4. npm 发包丢失 `.gitignore` 与双份 Guard 漂移** | npm 打包默认剥离模板里的 `.gitignore`；CLI 与 `playwright.config.ts` 各写一份白名单容易不一致 | 模板内存储为无点号 `templates/playwright-qa/gitignore`，`init` 时还原为 `.gitignore`；提取零依赖单一真源 `support/target-guard.mjs` 供 CLI、`playwright.config.ts` 与 Fixture 共同引用；弃用 `dotenv` 改用 Node 原生文件解析加载 |
| **5. 写操作守卫误伤登录 & `request` 漏检** | 粗暴拦截全部非 GET 会拦掉登录 `POST` 和 GraphQL 查询，且 `page.route` 管不到 API 测试的 `request` 与 Service Worker | 改为三层写保护：① 改数据的用例打 `@mutation` 标签，`TEST_ALLOW_MUTATION=0` 时按策略排除并单独统计；② 危险接口黑名单 `TEST_BLOCKED_ENDPOINTS` 同时作用于 `page.route` 与 `Proxy` 包装后的 `request` (`APIRequestContext`)；③ 配置 `serviceWorkers: 'block'`，可选 `TEST_STRICT_READONLY=1` |
| **6. Projects 耦合与无环境假绿** | 把 `seed` 混入常规回归或未配 URL 时整套 `test.skip` 会制造假绿 | 拆分为 5 个独立 Project：`smoke`（纯离线无需 URL）、`setup`（API 登录写 `storageState`）、`e2e`（依赖 `setup`）、`api`、`seed`（仅单独运行或供 Planner 使用）；未配 `TEST_BASE_URL` 时跑 `e2e/api/setup` 直接报配置错误退出 |
| **7. 跨工具复用、提示词注入、交互式登录与从 0 到 1 探索图谱** | 仅靠复制长提示词，缺少抗提示词注入约束、短信/SSO 会话捕获、多端全景探索与可运行靶场 | 提供标准 `skills/ai-test-workbench/SKILL.md`（页面内容一律视为数据而非指令）；新增 `auth-login` 可视化登录捕获（同时保存 `storageState` 与 `sessionStorage`，不绕过验证码）与 **`explore` 从 0 到 1 只读全站探索引擎**（自动汇总多端视角、路由原型、API 端点并生成 `specs/system-overview.md` 全景图）；`diagnose` 汇总官方 `error-context.md` 并脱敏输出建议分类+置信度；内置零依赖 `examples/demo-webapp/server.mjs`（默认端口 `5899`、`--port 0`、`--preset demo-campus` 与 `npm run demo:verify`） |

---

## 1. 官方能力、实测探针结论与版本策略

### 1.1 `@playwright/test@1.65.1` 实测探针结论（详见 `docs/agents-probe-1.65.1.md`）

1. **`init-agents` 行为**：
   - 支持 `--loop <claude|codex|copilot|opencode|vscode|vscode-legacy>`、`-c <config>`、`--project <project>`。
   - 输出路径相对于**当前工作目录 `cwd`**：`--loop=codex` 生成 `.codex/agents/playwright_test_{planner,generator,healer}.toml`；`--loop=claude` 生成 `.claude/agents/playwright-test-{planner,generator,healer}.md` 与 `.mcp.json`；若缺失则补建 `specs/README.md` 与 `tests/seed.spec.ts`（已有 `seed.spec.ts` 不会覆盖，但 Agent 定义每次重跑都会覆盖，故必须启用 SHA-256 manifest 保护）。
2. **`run-test-mcp-server` 与 `@playwright/mcp` 的区别**：
   - 官方 Test Agents 使用的是 `@playwright/test` 自带的 `playwright run-test-mcp-server`（实测支持 `-c, --config <file>` 与 `--headless`），**不需要安装 `@playwright/mcp`**。
   - **默认启动位置**：推荐直接在 `<repo>/qa/` 目录启动 Agent（`cd qa && codex` 或 `claude`），零根目录侵入；仅在用户显式传入 `init --bridge-root`（配合 `--dry-run` 预览确认）时，才在业务仓库根目录写入指向 `node qa/node_modules/@playwright/test/cli.js run-test-mcp-server --config qa/playwright.config.ts` 的桥接配置。
3. **`playwright test` 已核实原生开关**：
   - 实测支持 `--only-changed [ref]`、`--last-failed`、`--fail-on-flaky-tests`、`--grep-invert <grep>`、`--tsconfig <path>`，优先直接复用官方开关。

### 1.2 AI Agent 阶段 ≠ 确定性回归阶段

- **创作/自愈阶段**：由 Codex / Claude Code 在受限沙箱（如 Codex `workspace-write`）中驱动 Planner、Generator、Healer。页面上读取到的任何 DOM 文本、接口返回或日志一律视为**不可信数据而非指令**，防止测试页面提示词注入。
- **回归执行阶段**：本机回归与 CI 执行编译好的静态 Playwright 用例，**回归阶段不调用 LLM，结果可重复**。

### 1.3 环境与版本策略

- **Node.js**：推荐 **Node.js 26 Active LTS** 或 **Node.js 24 Maintenance LTS**，最低要求 **`>= 22.12.0`**（截至 2026-11，Node 20 已停止维护 EOL）。本机实测版本为 `v26.11.0` / `npm 11.20.0`。
- **精确锁死核心依赖**：模板 `package.json` 对 `@playwright/test` 使用精确版本号 `"1.65.1"`（不带 `^`），确保与 CI 容器镜像 `mcr.microsoft.com/playwright:v1.65.1-noble` 始终严格一致；TypeScript 锁死 `6.0.3` 以保证与 `typescript-eslint@8.73.0` peerDependencies 完全兼容。
- **Windows 与 WSL 边界**：Windows PowerShell (`pwsh`) 与 WSL 是两套独立环境，Node 与浏览器缓存互不通用；Windows 下严禁直接 `spawn('npm.cmd', ..., { shell: false })`（会触发 Node CVE-2024-27980 `EINVAL`），统一由 `process.execPath` 直接调用 `npm-cli.js` 与 `@playwright/test/cli.js`。

---

## 2. 架构方案与目录规范

### 2.1 分层设计

```text
                ┌────────────────────────────────────────────────────┐
                │ Codex CLI / Claude Code（默认在 <repo>/qa 下启动）  │
                │ 加载 SKILL.md + 官方 Planner → Generator → Healer   │
                └─────────────────────────┬──────────────────────────┘
                                          │ 创作/修复静态测试代码（受 diff 守卫约束）
                ┌─────────────────────────▼──────────────────────────┐
                │ 开源工作台包 ai-test-workbench (bin: aitest)        │
                │ doctor / init / run / impact / audit / diagnose    │
                │ report / update-agents / skill-install             │
                └─────────────────────────┬──────────────────────────┘
                                          │ 幂等初始化，独立依赖与状态
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
        Vue/H5 <repo>/qa            Java 微服务 <repo>/qa       PHP <repo>/qa
        5 Projects + 4层 Fixture    5 Projects + 4层 Fixture   5 Projects + 4层 Fixture
              └───────────────────────────┼──────────────────────────┘
                                          ▼
                ┌────────────────────────────────────────────────────┐
                │ 确定性回归 + 三层防假绿门禁                          │
                │ tsc --noEmit → eslint → playwright test → audit    │
                └────────────────────────────────────────────────────┘
```

### 2.2 开源主仓库目录结构

```text
ai-test-workbench/
├── README.md                          # 英文开源文档（统一使用 npx ai-test-workbench）
├── README.zh-CN.md                    # 中文完整落地指南
├── ARCHITECTURE.md                    # 架构决策与安全边界
├── VERSION.md                         # 版本与 Docker 镜像兼容矩阵
├── LICENSE / SECURITY.md / CONTRIBUTING.md
├── package.json                       # name: ai-test-workbench, bin: ai-test-workbench & aitest
├── tools/aitest.mjs                   # #!/usr/bin/env node 统一入口
├── src/                               # 零外部依赖 CLI 模块
│   ├── cli.mjs / i18n.mjs / proc.mjs / origin-guard.mjs
│   ├── doctor.mjs / init.mjs / agents.mjs / runner.mjs
│   └── impact.mjs / audit.mjs / diagnose.mjs / report.mjs / skill-install.mjs
├── skills/ai-test-workbench/          # 标准跨引擎 Agent Skill (<500 行 + references/)
├── templates/playwright-qa/           # 复制到各业务项目 <repo>/qa 的标准模板
│   ├── package.json & package-lock.json
│   ├── tsconfig.json & eslint.config.mjs & aitest.config.json
│   ├── playwright.config.ts
│   ├── gitignore                      # 无点号存储防止 npm pack 剥离，init 时还原为 .gitignore
│   ├── .env.example & impact-map.json & waivers.json
│   ├── support/target-guard.mjs       # 单一真源安全守卫（零依赖）
│   ├── scripts/audit-results.mjs      # CI 可独立运行的零依赖门禁脚本
│   ├── specs/                         # Planner 测试计划目录与示例
│   ├── tests/
│   │   ├── fixtures/base.ts           # 4 层稳定性扩展 Fixture
│   │   ├── auth.setup.ts & seed.spec.ts
│   │   ├── smoke/workbench.spec.ts    # 3 条离线自检 (DOM / AriaSnapshot / Axe)
│   │   ├── e2e/home.spec.ts
│   │   └── api/courses.spec.ts
│   └── docs/README.md
├── prompts/                           # 分阶段复用提示词
├── examples/
│   ├── demo-webapp/server.mjs         # 默认端口 5899 的智慧校园本地靶场
│   ├── jenkins/Jenkinsfile.example
│   └── gitlab/.gitlab-ci.example.yml
├── .github/workflows/ci.yml           # Ubuntu + Windows 双平台矩阵流水线
├── docs/                              # agents-probe-1.65.1 / troubleshooting / security / project-adapter / upgrade
└── test/                              # node:test 单元与集成测试
```

---

## 3. 核心配置与代码参考规范

### 3.1 `qa/.env.example`（零外部依赖加载，无需 `dotenv`）

```dotenv
# 仅填写非敏感占位符，真实 .env 文件严禁提交 Git
TEST_ENV=local
TEST_BASE_URL=
TEST_ALLOWED_HOSTS=127.0.0.1,localhost
TEST_ALLOWED_ORIGINS=
TEST_DENIED_ORIGINS=https://prod.example.com,https://www.example.com
REQUIRE_TEST_TARGET=0

# 写操作与危险接口策略
TEST_ALLOW_MUTATION=0
TEST_BLOCKED_ENDPOINTS=POST /api/pay*,POST /api/payment*,POST /api/sms*,POST /api/notify/real*,DELETE /api/prod*
TEST_STRICT_READONLY=0
TEST_SAFE_WRITE_PATHS=/api/login,/api/auth/login,/graphql,/__test__/reset

# 运行时异常守卫（也可在单测中通过 test.use({ failOnPageError: false }) 覆盖）
FAIL_ON_PAGEERROR=1
FAIL_ON_SERVER_5XX=1
TEST_IGNORE_PAGEERROR_PATTERNS=
TEST_IGNORE_5XX_PATTERNS=

# 专用 QA 测试账号（推荐在 auth.setup.ts 中走 API 登录生成 storageState，避免密码进入录像/Trace）
E2E_USERNAME=
E2E_PASSWORD=
```

### 3.2 `qa/playwright.config.ts`（5 Projects 拆分 + 单一真源守卫）

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { assertTargetSafety, loadEnvFileIfPresent } from './support/target-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFileIfPresent(path.join(__dirname, '.env'));

const safety = assertTargetSafety(process.env);
const baseURL = safety.baseURL;
const authStateFile = path.join(__dirname, 'playwright', '.auth', 'user.json');

const isTestRun = process.argv.includes('test');
const requestedOnlineProject = process.argv.some((arg) => /^--project=(e2e|api|setup)$/.test(arg));
if (isTestRun && requestedOnlineProject && !baseURL) {
  throw new Error('[AI Test Workbench Config Error] Online projects (e2e, api, setup) require TEST_BASE_URL.');
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalTimeout: 45 * 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'smoke', testDir: './tests/smoke', use: { ...devices['Desktop Chrome'] } },
    { name: 'setup', testDir: './tests', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: authStateFile },
    },
    { name: 'api', testDir: './tests/api', use: { ...devices['Desktop Chrome'] } },
    { name: 'seed', testDir: './tests', testMatch: /seed\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
});
```

### 3.3 离线 Smoke 自检与 `gitignore` 规范

- **离线 Smoke（`tests/smoke/workbench.spec.ts`）**：包含 3 条纯离线 `page.setContent` 用例，覆盖语义化按钮状态流转、`toMatchAriaSnapshot` 结构断言，以及 `@axe-core/playwright` 自动化无障碍检查（注：自动化 axe 检查仅覆盖可机器检测的一部分 WCAG 问题，不等于合规认证）。
- **模板 `gitignore`（`init` 时自动生成/合并为 `qa/.gitignore`）**：忽略 `node_modules/`、`.env`、`.env.*`（保留 `!.env.example`）、`playwright/.auth/*`、`playwright-report/`、`test-results/`、`reports/`、`blob-report/`、`*.aitest-new`、`*.log`。

---

## 4. 官方 Planner / Generator / Healer 闭环与防假绿治理

1. **Seed 准备（`--project=seed`）**：先确保 `tests/seed.spec.ts` 可独立运行，不产生不可逆写数据。
2. **Planner（生成 `specs/*.md`）**：基于真实无障碍快照探索应用，写明角色、前置条件、`@mutation` 标记、明确业务断言、异常与 `0/1` 边界场景。对需求不明确之处单列疑问，绝不把页面已有异常当成正确预期。
3. **Generator（生成 `tests/e2e` 与 `tests/api`）**：统一从 `../fixtures/base` 导入 `test / expect / expectAccessible / expectApiContract`，优先语义定位器，通过 `npm run typecheck && npm run lint`。
4. **Healer（严格 A/B/C/D 四分类与最多 3 轮熔断）**：
   - 先运行 `npx ai-test-workbench diagnose --target <repo>`，汇总 `results.json` 与 Playwright 生成的 `error-context.md`，输出脱敏的**建议分类 + 置信度**（仅供参考，非最终定论）。
   - **A 类（定位器/等待漂移）**：允许修改测试脚本（单用例最多修复 3 轮），改完必须通过 `aitest audit --check-specs --diff-base HEAD`。
   - **B 类（环境/鉴权/网络）**：保留红灯，输出环境排障建议。
   - **C 类（产品功能或后端缺陷）**：**严禁按官方默认提示加 `test.fixme()` / `test.skip()` 或删改断言**；输出含复现步骤与 Trace 路径的缺陷报告交由研发修复业务代码。
   - **D 类（需求歧义）**：暂停修改并请求确认验收标准。

---

## 5. Jenkins 示范流水线与质量门禁

```groovy
pipeline {
    agent {
        docker {
            // 必须与 qa/package-lock.json 中的精确 @playwright/test 版本一致
            image 'mcr.microsoft.com/playwright:v1.65.1-noble'
            args '--ipc=host'
        }
    }
    environment {
        CI = 'true'
        TEST_ENV = 'staging'
        TEST_BASE_URL = 'https://staging.example.internal'
        TEST_ALLOWED_HOSTS = 'staging.example.internal'
        REQUIRE_TEST_TARGET = '1'
        TEST_ALLOW_MUTATION = '0'
    }
    stages {
        stage('QA Dependencies') {
            steps {
                dir('qa') { sh 'npm ci --no-audit --no-fund' }
            }
        }
        stage('Static Anti-Fake-Green Gate') {
            steps {
                dir('qa') {
                    sh 'npm run typecheck'
                    sh 'npm run lint'
                }
            }
        }
        stage('Smoke, E2E & API') {
            steps {
                dir('qa') {
                    sh 'npx playwright test --project=smoke --project=e2e --project=api --grep-invert=@mutation --fail-on-flaky-tests'
                }
            }
        }
        stage('QA Policy Audit') {
            steps {
                dir('qa') {
                    sh 'node scripts/audit-results.mjs reports/results.json --check-specs --require-e2e'
                }
            }
        }
    }
    post {
        always {
            junit allowEmptyResults: false, testResults: 'qa/reports/junit.xml'
            // 注意：Trace 与录像可能包含会话敏感信息，必须按安全规范限制归档访问权限与留存天数
            archiveArtifacts allowEmptyArchive: true,
                artifacts: 'qa/playwright-report/**,qa/test-results/**,qa/reports/**'
        }
    }
}
```

---

## 6. 首次试点业务建议（智慧校园 / 课程管理系统）

| 测试模块 | 典型验收点 | 类型 |
|---|---|---|
| 登录与会话 | API 登录建立 `storageState`、错误凭据 `401` | Setup + API |
| 课程查询 | 关键词搜索过滤、无结果展示、已满按钮禁用态 | UI + Axe |
| 课程接口契约 | 字段类型校验、`0/1` 余量数据完整性 | API Contract |
| 报名与防重 | 正常报名 `201`、同一账号重复报名 `409` | API (`@mutation`) |
| 最后 1 名额并发边界 | `Promise.all` 双并发请求抢最后 1 个名额，结果严格为一个 `201` + 一个 `409` | API (`@mutation`) |
| 权限隔离 (RBAC) | 学生角色访问 `/admin` 与 `/api/admin/audit` 均返回 `403` | UI + API |

> **能力边界声明**：单靠浏览器 UI 测试不承诺验证大规模高并发压测、分布式事务一致性、K8s 故障容错或微信小程序/iOS/Android 原生容器；相关场景需配合 k6、后端并发测试及专用原生端自动化工具。

---

## 7. 常见故障与排查速查表

| 现象 | 先检查 | 修复原则 |
|---|---|---|
| 浏览器缺失或版本不匹配 | `npx playwright --version`、`npx playwright install chromium` | 保持项目锁定版本与浏览器缓存一致，禁止关闭 TLS 校验 |
| Windows PowerShell `.cmd` 报 `EINVAL` | `node -v`、`node tools/aitest.mjs doctor` | 使用 `process.execPath` 直接调用 `npm-cli.js` 与 `cli.js`，全程 `shell: false` |
| WSL 装了但 Windows 用不了 | `which node` / `where.exe node` | 两套环境分别安装 Node 与浏览器缓存 |
| `update-agents` 退出码 `2` 并报 `CONFLICT` | `qa/.aitest/agents-manifest.json` 与 `*.aitest-new` | 用户改过的 Agent 定义已被保护，手工合并 `*.aitest-new` 或显式加 `--force` |
| 跑 `e2e`/`api` 直接报 Config Error | `qa/.env` 中 `TEST_BASE_URL` 与 `TEST_ALLOWED_HOSTS` | 在线套件禁止未配 URL 静默 skip；配置白名单测试服或改跑 `--suite smoke` |
| 自定义断言触发 ESLint `expect-expect` | `qa/aitest.config.json` 中 `assertFunctionNames` | 以 `expect*`/`assert*`/`verify*` 命名辅助断言或在 `aitest.config.json` 注册 |
| Jenkins Docker 报浏览器缺失 | `Jenkinsfile` 镜像标签 vs `qa/package-lock.json` | 精确对齐 `mcr.microsoft.com/playwright:v1.65.1-noble` |

---

## 8. 三期演进路线与双口径验收标准

1. **第一期（本机工作台基座建设）**：完成 CLI、模板、官方 Test Agents 多 Loop 编排、两次独立项目幂等初始化、离线 Smoke、本地 Demo 靶场全栈验证、三层防假绿门禁及 `npm pack --dry-run` 发包校验。**不接生产，不触碰真实用户数据。**
2. **第二期（真实业务 Staging 试点）**：提供非生产 Staging URL 与专用 QA 账号后，围绕 10–20 条核心业务流程完成 `Seed → Planner → Generator → 审查 → 回归`。
3. **第三期（CI/CD 规模化门禁）**：在 PR 阶段启用 `impact` 快速反馈，在合入主干 / Nightly / 发布流水线强制运行全量确定性回归 + `audit-results.mjs`。

### 严格区分两种验收结论（严禁混淆）

- **结论 A：本机工作台验收通过** —— 证明本机环境、CLI、浏览器、官方 Agent 初始化、跨项目隔离、离线 Smoke、本地靶场及防假绿门禁全部实测有效。
- **结论 B：业务 E2E 验收通过** —— 必须接入真实业务 Staging 环境、真实业务需求与专用 QA 账号并跑通业务断言；在未提供真实业务 Staging 前，**绝不宣称已完成业务 E2E 验收**。

---

## 9. 实施交付实测核对表（仅勾选已获真实命令与退出码证据的项）

- [x] `npm test`（`node:test`）覆盖 guard、audit、impact 兜底、Healer diff 守卫、脱敏 redact、宿主工程隔离探测、`--preset demo-campus` 与 init 幂等（19/19 通过，退出码 `0`）
- [x] `doctor` 输出本机真实 OS / Node / npm / Git / Codex / Claude / Playwright / Chromium 信息（退出码 `0`）
- [x] `.sandbox/project-alpha-vue` 完成 `init --dry-run` → `init --loop codex` → `update-agents --loop claude` → 修改 Agent 文件后重跑产生 `CONFLICT`（退出码 `2`）与 `.aitest-new` 且不覆盖自定义 `seed.spec.ts`
- [x] 对 `alpha` 执行 `run --suite smoke --audit` 退出码 `0`，且 `playwright-report/index.html`、`reports/junit.xml`、`reports/results.json` 均真实存在
- [x] `.sandbox/project-beta-java`（含 `pom.xml`）独立初始化零互扰，二次对 `alpha` 执行 `init` 不覆盖自定义文件（退出码 `0`）
- [x] 启动 `examples/demo-webapp/server.mjs` 本地靶场（`npm run demo:verify`），跑通 `seed + smoke + e2e + api + audit --require-e2e`（含 `Promise.all` 单名额并发 `201 + 409`、重复报名 `409`、学生管理端 `403`，11/11 通过，退出码 `0`）
- [x] 真实业务项目接入验证（某生产级 Next.js 16.2.6 + Vitest Web 应用，已脱敏）：`init --dry-run` 准确识别技术栈与宿主隔离提示（不改源码）；在独立沙箱目录对本地 `http://127.0.0.1:3100` 跑通首页安全头、定价页、安全页 WCAG 扫描、中英文切换与 `/api/demo` 确定性契约（`seed` 1/1 + `all` 12/12 + `audit --require-e2e` 退出码 `0`）
- [x] 反向安全与防假绿门禁全部返回非 `0` 退出码：`TEST_ENV=production`（`2`）、未授权 host（`2`）、`REQUIRE_TEST_TARGET=1` 空 URL（`2`）、故意失败用例（`1`，含 Trace 生成与 `ai-diagnostics.md` 脱敏及 `error-context.md` 汇总）、`@critical` 被 skip（`1`）、零断言 spec（`1`）、含 `waitForTimeout`（`1`）、Healer diff 删减 `expect`（`1`）、命中危险接口黑名单（`1`）
- [x] **v2.1 新增 `explore` 从 0 到 1 系统探索引擎**：支持只读防火墙（拦截 `DELETE`/`PUT`/`PATCH` 及写类型 `POST`）、UI 按钮安全分类、API Query 密钥脱敏，并在本地靶场实测生成 `reports/system-topology.json` 与 `specs/system-overview.md`
- [x] `npm pack --dry-run` 验证产物不含 `node_modules` / `.env` / `reports` 且包含 `templates/playwright-qa/gitignore`
- [x] 根目录 `git status` 干净规范（`.sandbox` 已忽略，`templates/playwright-qa/package-lock.json` 受控跟踪）
