import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Authoritative Git & Workspace Fingerprinting Utilities (`G-07`, `G-10`, `T-05`).
 *
 * Design invariants:
 * 1. EVERY git invocation passes `-c core.quotePath=off` so non-ASCII (e.g. Chinese) paths
 *    are never octal-escaped or silently skipped.
 * 2. Repository discovery uses `git rev-parse --show-toplevel` (supports monorepo subdirs & worktrees).
 * 3. External raw unified diffs are still unquoted via `unquoteGitPath()` in case callers
 *    generated diffs without `core.quotePath=off`.
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options]
 */
export function execGitSync(cwd, args, options = {}) {
  return spawnSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
}

/**
 * Unquotes a Git C-style quoted path (e.g. `"b/\346\265\213\350\257\225/qa/playwright.config.ts"`)
 * into a clean UTF-8 string. Handles octal escapes, standard C escapes, and strips surrounding quotes.
 * @param {string} rawPath
 */
export function unquoteGitPath(rawPath) {
  let s = String(rawPath || '').trim();
  if (!s) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  if (!s.includes('\\')) return s;

  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (/[0-7]/.test(next) && i + 3 < s.length && /[0-7]{3}/.test(s.slice(i + 1, i + 4))) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      if (next === 'n') bytes.push(0x0a);
      else if (next === 'r') bytes.push(0x0d);
      else if (next === 't') bytes.push(0x09);
      else if (next === '"') bytes.push(0x22);
      else if (next === '\\') bytes.push(0x5c);
      else bytes.push(...Buffer.from(next, 'utf8'));
      i += 1;
    } else {
      bytes.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parses a `diff --git ...` header line robustly, supporting spaces, quotes, and non-ASCII paths.
 * @param {string} headerLine
 */
export function parseGitDiffHeaderPath(headerLine) {
  const rest = String(headerLine || '').replace(/^diff --git\s+/, '').trim();
  if (!rest) return 'unknown';

  // Tokenize two path tokens (either quoted "..." or unquoted non-space)
  /** @type {string[]} */
  const tokens = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    while (i < rest.length && rest[i] === ' ') i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === '\\' && j + 1 < rest.length) {
          j += 2;
        } else if (rest[j] === '"') {
          j += 1;
          break;
        } else {
          j += 1;
        }
      }
      tokens.push(unquoteGitPath(rest.slice(i, j)));
      i = j;
    } else {
      // Handle unquoted paths that might contain spaces by finding " b/" boundary
      if (tokens.length === 0) {
        const bMarker = rest.indexOf(' b/', i);
        const bQuotedMarker = rest.indexOf(' "b/', i);
        const splitIdx =
          bQuotedMarker >= 0 && (bMarker < 0 || bQuotedMarker < bMarker) ? bQuotedMarker : bMarker;
        if (splitIdx >= 0) {
          tokens.push(rest.slice(i, splitIdx));
          i = splitIdx + 1;
          continue;
        }
      }
      tokens.push(unquoteGitPath(rest.slice(i).trim()));
      break;
    }
  }

  const candidate = tokens[1] || tokens[0] || '';
  return candidate.replace(/^[ab]\//, '').replace(/\\/g, '/') || 'unknown';
}

/** @param {string} p @returns {string} */
function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Resolves the authoritative Git repository top-level root via `git rev-parse --show-toplevel`.
 * Works inside monorepo subdirectories and Git worktrees (where `.git` is a file or in a parent dir).
 * Canonicalizes via realpath to prevent Windows 8.3 short-path (`RUNNER~1`) and macOS `/var` mismatches.
 * @param {string} dir
 * @returns {string | null}
 */
export function resolveGitRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const res = execGitSync(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  if (res.status === 0 && res.stdout.trim()) {
    return canonicalPath(res.stdout.trim());
  }
  return null;
}

/**
 * Resolves current HEAD commit SHA or `'nogit'`.
 * @param {string} dir
 */
