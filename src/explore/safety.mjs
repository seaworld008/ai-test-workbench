// @ts-check
import { evaluateExploreRequestSafety } from '../origin-guard.mjs';
import { redactSecrets } from '../core/redact.mjs';

export const MAX_EXPLORE_PAGES = 500;
export const DEFAULT_EXPLORE_PAGES = 60;

const MUTATION_LABEL_RE =
  /(新增|添加|创建|新建|修改|编辑|更新|删除|移除|清空|导入|导出|审核|审批|通过|驳回|停用|启用|发布|退费|退款|缴费|支付|下单|提交|发送|获取验证码|退出|注销|取消|保存|重置密码|create|add|new|edit|update|save|delete|remove|import|export|approve|reject|audit|disable|enable|publish|refund|pay|submit|send|logout|sign[ \t]{0,8}out)/i;

const READONLY_LABEL_RE =
  /(搜索|查询|检索|重置|刷新|查看|详情|明细|展开|收起|折叠|预览|筛选|返回|关闭|search|query|reset|refresh|view|detail|expand|collapse|preview|filter|back|close|more)/i;

const SAFE_READONLY_DIALOG_RE =
  /^(查看|详情|明细|预览|查看详情|查看明细|基本信息|数据统计|成员|名单|二维码|记录|view|detail|details|preview|inspect|info)$/i;

const SENSITIVE_QUERY_KEY_RE =
  /(token|key|secret|password|passwd|pwd|mobile|phone|tel|idcard|card|email|code|ticket|auth|session|cookie|sig|sign)/i;

export { evaluateExploreRequestSafety };

/** @param {string} label */
export function classifyActionSafety(label) {
  const clean = String(label || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'unknown';
  if (MUTATION_LABEL_RE.test(clean)) return 'mutation';
  if (READONLY_LABEL_RE.test(clean)) return 'readonly';
  return 'unknown';
}

/**
 * Strictly whitelists read-only detail/preview dialog or drawer triggers while hard-blocking
 * any mutation label. Paired with the network-level default-deny read-only explore firewall.
 * @param {string} label
 */
export function isSafeReadonlyDialogTrigger(label) {
  const compact = String(label || '').replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > 24) return false;
  if (MUTATION_LABEL_RE.test(compact)) return false;
  return SAFE_READONLY_DIALOG_RE.test(compact.replace(/\s+/g, '')) || SAFE_READONLY_DIALOG_RE.test(compact);
}

/**
 * Domain-stratified round-robin BFS queue so multi-module SaaS exploration covers every
 * top-level domain evenly (e.g. /teach, /live, /student, /finance, /admin) rather than
 * exhausting maxPages inside the first module.
 */
export function createStratifiedRouteQueue() {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const bucketOrder = [];
  let cursor = 0;

  const getDomainKey = (/** @type {string} */ route) => {
    const clean = String(route || '/').split('?')[0].replace(/^\/+/, '');
    if (!clean) return '/';
    return `/${clean.split('/')[0]}`;
  };

  return {
    /** @param {string} route */
    enqueue(route) {
      const normalized = String(route || '/');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      const key = getDomainKey(normalized);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
        bucketOrder.push(key);
      }
      bucket.push(normalized);
      return true;
    },
    dequeue() {
      const totalBuckets = bucketOrder.length;
      if (totalBuckets === 0) return null;
      for (let i = 0; i < totalBuckets; i += 1) {
        const idx = (cursor + i) % totalBuckets;
        const key = bucketOrder[idx];
        const list = buckets.get(key);
        if (list && list.length > 0) {
          cursor = (idx + 1) % totalBuckets;
          return list.shift() ?? null;
        }
      }
      return null;
    },
    size() {
      let n = 0;
      for (const list of buckets.values()) n += list.length;
      return n;
    },
    domains() {
      return [...bucketOrder];
    },
  };
}

/** @param {string} rawUrl */
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

