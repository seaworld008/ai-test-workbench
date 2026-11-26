// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeSourceAst,
  canonicalFsPath,
  getFileAtGitRef,
  listChangedFilesUnderDir,
  loadAitestConfig,
  loadAndValidateWaivers,
} from '../kernel/gate-kernel.mjs';

const SHORTCUT_MIN_CHARS = 300;
const EXPIRING_WAIVER_DAYS = 3;
const REAL_IO_OR_DB_CALL_RE =
  /\b(?:fetch\s*\(|https?\.request\s*\(|axios\b|prisma\.|knex\b|drizzle\b|pool\.query\s*\(|db\.(?:query|select|insert|update|delete|execute|run|get|all)\b|createConnection\s*\(|createPool\s*\(|MongoClient\b|redis\.|SELECT\s+.+\s+FROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b)/i;

/**
 * Extracts `S4/S5 -> S4/S5` same-tier expected literal shifts across modified spec files in the current diff
 * so humans at the inner/outer seam can distinguish legitimate requirement changes from bug-catering edits.
 *
 * @param {string} qaDir
 * @param {{ isGitRepo?: boolean, gitRoot?: string | null, resolved?: string | null } | null | undefined} baseResolution
 */
export function extractS5LiteralShifts(qaDir, baseResolution) {
  /** @type {Array<{ file: string, line: number, testTitle: string, matcher: string, actualExpr: string, baseExpected: string, headExpected: string }>} */
  const shifts = [];
  if (!baseResolution?.isGitRepo || !baseResolution.gitRoot || !baseResolution.resolved) return shifts;

  const realQaDir = canonicalFsPath(qaDir);
  const realGitRoot = canonicalFsPath(baseResolution.gitRoot);
  const ch = listChangedFilesUnderDir(realGitRoot, baseResolution.resolved, realQaDir);
  if (!ch.ok) return shifts;

  const cfg = loadAitestConfig(qaDir);
  const astOpts = {
    assertFunctionNames: cfg.assertFunctionNames,
    customMatchers: cfg.customMatchers || {},
    qaDir,
    wrapInAsyncFn: false,
  };

  for (const item of ch.changed) {
    const absPath = path.join(realGitRoot, item.path);
    const relInsideQa = path.relative(realQaDir, absPath).replace(/\\/g, '/');
    if (!/\.(?:spec|test)\.[jt]sx?$/i.test(relInsideQa)) continue;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
    const baseSrc = item.status !== 'A' ? getFileAtGitRef(realGitRoot, baseResolution.resolved, item.oldPath || item.path) || '' : '';
    if (!baseSrc) continue;
    const headSrc = fs.readFileSync(absPath, 'utf8');

    const baseSum = analyzeSourceAst(relInsideQa, baseSrc, astOpts);
    const headSum = analyzeSourceAst(relInsideQa, headSrc, astOpts);
    if (!baseSum.usedAst || !headSum.usedAst) continue;

    /** @type {Map<string, Array<{ expectedArg: string, matcher: string, actualExpr: string, line: number, testTitle: string }>>} */
    const baseByKey = new Map();
    for (const a of baseSum.assertions) {
      if (a.tier < 4 || a.isTautology) continue;
      const exp = String(a.expectedArg || '').trim();
      if (!exp) continue;
      const key = `${a.testTitle || ''}||${a.matcher}||${String(a.actualExpr || '').replace(/\s+/g, '')}`;
      const arr = baseByKey.get(key) || [];
      arr.push({ expectedArg: exp, matcher: a.matcher, actualExpr: a.actualExpr || '', line: a.line, testTitle: a.testTitle || '<top-level>' });
      baseByKey.set(key, arr);
    }

    /** @type {Map<string, Array<{ expectedArg: string, matcher: string, actualExpr: string, line: number, testTitle: string }>>} */
    const headByKey = new Map();
    for (const a of headSum.assertions) {
      if (a.tier < 4 || a.isTautology) continue;
      const exp = String(a.expectedArg || '').trim();
      if (!exp) continue;
      const key = `${a.testTitle || ''}||${a.matcher}||${String(a.actualExpr || '').replace(/\s+/g, '')}`;
      const arr = headByKey.get(key) || [];
      arr.push({ expectedArg: exp, matcher: a.matcher, actualExpr: a.actualExpr || '', line: a.line, testTitle: a.testTitle || '<top-level>' });
      headByKey.set(key, arr);
    }

    for (const [key, headArr] of headByKey.entries()) {
      const baseArr = baseByKey.get(key);
      if (!baseArr || baseArr.length === 0) continue;
      const count = Math.min(baseArr.length, headArr.length);
      for (let i = 0; i < count; i += 1) {
        if (baseArr[i].expectedArg !== headArr[i].expectedArg) {
          shifts.push({
            file: relInsideQa,
            line: headArr[i].line,
            testTitle: headArr[i].testTitle,
            matcher: headArr[i].matcher,
            actualExpr: headArr[i].actualExpr,
            baseExpected: baseArr[i].expectedArg.slice(0, 80),
            headExpected: headArr[i].expectedArg.slice(0, 80),
          });
        }
      }
    }
  }
  return shifts;
}

/**
 * Extracts large static string/JSON/data literals (`>= 300` chars) from source text.
 * @param {string} sourceText
 */
function findLargeStaticLiterals(sourceText) {
  /** @type {Array<{ line: number, charLength: number, kind: string, signature: string, preview: string }>} */
  const hits = [];
  const text = String(sourceText || '');
  const patterns = [
    { kind: 'long-template-or-string-literal', re: /`[\s\S]{300,}?`|"(?:[^"\\]|\\.){300,}"|'(?:[^'\\]|\\.){300,}'/g },
    { kind: 'large-inline-json-blob', re: /(?:const|let|var|export\s+const)\s+[A-Za-z0-9_$]+\s*=\s*(?:\[\s*\{[\s\S]{300,}?\}\s*\]|\{\s*["'][A-Za-z0-9_$-]+["']\s*:[\s\S]{300,}?\})/g },
  ];
  for (const pat of patterns) {
    for (const m of text.matchAll(pat.re)) {
      const raw = m[0];
      if (raw.length < SHORTCUT_MIN_CHARS) continue;
      const idx = m.index ?? 0;
      const line = text.slice(0, idx).split(/\r?\n/).length;
      const sig = `${pat.kind}:${raw.slice(0, 80)}:${raw.length}`;
      hits.push({
        line,
        charLength: raw.length,
        kind: pat.kind,
        signature: sig,
        preview: raw.replace(/\s+/g, ' ').slice(0, 100),
      });
    }
  }
  return hits;
}

/**
 * Detects suspected throwaway static-copy shortcuts in modified product source files (`WU-F`):
 * newly added large static JSON / long string literals (`>= 300` chars) in files without real network/DB calls.
 *
 * @param {string} qaDir
 * @param {string} repoDir
 * @param {{ isGitRepo?: boolean, gitRoot?: string | null, resolved?: string | null } | null | undefined} baseResolution
 */
export function detectSuspectedShortcuts(qaDir, repoDir, baseResolution) {
  /** @type {Array<{ file: string, line: number, charLength: number, kind: string, preview: string, reason: string }>} */
  const suspected = [];
  if (!baseResolution?.isGitRepo || !baseResolution.gitRoot || !baseResolution.resolved) return suspected;

  const realQaDir = canonicalFsPath(qaDir);
  const realGitRoot = canonicalFsPath(baseResolution.gitRoot);
  const ch = listChangedFilesUnderDir(realGitRoot, baseResolution.resolved, realGitRoot);
  if (!ch.ok) return suspected;

  const items = [
    ...ch.changed.map((c) => ({ rel: c.path, status: c.status, oldRel: c.oldPath || c.path })),
    ...ch.untracked.map((p) => ({ rel: p, status: 'U', oldRel: null })),
  ];

  for (const item of items) {
    const normRel = item.rel.replace(/\\/g, '/');
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(normRel)) continue;
    const absPath = path.join(realGitRoot, item.rel);
    const relFromQa = path.relative(realQaDir, absPath).replace(/\\/g, '/');
    if (!relFromQa.startsWith('..')) continue;
    if (/^(?:qa|test|tests|bench|scripts|docs|reports|\.aitest|node_modules)\//i.test(normRel)) continue;
    if (/\.(?:spec|test)\.[jt]sx?$/i.test(normRel)) continue;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;

    const headSrc = fs.readFileSync(absPath, 'utf8');
    if (REAL_IO_OR_DB_CALL_RE.test(headSrc)) continue;

    const baseSrc =
      item.oldRel && item.status !== 'A' && item.status !== 'U'
        ? getFileAtGitRef(realGitRoot, baseResolution.resolved, item.oldRel) || ''
        : '';
    const baseSigs = new Set(findLargeStaticLiterals(baseSrc).map((h) => h.signature));
    const headHits = findLargeStaticLiterals(headSrc);
    for (const h of headHits) {
      if (baseSigs.has(h.signature)) continue;
      suspected.push({
        file: normRel,
        line: h.line,
        charLength: h.charLength,
        kind: h.kind,
        preview: h.preview,
        reason: `Added ${h.charLength}-char static literal in file without network/DB calls — verify this is not a throwaway static-copy shortcut.`,
      });
      break;
    }
  }
  return suspected;
}

/**
 * Finds active waivers expiring within `withinDays` days (default: 3 days).
 * @param {string} qaDir
 * @param {number} [nowMs]
 * @param {number} [withinDays]
 */
export function collectExpiringWaivers(qaDir, nowMs = Date.now(), withinDays = EXPIRING_WAIVER_DAYS) {
  const waiversPath = path.join(qaDir, 'waivers.json');
  const cfg = loadAitestConfig(qaDir);
  const res = loadAndValidateWaivers(waiversPath, nowMs, {
    maxWaiverDays: cfg.maxWaiverDays,
    maxWaivers: cfg.maxWaivers,
    legacyCompat: true,
  });
  const thresholdMs = withinDays * 24 * 60 * 60 * 1000;
  return res.activeWaivers
    .map((w) => {
      const expMs = Date.parse(String(w.expiresAt || ''));
      const remainingMs = expMs - nowMs;
      return {
        target: String(w.testId || w.titlePattern || w.filePattern || 'unknown'),
        owner: String(w.owner || 'unknown'),
        expiresAt: String(w.expiresAt || ''),
        remainingHours: Math.max(0, Math.round((remainingMs / (60 * 60 * 1000)) * 10) / 10),
        reason: String(w.reason || ''),
        remainingMs,
      };
    })
    .filter((w) => Number.isFinite(w.remainingMs) && w.remainingMs > 0 && w.remainingMs <= thresholdMs)
    .map(({ remainingMs: _omit, ...rest }) => rest);
}

/**
 * Builds the structured `seamReview` payload (`Human Seam Gatekeeper Card`, `WU-F`) for `verdictPayload`.
 * @param {{
 *   qaDir: string;
 *   repoDir: string;
 *   baseResolution?: { isGitRepo?: boolean, gitRoot?: string | null, resolved?: string | null } | null;
 *   verdictPayload: Record<string, any>;
 *   nowMs?: number;
 * }} params
 */
export function buildSeamGatekeeperCard({ qaDir, repoDir, baseResolution, verdictPayload, nowMs = Date.now() }) {
  const s5LiteralShifts = extractS5LiteralShifts(qaDir, baseResolution);
  const suspectedShortcuts = detectSuspectedShortcuts(qaDir, repoDir, baseResolution);
  const expiringWaivers = collectExpiringWaivers(qaDir, nowMs, EXPIRING_WAIVER_DAYS);

  /** @type {Map<string, { blockerId: string, reason: string, count: number, testIds: string[] }>} */
  const blockerMap = new Map();
  for (const f of verdictPayload?.failures || []) {
    if (!f?.linkedKnownBlockerId) continue;
    const cur = blockerMap.get(f.linkedKnownBlockerId) || {
      blockerId: f.linkedKnownBlockerId,
      reason: String(f.knownBlockerReason || ''),
      count: 0,
      testIds: /** @type {string[]} */ ([]),
    };
    cur.count += 1;
    if (f.testId) cur.testIds.push(String(f.testId));
    blockerMap.set(f.linkedKnownBlockerId, cur);
  }
  const linkedKnownBlockers = [...blockerMap.values()];

  const ps = verdictPayload?.paritySummary || null;
  const parityCohortSummary = ps
    ? {
        parityPct: ps.parityPct ?? 100,
        totalSamples: ps.totalSamples ?? 0,
        matchedSamples: ps.matchedSamples ?? 0,
        mismatchedSamples: ps.mismatchedSamples ?? 0,
        clusterCount: ps.clusterCount ?? 0,
        cohortStats: ps.cohortStats || {},
      }
    : null;

  const hasAttentionItems =
    s5LiteralShifts.length > 0 ||
    suspectedShortcuts.length > 0 ||
    expiringWaivers.length > 0 ||
    linkedKnownBlockers.length > 0 ||
    Boolean(parityCohortSummary && parityCohortSummary.mismatchedSamples > 0);

  return {
    hasAttentionItems,
    s5LiteralShifts,
    suspectedShortcuts,
    expiringWaivers,
    linkedKnownBlockers,
    parityCohortSummary,
  };
}

/**
 * Renders the Human Seam Gatekeeper Card section for `verdict-summary.md`.
 * @param {ReturnType<typeof buildSeamGatekeeperCard> | null | undefined} seamReview
 * @param {'zh' | 'en' | string} [lang]
 * @returns {string[]}
 */
export function renderSeamGatekeeperMarkdown(seamReview, lang = 'zh') {
  if (!seamReview) return [];
  const isZh = lang === 'zh';
  const lines = [
    isZh
      ? '### 内外环交界人工必审焦点 (Human Seam Gatekeeper Card)'
      : '### Human Seam Gatekeeper Card (Inner/Outer Seam Review)',
  ];

  if (!seamReview.hasAttentionItems && !seamReview.parityCohortSummary) {
    lines.push(
      isZh
        ? '- 未检出 S4/S5 同阶字面量翻转、疑似静态拷贝捷径、3 天内到期豁免或关联已知阻塞单。'
        : '- No S4/S5 literal shifts, suspected static-copy shortcuts, expiring waivers (<=3d), or linked known blockers detected.',
      ''
    );
    return lines;
  }

  if (seamReview.s5LiteralShifts.length > 0) {
    lines.push(
      isZh
        ? `- **S4/S5 同阶预期字面量变更 (\`${seamReview.s5LiteralShifts.length}\`)** — 请人工核验属于合法需求变更而非迎合缺陷改测试：`
        : `- **S4/S5 Same-Tier Literal Shifts (\`${seamReview.s5LiteralShifts.length}\`)** — confirm intentional requirement change vs bug-catering edit:`
    );
    for (const s of seamReview.s5LiteralShifts.slice(0, 10)) {
      lines.push(`  - \`${s.file}:${s.line}\` (${s.testTitle}): \`${s.matcher}\` \`${s.baseExpected}\` → \`${s.headExpected}\``);
    }
  }

  if (seamReview.suspectedShortcuts.length > 0) {
    lines.push(
      isZh
        ? `- **疑似静态拷贝捷径 (\`${seamReview.suspectedShortcuts.length}\`)** — 新增 >=300 字符静态字面量且文件无网络/DB 调用：`
        : `- **Suspected Throwaway Static-Copy Shortcuts (\`${seamReview.suspectedShortcuts.length}\`)** — >=300-char static literal without network/DB calls:`
    );
    for (const sc of seamReview.suspectedShortcuts.slice(0, 5)) {
      lines.push(`  - \`${sc.file}:${sc.line}\` (${sc.charLength} chars, \`${sc.kind}\`): ${sc.reason}`);
    }
  }

  if (seamReview.expiringWaivers.length > 0) {
    lines.push(
      isZh
        ? `- **3 天内到期豁免 (\`${seamReview.expiringWaivers.length}\`)**：`
        : `- **Waivers Expiring Within 3 Days (\`${seamReview.expiringWaivers.length}\`)**:`
    );
    for (const w of seamReview.expiringWaivers) {
      lines.push(`  - \`${w.target}\` (owner=\`${w.owner}\`, expires=\`${w.expiresAt}\`, remaining=\`${w.remainingHours}h\`)`);
    }
  }

  if (seamReview.linkedKnownBlockers.length > 0) {
    lines.push(
      isZh
        ? `- **关联已知阻塞单 (\`${seamReview.linkedKnownBlockers.length}\`)**：`
        : `- **Linked Open Known Blockers (\`${seamReview.linkedKnownBlockers.length}\`)**:`
    );
    for (const b of seamReview.linkedKnownBlockers) {
      lines.push(`  - \`${b.blockerId}\` (${b.count} failure(s)): ${b.reason}`);
    }
  }

  if (seamReview.parityCohortSummary) {
    const p = seamReview.parityCohortSummary;
    const cohortTxt = Object.entries(p.cohortStats || {})
      .map(([k, v]) => `${k}=${v.parityPct}% (${v.matched}/${v.total})`)
      .join(', ');
    lines.push(
      `- **Differential Parity Cohort Summary**: \`${p.parityPct}%\` (${p.matchedSamples}/${p.totalSamples}, clusters=\`${p.clusterCount}\`)${cohortTxt ? ` — ${cohortTxt}` : ''}`
    );
  }

  lines.push('');
  return lines;
}
