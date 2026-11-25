// @ts-check
import { redactSecrets } from '../core/redact.mjs';

/**
 * Selects the FIRST failing attempt from Playwright `test.results[]` (`D-03`).
 * @param {Array<any>} results
 */
export function selectFirstFailedAttempt(results = []) {
  if (!Array.isArray(results) || results.length === 0) return {};
  const failedAttempt = results.find(
    (r) =>
      (r.status && r.status !== 'passed' && r.status !== 'expected' && r.status !== 'skipped') ||
      Boolean(r.error) ||
      (Array.isArray(r.errors) && r.errors.length > 0)
  );
  return failedAttempt || results[0];
}

/**
 * Extracts the pure 32-hex W3C trace-id segment from `traceparent` (`00-<32hex>-<16hex>-01`) or header value (`D-02`).
 * @param {string} rawEntry
 */
export function extractQueryableTraceId(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'string') return '<trace-id>';
  const valPart = rawEntry.includes(':') ? rawEntry.split(':').slice(1).join(':').trim() : rawEntry.trim();
  const w3cMatch = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(valPart);
  if (w3cMatch) return w3cMatch[1];
  return redactSecrets(valPart);
}

const VALUE_CONTRACT_MATCHERS = new Set([
  'tobe',
  'toequal',
  'tostrictequal',
  'tohavetext',
  'tocontaintext',
  'tohavevalue',
  'tohavevalues',
  'tohavecount',
  'tohaveurl',
  'tohavetitle',
  'tohaveattribute',
  'tohaveclass',
  'tohavecss',
  'tohavejsproperty',
  'tohaveproperty',
  'tomatch',
  'tomatchobject',
  'tocontain',
  'tocontainequal',
  'tobedisabled',
  'tobeenabled',
  'tobechecked',
  'tobeempty',
  'tomatchariasnapshot',
  'tohavescreenshot',
  'tobegreaterthan',
  'tobegreaterthanorequal',
  'tobelessthan',
  'tobelessthanorequal',
  'tobecloseto',
]);

const TEXT_COPY_MATCHERS = new Set(['tohavetext', 'tocontaintext', 'tomatchariasnapshot', 'tohavetitle']);

/**
 * Parses structured Playwright assertion/matcher evidence from raw error text and optional `error.matcherResult`.
 * @param {string} errorText
 * @param {any} [errorObj]
 */
