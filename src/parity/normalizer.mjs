// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_NORMALIZE_PATHS } from '../kernel/diff-oracle.mjs';
import { loadAitestConfig } from '../kernel/gate-kernel.mjs';

/**
 * @typedef {{
 *   id: string;
 *   method: string;
 *   path: string;
 *   headers: Record<string, string>;
 *   body: unknown;
 *   expectJson?: boolean;
 *   featureCohort: string[];
 * }} ParityRequestItem
 */

/**
 * Merges governance-protected `aitest.config.json#parity` settings with explicit runtime overrides.
 * Only explicit `normalizePaths` are stripped; never performs blind double-baseline auto-denoising.
 * @param {string} qaDir
 * @param {{
 *   normalizePaths?: string[];
 *   strictByteEscape?: boolean;
 *   maxLatencyRatio?: number;
 *   maxTtftRatio?: number;
 *   privacyMode?: string;
 * }} [overrides]
 */
export function resolveParityPolicy(qaDir, overrides = {}) {
  const cfg = loadAitestConfig(qaDir);
  const cfgParity = cfg.parity || {};
  const normalizePaths = [
    ...new Set([
      ...DEFAULT_NORMALIZE_PATHS,
      ...(Array.isArray(cfgParity.normalizePaths) ? cfgParity.normalizePaths : []),
      ...(Array.isArray(overrides.normalizePaths) ? overrides.normalizePaths : []),
    ]),
  ];
  const strictByteEscape =
    overrides.strictByteEscape !== undefined ? Boolean(overrides.strictByteEscape) : Boolean(cfgParity.strictByteEscape);
  const maxLatencyRatio =
    overrides.maxLatencyRatio !== undefined
      ? Number(overrides.maxLatencyRatio)
      : cfgParity.maxLatencyRatio !== undefined
        ? Number(cfgParity.maxLatencyRatio)
        : null;
  const maxTtftRatio =
    overrides.maxTtftRatio !== undefined
      ? Number(overrides.maxTtftRatio)
      : cfgParity.maxTtftRatio !== undefined
        ? Number(cfgParity.maxTtftRatio)
        : null;
  const rawPrivacy = String(overrides.privacyMode || cfgParity.privacyMode || 'redacted').toLowerCase();
  const privacyMode = /** @type {'redacted' | 'shape-only'} */ (rawPrivacy === 'shape-only' ? 'shape-only' : 'redacted');

  return {
    normalizePaths,
    strictByteEscape,
    maxLatencyRatio: Number.isFinite(maxLatencyRatio) ? maxLatencyRatio : null,
    maxTtftRatio: Number.isFinite(maxTtftRatio) ? maxTtftRatio : null,
    privacyMode,
    authStorageKeys: Array.isArray(cfgParity.authStorageKeys) ? cfgParity.authStorageKeys : [],
    failOnAuthError: cfgParity.failOnAuthError !== false,
    apiPrefixes: Array.isArray(cfg.apiPrefixes) ? cfg.apiPrefixes : [],
  };
}

/** @param {string} filePath @returns {ParityRequestItem[]} */
function parseCorpusFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  /** @type {any[]} */
  const rawItems = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));

  return rawItems
    .filter((item) => item && typeof item === 'object')
    .map((item, idx) => ({
      id: String(item.id || `req_${String(idx + 1).padStart(4, '0')}`),
      method: String(item.method || 'GET').toUpperCase(),
      path: String(item.path || item.url || '/'),
      headers: item.headers && typeof item.headers === 'object' ? item.headers : {},
      body: item.body ?? null,
      ...(item.expectJson ? { expectJson: true } : {}),
      featureCohort: Array.isArray(item.featureCohort) ? item.featureCohort.map(String) : ['corpus'],
    }));
}

/**
 * Resolves parity input requests in deterministic priority order:
 * 1. Explicit `--corpus <path>` or default `<qaDir>/corpus/sanitized-requests.jsonl`
 * 2. Explicit `--routes /a,/b`
 * 3. Auto-fallback from `qa/knowledge/api-schemas.json` or `qa/knowledge/code-map.json` GET routes (min fallback `/`)
 * @param {string} qaDir
 * @param {{ corpus?: string, routes?: string | string[] }} [options]
 * @returns {{ source: string, requests: ParityRequestItem[] }}
 */
