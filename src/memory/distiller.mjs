// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../core/redact.mjs';
import { WORKBENCH_VERSION } from '../core/version.mjs';
import { loadKnownBlockers } from './blockers.mjs';

/**
 * Theme catalog used to cluster recurring lessons from heals, defects, governance audit logs, and PR reviews.
 */
const THEME_CATALOG = [
  {
    theme: 'static-copy-shortcut',
    title: 'Forbid static copy-paste fallback shortcuts instead of real service/logic fixes',
    regex: /static[\s_-]*copy|static[\s_-]*fallback|throwaway|hardcod(?:e|ed)\s+(?:fallback|response|catalog|tool\s+description)/i,
    rulePattern: 'STATIC_FALLBACK|STATIC_COPY_FALLBACK|THROWAWAY_COPY',
    scope: /** @type {const} */ ('product'),
    guideline: 'Never hardcode static copy-paste payloads to appease tests; fix the real upstream integration or register an approved entry in `qa/known-blockers.json`.',
  },
  {
    theme: 'guess-behavior-without-source',
    title: 'Do not guess legacy/baseline behavior without consulting source or parity oracle',
    regex: /\b(?:guess(?:ed|ing)?|assumed|speculat(?:e|ed)|without\s+checking\s+source|port\s+by\s+guess)\b/i,
    rulePattern: 'TODO:\\s*guess|ASSUMED_BEHAVIOR|UNVERIFIED_PORT',
    scope: /** @type {const} */ ('product'),
    guideline: 'When porting or refactoring, verify exact behavior against baseline source and `aitest_parity` rather than guessing edge-case semantics.',
  },
  {
    theme: 'assertion-weakening-or-misheal',
    title: 'Never weaken assertions or mis-heal Class C product regressions',
    regex: /\b(?:mis-?heal|class\s*c|toBeVisible|toBeTruthy|weak(?:en|ened)|assertion\s+downgrade|skip(?:ped)?|category\s+c)\b/i,
    rulePattern: 'expect\\s*\\(\\s*true\\s*\\)\\s*\\.\\s*toBe\\s*\\(\\s*true\\s*\\)',
    scope: /** @type {const} */ ('specs'),
    guideline: 'Keep Class C product failures red and conclude with a defect report via `aitest_heal(action="conclude")`; never downgrade S4/S5 assertions.',
  },
  {
    theme: 'governance-lock-tamper',
    title: 'Never modify governance-locked files without human CLI approval',
    regex: /\b(?:governance\.lock|governance\s+tamper|protected\s+governance|unapproved\s+protected|waivers\.json)\b/i,
    rulePattern: 'testIgnore\\s*:\\s*\\[',
    scope: /** @type {const} */ ('specs'),
    guideline: 'Treat `qa/aitest.config.json`, `qa/waivers.json`, `qa/known-blockers.json`, and `qa/support/**` as immutable to agents; request human `governance approve`.',
  },
  {
    theme: 'flaky-locator-or-sync-drift',
    title: 'Use deterministic role/testId locators and web-first assertions instead of brittle selectors',
    regex: /\b(?:locator|timeout|strict\s+mode|waiting\s+for|waitForTimeout|escalated|flaky)\b/i,
    rulePattern: 'waitForTimeout\\s*\\(',
    scope: /** @type {const} */ ('specs'),
    guideline: 'Prefer accessible `getByRole`/`getByTestId` locators and web-first assertions; escalate after 3 failed Class A attempts.',
  },
  {
    theme: 'lockstep-contract-drift',
    title: 'Synchronize paired cross-stack / DTO / schema directories in lockstep',
    regex: /\b(?:lockstep|schema\s+drift|dto|out\s+of\s+sync|mirror|paired\s+directory)\b/i,
    rulePattern: 'SKIP_SCHEMA_VALIDATION',
    scope: /** @type {const} */ ('all'),
    guideline: 'Keep paired legacy/new implementations and API schemas synchronized in the same commit via `aitest.config.json#lockstepRules`.',
  },
];

/**
 * Parses a team PR review comments file (JSON array, `{ reviews/comments: [] }`, or Markdown bullet list).
 * @param {string} filePath
 * @returns {Array<{ body: string, path: string | null, author: string | null }>}
 */
export function parseReviewCommentsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Reviews input file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.reviews)
        ? parsed.reviews
        : Array.isArray(parsed.comments)
          ? parsed.comments
          : [];
    return list
      .map((/** @type {any} */ item) => ({
        body: redactSecrets(String(typeof item === 'string' ? item : item?.body || item?.comment || item?.text || '')).trim(),
        path: typeof item?.path === 'string' ? item.path.trim() : null,
        author: typeof item?.author === 'string' ? item.author.trim() : null,
      }))
      .filter((/** @type {{ body: string }} */ r) => r.body.length > 0);
  }

  // Markdown bullet / numbered list parser
  /** @type {Array<{ body: string, path: string | null, author: string | null }>} */
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (!m) continue;
    const body = redactSecrets(m[1].trim());
    if (body) out.push({ body, path: null, author: null });
  }
  return out;
}

