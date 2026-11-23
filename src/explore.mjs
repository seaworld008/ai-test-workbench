import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { redactSecrets } from './proc.mjs';

const MUTATION_LABEL_RE =
  /(新增|添加|创建|新建|修改|编辑|更新|删除|移除|清空|导入|导出|审核|审批|通过|驳回|停用|启用|发布|退费|退款|缴费|支付|下单|提交|发送|获取验证码|退出|注销|取消|create|add|new|edit|update|save|delete|remove|import|export|approve|reject|audit|disable|enable|publish|refund|pay|submit|send|logout|sign\s*out)/i;

const READONLY_LABEL_RE =
  /(搜索|查询|检索|重置|刷新|查看|详情|明细|展开|收起|折叠|预览|筛选|返回|关闭|search|query|reset|refresh|view|detail|expand|collapse|preview|filter|back|close|more)/i;

const SENSITIVE_QUERY_KEY_RE =
  /(token|key|secret|password|passwd|pwd|mobile|phone|tel|idcard|card|email|code|ticket|auth|session|cookie|sig|sign)/i;

const MUTATING_POST_PATH_RE =
  /\/(create|add|save|update|delete|remove|import|pay|payment|sms|send-sms|approve|reject|audit|submit|logout|refund|withdraw)(?:[/?_-]|$)/i;

/**
 * Classifies UI button/action labels into readonly, mutation, or unknown so explorers never trigger writes.
 */
export function classifyActionSafety(label) {
  const clean = String(label || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'unknown';
  if (MUTATION_LABEL_RE.test(clean)) return 'mutation';
  if (READONLY_LABEL_RE.test(clean)) return 'readonly';
  return 'unknown';
}

/**
 * Redacts credentials, tokens, and PII query parameters from discovered API URLs.
 */
export function redactEndpointUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input);
    const parsed = new URL(input, 'http://placeholder.local');
    const cleanParams = new URLSearchParams();
    for (const [k, v] of parsed.searchParams.entries()) {
      cleanParams.append(k, SENSITIVE_QUERY_KEY_RE.test(k) ? '[REDACTED]' : v);
    }
    const qs = cleanParams.toString();
    const base = isAbsolute ? `${parsed.origin}${parsed.pathname}` : parsed.pathname;
    return qs ? `${base}?${qs}` : base;
  } catch {
    return redactSecrets(input);
  }
}

/**
 * Detects malformed query parameters such as serialized JS/Day.js objects (`[$L]=en`, `[object Object]`).
 */
export function detectUrlQueryAnomalies(rawUrl) {
  const input = String(rawUrl || '');
  const anomalies = [];
  if (/(?:\[|\\%5B)\$[a-zA-Z0-9_]+(?:\]|\\%5D)=/.test(input)) {
    anomalies.push('Serialized date/object internals in query parameters (e.g. dayjs [$L]/[$d])');
  }
  if (/\[object Object\]|%5Bobject%20Object%5D/i.test(input)) {
    anomalies.push('Literal [object Object] serialized in URL query');
  }
  if (/[?&][^=]+=undefined(?:&|$)/i.test(input)) {
    anomalies.push('Literal "undefined" passed as URL query parameter');
  }
  return anomalies;
}

/**
 * Classifies a structural page snapshot into a high-level UI archetype for functional test planning.
 */
export function detectPageArchetype(pageInfo = {}) {
  const route = String(pageInfo.route || pageInfo.actualPath || '');
  const tableHeaders = pageInfo.tableHeaders || [];
  const filterLabels = pageInfo.filterLabels || [];
  const buttons = pageInfo.buttons || [];
  if (/\/(login|signin|auth|sso|passport)\b/i.test(route) || pageInfo.hasPasswordInput) {
    return 'auth-portal';
  }
  if (/\/(overview|dashboard|board|home)\b/i.test(route) || (pageInfo.hasChart && tableHeaders.length === 0)) {
    return 'dashboard';
  }
  if (tableHeaders.length > 0 || pageInfo.hasTable) {
    return 'crud-table';
  }
  if (filterLabels.length > 0 || buttons.length > 0) {
    return 'form-config';
  }
  return 'content-page';
}

