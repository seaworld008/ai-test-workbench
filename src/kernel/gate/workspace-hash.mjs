// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadAndValidateAitestConfigFile } from '../../core/config.mjs';
import { canonicalFsPath, execGitSync, isPathGitIgnored, resolveGitRoot } from './git-utils.mjs';

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

/** @param {string | Buffer} content @returns {string} */
export function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Walks `dir` deterministically and feeds matching source/config file digests into `hash`.
 * @param {crypto.Hash} hash
 * @param {string} dir
 * @param {string} prefix
 * @param {Set<string>} ignoreDirs
 * @param {{ count: number }} state
 */
function walkDirectoryIntoHash(hash, dir, prefix, ignoreDirs, state) {
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
      walkDirectoryIntoHash(hash, full, rel, ignoreDirs, state);
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
}

/**
 * Deterministic filesystem tree SHA-256 hash (`sha256:...`) for non-Git or gitignored directories.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string}
 */
export function computeNonGitDirectoryHash(dir, prefix = 'dir') {
  const hash = crypto.createHash('sha256');
  const resolved = canonicalFsPath(dir);
  walkDirectoryIntoHash(hash, resolved, prefix, new Set(WORKSPACE_HASH_IGNORE_DIRS), { count: 0 });
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Feeds `git ls-files` + dirty/untracked file hashes under `scanDir` into `hash`.
 * Returns `false` if `scanDir` is not inside `gitRoot`, is gitignored, or `git ls-files` fails.
 * @param {crypto.Hash} hash
 * @param {string} gitRoot
 * @param {string} scanDir
 * @param {string} [scopeLabel]
 * @param {string[]} [excludeTopSegments]
 * @returns {boolean}
 */
function hashGitTrackedDirInto(hash, gitRoot, scanDir, scopeLabel = '', excludeTopSegments = []) {
  const gitRootWithSep = gitRoot.endsWith(path.sep) ? gitRoot : `${gitRoot}${path.sep}`;
  if (scanDir !== gitRoot && !scanDir.startsWith(gitRootWithSep)) return false;
  if (isPathGitIgnored(scanDir, gitRoot)) return false;

  const relSub = path.relative(gitRoot, scanDir).replace(/\\/g, '/') || '.';
  const lsRes = execGitSync(gitRoot, ['ls-files', '-s', '-z', '--', relSub], { timeoutMs: 10_000 });
  if (lsRes.status !== 0) return false;

  const relSubPrefix = relSub === '.' ? '' : `${relSub}/`;
  const excludedSet = new Set(excludeTopSegments.filter(Boolean));

  /** @param {string} p */
  const isIgnoredArtifact = (p) => {
    const norm = p.replace(/\\/g, '/');
    const segs = norm.split('/');
    if (segs.some((s) => WORKSPACE_HASH_IGNORE_DIRS.has(s))) return true;
    if (norm.endsWith('.log') || path.basename(norm) === '.env') return true;
    if (excludedSet.size > 0) {
      const underScan = relSubPrefix && norm.startsWith(relSubPrefix) ? norm.slice(relSubPrefix.length) : norm;
      const top = underScan.split('/')[0];
      if (excludedSet.has(top)) return true;
    }
    return false;
  };

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

  const tagPrefix = scopeLabel ? `${scopeLabel}:` : '';
  for (const entry of trackedEntries) {
    hash.update(`${tagPrefix}tracked:${entry.relPath}:${entry.oid}\n`);
  }

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
        hash.update(`${tagPrefix}deleted:${relPath}\n`);
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          const content =
            stat.size <= 2 * 1024 * 1024
              ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
              : `size:${stat.size}:mtime:${stat.mtimeMs}`;
          hash.update(`${tagPrefix}dirty:${relPath}:${sha256Hex(content)}\n`);
        }
      } catch {
        // transient file
      }
    }
  }
  return true;
}

/**
 * Resolves valid configured `aitest.config.json#sourceRepos` paths distinct from `resolvedQa` and `resolvedRepo`.
 * @param {string} resolvedQa
 * @param {string} resolvedRepo
 * @returns {string[]}
 */
