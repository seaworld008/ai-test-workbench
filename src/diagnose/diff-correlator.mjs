// @ts-check
import path from 'node:path';
import { execGitSync, resolveDefaultDiffBase } from '../kernel/gate-kernel.mjs';

const FRONTEND_PATH_RE = /^(?:src|app|web|client|frontend|components|pages|views|ui|public)\//i;
const FRONTEND_EXT_RE = /\.(?:[jt]sx?|mjs|vue|svelte|html)$/i;

/**
 * Extracts quoted string literals, JSX text fragments, and testid/aria attributes removed in diff (`-` lines).
 * @param {string} diffText
 * @returns {string[]}
 */
function extractRemovedUiTokens(diffText) {
  /** @type {Set<string>} */
  const tokens = new Set();
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const content = line.slice(1);
    for (const m of content.matchAll(/['"`]([^'"`\r\n]{3,80})['"`]/g)) {
      tokens.add(m[1].trim());
    }
    for (const m of content.matchAll(/>([^<>\r\n]{3,80})</g)) {
      const t = m[1].trim();
      if (t && !t.startsWith('{')) tokens.add(t);
    }
  }
  return [...tokens];
}

/**
 * Extracts target locator strings / expected text from a Playwright error snippet.
 * @param {string} errorText
 * @returns {string[]}
 */
function extractFailedLocatorTokens(errorText) {
  /** @type {Set<string>} */
  const wanted = new Set();
  for (const m of String(errorText || '').matchAll(/['"`]([^'"`\r\n]{3,80})['"`]/g)) {
    wanted.add(m[1].trim());
  }
  return [...wanted];
}

/**
 * Correlates ambiguous element-not-found / copy-mismatch failures (`candidates` has both `C` and `A`,
 * with zero 5xx / pageerror) against recent frontend source git diffs (`WU-04`, `A-UI-Sync`).
 *
 * @param {string} repoDir
 * @param {{ categoryCode: string, candidates?: string[] }} triage
 * @param {string} errorText
 * @param {{ serverErrors?: string[], pageErrors?: string[] } | null} [guardSignals]
 * @returns {{ matched: boolean, subCategory?: 'A-UI-Sync', matchedTokens?: string[], changedFiles?: string[] }}
 */
export function correlateFailureWithFrontendDiff(repoDir, triage, errorText, guardSignals = null) {
  const candidates = triage?.candidates || [];
  if (!candidates.includes('C') || !candidates.includes('A')) {
    return { matched: false };
  }
  if (guardSignals && ((guardSignals.serverErrors?.length || 0) > 0 || (guardSignals.pageErrors?.length || 0) > 0)) {
    return { matched: false };
  }
  if (!repoDir) return { matched: false };

  const base = resolveDefaultDiffBase(repoDir);
  if (!base.isGitRepo || !base.gitRoot || !base.resolved) {
    return { matched: false };
  }

  const failedTokens = extractFailedLocatorTokens(errorText);
  if (failedTokens.length === 0) return { matched: false };

  const diffChunks = [];
  const headDiff = execGitSync(base.gitRoot, ['diff', '-U1', `${base.resolved}...HEAD`, '--']);
  if (headDiff.status === 0 && headDiff.stdout) diffChunks.push(headDiff.stdout);
  const wtDiff = execGitSync(base.gitRoot, ['diff', '-U1', 'HEAD', '--']);
  if (wtDiff.status === 0 && wtDiff.stdout) diffChunks.push(wtDiff.stdout);
  const combined = diffChunks.join('\n');
  if (!combined.trim()) return { matched: false };

  /** @type {string[]} */
  const changedFiles = [];
  /** @type {string[]} */
  const frontendSections = [];
  let activeFile = null;
  let activeLines = [];

  for (const line of combined.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      if (activeFile && activeLines.length > 0) {
        frontendSections.push(activeLines.join('\n'));
      }
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      const candFile = m ? m[1].trim() : '';
      const isFrontend =
        candFile &&
        !candFile.startsWith('qa/') &&
        !candFile.includes('/qa/') &&
        FRONTEND_EXT_RE.test(candFile) &&
        (FRONTEND_PATH_RE.test(candFile) || !candFile.includes('server'));
      activeFile = isFrontend ? path.normalize(candFile).replace(/\\/g, '/') : null;
      activeLines = [];
      if (activeFile) changedFiles.push(activeFile);
    } else if (activeFile) {
      activeLines.push(line);
    }
  }
  if (activeFile && activeLines.length > 0) {
    frontendSections.push(activeLines.join('\n'));
  }

  if (frontendSections.length === 0) return { matched: false };

  const removedTokens = extractRemovedUiTokens(frontendSections.join('\n'));
  const matchedTokens = failedTokens.filter((ft) => {
    const fl = ft.toLowerCase();
    return removedTokens.some((rt) => {
      const rl = rt.toLowerCase();
      return rl === fl || (rl.length >= 4 && fl.includes(rl)) || (fl.length >= 4 && rl.includes(fl));
    });
  });

  if (matchedTokens.length === 0) {
    return { matched: false };
  }

  return {
    matched: true,
    subCategory: 'A-UI-Sync',
    matchedTokens: [...new Set(matchedTokens)].slice(0, 8),
    changedFiles: [...new Set(changedFiles)].slice(0, 8),
  };
}
