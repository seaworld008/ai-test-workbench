#!/usr/bin/env node
// @ts-check
/**
 * Deterministic unseen holdout sampler following `bench/real-world/PREREGISTRATION.md`.
 * Uses mulberry32(20261125), strictly excludes all 50 pilot SHAs in `corpus.json`,
 * applies identical mechanical filters (non-merge, <=50 files, >=1 modified Playwright spec),
 * and records metadata only (zero third-party source code committed).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PILOT_CORPUS_PATH = path.join(REPO_ROOT, 'bench', 'real-world', 'corpus.json');
const HOLDOUT_CORPUS_PATH = path.join(REPO_ROOT, 'bench', 'real-world', 'holdout-v6-corpus.json');
const CACHE_DIR = path.join(REPO_ROOT, 'bench', 'real-world', '.cache');

const SEED = 20261125;
const TARGET_SIZE = 50;

const REPO_CONFIGS = [
  {
    repo: 'actualbudget/actual',
    license: 'MIT',
    isPlaywrightTest: (p) => /^packages\/desktop-client\/e2e\/.+\.(?:spec|test)\.[jt]sx?$/.test(p),
  },
  {
    repo: 'microsoft/playwright-mcp',
    license: 'Apache-2.0',
    isPlaywrightTest: (p) => /^tests\/.+\.(?:spec|test)\.[jt]sx?$/.test(p),
  },
  {
    repo: 'sveltejs/kit',
    license: 'MIT',
    isPlaywrightTest: (p) => /\/test\/.*\.(?:spec|test)\.[jt]s$/.test(p) && !/unit/i.test(p),
  },
  {
    repo: 'vuejs/vitepress',
    license: 'MIT',
    isPlaywrightTest: (p) => /^__tests__\/e2e\/.+\.(?:spec|test)\.[jt]s$/.test(p),
  },
  {
    repo: 'vitejs/vite',
    license: 'MIT',
    isPlaywrightTest: (p) => /^playground\/.+\.(?:spec|test)\.[jt]s$/.test(p),
  },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runGit(args, cwd) {
  return spawnSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function collectEligibleCommits(cfg, excludedShas) {
  const bareDir = path.join(CACHE_DIR, `${cfg.repo.replace('/', '__')}.git`);
  if (!fs.existsSync(bareDir)) {
    throw new Error(`Missing cached bare repo: ${bareDir}`);
  }

  // Single fast local git log over cached commits (no per-commit spawns, no on-demand blob fetches)
  const logRes = runGit(
    ['log', '--all', '--no-merges', '--name-status', '--no-renames', '--format=@@COMMIT@@ %H %P'],
    bareDir
  );
  if (logRes.status !== 0) {
    throw new Error(`git log failed for ${cfg.repo}: ${logRes.stderr}`);
  }

  const eligible = [];
  const seenShas = new Set();
  /** @type {{ sha: string, parentSha: string, totalFiles: number, modifiedTests: string[], addedTests: string[] } | null} */
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (
      cur.totalFiles > 0 &&
      cur.totalFiles <= 50 &&
      cur.modifiedTests.length > 0 &&
      !excludedShas.has(`${cfg.repo}@${cur.sha}`) &&
      !seenShas.has(cur.sha)
    ) {
      seenShas.add(cur.sha);
      eligible.push({
        repo: cfg.repo,
        sha: cur.sha,
        parentSha: cur.parentSha,
        license: cfg.license,
        testPaths: [...new Set(cur.modifiedTests)].sort(),
        ...(cur.addedTests.length > 0 ? { addedTestPaths: [...new Set(cur.addedTests)].sort() } : {}),
      });
    }
    cur = null;
  };

  for (const rawLine of logRes.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('@@COMMIT@@ ')) {
      flush();
      const parts = line.slice('@@COMMIT@@ '.length).trim().split(/\s+/);
      if (parts.length !== 2) {
        cur = null;
        continue;
      }
      cur = { sha: parts[0], parentSha: parts[1], totalFiles: 0, modifiedTests: [], addedTests: [] };
      continue;
    }
    if (!cur) continue;
    const cols = line.split('\t');
    const status = cols[0];
    const filePath = cols[1];
    if (!status || !filePath) continue;
    cur.totalFiles += 1;
    if (status === 'M' && cfg.isPlaywrightTest(filePath)) {
      cur.modifiedTests.push(filePath);
    } else if (status === 'A' && cfg.isPlaywrightTest(filePath)) {
      cur.addedTests.push(filePath);
    }
  }
  flush();

  // Stable lexicographic sort before deterministic Fisher-Yates shuffle
  eligible.sort((a, b) => `${a.repo}:${a.sha}`.localeCompare(`${b.repo}:${b.sha}`));
  return eligible;
}

function main() {
  const pilot = JSON.parse(fs.readFileSync(PILOT_CORPUS_PATH, 'utf8'));
  const excludedShas = new Set((pilot.commits || []).map((c) => `${c.repo}@${c.sha}`));
  const rng = mulberry32(SEED);

  const pools = REPO_CONFIGS.map((cfg) => {
    const list = collectEligibleCommits(cfg, excludedShas);
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return { cfg, list, cursor: 0 };
  });

  const selected = [];
  let progressed = true;
  while (selected.length < TARGET_SIZE && progressed) {
    progressed = false;
    for (const pool of pools) {
      if (selected.length >= TARGET_SIZE) break;
      if (pool.cursor < pool.list.length) {
        selected.push(pool.list[pool.cursor]);
        pool.cursor += 1;
        progressed = true;
      }
    }
  }

  const out = {
    protocolVersion: '1.1.0-holdout',
    preregistrationDoc: 'bench/real-world/PREREGISTRATION.md',
    samplingSeed: SEED,
    prng: 'mulberry32',
    disjointFrom: 'bench/real-world/corpus.json',
    collectedAt: new Date().toISOString(),
    targetSampleSize: TARGET_SIZE,
    actualSampleSize: selected.length,
    repositories: pools.map((p) => ({
      repo: p.cfg.repo,
      license: p.cfg.license,
      sampledCommits: p.cursor,
      unseenEligiblePoolSize: p.list.length,
    })),
    commits: selected,
  };

  fs.writeFileSync(HOLDOUT_CORPUS_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`[Holdout Sampler] Wrote ${selected.length} disjoint unseen commits to ${path.relative(REPO_ROOT, HOLDOUT_CORPUS_PATH)}`);
  for (const r of out.repositories) {
    console.log(`  - ${r.repo}: sampled=${r.sampledCommits} / unseenEligible=${r.unseenEligiblePoolSize}`);
  }
}

main();
