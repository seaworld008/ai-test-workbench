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
    appTitle: 'AI Test Workbench (ai-test-workbench / aitest) v2.1 — 可复用 AI 自动化测试工作台',
    usageHeader: '用法',
    commandsHeader: '可用命令',
    optionsHeader: '常用选项',
    unknownCmd: (cmd) => `未知命令: ${cmd}。请运行 "npx ai-test-workbench --help" 查看用法。`,
    helpSummary: {
      doctor: '检测本机 OS、Node/npm、Git、Codex/Claude、Docker、Playwright 与浏览器缓存状态',
      init: '将独立可复用的 Playwright QA 子工程幂等初始化到目标业务仓库 (<repo>/qa)',
      'auth-login': '打开可视化 Chromium 登录页（支持人工输入短信验证码/SSO），捕获并持久化登录态',
      explore: '登录后从 0 到 1 只读巡检全站路由、表单表格结构与 API 面，生成系统全景图谱 (system-overview.md)',
      run: '按套件运行 Playwright 测试 (smoke/e2e/api/a11y/critical/seed/impact/all) 并传递真实退出码',
      impact: '基于 git diff 与 impact-map.json 计算受影响用例（不确定时自动回退全量）',
      audit: '执行三层防假绿门禁（ESLint+TSC 静态检查 + results.json 审计 + Healer diff 守卫）',
      diagnose: '汇总 results.json 与官方 error-context.md，脱敏并输出建议 A/B/C/D 分类与置信度',
      report: '展示本地 HTML/JUnit/JSON 报告及 Trace 路径（不主动连远端或外传）',
      'update-agents': '按 SHA-256 清单安全更新官方 playwright init-agents，冲突自动写入 .aitest-new',
      'skill-install': '将标准 ai-test-workbench Agent Skill 安装到业务仓库 .codex/.claude/qa 目录',
    },
    missingTarget: '缺少必填参数 --target <业务仓库或QA目录路径>',
    qaNotFound: (p) => `未找到 QA 测试目录（期望 ${p} 或包含 playwright.config.ts 的目录）。请先执行 init。`,
  },
  en: {
    appTitle: 'AI Test Workbench (ai-test-workbench / aitest) v2.1 — Reusable AI-Driven E2E Testing Workbench',
    usageHeader: 'Usage',
    commandsHeader: 'Commands',
    optionsHeader: 'Global Options',
    unknownCmd: (cmd) => `Unknown command: ${cmd}. Run "npx ai-test-workbench --help" for usage.`,
    helpSummary: {
      doctor: 'Inspect OS, Node/npm, Git, Codex/Claude, Docker, Playwright & browser cache readiness',
      init: 'Idempotently initialize an isolated Playwright QA subproject into <repo>/qa',
      'auth-login': 'Open headed Chromium login window (for manual SMS OTP/SSO) and capture reusable session state',
      explore: 'Crawl authenticated app routes & APIs read-only from 0 to 1 and generate specs/system-overview.md',
      run: 'Execute a Playwright suite (smoke/e2e/api/a11y/critical/seed/impact/all) with real exit code propagation',
      impact: 'Select targeted tests via git diff + impact-map.json (falls back to full suite when uncertain)',
      audit: 'Run 3-layer anti-fake-green gate (ESLint+TSC + results.json + Healer diff guard)',
      diagnose: 'Aggregate results.json & error-context.md, redact secrets, and suggest A/B/C/D triage + confidence',
      report: 'Display local HTML/JUnit/JSON report and Trace paths (never auto-uploads data)',
      'update-agents': 'Safely update official playwright init-agents with SHA-256 manifest & .aitest-new conflict files',
      'skill-install': 'Install the standard ai-test-workbench Agent Skill into .codex/skills, .claude/skills, or qa/',
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