export function resolveGitHeadSha(dir) {
  if (!dir || !fs.existsSync(dir)) return 'nogit';
  const res = execGitSync(dir, ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  return 'nogit';
}

/**
 * Resolves current HEAD git tree SHA (for in-toto attestation subject binding).
 * @param {string} dir
 */
export function resolveGitTreeSha(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const res = execGitSync(dir, ['rev-parse', 'HEAD^{tree}'], { timeoutMs: 5000 });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  return null;
}

/**
 * Resolves Git user attribution (`user.email` / `user.name`) for governance audit records.
 * @param {string} dir
 */
export function resolveGitIdentity(dir) {
  if (!dir || !fs.existsSync(dir)) return { name: null, email: null };
  const nameRes = execGitSync(dir, ['config', '--get', 'user.name'], { timeoutMs: 3000 });
  const emailRes = execGitSync(dir, ['config', '--get', 'user.email'], { timeoutMs: 3000 });
  return {
    name: nameRes.status === 0 && nameRes.stdout.trim() ? nameRes.stdout.trim() : null,
    email: emailRes.status === 0 && emailRes.stdout.trim() ? emailRes.stdout.trim() : null,
  };
}

/**
 * Resolves the trustworthy diff base ref for `verify_change` (`T-05`).
 *
 * Fixes the "agent commits before verifying -> diff against HEAD is empty" bypass:
 * - Explicit `requestedBase` is strictly verified via `git rev-parse --verify`.
 * - When omitted:
 *   1. On a branch diverged from `origin/main|origin/master|main|master`, resolves `git merge-base HEAD <branch>`.
 *   2. On a clean working tree directly on the default branch (e.g. agent just committed), resolves `HEAD~1`.
 *   3. On a dirty working tree directly on the default branch, resolves `HEAD`.
 *   4. On an initial single-commit repo, resolves `HEAD`.
 *
 * @param {string} dir
 * @param {string | null | undefined} [requestedBase]
 */
export function resolveDefaultDiffBase(dir, requestedBase = null) {
  const gitRoot = resolveGitRoot(dir);
  if (!gitRoot) {
    return {
      isGitRepo: false,
      gitRoot: null,
      requested: requestedBase || null,
      resolved: null,
      strategy: 'no-git',
      sha: null,
      error: `Directory "${dir}" is not inside a Git repository.`,
    };
  }

  const headRes = execGitSync(gitRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeoutMs: 5000 });
  const headSha = headRes.status === 0 ? headRes.stdout.trim() : null;

  if (requestedBase) {
    const verify = execGitSync(gitRoot, ['rev-parse', '--verify', `${requestedBase}^{commit}`], { timeoutMs: 5000 });
    if (verify.status !== 0 || !verify.stdout.trim()) {
      return {
        isGitRepo: true,
        gitRoot,
        requested: requestedBase,
        resolved: null,
        strategy: 'invalid-ref',
        sha: null,
        error: `Requested diff base "${requestedBase}" could not be resolved to a valid commit.`,
      };
    }
    return {
      isGitRepo: true,
      gitRoot,
      requested: requestedBase,
      resolved: requestedBase,
      strategy: 'explicit',
      sha: verify.stdout.trim(),
      error: null,
    };
  }

  if (!headSha) {
    return {
      isGitRepo: true,
      gitRoot,
      requested: null,
      resolved: null,
      strategy: 'unborn-head',
      sha: null,
      error: 'Git repository has no commits yet (unborn HEAD).',
    };
  }

  // 1. Check merge-base against upstream/default protected branches
  const envBranch = process.env.AITEST_DEFAULT_BRANCH || process.env.GITHUB_BASE_REF || '';
  const candidates = [
    ...(envBranch ? [`origin/${envBranch}`, envBranch] : []),
    'origin/main',
    'origin/master',
    'main',
    'master',
  ];

  for (const cand of [...new Set(candidates)]) {
    const refVerify = execGitSync(gitRoot, ['rev-parse', '--verify', `${cand}^{commit}`], { timeoutMs: 5000 });
    if (refVerify.status !== 0) continue;
    const mb = execGitSync(gitRoot, ['merge-base', 'HEAD', cand], { timeoutMs: 5000 });
    if (mb.status === 0 && mb.stdout.trim()) {
      const mbSha = mb.stdout.trim();
      if (mbSha !== headSha) {
        return {
          isGitRepo: true,
          gitRoot,
          requested: null,
          resolved: mbSha,
          strategy: `merge-base(${cand})`,
          sha: mbSha,
          error: null,
        };
      }
    }
  }

  // 2. Check if working tree has uncommitted changes relative to HEAD
  const wtStatus = execGitSync(gitRoot, ['status', '--porcelain', '-z'], { timeoutMs: 5000 });
  const isDirty = wtStatus.status === 0 && wtStatus.stdout.length > 0;

  if (!isDirty) {
    // Clean tree on default branch -> agent may have just committed; compare against HEAD~1!
    const parentRes = execGitSync(gitRoot, ['rev-parse', '--verify', 'HEAD~1^{commit}'], { timeoutMs: 5000 });
    if (parentRes.status === 0 && parentRes.stdout.trim()) {
      return {
        isGitRepo: true,
        gitRoot,
        requested: null,
        resolved: 'HEAD~1',
        strategy: 'head-parent-clean-tree',
        sha: parentRes.stdout.trim(),
        error: null,
      };
    }
  }

  return {
    isGitRepo: true,
    gitRoot,
    requested: null,
    resolved: 'HEAD',
    strategy: isDirty ? 'dirty-worktree-vs-head' : 'initial-commit-head',
    sha: headSha,
    error: null,
  };
}

