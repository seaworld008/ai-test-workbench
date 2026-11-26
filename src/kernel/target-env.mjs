// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from '../core/config.mjs';
import { isLoopbackHttpUrl } from '../core/runtime-config.mjs';

export { parseEnvText };

const LOOPBACK_DEFAULT_CRUD_ENVS = new Set(['local', 'dev', 'development', 'test', 'testing', 'ci']);

/**
 * Resolves tiered write/mutation defaults (`WU-04`).
 * @param {Record<string, string | undefined>} [envInput]
 * @param {string | undefined | null} [baseURL]
 * @param {string} [testEnv]
 */
export function resolveDefaultMutationPolicy(envInput = {}, baseURL = undefined, testEnv = 'local') {
  const normEnv = String(testEnv || envInput.TEST_ENV || 'local').trim().toLowerCase();
  const explicitAllowRaw = envInput.TEST_ALLOW_MUTATION;
  const explicitStrictRaw = envInput.TEST_STRICT_READONLY;
  const isLoopback = isLoopbackHttpUrl(baseURL);
  const loopbackDefault = LOOPBACK_DEFAULT_CRUD_ENVS.has(normEnv) && isLoopback;

  const allowMutation =
    explicitAllowRaw !== undefined && explicitAllowRaw !== ''
      ? explicitAllowRaw === '1' || explicitAllowRaw === 'true'
      : loopbackDefault;

  const strictReadonly =
    explicitStrictRaw !== undefined && explicitStrictRaw !== ''
      ? explicitStrictRaw === '1' || explicitStrictRaw === 'true'
      : !allowMutation;

  return {
    allowMutation: strictReadonly ? false : allowMutation,
    strictReadonly,
    isLoopback,
  };
}

/** @param {string | undefined | null} value @returns {string[]} */
export function parseCsvList(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {string | undefined | null} value @returns {string[]} */
export function parseLowerCsvList(value) {
  return parseCsvList(value).map((s) => s.toLowerCase());
}

/**
 * Purely reads an `.env` file into a key-value map WITHOUT mutating `process.env`.
 * @param {string | undefined | null} envFilePath
 * @returns {Record<string, string>}
 */
export function readEnvFileIfPresent(envFilePath) {
  if (!envFilePath || !fs.existsSync(envFilePath)) return {};
  return parseEnvText(fs.readFileSync(envFilePath, 'utf8'));
}

/**
 * Explicit host `playwright.config.ts` loader: populates unset keys in `targetEnv` (defaults to `process.env`).
 * @param {string | undefined | null} envFilePath
 * @param {Record<string, string | undefined>} [targetEnv]
 * @returns {Record<string, string>}
 */
export function applyEnvFileToProcess(envFilePath, targetEnv = process.env) {
  const parsed = readEnvFileIfPresent(envFilePath);
  for (const [k, v] of Object.entries(parsed)) {
    if (targetEnv[k] === undefined) {
      targetEnv[k] = v;
    }
  }
  return parsed;
}

/**
 * Deprecated alias preserved for backward compatibility; calls `applyEnvFileToProcess`.
 * @param {string | undefined | null} envFilePath
 * @returns {Record<string, string>}
 */
export function loadEnvFileIfPresent(envFilePath) {
  return applyEnvFileToProcess(envFilePath, process.env);
}

/**
 * Reads `<qaDir>/.env` merged with `overrideEnv` without mutating `process.env`.
 * @param {string} qaDir
 * @param {Record<string, string | undefined>} [overrideEnv]
 * @returns {Record<string, string | undefined>}
 */
export function loadMergedQaEnv(qaDir, overrideEnv = process.env) {
  const fileEnv = readEnvFileIfPresent(path.join(qaDir, '.env'));
  return { ...fileEnv, ...overrideEnv };
}
