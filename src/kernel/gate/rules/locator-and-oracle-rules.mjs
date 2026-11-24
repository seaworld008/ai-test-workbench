import { diffEventSnippets } from './governance-rules.mjs';

/**
 * AITEST-G111: Semantic locator (`getByRole`/`Label`/`Text`/`TestId`) degraded to generic `body`/`html`/`*`/`div`.
 */
export const ruleG111 = {
  code: 'AITEST-G111',
  name: 'no-locator-degradation',
  description: 'Blocks replacing semantic locators with overly generic body/html/*/div locators.',
  waiverKey: 'locator-degradation',
  defaultEnabled: true,
  evaluate(ctx) {
    const { file, baseSum, headSum, canWaive } = ctx;
    if (!baseSum || !headSum) return [];
    if (
      headSum.semanticLocators < baseSum.semanticLocators &&
      headSum.genericLocators > baseSum.genericLocators &&
      !canWaive('locator-degradation') &&
      !canWaive('AITEST-G111')
    ) {
      return [
        {
          code: 'AITEST-G111',
          severity: 'error',
          file,
          message: `${file}: semantic locator (getByRole/Label/Text/TestId) degraded to generic body/html/*/div locator.`,
          evidence: {
            baseSemantic: baseSum.semanticLocators,
            headSemantic: headSum.semanticLocators,
            baseGeneric: baseSum.genericLocators,
            headGeneric: headSum.genericLocators,
          },
        },
      ];
    }
    return [];
  },
};

/**
 * AITEST-G112: HTTP status oracle flipped from `2xx`/`4xx` to `5xx` to mask backend failures.
 */
export const ruleG112 = {
  code: 'AITEST-G112',
  name: 'no-5xx-oracle-flip',
  description: 'Blocks flipping expected HTTP status assertions from 2xx/4xx to 5xx.',
  waiverKey: 'oracle-5xx-flip',
  defaultEnabled: true,
  evaluate(ctx) {
    const { file, baseSum, headSum, canWaive } = ctx;
    if (!baseSum || !headSum) return [];
    if (
      headSum.successStatuses < baseSum.successStatuses &&
      headSum.serverErrorStatuses > baseSum.serverErrorStatuses &&
      !canWaive('oracle-5xx-flip') &&
      !canWaive('AITEST-G112')
    ) {
      return [
        {
          code: 'AITEST-G112',
          severity: 'error',
          file,
          message: `${file}: HTTP status oracle flipped from 2xx/4xx to 5xx to mask backend failure.`,
          evidence: {
            baseSuccess: baseSum.successStatuses,
            headSuccess: headSum.successStatuses,
            base5xx: baseSum.serverErrorStatuses,
            head5xx: headSum.serverErrorStatuses,
          },
        },
      ];
    }
    return [];
  },
};

/**
 * AITEST-G114: Mocking backend responses via `page.route(... fulfill(...))` in specs.
 */
export const ruleG114 = {
  code: 'AITEST-G114',
  name: 'no-route-fulfill-mocking',
  description: 'Blocks mocking backend responses via route.fulfill() to fabricate fake-green oracles.',
  waiverKey: 'route-fulfill',
  defaultEnabled: true,
  evaluate(ctx) {
    const { file, baseSum, headSum, canWaive } = ctx;
    const findings = [];
    for (const ev of diffEventSnippets(baseSum?.events?.routeFulfills, headSum?.events?.routeFulfills)) {
      if (canWaive(ev.snippet) || canWaive('AITEST-G114')) continue;
      findings.push({
        code: 'AITEST-G114',
        severity: 'error',
        file,
        line: ev.line,
        testTitle: ev.testTitle || undefined,
        message: ev.message,
        evidence: {
          urlPatternText: ev.urlPatternText,
          statusCodes: ev.statusCodes,
          isFaultInjection: ev.isFaultInjection,
          setsExternalTrapVar: ev.setsExternalTrapVar,
          snippet: ev.snippet,
        },
      });
    }
    return findings;
  },
};
