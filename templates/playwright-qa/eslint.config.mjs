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

const rawAssertEntries = aitestCfg.assertFunctionNames || ['expect*', 'assert*', 'verify*'];
const exactAssertNames = rawAssertEntries.filter((entry) => !entry.includes('*'));
const regexAssertPatterns = rawAssertEntries
  .filter((entry) => entry.includes('*'))
  .map((entry) => `^${entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

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
    files: ['tests/**/*.ts'],
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
    },
  },
  {
    files: ['tests/seed.spec.ts', 'tests/*.setup.ts', 'tests/fixtures/**/*.ts'],
    rules: {
      'playwright/expect-expect': 'off',
      'playwright/no-conditional-in-test': 'off',
      'playwright/no-conditional-expect': 'off',
    },
  },
];