export function loadParityRequests(qaDir, options = {}) {
  if (options.corpus) {
    const corpusPath = path.isAbsolute(options.corpus) ? options.corpus : path.resolve(qaDir, options.corpus);
    if (!fs.existsSync(corpusPath)) {
      throw new Error(`Parity corpus file not found: ${corpusPath}`);
    }
    return { source: corpusPath, requests: parseCorpusFile(corpusPath) };
  }

  const defaultCorpus = path.join(qaDir, 'corpus', 'sanitized-requests.jsonl');
  if (!options.routes && fs.existsSync(defaultCorpus)) {
    const loaded = parseCorpusFile(defaultCorpus);
    if (loaded.length > 0) return { source: defaultCorpus, requests: loaded };
  }

  if (options.routes) {
    const list = (Array.isArray(options.routes) ? options.routes : String(options.routes).split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) {
      return {
        source: 'explicit-routes',
        requests: list.map((r, idx) => ({
          id: `route_${String(idx + 1).padStart(4, '0')}`,
          method: 'GET',
          path: r.startsWith('/') ? r : `/${r}`,
          headers: {},
          body: null,
          featureCohort: ['explicit-route'],
        })),
      };
    }
  }

  /** @type {Set<string>} */
  const fallbackPaths = new Set();
  const apiSchemasPath = path.join(qaDir, 'knowledge', 'api-schemas.json');
  if (fs.existsSync(apiSchemasPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(apiSchemasPath, 'utf8'));
      for (const ep of doc?.endpoints || []) {
        if (String(ep?.method || 'GET').toUpperCase() === 'GET' && typeof ep?.pathname === 'string' && !ep.pathname.includes(':')) {
          fallbackPaths.add(ep.pathname);
        }
      }
    } catch {
      // ignore malformed knowledge cache
    }
  }

  const codeMapPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (fallbackPaths.size === 0 && fs.existsSync(codeMapPath)) {
    try {
      const cm = JSON.parse(fs.readFileSync(codeMapPath, 'utf8'));
      for (const r of Object.keys(cm?.routes || {})) {
        if (r && !r.includes(':') && !/login|404|403|401/i.test(r)) fallbackPaths.add(r);
      }
    } catch {
      // ignore
    }
  }

  if (fallbackPaths.size === 0) fallbackPaths.add('/');

  return {
    source: 'knowledge-fallback',
    requests: [...fallbackPaths].slice(0, 30).map((p, idx) => ({
      id: `auto_${String(idx + 1).padStart(4, '0')}`,
      method: 'GET',
      path: p.startsWith('/') ? p : `/${p}`,
      headers: {},
      body: null,
      featureCohort: ['auto-route'],
    })),
  };
}

/**
 * Renders a redacted or strictly zero-plaintext (`shape-only`) Markdown parity report.
 * @param {Record<string, any>} report
 * @param {'zh' | 'en' | string} [lang]
 * @returns {string}
 */
export function buildParityMarkdown(report, lang = 'zh') {
  const isZh = lang === 'zh';
  const lines = [
    isZh
      ? '# AI Test Workbench 双目标差分验证报告 (`parity`)'
      : '# AI Test Workbench Differential Parity Report (`parity`)',
    '',
    `- **Baseline**: \`${report.baselineUrl}\` · **Candidate**: \`${report.candidateUrl}\``,
    `- **Privacy Mode**: \`${report.privacyMode}\` · **Strict Byte Escape**: \`${Boolean(report.strictByteEscape)}\` · **Elapsed**: \`${report.elapsedMs}ms\``,
    `- **Parity Match Rate**: **${report.parityPct}%** (\`${report.matchedSamples}/${report.totalSamples}\`, mismatched=\`${report.mismatchedSamples}\`, clusters=\`${report.clusters.length}\`)`,
    ...(report.blockerKind ? [`- **Blocked**: \`${report.blockerKind}\` — ${report.error || ''}`] : []),
    '',
  ];

  const cohorts = Object.entries(report.cohortStats || {});
  if (cohorts.length > 0) {
    lines.push(
      isZh ? '## 1. 按特征分群匹配率 (Feature Cohorts)' : '## 1. Feature Cohort Match Rates',
      '| Feature Cohort | Total | Matched | Mismatched | Parity % |',
      '|---|---:|---:|---:|---:|'
    );
    for (const [tag, st] of cohorts) {
      lines.push(`| \`${tag}\` | ${st.total} | ${st.matched} | ${st.mismatched} | ${st.parityPct}% |`);
    }
    lines.push('');
  }

  lines.push(
    isZh ? '## 2. 去重形状指纹簇 (Shape Fingerprint Clusters)' : '## 2. Deduplicated Shape Fingerprint Clusters'
  );
  if (!Array.isArray(report.clusters) || report.clusters.length === 0) {
    lines.push(isZh ? '- 未发现 CP1..CP4 差分异常，Baseline 与 Candidate 行为一致。' : '- Zero CP1..CP4 parity mismatches detected.');
  } else {
    lines.push(
      '| Fingerprint | Checkpoint | Diff Kind | Route | Path / Piece | First Diff Byte | Byte Len (Base vs Cand) | Count |',
      '|---|---|---|---|---|---:|---|---:|'
    );
    for (const c of report.clusters) {
      lines.push(
        `| \`${c.fingerprintId}\` | \`${c.checkpoint}\` | \`${c.diffKind}\` | \`${c.routePattern}\` | \`${c.pieceOrJsonPath}\` | ${c.firstDiffByteOffset} | ${c.baselineByteLen} vs ${c.candidateByteLen} | ${c.count} |`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
