// @ts-check
import { WORKBENCH_VERSION } from './version.mjs';

export function detectLang(flagLang) {
  if (flagLang) {
    return String(flagLang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  if (process.env.AITEST_LANG) {
    return process.env.AITEST_LANG.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  const envLocale =
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    'en';
  return String(envLocale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const DICT = {
  zh: {
    appTitle: `AI Test Workbench (ai-test-workbench / aitw) v${WORKBENCH_VERSION} — AI 编码 Agent 的独立可信验证内核与多协议 MCP 服务端`,
    usageHeader: '用法',
    commandsHeader: '可用命令',
    optionsHeader: '常用选项',
    unknownCmd: (cmd) =>
      `未知命令: ${cmd}。请运行 "npx ai-test-workbench@${WORKBENCH_VERSION} --help" 或 "aitw --help" 查看用法。`,
    helpSummary: {
      doctor: '检测本机 OS、Node/npm、Git、Codex/Claude、Playwright 缓存与门禁内核版本漂移',
      init: '幂等初始化隔离 Playwright QA 子工程 (<repo>/qa) 并生成 .aitest/governance.lock',
      'auth-login': '打开可视化 Chromium 登录页（人工输入短信验证码/SSO），捕获并持久化登录态',
      explore: '零写默认拒绝模式下从 0 到 1 巡检全站路由、输出页面 ARIA 规格并同步代码地图',
      map: '融合宿主源码（含动态路由）+ 运行态探索 + 测试结果，收敛更新活体代码地图 v4',
      mcp: '7 大支柱全链路 MCP 中枢 (presets | add | doctor | serve)：版本锁定、风险分级与提示词投毒检测',
      'mcp-serve': '启动原生全协议 MCP 服务端 (stdio / Streamable HTTP / Legacy SSE + 异步任务与会话治理)',
      perf: '真实 PerformanceObserver Web Vitals (LCP/CLS/INP 多样本中位数) + 并发只读 API SLO 检查',
      run: '按套件运行 Playwright 测试并绑定 Run Ledger (runId + 工作区哈希)',
      impact: '基于静态 import 依赖图反向传递闭包 + 历史失败加权计算受影响用例',
      audit: '执行四层防假绿门禁（治理哈希锁 + Run Ledger 绑定审计 + TSC/ESLint + AST 语义 Diff 守卫）',
      diagnose: '基于结构化护栏信号、32 位 W3C Trace-ID 与脱敏引擎 v2 输出 A/B/C/D 根因报告',
      'verify-change': '一键执行治理校验 -> Impact v2 -> 测试运行 -> 四层门禁 -> 诊断，输出证明包与 SARIF',
      heal: '有状态 A/B/C/D 自愈状态机 (begin | attempt | conclude)，强制拦截 C/D 类误修与超过 3 次重试',
      flaky: '基于 Run Ledger 统计历史 Flaky 率并管理带期限的自动隔离区 (quarantine.json)',
      'trace-matrix': '生成 specs/REQ-xxx 需求 <-> 测试用例 <-> 运行结果的双向可追溯矩阵',
      governance: '人类专属治理审批 CLI (verify | status | approve)，严禁暴露给 MCP Agent',
      attest: '离线校验 in-toto Statement v1 判决证书、T1 MAC 与 T2 Sigstore 签发身份 (verify)',
      report: '展示本地 HTML/JUnit/JSON/SARIF 报告、知识地图、性能报告及 Trace 路径',
      'update-agents': '按 SHA-256 清单安全更新官方 playwright init-agents，冲突自动写入 .aitest-new',
      'skill-install': '将标准 ai-test-workbench Skill 安装到 .codex/.claude/.gemini/.github/qa 目录',
    },
    missingTarget: '缺少必填参数 --target <业务仓库或QA目录路径>',
    qaNotFound: (p) => `未找到 QA 测试目录（期望 ${p} 或包含 playwright.config.ts 的目录）。请先执行 init。`,
  },
  en: {
    appTitle: `AI Test Workbench (ai-test-workbench / aitw) v${WORKBENCH_VERSION} — Trustworthy Verification Kernel & Multi-Protocol MCP Server for AI Coding Agents`,
    usageHeader: 'Usage',
    commandsHeader: 'Commands',
    optionsHeader: 'Global Options',
    unknownCmd: (cmd) =>
      `Unknown command: ${cmd}. Run "npx ai-test-workbench@${WORKBENCH_VERSION} --help" or "aitw --help" for usage.`,
    helpSummary: {
      doctor: 'Inspect OS, Node/npm, Git, Codex/Claude, browser cache, and Gate Kernel version drift',
      init: 'Idempotently initialize isolated <repo>/qa subproject with .aitest/governance.lock',
      'auth-login': 'Open headed Chromium login window (manual SMS OTP/SSO) and capture session state',
      explore: 'Default-deny zero-write 0->1 explorer generating per-page ARIA specs & Living Code Map',
      map: 'Fuse repo source (including dynamic routes) + runtime topology into convergent Code Map v4',
      mcp: '7-pillar MCP Hub (presets | add | doctor | serve) with version pinning, risk tiers & mcp.lock',
      'mcp-serve': 'Run native multi-protocol MCP server (stdio, Streamable HTTP, SSE, async Job Runner)',
      perf: 'Measure PerformanceObserver Web Vitals (LCP/CLS/INP median/P75) + concurrent API SLOs',
      run: 'Execute Playwright suite bound to Run Ledger (ULID runId + workspace input hash)',
      impact: 'Select targeted tests via reverse import dependency graph + Ledger failure history',
      audit: 'Run 4-layer anti-fake-green gate (Governance Lock + Ledger Binding + TSC/ESLint + Semantic AST Diff)',
      diagnose: 'Structured runtime-guard triage + 32-char W3C traceId + Redaction v2 diagnostics',
      'verify-change': 'One-call verdict pipeline producing attestation.json, PR Markdown & SARIF 2.1.0',
      heal: 'Stateful A/B/C/D Heal Session engine (begin | attempt | conclude) blocking C/D mis-heals',
      flaky: 'Compute historical flaky rates from Run Ledger and manage time-bounded quarantine.json',
      'trace-matrix': 'Generate REQ-xxx Requirement <-> Spec <-> Outcome traceability matrix',
      governance: 'Human-only governance CLI (verify | status | approve) — never exposed via MCP',
      attest: 'Offline verify in-toto Statement v1 verdict attestations, T1 MAC & T2 Sigstore identity (verify)',
      report: 'Display local HTML/JUnit/JSON/SARIF reports, Living Code Map, Perf & Trace paths',
      'update-agents': 'Safely update official playwright init-agents with SHA-256 manifest',
      'skill-install': 'Install portable ai-test-workbench Skill into .codex, .claude, .agents, .gemini, .github, or qa/',
    },
    missingTarget: 'Missing required option --target <repo-or-qa-path>',
    qaNotFound: (p) => `QA directory not found (expected ${p} or a directory with playwright.config.ts). Run init first.`,
  },
};

export function t(lang, key, ...args) {
  const table = DICT[lang] || DICT.en;
  const val = table[key] ?? DICT.en[key];
  if (typeof val === 'function') return val(...args);
  return val;
}