export function parsePlaywrightErrorEvidence(errorText, errorObj = null) {
  const clean = String(errorText || '').replace(/\x1b\[[0-9;]*m/g, '');
  const matcherResult = errorObj?.matcherResult || null;

  const expectCallMatch = /\bexpect(?:\.(?:soft|poll))?\([^)]*\)\.(?:not\.)?([a-zA-Z0-9_]+)\s*\(/i.exec(clean);
  const callLogExpectMatch = /Expect\s+"([a-zA-Z0-9_]+)"/i.exec(clean);
  const matcher =
    (matcherResult?.name ? String(matcherResult.name) : null) ||
    (expectCallMatch ? expectCallMatch[1] : null) ||
    (callLogExpectMatch ? callLogExpectMatch[1] : null);
  const matcherLower = matcher ? matcher.toLowerCase() : null;

  const expectedMatch = /^\s*Expected(?:\s+(?:string|substring|pattern|number|value))?:\s*(.+)$/im.exec(clean);
  const receivedMatch = /^\s*Received(?:\s+(?:string|substring|pattern|number|value))?:\s*(.+)$/im.exec(clean);

  const expectedValue =
    matcherResult && matcherResult.expected !== undefined
      ? String(matcherResult.expected)
      : expectedMatch
        ? expectedMatch[1].trim()
        : null;
  const receivedValue =
    matcherResult && matcherResult.actual !== undefined
      ? String(matcherResult.actual)
      : receivedMatch
        ? receivedMatch[1].trim()
        : null;

  const elementNotFound =
    /received:\s*<element\(s\) not found>/i.test(clean) ||
    /element\(s\) not found/i.test(clean);

  const hasValueAssertion =
    !elementNotFound &&
    (Boolean(matcherLower && VALUE_CONTRACT_MATCHERS.has(matcherLower)) ||
      (expectedValue !== null && receivedValue !== null));

  const isTextCopyMatcher =
    Boolean(matcherLower && TEXT_COPY_MATCHERS.has(matcherLower)) ||
    /Expected string:/i.test(clean);

  return {
    clean,
    matcher,
    matcherLower,
    expectedValue,
    receivedValue,
    elementNotFound,
    hasValueAssertion,
    isTextCopyMatcher,
  };
}

/**
 * Evidence-first A/B/C/D failure classifier (`D-01`, `D-02`, `D-03`).
 * @param {string} errorText
 * @param {{ serverErrors?: string[], blockedRequests?: string[], pageErrors?: string[] } | null} [guardSignals]
 * @param {any} [errorObj]
 */
export function suggestFailureCategory(errorText, guardSignals = null, errorObj = null) {
  const ev = parsePlaywrightErrorEvidence(errorText, errorObj);
  const txt = ev.clean.toLowerCase();

  if (guardSignals) {
    if (Array.isArray(guardSignals.serverErrors) && guardSignals.serverErrors.length > 0) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Backend Defect)',
        confidence: 'high',
        candidates: ['C'],
        evidence: ['runtime-guard:serverErrors'],
        guidance:
          'Structured 5xx server error captured by runtime guard. NEVER weaken assertions or add test.skip/fixme; file a C-class defect with traceId.',
      };
    }
    if (Array.isArray(guardSignals.blockedRequests) && guardSignals.blockedRequests.length > 0) {
      return {
        categoryCode: 'B',
        category: 'B (Environment / Auth / Network)',
        confidence: 'high',
        candidates: ['B', 'A'],
        evidence: ['runtime-guard:blockedRequests'],
        guidance:
          'Request blocked by outbound/mutation safety guard. Check TEST_ALLOWED_HOSTS, TEST_EGRESS_MODE, or add @mutation if state write is intentional.',
      };
    }
    if (Array.isArray(guardSignals.pageErrors) && guardSignals.pageErrors.length > 0) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Backend Defect)',
        confidence: 'medium-high',
        candidates: ['C'],
        evidence: ['runtime-guard:pageErrors'],
        guidance: 'Uncaught frontend exception captured by pageerror guard. Keep red and report product defect.',
      };
    }
  }

  if (
    /ambiguous spec|requirement conflict|missing req-|todo:\s*confirm|notimplementederror|specification unclear|undocumented status|schema ambiguity/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'D',
      category: 'D (Needs Requirement / Spec Clarification)',
      confidence: 'medium-high',
      candidates: ['D'],
      evidence: ['explicit-spec-ambiguity'],
      guidance: 'Explicit specification ambiguity detected. Pause test edits and confirm expected behavior with user.',
    };
  }

  if (
    /\[same-origin 5xx guard\]|\[uncaught pageerror guard\]|server 5xx|status 50\d|\b50[0234]\b.*(?:internal server error|bad gateway|service unavailable|gateway timeout)|got 50\d\b|expected http \d+.*got 5\d\d|pageerror|uncaught (?:typeerror|referenceerror|syntaxerror|rangeerror)|json schema contract violation|openapi contract drift/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'high',
      candidates: ['C'],
      evidence: ['backend-5xx-or-contract-error'],
      guidance:
        'Backend 5xx, uncaught frontend exception, or API contract violation. Do NOT weaken assertions or add test.skip/fixme; file a bug report with traceId.',
    };
  }

  if (
    /\[ai test workbench network guard\]|\[ai test workbench request guard\]|\[ai test workbench target guard\]|\[ai test workbench config error\]|test_egress_mode|test_strict_readonly|blocked outbound request|blocked dangerous endpoint|blocked request to denied origin|econnrefused|enotfound|econnreset|etimedout|err_name_not_resolved|err_connection|net::err_|401 unauthorized|qa api login failed|target guard|test_allowed_hosts|storagestate/i.test(
      txt
    )
  ) {
    return {
      categoryCode: 'B',
      category: 'B (Environment / Auth / Network)',
      confidence: 'high',
      candidates: ['B'],
      evidence: ['network-auth-env-guard'],
      guidance:
        'Environment, network firewall, or authentication failure. Do NOT rewrite business assertions; verify server reachability, .env allowlist, and storageState.',
    };
  }

  if (ev.hasValueAssertion) {
    const receivedLower = String(ev.receivedValue || '').toLowerCase();
    const receivedLooksBroken = /\b(500|502|503|504|undefined|nan|null|failed|exception|crash|error)\b/i.test(receivedLower);
    if (ev.isTextCopyMatcher && !receivedLooksBroken) {
      return {
        categoryCode: 'C',
        category: 'C (Suspected Product / Copy Regression — Dual Candidate C/A)',
        confidence: 'medium',
        candidates: ['C', 'A'],
        evidence: [
          `matcher=${ev.matcher || 'text'}`,
          ...(ev.expectedValue !== null ? [`expected=${ev.expectedValue.slice(0, 60)}`] : []),
          ...(ev.receivedValue !== null ? [`received=${ev.receivedValue.slice(0, 60)}`] : []),
        ],
        guidance:
          'Rendered UI text/ARIA differs from expected assertion. Keep red as Class C regression unless specs/*.md confirms an intentional UI copy update.',
      };
    }

    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'high',
      candidates: ['C'],
      evidence: [
        `matcher=${ev.matcher || 'assertion'}`,
        ...(ev.expectedValue !== null ? [`expected=${ev.expectedValue.slice(0, 60)}`] : []),
        ...(ev.receivedValue !== null ? [`received=${ev.receivedValue.slice(0, 60)}`] : []),
      ],
      guidance:
        'Business value or contract assertion failed against expected oracle. Keep red and report product defect with traceId.',
    };
  }

  if (
    /strict mode violation|resolved to \d+ elements|waiting for getby|waiting for locator|locator\(|timeout \d+ms exceeded.*(?:locator|getby|click|fill|visible)|element is not (?:visible|enabled|attached|stable)|element was detached|subtree intercepts pointer events/i.test(
      txt
    )
  ) {
    if (/\btobevisible\b/i.test(txt) && ev.elementNotFound) {
      return {
        categoryCode: 'C',
        category: 'C (Visibility Assertion Missing Element — Dual Candidate C/A)',
        confidence: 'medium',
        candidates: ['C', 'A'],
        evidence: ['matcher=toBeVisible', 'element-not-found'],
        guidance:
          'Expected visible element was absent. Verify whether product failed to render before updating locator.',
      };
    }
    return {
      categoryCode: 'A',
      category: 'A (Test Script / Locator / Synchronization)',
      confidence: 'medium-high',
      candidates: ['A'],
      evidence: ['locator-or-action-drift'],
      guidance:
        'Inspect ARIA snapshot in error-context.md. If UI locator drifted legitimately without business regression, repair semantic locator (max 3 attempts via aitest_heal(action="begin"|"attempt")).',
    };
  }

  return {
    categoryCode: 'D',
    category: 'D (Needs Requirement / Spec Clarification)',
    confidence: 'low',
    candidates: ['D'],
    evidence: ['unclassified'],
    guidance:
      'Ambiguous failure signature. Compare actual app behavior against specs/*.md and confirm expected behavior with user.',
  };
}