/**
 * Generates a structured Markdown system atlas (`specs/system-overview.md`) from exploration topology.
 */
export function generateSystemOverviewMarkdown(topology, lang = 'zh') {
  const isZh = lang === 'zh';
  const pages = Array.isArray(topology?.pages) ? topology.pages : [];
  const portals = Array.isArray(topology?.portals) ? topology.portals : [];
  const endpoints = Array.isArray(topology?.endpoints) ? topology.endpoints : [];
  const consoleErrors = Array.isArray(topology?.consoleErrors) ? topology.consoleErrors : [];
  const serverErrors = Array.isArray(topology?.serverErrors) ? topology.serverErrors : [];

  const title = isZh
    ? '# 系统全景画像与功能测试蓝图 (System Panorama & Deep Test Atlas)'
    : '# System Panorama & Deep Functional Test Atlas';

  const summaryRows = isZh
    ? [
        `- **目标地址**：\`${topology.baseURL || 'unknown'}\``,
        `- **探索时间**：\`${topology.exploredAt || new Date().toISOString()}\``,
        `- **探索模式**：\`${topology.readOnly ? 'strict-readonly (零写操作)' : 'standard'}\`（最大页数上限 \`${topology.maxPages || pages.length}\`）`,
        `- **技术栈探测**：${(topology.techStack || []).join(' / ') || '通用 Web 应用'}`,
        `- **鉴权存储键名（脱敏）**：${(topology.authKeyNames || []).map((k) => `\`${k}\``).join(', ') || '无 / 未登录态'}`,
        `- **已探索页面数**：\`${pages.length}\` 个路由 · **API 端点**：\`${endpoints.length}\` 个 · **预存 Console 错误**：\`${consoleErrors.length}\` · **服务端 5xx**：\`${serverErrors.length}\``,
      ]
    : [
        `- **Target URL**: \`${topology.baseURL || 'unknown'}\``,
        `- **Explored At**: \`${topology.exploredAt || new Date().toISOString()}\``,
        `- **Mode**: \`${topology.readOnly ? 'strict-readonly (zero mutations)' : 'standard'}\` (max pages \`${topology.maxPages || pages.length}\`)`,
        `- **Detected Stack**: ${(topology.techStack || []).join(' / ') || 'Standard Web App'}`,
        `- **Auth Storage Keys (Names Only)**: ${(topology.authKeyNames || []).map((k) => `\`${k}\``).join(', ') || 'None / Anonymous'}`,
        `- **Pages Explored**: \`${pages.length}\` · **API Endpoints**: \`${endpoints.length}\` · **Console Errors**: \`${consoleErrors.length}\` · **Server 5xx**: \`${serverErrors.length}\``,
      ];

  const lines = [title, '', ...summaryRows, ''];

  lines.push(isZh ? '## 1. 多端视角与租户/组织上下文' : '## 1. Portals & Tenant Switchers', '');
  if (portals.length === 0) {
    lines.push(isZh ? '- 当前会话仅发现单端上下文（未检测到租户/组织切换抽屉）。' : '- Single context detected in current session.', '');
  } else {
    for (const p of portals) {
      lines.push(`- **${p.name}** (\`${p.mode || 'context'}\`${p.id ? `, id=${p.id}` : ''}): ${p.notes || ''}`);
    }
    lines.push('');
  }

  lines.push(isZh ? '## 2. 已探索页面与组件结构清单' : '## 2. Explored Route & Component Inventory', '');
  lines.push(
    isZh
      ? '| 路由 | 面包屑 / 标题 | 原型 | 表头/筛选字段 | 操作按钮 (只读 / 写风险) | 表格行数 | 无障碍基线 |'
      : '| Route | Breadcrumb / Title | Archetype | Table Headers / Filters | Actions (ReadOnly / Mutation) | Rows | A11y Baseline |',
    '|---|---|---|---|---|---|---|'
  );

  for (const p of pages) {
    const label = (p.breadcrumbs && p.breadcrumbs.length > 0 ? p.breadcrumbs.join(' > ') : p.title) || '-';
    const schema = [
      ...(p.tableHeaders || []).slice(0, 6),
      ...((p.filterLabels || []).length > 0 ? [`[筛选: ${(p.filterLabels || []).slice(0, 4).join(', ')}]`] : []),
    ].join(' / ') || '-';
    const roBtns = (p.readonlyButtons || []).slice(0, 4).join(', ') || '-';
    const mutBtns = (p.mutationButtons || []).slice(0, 4).join(', ') || '-';
    const a11ySummary = p.a11y
      ? `main=${p.a11y.hasMainLandmark ? 'Y' : 'N'}, h1=${p.a11y.hasH1 ? 'Y' : 'N'}, noLabel=${p.a11y.inputsMissingLabel ?? 0}`
      : '-';
    lines.push(
      `| \`${p.route}\` | ${label.replace(/\|/g, '\\|')} | \`${p.archetype || 'content-page'}\` | ${schema.replace(/\|/g, '\\|')} | R:[${roBtns}] / M:[${mutBtns}] | ${p.tableRowCount ?? '-'} | ${a11ySummary} |`
    );
  }
  lines.push('');

  lines.push(isZh ? '## 3. 观测到的 API 端点面（已脱敏）' : '## 3. Observed API Endpoints (Redacted)', '');
  if (endpoints.length === 0) {
    lines.push(isZh ? '- 本次探索未触发同域或网关 API 请求。' : '- No API requests observed during exploration.', '');
  } else {
    for (const ep of endpoints.slice(0, 80)) {
      lines.push(`- \`${ep.method}\` \`${ep.endpoint}\` -> HTTP \`${ep.status}\``);
    }
    if (endpoints.length > 80) {
      lines.push(isZh ? `- ……共 ${endpoints.length} 条端点，详见 \`reports/system-topology.json\`` : `- ... ${endpoints.length} total endpoints (see reports/system-topology.json)`);
    }
    lines.push('');
  }

  lines.push(isZh ? '## 4. 预存异常与架构改进线索' : '## 4. Pre-existing Runtime Errors & Architecture Gaps', '');
  if (consoleErrors.length === 0 && serverErrors.length === 0) {
    lines.push(isZh ? '- 未发现 Console `error` 或 HTTP `5xx` 响应。' : '- Zero Console errors or HTTP 5xx responses recorded.', '');
  } else {
    for (const err of consoleErrors.slice(0, 20)) {
      lines.push(`- [Console Error] \`${err.route || '/'}\`: ${String(err.message || err).slice(0, 180)}`);
    }
    for (const srv of serverErrors.slice(0, 20)) {
      lines.push(`- [HTTP 5xx] \`${srv}\``);
    }
    lines.push('');
  }

  lines.push(isZh ? '## 5. 推荐深度功能测试矩阵（下一步 Generator 输入）' : '## 5. Recommended Deep Functional Test Matrix', '');
  const crudPages = pages.filter((p) => p.archetype === 'crud-table');
  const authPages = pages.filter((p) => p.archetype === 'auth-portal');
  if (authPages.length > 0) {
    lines.push(
      isZh
        ? `- **P0 认证与权限守卫**：验证 \`${authPages.map((p) => p.route).join(', ')}\` 登录模式切换、空表单客户端校验，以及未登录直接访问业务路由强制跳转。`
        : `- **P0 Auth & Route Guards**: Verify mode tabs, client validation, and unauthenticated redirects on \`${authPages.map((p) => p.route).join(', ')}\`.`
    );
  }
  if (crudPages.length > 0) {
    lines.push(
      isZh
        ? `- **P0 核心列表检索/0-1空态/重置还原**：对 ${crudPages.slice(0, 6).map((p) => `\`${p.route}\``).join('、')} 等列表页执行空结果检索验证（0 行空块渲染）与重置还原。`
        : `- **P0 List Search / 0-Row Empty Boundary / Reset**: Verify search + empty state + reset on ${crudPages.slice(0, 6).map((p) => `\`${p.route}\``).join(', ')}.`
    );
    lines.push(
      isZh
        ? `- **P1 分页切换 / Tab 状态切换 / 只读详情下钻**：覆盖分页第 1↔2 页数据刷新、多状态标签页过滤与只读详情弹窗/页面返回。`
        : `- **P1 Pagination / Tabs / Read-Only Detail Drill-Down**: Verify page transitions, status tabs, and read-only detail views.`
    );
  }
  if (portals.length > 1) {
    lines.push(
      isZh
        ? '- **P0 多端 / 多组织租户数据隔离**：切换不同租户/组织上下文后核验看板统计与列表数据彻底隔离，无串租户缓存污染。'
        : '- **P0 Multi-Portal / Tenant Isolation**: Switch tenant/organization workspaces and verify zero cross-tenant data leakage.'
    );
  }
  lines.push('');
  return lines.join('\n');
}

function loadPlaywrightChromium(qaDir) {
  const candidates = [
    path.join(qaDir, 'node_modules', 'playwright', 'index.mjs'),
    path.join(qaDir, 'node_modules', '@playwright', 'test', 'index.mjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadJsonIfValid(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Executes a bounded, strictly read-only zero-to-one browser exploration from an entry URL
 * and generates `reports/system-topology.json` and `specs/system-overview.md`.
 */
export async function runExploreCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  const safety = evaluateTargetSafety(mergedEnv);

  if (!safety.ok || !safety.baseURL) {
    const errs = safety.errors.length > 0 ? safety.errors : ['TEST_BASE_URL is required for explore.'];
    for (const err of errs) {
      console.error(`[Target Guard Blocked] ${err}`);
    }
    return 2;
  }

  const pwPkg = loadPlaywrightChromium(qaDir);
  if (!pwPkg) {
    console.error(
      lang === 'zh'
        ? `在 ${qaDir} 中未找到 playwright 包，请先安装依赖。`
        : `playwright package not found in ${qaDir}. Install dependencies first.`
    );
    return 1;
  }

  const maxPages = Math.max(1, Math.min(100, Number(options.maxPages || 25)));
  const entryPath = options.entryPath ? String(options.entryPath) : '/';
  const baseOrigin = new URL(safety.baseURL).origin;
  const userAuthPath = path.join(qaDir, 'playwright', '.auth', 'user.json');
  const sessionAuthPath = path.join(qaDir, 'playwright', '.auth', 'session.json');
  const sessionData = loadJsonIfValid(sessionAuthPath);

  const { chromium } = await import(pathToFileURL(pwPkg).href);
  const browser = await chromium.launch({ headless: true });

  const topology = {
    baseURL: safety.baseURL,
    exploredAt: new Date().toISOString(),
    readOnly: true,
    maxPages,
    techStack: [],
    authKeyNames: [],
    portals: [],
    pages: [],
    endpoints: [],
    queryAnomalies: [],
    duplicateWaterfalls: [],
    consoleErrors: [],
    serverErrors: [],
  };

  try {
    const contextOpts = { viewport: { width: 1440, height: 900 } };
    if (loadJsonIfValid(userAuthPath)) {
      contextOpts.storageState = userAuthPath;
    }

    const context = await browser.newContext(contextOpts);
    if (sessionData?.origin && Array.isArray(sessionData.entries) && sessionData.entries.length > 0) {
      await context.addInitScript(
        ({ targetOrigin, entries }) => {
          if (window.location.origin === targetOrigin) {
            for (const [k, v] of entries) {
              window.sessionStorage.setItem(k, v);
            }
          }
        },
        { targetOrigin: sessionData.origin, entries: sessionData.entries }
      );
    }

    const page = await context.newPage();
    let activeRouteLabel = entryPath;
    const seenEndpointKeys = new Set();
    let routeApiCounts = new Map();
    const seenAnomalyKeys = new Set();

    // Strict zero-mutation firewall during automated exploration
    await page.route('**/*', async (route) => {
      const req = route.request();
      const method = req.method().toUpperCase();
      const url = req.url();
      let pathname = '/';
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = '/';
      }
      if (
        method === 'DELETE' ||
        method === 'PUT' ||
        method === 'PATCH' ||
        (method === 'POST' && MUTATING_POST_PATH_RE.test(pathname))
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    page.on('pageerror', (err) => {
      topology.consoleErrors.push({
        route: activeRouteLabel,
        message: redactSecrets(err?.message || String(err)),
      });
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        topology.consoleErrors.push({
          route: activeRouteLabel,
          message: redactSecrets(msg.text()),
        });
      }
    });

    page.on('response', (res) => {
      const status = res.status();
      const reqType = res.request().resourceType();
      const url = res.url();
      if (status >= 500) {
        topology.serverErrors.push(`${status} ${res.request().method()} ${redactEndpointUrl(url)}`);
      }
      if (reqType === 'xhr' || reqType === 'fetch') {
        const cleanEp = redactEndpointUrl(url);
        const key = `${res.request().method()} ${cleanEp} ${status}`;
        if (!seenEndpointKeys.has(key)) {
          seenEndpointKeys.add(key);
          topology.endpoints.push({
            method: res.request().method(),
            endpoint: cleanEp,
            status,
          });
        }
        if (res.request().method().toUpperCase() === 'GET') {
          let pathnameOnly = cleanEp;
          try {
            pathnameOnly = new URL(url).pathname;
          } catch {
            // keep cleanEp
          }
          routeApiCounts.set(pathnameOnly, (routeApiCounts.get(pathnameOnly) || 0) + 1);
        }
        for (const detail of detectUrlQueryAnomalies(url)) {
          const aKey = `${activeRouteLabel}:${detail}`;
          if (!seenAnomalyKeys.has(aKey)) {
            seenAnomalyKeys.add(aKey);
            topology.queryAnomalies.push({ route: activeRouteLabel, detail, endpoint: cleanEp });
          }
        }
      }
    });

    const queue = [entryPath];
    const visited = new Set();
    const stackSet = new Set();
    const authKeysSet = new Set();
    const portalMap = new Map();

    while (queue.length > 0 && topology.pages.length < maxPages) {
      const nextRoute = queue.shift();
      const targetUrl = new URL(nextRoute, safety.baseURL).toString();
      const normalizedKey = new URL(targetUrl).pathname + new URL(targetUrl).search;
      if (visited.has(normalizedKey)) continue;
      visited.add(normalizedKey);
      activeRouteLabel = normalizedKey;
      routeApiCounts = new Map();

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      } catch {
        continue;
      }

      // Brief bounded wait for initial async render & common loading spinners
      await page.waitForTimeout(450);
      await page
        .waitForFunction(
          () => {
            const masks = document.querySelectorAll('.el-loading-mask, .ant-spin-spinning, [aria-busy="true"], .el-skeleton');
            for (const m of masks) {
              if (getComputedStyle(m).display !== 'none') return false;
            }
            return true;
          },
          null,
          { timeout: 5_000 }
        )
        .catch(() => {});

      const snap = await page.evaluate(() => {
        const mainScope = document.querySelector('.app-main, main, [role="main"]') || document.body;
        const buttons = Array.from(
          new Set(
            Array.from(mainScope.querySelectorAll('button, [role="button"]'))
              .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
        ).slice(0, 25);

        const tableHeaders = Array.from(
          new Set(
            Array.from(mainScope.querySelectorAll('table th, .el-table__header th .cell'))
              .map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
        ).slice(0, 20);

        const filterLabels = Array.from(
          new Set(
            Array.from(mainScope.querySelectorAll('.el-form-item__label, label'))
              .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
        ).slice(0, 20);

        const breadcrumbs = Array.from(
          document.querySelectorAll('.app-breadcrumb .el-breadcrumb__inner, nav[aria-label="breadcrumb"] a, nav[aria-label="breadcrumb"] span')
        )
          .map((e) => (e.textContent || '').trim())
          .filter(Boolean);

        const anchors = Array.from(document.querySelectorAll('a[href], [role="menuitem"][href]'))
          .map((a) => a.getAttribute('href') || '')
          .filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:') && !h.startsWith('mailto:'));

        const tech = [];
        if (document.querySelector('#app')?.__vue__) tech.push('Vue');
        if (document.querySelector('.el-table, .el-menu, .el-form')) tech.push('Element UI');
        if (document.querySelector('[class*="ant-"]')) tech.push('Ant Design');
        if (document.querySelector('#__next, [data-nextjs-scroll-focus-boundary]')) tech.push('Next.js');

        const vueRoot = document.querySelector('#app')?.__vue__;
        const vueRouter = vueRoot?.$router;
        const vueRoutes = [];
        const walkVueRoutes = (routes, prefix = '') => {
          for (const r of routes || []) {
            if (!r || !r.path || r.path.includes(':') || r.path.includes('*')) continue;
            const full = r.path.startsWith('/') ? r.path : `${prefix.replace(/\/$/, '')}/${r.path}`;
            if (!r.children || r.children.length === 0) vueRoutes.push(full);
            else walkVueRoutes(r.children, full);
          }
        };
        if (vueRouter?.options?.routes) walkVueRoutes(vueRouter.options.routes);
        if (vueRoot?.$store?.state?.permission?.routes) walkVueRoutes(vueRoot.$store.state.permission.routes);
        if (vueRoot?.$store?.state?.permission?.sidebarRouters) walkVueRoutes(vueRoot.$store.state.permission.sidebarRouters);

        const vue3Router = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
        if (vue3Router && typeof vue3Router.getRoutes === 'function') {
          for (const r of vue3Router.getRoutes()) {
            if (r?.path && !r.path.includes(':') && !r.path.includes('*')) vueRoutes.push(r.path);
          }
        }

        const detectedPortals = [];
        const appPlatforms = vueRoot?.$store?.state?.app?.platforms;
        if (Array.isArray(appPlatforms)) {
          for (const pf of appPlatforms.slice(0, 10)) {
            if (pf?.name) detectedPortals.push({ name: pf.name, mode: 'platform', id: pf.id ?? null, notes: 'Vuex app.platforms' });
          }
        }
        const switcherKeys = ['tenants', 'workspaces', 'organizations', 'orgs', 'projects'];
        const walkFindSwitcher = (node, depth = 0) => {
          if (!node || depth > 5) return;
          for (const key of switcherKeys) {
            if (Array.isArray(node[key])) {
              for (const item of node[key].slice(0, 10)) {
                if (item?.name) detectedPortals.push({ name: item.name, mode: 'tenant', id: item.id ?? null, notes: `Workspace Switcher (${key})` });
              }
            }
          }
          for (const c of node.$children || []) walkFindSwitcher(c, depth + 1);
        };
        walkFindSwitcher(vueRoot);
        const switcherDom = document.querySelectorAll('[class*="tenant-switch"], [class*="workspace-switch"], [class*="org-switch"], [data-testid*="tenant-switcher"], [data-testid*="workspace-switcher"]');
        if (switcherDom.length > 0 && detectedPortals.length === 0) {
          detectedPortals.push({ name: 'Multi-Tenant Drawer Detected', mode: 'switcher', notes: 'Interactive switcher DOM found' });
        }

        return {
          actualPath: window.location.pathname,
          title: document.title || '',
          breadcrumbs,
          tableHeaders,
          hasTable: !!mainScope.querySelector('table, .el-table'),
          tableRowCount: mainScope.querySelectorAll('tbody tr.el-table__row, table tbody tr').length,
          filterLabels,
          buttons,
          hasPasswordInput: !!document.querySelector('input[type="password"]'),
          hasChart: !!mainScope.querySelector('canvas, .echarts, [class*="chart"]'),
          a11y: {
            hasMainLandmark: !!document.querySelector('main, [role="main"]'),
            hasH1: !!document.querySelector('h1'),
            inputsMissingLabel: Array.from(mainScope.querySelectorAll('input:not([type="hidden"])')).filter(
              (i) =>
                !i.getAttribute('aria-label') &&
                !i.getAttribute('aria-labelledby') &&
                !(i.id && document.querySelector(`label[for="${i.id.replace(/"/g, '\\"')}"]`))
            ).length,
            imagesMissingAlt: mainScope.querySelectorAll('img:not([alt])').length,
          },
          tech,
          authKeyNames: Object.keys(window.localStorage || {}).filter((k) =>
            /token|auth|session|user|platform|tenant|admin/i.test(k)
          ),
          detectedPortals,
          discoveredLinks: [...anchors, ...vueRoutes],
        };
      });

      for (const tName of snap.tech) stackSet.add(tName);
      for (const k of snap.authKeyNames) authKeysSet.add(k);
      for (const dp of snap.detectedPortals || []) {
        portalMap.set(`${dp.mode}:${dp.id ?? dp.name}`, dp);
      }

      const apisObserved = [...routeApiCounts.keys()];
      for (const [epPath, count] of routeApiCounts.entries()) {
        if (count >= 2) {
          topology.duplicateWaterfalls.push({ route: normalizedKey, endpoint: epPath, count });
        }
      }

      const readonlyButtons = snap.buttons.filter((b) => classifyActionSafety(b) === 'readonly');
      const mutationButtons = snap.buttons.filter((b) => classifyActionSafety(b) === 'mutation');

      const pageEntry = {
        route: normalizedKey,
        actualPath: snap.actualPath,
        title: snap.title,
        breadcrumbs: snap.breadcrumbs,
        tableHeaders: snap.tableHeaders,
        hasTable: snap.hasTable,
        tableRowCount: snap.tableRowCount,
        filterLabels: snap.filterLabels,
        buttons: snap.buttons,
        readonlyButtons,
        mutationButtons,
        apisObserved,
        hasPasswordInput: snap.hasPasswordInput,
        hasChart: snap.hasChart,
        a11y: snap.a11y,
      };
      pageEntry.archetype = detectPageArchetype(pageEntry);
      topology.pages.push(pageEntry);

      for (const rawHref of snap.discoveredLinks) {
        try {
          const resolved = new URL(rawHref, safety.baseURL);
          if (resolved.origin !== baseOrigin) continue;
          if (/\/(logout|signout|download|loading)\b/i.test(resolved.pathname)) continue;
          const rel = resolved.pathname + resolved.search;
          if (!visited.has(rel) && !queue.includes(rel)) {
            queue.push(rel);
          }
        } catch {
          // ignore malformed href
        }
      }
    }

    topology.techStack = [...stackSet];
    topology.authKeyNames = [...authKeysSet];
    topology.portals = portalMap.size > 0
      ? [...portalMap.values()]
      : [{
          name: topology.pages[0]?.title || 'Default Web Context',
          mode: 'default',
          notes: `${topology.pages.length} route(s) explored cleanly.`,
        }];
  } finally {
    await browser.close();
  }

  const reportsDir = path.join(qaDir, 'reports');
  const specsDir = path.join(qaDir, 'specs');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(specsDir, { recursive: true });

  const topologyPath = path.join(reportsDir, 'system-topology.json');
  const overviewPath = path.join(specsDir, 'system-overview.md');
  fs.writeFileSync(topologyPath, JSON.stringify(topology, null, 2) + '\n', 'utf8');
  fs.writeFileSync(overviewPath, generateSystemOverviewMarkdown(topology, lang), 'utf8');

  const codeMapSync = syncLivingCodeMap(qaDir, { lang });

  if (options.json) {
    console.log(JSON.stringify({
      topologyPath,
      overviewPath,
      codeMapPath: codeMapSync.codeMapPath,
      systemMapMdPath: codeMapSync.systemMapMdPath,
      revision: codeMapSync.revision,
      pagesCount: topology.pages.length,
      endpointsCount: topology.endpoints.length,
    }, null, 2));
  } else {
    console.log(
      lang === 'zh'
        ? `\n[Explore] 从 0 到 1 探索完成：共扫描 ${topology.pages.length} 个路由、${topology.endpoints.length} 个脱敏 API 端点，并同步更新活体知识图谱 (Revision #${codeMapSync.revision})。`
        : `\n[Explore] Zero-to-one exploration complete: ${topology.pages.length} route(s), ${topology.endpoints.length} redacted API endpoint(s), synced Living Code Map (Revision #${codeMapSync.revision}).`
    );
    console.log(`  Topology JSON : ${topologyPath}`);
    console.log(`  System Atlas  : ${overviewPath}`);
    console.log(`  Code Map MD   : ${codeMapSync.systemMapMdPath}`);
  }

  return 0;
}