/**
 * Classifies a signal text into a canonical memory theme.
 * @param {string} text
 */
function classifySignalTheme(text) {
  for (const entry of THEME_CATALOG) {
    if (entry.regex.test(text)) return entry;
  }
  return {
    theme: 'general-engineering-lesson',
    title: 'Recurring verification / review finding requiring explicit project guardrail',
    rulePattern: '',
    scope: /** @type {const} */ ('all'),
    guideline: 'Review recurring PR and test-failure feedback and encode explicit verification checks before merging.',
  };
}

/**
 * Generates a `@regression` Playwright spec skeleton for a Class C defect ticket.
 * @param {{ defectId: string, title: string, specFile: string | null, errorSnippet: string }} defect
 */
function buildRegressionSpecSkeleton(defect) {
  const slug = defect.defectId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'defect';
  const safeTitle = defect.title.replace(/['`\\]/g, '').slice(0, 80);
  return {
    defectId: defect.defectId,
    suggestedFile: `tests/regression/${slug}.spec.ts`,
    testTitle: `[${defect.defectId}] ${safeTitle} @regression`,
    sourceSpec: defect.specFile,
    code: [
      `import { test, expect } from '../fixtures/base';`,
      '',
      `test('[${defect.defectId}] ${safeTitle} @regression', async ({ request }) => {`,
      `  // Reproduce defect (${defect.defectId}) so it FAILS on broken baseline and PASSES after real product fix.`,
      `  const res = await request.get('/api/health');`,
      `  expect(res.status()).toBe(200);`,
      `});`,
      '',
    ].join('\n'),
  };
}

/**
 * Renders staging proposal artifacts to human-readable Markdown (`learn-proposals.md`).
 * @param {Record<string, any>} proposal
 * @param {'zh' | 'en'} [lang]
 */
export function buildLearnProposalsMarkdown(proposal, lang = 'en') {
  const isZh = lang === 'zh';
  const lines = [
    isZh
      ? '# AI Test Workbench — 记忆循环待审提案 (Staging Proposals Only)'
      : '# AI Test Workbench — Memory Loop Staging Proposals (Human Approval Required)',
    '',
    `> Generated at: ${proposal.generatedAt}`,
    isZh
      ? '> **治理护栏**：本文件仅为待审提案，**未自动修改任何受锁治理文件或 `AGENTS.md`**。请人类审阅后拷贝采纳的规则至 `qa/support/project-rules.json` 并运行人类本地审批命令。'
      : '> **Governance Guardrail**: Staging proposal ONLY — zero protected governance files or `AGENTS.md` were modified. Review, copy approved rules into `qa/support/project-rules.json`, and seal with human CLI approval.',
    '',
    `## ${isZh ? '输入源统计' : 'Source Summary'}`,
    `- Heals scanned: \`${proposal.sources.heals}\` (escalated=\`${proposal.sources.escalatedHeals}\`, misHealBlocked=\`${proposal.sources.misHealBlocked}\`)`,
    `- Defects scanned: \`${proposal.sources.defects}\` · Governance events: \`${proposal.sources.governanceEvents}\` · PR reviews: \`${proposal.sources.reviews}\` · Open known blockers: \`${proposal.sources.openKnownBlockers}\``,
    '',
    `## ${isZh ? '聚类高频模式' : 'Clustered Recurring Patterns'}`,
    '',
  ];

  if (proposal.clusters.length === 0) {
    lines.push(isZh ? '暂无可蒸馏的失败/审校记录。' : 'No recurring heal, defect, audit, or review signals found yet.', '');
  } else {
    lines.push('| Cluster | Theme | Count | Sources | Suggested Guideline |', '|---|---|---:|---|---|');
    for (const c of proposal.clusters) {
      lines.push(`| \`${c.clusterId}\` | \`${c.theme}\` | ${c.count} | ${c.sources.join(', ')} | ${c.guideline.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  lines.push(
    `## ${isZh ? '建议合入 AGENTS.md / CLAUDE.md 的受管区块' : 'Proposed Managed Block for AGENTS.md / CLAUDE.md'}`,
    '```markdown',
    proposal.managedAgentsMarkdownBlock,
    '```',
    '',
    `## ${isZh ? '候选声明式项目门禁规则 (qa/support/project-rules.json)' : 'Candidate Declarative Project Gate Rules (qa/support/project-rules.json)'}`,
    '```json',
    JSON.stringify({ schemaVersion: 1, rules: proposal.candidateRuleSpecs }, null, 2),
    '```',
    '',
    `## ${isZh ? '人类审批生效命令' : 'Human Approval Command'}`,
    '```bash',
    proposal.humanApprovalCommand,
    '```',
    ''
  );
  return lines.join('\n');
}

/**
 * Multi-source Memory Loop Distiller (`WU-D`):
 * Aggregates `.aitest/heals/*.json`, `reports/defects/*.md`, `.aitest/governance-audit.jsonl`,
 * `known-blockers.json`, and optional `--from-reviews <file>` into staging proposals ONLY.
 *
 * @param {string} qaDir
 * @param {{ fromReviews?: string, dryRun?: boolean, lang?: 'zh' | 'en' }} [options]
 */
export function distillMemoryProposals(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  /** @type {Array<{ source: string, text: string, detail: string }>} */
  const signals = [];
  const counts = {
    heals: 0,
    escalatedHeals: 0,
    misHealBlocked: 0,
    defects: 0,
    governanceEvents: 0,
    reviews: 0,
    openKnownBlockers: 0,
  };

  // 1. Scan `.aitest/heals/*.json`
  const healsDir = path.join(qaDir, '.aitest', 'heals');
  if (fs.existsSync(healsDir)) {
    for (const name of fs.readdirSync(healsDir).filter((n) => n.endsWith('.json') && n !== 'ledger.json').sort()) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(healsDir, name), 'utf8'));
        counts.heals += 1;
        const isEscalated = s.state === 'escalated' || Number(s.attemptsUsed || 0) >= 3;
        const hasMisHeal =
          Array.isArray(s.attempts) && s.attempts.some((/** @type {any} */ a) => Boolean(a?.blockedReason));
        if (isEscalated) {
          counts.escalatedHeals += 1;
          signals.push({
            source: 'heal:escalated',
            text: `${s.category || ''} ${s.title || ''} ${s.errorSnippet || ''} escalated`,
            detail: redactSecrets(`Escalated heal ${s.sessionId} (${s.specFile || s.testId})`),
          });
        }
        if (hasMisHeal || (s.categoryCode && s.categoryCode !== 'A')) {
          if (hasMisHeal) counts.misHealBlocked += 1;
          signals.push({
            source: hasMisHeal ? 'heal:misHealBlocked' : 'heal:non-a',
            text: `Class ${s.categoryCode} ${s.category || ''} ${s.errorSnippet || ''} mis-heal`,
            detail: redactSecrets(`Class ${s.categoryCode} session ${s.sessionId} on ${s.testId || s.specFile}`),
          });
        }
      } catch {
        // skip unreadable session
      }
    }
  }

  // 2. Scan `reports/defects/*.md`
  /** @type {Array<{ defectId: string, title: string, specFile: string | null, errorSnippet: string }>} */
  const defectRecords = [];
  const defectsDir = path.join(qaDir, 'reports', 'defects');
  if (fs.existsSync(defectsDir)) {
    for (const name of fs.readdirSync(defectsDir).filter((n) => n.endsWith('.md')).sort()) {
      const content = fs.readFileSync(path.join(defectsDir, name), 'utf8');
      counts.defects += 1;
      const defectId = name.replace(/\.md$/i, '');
      const titleMatch = /^#\s+(.+)$/m.exec(content);
      const specMatch = /Spec(?:\s+File)?\*?\*?:\s*`?([^\n`]+)`?/i.exec(content);
      const title = redactSecrets(titleMatch ? titleMatch[1].trim() : defectId);
      const specFile = specMatch ? specMatch[1].trim() : null;
      defectRecords.push({ defectId, title, specFile, errorSnippet: redactSecrets(content.slice(0, 400)) });
      signals.push({
        source: 'defect',
        text: `${title} ${content.slice(0, 600)}`,
        detail: `${defectId}: ${title}`,
      });
    }
  }

  // 3. Scan `.aitest/governance-audit.jsonl`
  const govLogPath = path.join(qaDir, '.aitest', 'governance-audit.jsonl');
  if (fs.existsSync(govLogPath)) {
    for (const line of fs.readFileSync(govLogPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        counts.governanceEvents += 1;
        const action = String(ev.action || ev.event || '');
        if (/block|tamper|reject|fail/i.test(action) || ev.ok === false) {
          signals.push({
            source: 'governance-audit',
            text: `governance.lock ${action} ${ev.reason || ''} ${ev.detail || ''}`,
            detail: redactSecrets(`Governance event (${action}): ${ev.reason || ev.detail || 'blocked'}`),
          });
        }
      } catch {
        // skip malformed line
      }
    }
  }

  // 4. Optional `--from-reviews <file>`
  if (options.fromReviews) {
    const reviews = parseReviewCommentsFile(options.fromReviews);
    counts.reviews = reviews.length;
    for (const r of reviews) {
      signals.push({
        source: 'pr-review',
        text: `${r.path || ''} ${r.body}`,
        detail: redactSecrets(`${r.author ? `@${r.author}: ` : ''}${r.path ? `[${r.path}] ` : ''}${r.body.slice(0, 140)}`),
      });
    }
  }

  // 5. Known blockers context
  const blockersRes = loadKnownBlockers(qaDir);
  counts.openKnownBlockers = blockersRes.openBlockers.length;

  // Cluster signals by theme
  /** @type {Map<string, { meta: ReturnType<typeof classifySignalTheme>, count: number, sources: Set<string>, examples: string[] }>} */
  const buckets = new Map();
  for (const sig of signals) {
    const meta = classifySignalTheme(sig.text);
    const cur = buckets.get(meta.theme) || { meta, count: 0, sources: new Set(), examples: [] };
    cur.count += 1;
    cur.sources.add(sig.source);
    if (cur.examples.length < 3 && !cur.examples.includes(sig.detail)) {
      cur.examples.push(sig.detail);
    }
    buckets.set(meta.theme, cur);
  }

  const clusters = [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.meta.theme.localeCompare(b.meta.theme))
    .map((b) => {
      const digest = crypto.createHash('sha256').update(b.meta.theme, 'utf8').digest('hex').slice(0, 8);
      return {
        clusterId: `mem_${digest}`,
        theme: b.meta.theme,
        title: b.meta.title,
        count: b.count,
        sources: [...b.sources].sort(),
        examples: b.examples,
        guideline: b.meta.guideline,
      };
    });

  const candidateRuleSpecs = [...buckets.values()]
    .filter((b) => b.meta.rulePattern)
    .sort((a, b) => b.count - a.count || a.meta.theme.localeCompare(b.meta.theme))
    .map((b, idx) => {
      const code = `PROJ-R${String(idx + 1).padStart(3, '0')}`;
      return {
        id: code,
        code,
        title: b.meta.title,
        description: `Distilled from ${b.count} signal(s) (${[...b.sources].sort().join(', ')})`,
        pattern: b.meta.rulePattern,
        flags: 'i',
        scope: b.meta.scope,
        severity: 'error',
        remediation: b.meta.guideline,
        sourceCount: b.count,
      };
    });

  const memoryBullets =
    clusters.length > 0
      ? clusters.map((c) => `- **${c.theme}** (${c.count}x): ${c.guideline}`)
      : ['- Keep Class C product defects red and file defect tickets via `aitest_heal(action="conclude")`.'];
  if (blockersRes.openBlockers.length > 0) {
    for (const b of blockersRes.openBlockers) {
      memoryBullets.push(
        `- **Open Blocker \`${b.id}\`** (\`${b.routePattern || 'general'}\`): ${b.reason} (track: ${b.trackingIssue || b.id}; do NOT patch with static copies).`
      );
    }
  }

  const managedAgentsMarkdownBlock = [
    '<!-- BEGIN:AITEST_PROJECT_MEMORY -->',
    '## Project Verification Memory (Human-Approved Staging Block)',
    ...memoryBullets,
    '<!-- END:AITEST_PROJECT_MEMORY -->',
  ].join('\n');

  // Generate @regression skeletons for Class C defects not already covered by a tests/regression/* spec
  const regDir = path.join(qaDir, 'tests', 'regression');
  const existingRegFiles = fs.existsSync(regDir) ? new Set(fs.readdirSync(regDir)) : new Set();
  const regressionSpecSkeletons = defectRecords
    .map(buildRegressionSpecSkeleton)
    .filter((sk) => !existingRegFiles.has(path.basename(sk.suggestedFile)));

  const proposal = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    proposalOnly: true,
    sources: counts,
    openKnownBlockers: blockersRes.openBlockers,
    clusters,
    managedAgentsMarkdownBlock,
    candidateRuleSpecs,
    regressionSpecSkeletons,
    humanApprovalCommand: `npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target <repo> --by <human> --reason "adopt memory loop project rules"`,
  };

  let proposalsJsonPath = null;
  let proposalsMdPath = null;
  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    proposalsJsonPath = path.join(reportsDir, 'learn-proposals.json');
    proposalsMdPath = path.join(reportsDir, 'learn-proposals.md');
    fs.writeFileSync(proposalsJsonPath, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
    fs.writeFileSync(proposalsMdPath, buildLearnProposalsMarkdown(proposal, lang), 'utf8');
  }

  return {
    ok: true,
    exitCode: 0,
    ...proposal,
    proposalsJsonPath,
    proposalsMdPath,
  };
}
