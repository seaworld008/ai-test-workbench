import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

const WORKSPACE_HASH_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'reports',
  'playwright-report',
  'test-results',
  'knowledge',
  '.aitest',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
]);

const WORKSPACE_HASH_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|vue|svelte|html|htm|css|scss|less|yaml|yml|py|java|go|rs|rb|php|cs|kt|sql|prisma|graphql|gql)$/i;

/**
 * Executes a git command synchronously with `-c core.quotePath=off` and `shell: false`.
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

/** @param {string | Buffer} content @returns {string} */
export function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Computes a deterministic SHA-256 fingerprint of code + specs under test (`G-10`).
 * Uses `git ls-files -s -z` + dirty/untracked content hashing when inside a Git repo (O(changes) I/O),
 * and falls back to sorted filesystem traversal with broad language/config coverage outside Git.
 * @param {string} qaDir
 * @param {string} [repoDir]
 */
export function computeWorkspaceInputHash(qaDir, repoDir = path.dirname(qaDir)) {
  const hash = crypto.createHash('sha256');
  const resolvedQa = path.resolve(qaDir);
  const resolvedRepo = path.resolve(repoDir);

  const looksLikeRealHostRepo =
    resolvedRepo !== resolvedQa &&
    resolvedQa.startsWith(resolvedRepo) &&
    (path.basename(resolvedQa) === 'qa' ||
      Boolean(resolveGitRoot(resolvedRepo)) ||
      fs.existsSync(path.join(resolvedRepo, 'package.json')));

  const scanRoot = looksLikeRealHostRepo ? resolvedRepo : resolvedQa;
  const gitRoot = resolveGitRoot(scanRoot);

  if (gitRoot && (scanRoot === gitRoot || scanRoot.startsWith(`${gitRoot}${path.sep}`))) {
    const relSub = path.relative(gitRoot, scanRoot).replace(/\\/g, '/') || '.';
    const lsRes = execGitSync(gitRoot, ['ls-files', '-s', '-z', '--', relSub], { timeoutMs: 10_000 });
    if (lsRes.status === 0) {
      /** @param {string} p */
      const isIgnoredArtifact = (p) => {
        const segs = p.replace(/\\/g, '/').split('/');
        return (
          segs.some((s) => WORKSPACE_HASH_IGNORE_DIRS.has(s)) ||
          p.endsWith('.log') ||
          path.basename(p) === '.env'
        );
      };

      // 1. Tracked git blob OIDs (O(index), zero disk read for clean files)
      const trackedEntries = lsRes.stdout
        .split('\0')
        .filter(Boolean)
        .flatMap((line) => {
          const tabIdx = line.indexOf('\t');
          if (tabIdx < 0) return [];
          const meta = line.slice(0, tabIdx).trim().split(/\s+/);
          const relPath = line.slice(tabIdx + 1).replace(/\\/g, '/');
          return isIgnoredArtifact(relPath) ? [] : [{ oid: meta[1] || '', relPath }];
        })
        .sort((a, b) => a.relPath.localeCompare(b.relPath));

      for (const entry of trackedEntries) {
        hash.update(`tracked:${entry.relPath}:${entry.oid}\n`);
      }

      // 2. Overlay dirty tracked files + untracked files with live disk content hash
      const dirtyRes = execGitSync(
        gitRoot,
        ['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z', '--', relSub],
        { timeoutMs: 10_000 }
      );
      if (dirtyRes.status === 0) {
        const dirtyFiles = [...new Set(dirtyRes.stdout.split('\0').filter(Boolean))]
          .map((p) => p.replace(/\\/g, '/'))
          .filter((p) => !isIgnoredArtifact(p))
          .sort();
        for (const relPath of dirtyFiles) {
          const abs = path.join(gitRoot, relPath);
          if (!fs.existsSync(abs)) {
            hash.update(`deleted:${relPath}\n`);
            continue;
          }
          try {
            const stat = fs.statSync(abs);
            if (stat.isFile()) {
              const content =
                stat.size <= 2 * 1024 * 1024
                  ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
                  : `size:${stat.size}:mtime:${stat.mtimeMs}`;
              hash.update(`dirty:${relPath}:${sha256Hex(content)}\n`);
            }
          } catch {
            // transient file
          }
        }
      }

      return `sha256:${hash.digest('hex')}`;
    }
  }

  // Non-Git fallback traversal
  const ignoreDirs = new Set(WORKSPACE_HASH_IGNORE_DIRS);
  /** @param {string} dir @param {string} prefix @param {{ count: number }} state */
  const walk = (dir, prefix, state) => {
    if (!dir || !fs.existsSync(dir) || state.count > 10_000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      if (entry.name === '.env' || entry.name.endsWith('.log')) continue;
      const full = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel, state);
      } else if (
        entry.isFile() &&
        (WORKSPACE_HASH_EXT_RE.test(entry.name) || entry.name === '.gitignore' || entry.name === '.env.example')
      ) {
        try {
          const stat = fs.statSync(full);
          state.count += 1;
          hash.update(`${rel}:`);
          if (stat.size <= 2 * 1024 * 1024) {
            hash.update(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
          } else {
            hash.update(`size:${stat.size}`);
          }
          hash.update('\n');
        } catch {
          // ignore transient file
        }
      }
    }
  };

  const state = { count: 0 };
  walk(resolvedQa, 'qa', state);
  if (looksLikeRealHostRepo) {
    const qaFolderName = path.relative(resolvedRepo, resolvedQa).split(/[\\/]/)[0];
    ignoreDirs.add(qaFolderName);
    walk(resolvedRepo, 'repo', state);
  }
  return `sha256:${hash.digest('hex')}`;
}
