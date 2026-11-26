// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_REL_PATH = '.aitest/agents-manifest.json';

/**
 * @typedef {{ sha256: string, loop: string, updatedAt: string }} AgentManifestEntry
 * @typedef {{ version: number, files: Record<string, AgentManifestEntry> }} AgentsManifest
 */

/**
 * @param {string} content
 * @returns {string}
 */
export function sha256Text(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {Map<string, string>}
 */
export function walkFiles(dir, baseDir = dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'playwright-report' ||
      entry.name === 'test-results' ||
      entry.name === 'reports' ||
      entry.name === '.git'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      for (const [k, v] of walkFiles(full, baseDir)) {
        out.set(k, v);
      }
    } else if (entry.isFile()) {
      out.set(rel, fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/**
 * Replaces any absolute path references to the temporary staging directory with qaDir
 * across native, forward-slash, backslash, and JSON-escaped backslash forms,
 * and asserts zero leftover staging marker (`aitest-agents-`).
 * @param {string} content
 * @param {string} tempDir
 * @param {string} qaDir
 * @returns {string}
 */
export function sanitizeStagedContent(content, tempDir, qaDir) {
  const tempNative = path.resolve(tempDir);
  const qaNative = path.resolve(qaDir);

  const tempFwd = tempNative.replace(/\\/g, '/');
  const qaFwd = qaNative.replace(/\\/g, '/');

  const tempBack = tempNative.replace(/\//g, '\\');
  const qaBack = qaNative.replace(/\//g, '\\');

  const tempJsonEsc = tempBack.replace(/\\/g, '\\\\');
  const qaJsonEsc = qaBack.replace(/\\/g, '\\\\');

  let out = content;
  out = out.replaceAll(tempJsonEsc, qaJsonEsc);
  out = out.replaceAll(tempFwd, qaFwd);
  out = out.replaceAll(tempBack, qaBack);

  if (out.includes('aitest-agents-')) {
    throw new Error('Staging path leak detected after sanitization ("aitest-agents-" remained in generated agent config).');
  }
  return out;
}

/**
 * @param {string} qaDir
 * @returns {AgentsManifest}
 */
export function loadAgentsManifest(qaDir) {
  const manifestPath = path.join(qaDir, MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, files: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { version: 1, files: parsed.files || {} };
  } catch {
    return { version: 1, files: {} };
  }
}

/**
 * @param {string} qaDir
 * @param {AgentsManifest} manifest
 */
export function saveAgentsManifest(qaDir, manifest) {
  const manifestPath = path.join(qaDir, MANIFEST_REL_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Safely merges JSON MCP configs only when existing keys are either untouched since manifest
 * or disjoint from incoming keys. Returns { status: 'MERGED_JSON' | 'CONFLICT', content }.
 * @param {string} existingStr
 * @param {string} incomingStr
 * @param {string | null} recordedSha
 * @returns {{ status: 'MERGED_JSON', content: string } | { status: 'CONFLICT', content: null }}
 */
export function tryMergeMcpJson(existingStr, incomingStr, recordedSha) {
  try {
    const existing = JSON.parse(existingStr);
    const incoming = JSON.parse(incomingStr);
    const existingSha = sha256Text(existingStr);
    const userEdited = Boolean(recordedSha && existingSha !== recordedSha) || !recordedSha;

    const merged = { ...existing };
    for (const rootKey of ['mcpServers', 'servers']) {
      if (existing[rootKey] || incoming[rootKey]) {
        const exMap = existing[rootKey] || {};
        const inMap = incoming[rootKey] || {};
        const nextMap = { ...exMap };
        for (const [srvName, srvVal] of Object.entries(inMap)) {
          if (srvName in exMap && JSON.stringify(exMap[srvName]) !== JSON.stringify(srvVal)) {
            if (userEdited) {
              return { status: 'CONFLICT', content: null };
            }
          }
          nextMap[srvName] = srvVal;
        }
        merged[rootKey] = nextMap;
      }
    }
    return { status: 'MERGED_JSON', content: JSON.stringify(merged, null, 2) + '\n' };
  } catch {
    return { status: 'CONFLICT', content: null };
  }
}

/**
 * @param {string} qaDir
 * @returns {boolean}
 */
export function hasSeedProjectInConfig(qaDir) {
  const cfgPath = path.join(qaDir, 'playwright.config.ts');
  if (!fs.existsSync(cfgPath)) return false;
  const txt = fs.readFileSync(cfgPath, 'utf8');
  return /name\s*:\s*['"]seed['"]/.test(txt);
}