function resolveExternalSourceRepos(resolvedQa, resolvedRepo) {
  if (!fs.existsSync(path.join(resolvedQa, 'aitest.config.json'))) return [];
  const cfgRes = loadAndValidateAitestConfigFile(resolvedQa);
  const rawRepos = Array.isArray(cfgRes.config?.sourceRepos) ? cfgRes.config.sourceRepos : [];
  if (rawRepos.length === 0) return [];
  const seen = new Set([resolvedQa, resolvedRepo]);
  /** @type {string[]} */
  const out = [];
  for (const raw of rawRepos) {
    const candidateFromRepo = path.resolve(resolvedRepo, raw);
    const candidateFromQa = path.resolve(resolvedQa, raw);
    const chosen = fs.existsSync(candidateFromRepo) ? candidateFromRepo : candidateFromQa;
    const canon = canonicalFsPath(chosen);
    if (!seen.has(canon) && fs.existsSync(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

/**
 * Computes a deterministic SHA-256 fingerprint of code + specs under test (`G-10`).
 * Uses `git ls-files -s -z` + dirty/untracked content hashing when inside a tracked Git repo (O(changes) I/O),
 * and immediately falls back to sorted filesystem traversal when outside Git or when the directory
 * (e.g., `.sandbox/<ws>/qa` or a `.gitignore`d `qa/` folder) is gitignored by an ancestor repository.
 * @param {string} qaDir
 * @param {string} [repoDir]
 * @returns {string}
 */
export function computeWorkspaceInputHash(qaDir, repoDir = path.dirname(qaDir)) {
  const hash = crypto.createHash('sha256');
  const resolvedQa = canonicalFsPath(qaDir);
  const resolvedRepo = canonicalFsPath(repoDir);

  const repoWithSep = resolvedRepo.endsWith(path.sep) ? resolvedRepo : `${resolvedRepo}${path.sep}`;
  const looksLikeRealHostRepo =
    resolvedRepo !== resolvedQa &&
    resolvedQa.startsWith(repoWithSep) &&
    (path.basename(resolvedQa) === 'qa' ||
      Boolean(resolveGitRoot(resolvedRepo)) ||
      fs.existsSync(path.join(resolvedRepo, 'package.json')));

  const externalRepos = resolveExternalSourceRepos(resolvedQa, resolvedRepo);
  const qaGitRoot = resolveGitRoot(resolvedQa);
  const qaIsGitIgnored = Boolean(qaGitRoot && isPathGitIgnored(resolvedQa, qaGitRoot));
  const repoGitRoot = looksLikeRealHostRepo ? resolveGitRoot(resolvedRepo) : null;
  const repoIsGitIgnored = Boolean(repoGitRoot && isPathGitIgnored(resolvedRepo, repoGitRoot));
  const state = { count: 0 };

  if (!qaIsGitIgnored && !repoIsGitIgnored) {
    const scanRoot = looksLikeRealHostRepo ? resolvedRepo : resolvedQa;
    const gitRoot = looksLikeRealHostRepo ? repoGitRoot : qaGitRoot;
    if (gitRoot && hashGitTrackedDirInto(hash, gitRoot, scanRoot)) {
      externalRepos.forEach((sr, idx) => {
        const srRoot = resolveGitRoot(sr);
        if (!srRoot || !hashGitTrackedDirInto(hash, srRoot, sr, `sourceRepo[${idx}]`)) {
          walkDirectoryIntoHash(hash, sr, `sourceRepo[${idx}]`, new Set(WORKSPACE_HASH_IGNORE_DIRS), state);
        }
      });
      return `sha256:${hash.digest('hex')}`;
    }
  }

  walkDirectoryIntoHash(hash, resolvedQa, 'qa', new Set(WORKSPACE_HASH_IGNORE_DIRS), state);
  if (looksLikeRealHostRepo) {
    const qaFolderName = path.relative(resolvedRepo, resolvedQa).split(/[\\/]/)[0];
    if (!repoGitRoot || repoIsGitIgnored || !hashGitTrackedDirInto(hash, repoGitRoot, resolvedRepo, 'repo', [qaFolderName])) {
      const repoIgnoreDirs = new Set(WORKSPACE_HASH_IGNORE_DIRS);
      if (qaFolderName) repoIgnoreDirs.add(qaFolderName);
      walkDirectoryIntoHash(hash, resolvedRepo, 'repo', repoIgnoreDirs, state);
    }
  }
  externalRepos.forEach((sr, idx) => {
    const srRoot = resolveGitRoot(sr);
    if (!srRoot || !hashGitTrackedDirInto(hash, srRoot, sr, `sourceRepo[${idx}]`)) {
      walkDirectoryIntoHash(hash, sr, `sourceRepo[${idx}]`, new Set(WORKSPACE_HASH_IGNORE_DIRS), state);
    }
  });
  return `sha256:${hash.digest('hex')}`;
}