/** @param {string} rawUrl */
export function detectUrlQueryAnomalies(rawUrl) {
  const input = String(rawUrl || '');
  const anomalies = [];
  if (/(?:\[|%5B)\$[a-zA-Z0-9_]{1,64}(?:\]|%5D)=/i.test(input)) {
    anomalies.push('Serialized date/object internals in query parameters (e.g. dayjs [$L]/[$d])');
  }
  if (/\[object Object\]|%5Bobject%20Object%5D/i.test(input)) {
    anomalies.push('Literal [object Object] serialized in URL query');
  }
  if (/[?&][^=&?\s]{1,128}=undefined(?:&|$)/i.test(input)) {
    anomalies.push('Literal "undefined" passed as URL query parameter');
  }
  return anomalies;
}

/**
 * Detects wrapped business-envelope errors inside HTTP 200 JSON responses common in enterprise
 * Spring Boot / RuoYi / Yudao / AntD Pro gateways (e.g. HTTP 200 + `{"code": 401, "msg": "..."}`).
 * @param {number} httpStatus
 * @param {any} body
 */
export function detectEnvelopeBusinessError(httpStatus, body) {
  if (httpStatus >= 500) {
    return { isError: true, code: httpStatus, message: `HTTP ${httpStatus}` };
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const code = typeof body.code === 'number' ? body.code : null;
    if (code !== null && code >= 400 && code < 600) {
      const msg = String(body.msg || body.message || body.error || `Envelope code ${code}`).slice(0, 160);
      return { isError: true, code, message: redactSecrets(msg) };
    }
  }
  return { isError: false, code: null, message: null };
}

/**
 * Extracts navigable static paths from Vue Router / Vuex permission trees (RuoYi / Yudao / ElementUI).
 * Skips `hidden: true`, parameterized `:id` segments, wildcards `*`, and external URLs.
 * @param {Array<any>} routeTrees
 */
export function extractVueDynamicRoutes(routeTrees = []) {
  /** @type {Set<string>} */
  const out = new Set();
  /** @param {any[]} routes @param {string} [prefix] */
  const walk = (routes, prefix = '') => {
    for (const r of routes || []) {
      if (!r || r.hidden) continue;
      const rawPath = typeof r.path === 'string' ? r.path.trim() : '';
      if (!rawPath || rawPath.includes('*') || rawPath.includes(':') || /^https?:\/\//i.test(rawPath)) {
        if (Array.isArray(r.children) && r.children.length > 0 && !rawPath.includes(':')) {
          walk(r.children, prefix);
        }
        continue;
      }
      const full = (rawPath.startsWith('/') ? rawPath : `${prefix.replace(/\/$/, '')}/${rawPath}`).replace(/\/+/g, '/');
      if (Array.isArray(r.children) && r.children.length > 0) {
        walk(r.children, full);
      } else if (full && full !== '/') {
        out.add(full);
      }
    }
  };
  for (const tree of routeTrees) {
    if (Array.isArray(tree)) walk(tree, '');
  }
  return [...out];
}

/** @param {{ route?: string, actualPath?: string, tableHeaders?: string[], filterLabels?: string[], buttons?: string[], hasPasswordInput?: boolean, hasChart?: boolean, hasTable?: boolean }} [pageInfo] */
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

/** @param {string} routePath */
export function routeToSafeSlug(routePath) {
  const clean = String(routePath || '/')
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/(?<!\/)\/+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-');
  return clean || 'root';
}

/**
 * Redacts both secrets AND PII (email, mobile numbers, 18-digit national IDs, 13-19 digit PANs)
 * and neutralizes Markdown triple-backtick fence escapes from untrusted DOM/ARIA content (`E-04`).
 * Bounded matchers prevent polynomial ReDoS on pathological inputs.
 * @param {string} raw
 */
export function sanitizeUntrustedDomText(raw) {
  let out = redactSecrets(String(raw || ''));
  out = out.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, '[REDACTED_EMAIL]');
  out = out.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]');
  out = out.replace(/\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
  out = out.replace(/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '[REDACTED_ID]');
  out = out.replace(/(?<!\d)(?:\d[ -]?){15,19}(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 15 && digits.length <= 19 ? '[REDACTED_CARD]' : m;
  });
  out = out.replace(/```/g, '` ` `');
  return out;
}
