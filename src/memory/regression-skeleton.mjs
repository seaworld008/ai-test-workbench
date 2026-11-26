// @ts-check

/**
 * Extracts an actual API endpoint (`{ kind: 'api', method, path }`) or UI route (`{ kind: 'route', path }`)
 * from defect ticket JSON/Markdown or linked heal session context so generated regression skeletons
 * target the real failing surface instead of a hardcoded `/` placeholder (`WB-P1-08`).
 * @param {{ defectId: string, title: string, specFile: string | null, errorSnippet: string, codeCorrelation?: Record<string, any> | null }} defect
 */
export function extractDefectTarget(defect) {
  const corr = defect.codeCorrelation || null;
  if (Array.isArray(corr?.apis) && corr.apis.length > 0) {
    const rawApi = String(corr.apis[0] || '').trim();
    const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s"'`),]+)/i.exec(rawApi);
    if (m) return { kind: /** @type {const} */ ('api'), method: m[1].toUpperCase(), path: m[2] };
    if (rawApi.startsWith('/')) return { kind: /** @type {const} */ ('api'), method: 'GET', path: rawApi };
  }

  const snippet = String(defect.errorSnippet || '');
  const httpMatch = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(?:https?:\/\/[^/\s]+)?(\/[^\s"'`),`]+)/i.exec(snippet);
  if (httpMatch) {
    return { kind: /** @type {const} */ ('api'), method: httpMatch[1].toUpperCase(), path: httpMatch[2] };
  }
  const apiMatch = /(?:https?:\/\/[^/\s"'`)]+)?(\/(?:api|v\d+)\/[^\s"'`),`]+)/i.exec(snippet);
  if (apiMatch) {
    return { kind: /** @type {const} */ ('api'), method: 'GET', path: apiMatch[1] };
  }
  const urlMatch = /https?:\/\/[^/\s"'`)]+(\/[^\s"'`),`]+)/i.exec(snippet);
  if (urlMatch && urlMatch[1] && urlMatch[1] !== '/') {
    return { kind: /** @type {const} */ ('route'), method: 'GET', path: urlMatch[1] };
  }
  if (Array.isArray(corr?.routes) && corr.routes.length > 0) {
    const route = String(corr.routes[0] || '').trim();
    if (route) return { kind: /** @type {const} */ ('route'), method: 'GET', path: route.startsWith('/') ? route : `/${route}` };
  }
  return { kind: /** @type {const} */ ('api'), method: 'GET', path: '/api/health' };
}

/**
 * Generates a `@regression` Playwright spec skeleton for a Class C defect ticket using the actual
 * failing route or API endpoint when known.
 * @param {{ defectId: string, title: string, specFile: string | null, errorSnippet: string, codeCorrelation?: Record<string, any> | null }} defect
 */
export function buildRegressionSpecSkeleton(defect) {
  const slug = defect.defectId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'defect';
  const safeTitle = defect.title.replace(/['`\\]/g, '').slice(0, 80);
  const target = extractDefectTarget(defect);
  const safeTargetPath = target.path.replace(/['`\\]/g, '');

  const code =
    target.kind === 'route'
      ? [
          `import { test, expect } from '../fixtures/base';`,
          '',
          `test('[${defect.defectId}] ${safeTitle} @regression', async ({ page }) => {`,
          `  // Reproduce defect (${defect.defectId}) on ${safeTargetPath} so it FAILS on broken baseline and PASSES after real fix.`,
          `  await page.goto('${safeTargetPath}');`,
          `  await expect(page).toHaveURL(new RegExp('${safeTargetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'));`,
          `});`,
          '',
        ].join('\n')
      : [
          `import { test, expect } from '../fixtures/base';`,
          '',
          `test('[${defect.defectId}] ${safeTitle} @regression', async ({ request }) => {`,
          `  // Reproduce defect (${defect.defectId}) on ${target.method} ${safeTargetPath} so it FAILS on broken baseline and PASSES after real fix.`,
          `  const res = await request.${target.method === 'GET' ? 'get' : 'fetch'}('${safeTargetPath}'${target.method === 'GET' ? '' : `, { method: '${target.method}' }`});`,
          `  expect(res.status()).toBe(200);`,
          `});`,
          '',
        ].join('\n');

  return {
    defectId: defect.defectId,
    suggestedFile: `tests/regression/${slug}.spec.ts`,
    testTitle: `[${defect.defectId}] ${safeTitle} @regression`,
    sourceSpec: defect.specFile,
    targetPath: safeTargetPath,
    targetKind: target.kind,
    code,
  };
}
