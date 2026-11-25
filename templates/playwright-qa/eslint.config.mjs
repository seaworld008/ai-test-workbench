import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aitestCfgPath = path.join(__dirname, 'aitest.config.json');
const aitestCfg = fs.existsSync(aitestCfgPath)
  ? JSON.parse(fs.readFileSync(aitestCfgPath, 'utf8'))
  : { assertFunctionNames: ['expect*', 'assert*', 'verify*'] };

const rawAssertEntries = (aitestCfg.assertFunctionNames || ['expect*', 'assert*', 'verify*']).filter(
  (entry) => entry && entry !== '*'
);
const exactAssertNames = rawAssertEntries.filter((entry) => !entry.includes('*'));
const regexAssertPatterns = rawAssertEntries
  .filter((entry) => entry.includes('*'))
  .map((entry) => `^${entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const FORBIDDEN_NET_EXEC_IMPORTS = [
  { name: 'http', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'https', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'http2', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'net', message: '[aitest/no-raw-net] Raw socket access is forbidden in tests; use fixtures/base.ts.' },
  { name: 'tls', message: '[aitest/no-raw-net] Raw TLS access is forbidden in tests; use fixtures/base.ts.' },
  { name: 'dgram', message: '[aitest/no-raw-net] Raw UDP socket access is forbidden in tests.' },
  { name: 'dns', message: '[aitest/no-raw-net] Raw DNS access is forbidden in tests.' },
  { name: 'child_process', message: '[aitest/no-exec] Subprocess execution is forbidden in tests.' },
  { name: 'worker_threads', message: '[aitest/no-exec] Worker threads are forbidden in tests.' },
  { name: 'node:http', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'node:https', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'node:http2', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'node:net', message: '[aitest/no-raw-net] Raw socket access is forbidden in tests; use fixtures/base.ts.' },
  { name: 'node:tls', message: '[aitest/no-raw-net] Raw TLS access is forbidden in tests; use fixtures/base.ts.' },
  { name: 'node:dgram', message: '[aitest/no-raw-net] Raw UDP socket access is forbidden in tests.' },
  { name: 'node:dns', message: '[aitest/no-raw-net] Raw DNS access is forbidden in tests.' },
  { name: 'node:child_process', message: '[aitest/no-exec] Subprocess execution is forbidden in tests.' },
  { name: 'node:worker_threads', message: '[aitest/no-exec] Worker threads are forbidden in tests.' },
  { name: 'undici', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'axios', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'node-fetch', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
  { name: 'got', message: '[aitest/no-raw-http] Use the guarded { request } fixture from fixtures/base.ts.' },
];

export default [
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'reports/**',
      'tests/seed.official.example.ts',
    ],
  },
  {
    files: ['tests/**/*.{ts,js,mjs}'],
    ignores: ['tests/fixtures/base.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      playwright,
    },
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/expect-expect': [
        'error',
        {
          assertFunctionNames: exactAssertNames,
          assertFunctionPatterns: regexAssertPatterns,
        },
      ],
      'playwright/no-focused-test': 'error',
      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-skipped-test': 'error',
      'playwright/no-force-option': 'error',
      'playwright/prefer-web-first-assertions': 'error',
      'playwright/no-conditional-in-test': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              message:
                '[aitest/must-use-base-fixture] All tests, setups, and custom fixtures MUST import test/expect from fixtures/base instead of @playwright/test.',
            },
            ...FORBIDDEN_NET_EXEC_IMPORTS,
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            '[aitest/no-raw-fetch] Do not call global fetch() in tests; use the guarded { request } fixture from fixtures/base.ts.',
        },
        {
          selector: "MemberExpression[property.name='fetch'][object.name!='request'][object.property.name!='request']",
          message:
            '[aitest/no-raw-fetch] Do not call globalThis.fetch / window.fetch / self.fetch in tests or custom fixtures; use the guarded { request } fixture from fixtures/base.ts.',
        },
        {
          selector: "MemberExpression[property.value='fetch'][object.name!='request'][object.property.name!='request']",
          message:
            '[aitest/no-raw-fetch] Do not invoke computed ["fetch"] bypass in tests or custom fixtures; use fixtures/base.ts.',
        },
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message:
            '[aitest/no-raw-websocket] Raw WebSocket creation bypasses egress guard; use guarded page context.',
        },
        {
          selector: 'ImportExpression',
          message:
            '[aitest/no-dynamic-import] Dynamic import() is forbidden in tests and custom fixtures (prevents static guard bypass).',
        },
        {
          selector: "CallExpression[callee.property.name='newContext'][callee.object.name='request']",
          message:
            '[aitest/no-raw-request-context] Do not call request.newContext() directly; use the guarded { request } fixture from fixtures/base.ts.',
        },
        {
          selector: "CallExpression[callee.property.name='newContext'][callee.object.property.name='request']",
          message:
            '[aitest/no-raw-request-context] Do not call playwright.request.newContext() directly; use the guarded { request } fixture from fixtures/base.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='test'][callee.property.name='fail']",
          message:
            '[aitest/no-test-fail] Expectation-inverting test.fail() is forbidden; keep C-class product bugs red.',
        },
      ],
    },
  },
  {
    files: ['tests/seed.spec.ts', 'tests/*.setup.{ts,js}', 'tests/setup/*.setup.{ts,js}', 'tests/fixtures/**/*.{ts,js,mjs}'],
    ignores: ['tests/fixtures/base.ts'],
    rules: {
      'playwright/expect-expect': 'off',
      'playwright/no-conditional-in-test': 'off',
      'playwright/no-conditional-expect': 'off',
    },
  },
];
