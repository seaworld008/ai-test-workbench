import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Returns true only when BOTH the Playwright package in templates/playwright-qa/node_modules
 * AND a launchable Chromium browser binary exist on disk.
 *
 * When AITEST_REQUIRE_BROWSER=1 is set (e.g. in verify-e2e-typecheck-and-bench CI jobs),
 * throws explicitly instead of skipping so live browser E2E regressions are never silently bypassed.
 *
 * @param {string} templateModulesDir
 * @returns {boolean}
 */
export function hasPlaywrightChromium(templateModulesDir) {
  const pwCli = path.join(templateModulesDir, '@playwright', 'test', 'cli.js');
  const requireBrowser = process.env.AITEST_REQUIRE_BROWSER === '1';
  if (!fs.existsSync(pwCli)) {
    if (requireBrowser) {
      throw new Error(`AITEST_REQUIRE_BROWSER=1 but @playwright/test is missing at ${pwCli}`);
    }
    return false;
  }
  try {
    const templatePkg = path.resolve(templateModulesDir, '..', 'package.json');
    const req = createRequire(templatePkg);
    const pw = req('playwright');
    const exe = pw?.chromium?.executablePath?.();
    if (exe && fs.existsSync(exe)) {
      return true;
    }
    if (requireBrowser) {
      throw new Error(
        `AITEST_REQUIRE_BROWSER=1 but Playwright Chromium binary was not found at ${exe || '<empty>'}`
      );
    }
    return false;
  } catch (err) {
    if (requireBrowser) throw err;
    return false;
  }
}