/**
 * Reads a file's contents at a specific git ref (`git show <ref>:<posixRel>`), returning `null` if absent.
 * @param {string} gitRoot
 * @param {string} ref
 * @param {string} relPosixFromGitRoot
 */
export function getFileAtGitRef(gitRoot, ref, relPosixFromGitRoot) {
  const normRel = String(relPosixFromGitRoot || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const res = execGitSync(gitRoot, ['show', `${ref}:${normRel}`], { timeoutMs: 10_000 });
  if (res.status !== 0) return null;
  return res.stdout;
}

/**
 * Lists modified (vs `diffBase`) and untracked files under `targetDir` using NUL-delimited `-z` output.
 * @param {string} gitRoot
 * @param {string} diffBase
 * @param {string} targetDir
 */
export function listChangedFilesUnderDir(gitRoot, diffBase, targetDir) {
  const realRoot = canonicalPath(gitRoot);
  const realTarget = canonicalPath(targetDir);
  const relSub = path.relative(realRoot, realTarget).replace(/\\/g, '/') || '.';

  const diffRes = execGitSync(gitRoot, ['diff', '--name-status', '-z', diffBase, '--', relSub]);
  if (diffRes.status !== 0) {
    return {
      ok: false,
      error: (diffRes.stderr || diffRes.stdout || `git diff ${diffBase} failed`).trim(),
      changed: [],
      untracked: [],
    };
  }

  /** @type {Array<{ status: string, path: string, oldPath?: string }>} */
  const changed = [];
  const rawTokens = diffRes.stdout.split('\0');
  for (let i = 0; i < rawTokens.length; i += 1) {
    const status = rawTokens[i];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = rawTokens[i + 1] || '';
      const newPath = rawTokens[i + 2] || '';
      i += 2;
      if (newPath) changed.push({ status, path: newPath.replace(/\\/g, '/'), oldPath: oldPath.replace(/\\/g, '/') });
    } else {
      const filePath = rawTokens[i + 1] || '';
      i += 1;
      if (filePath) changed.push({ status, path: filePath.replace(/\\/g, '/') });
    }
  }

  const untrackedRes = execGitSync(gitRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', relSub]);
  const untracked =
    untrackedRes.status === 0 && untrackedRes.stdout
      ? untrackedRes.stdout
          .split('\0')
          .filter(Boolean)
          .map((p) => p.replace(/\\/g, '/'))
      : [];

  return { ok: true, error: null, changed, untracked };
}
