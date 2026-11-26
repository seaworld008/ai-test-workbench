// @ts-check
import { redactSecrets } from '../core/redact.mjs';
import { WORKBENCH_VERSION } from '../core/version.mjs';

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
 * Extracts a queryable trace ID from W3C `traceparent` (`00-<32hex>-<16hex>-01`),
 * SkyWalking `sw8` (`1-<base64TraceId>-...` -> UTF-8 decoded), or `header: value` entries (`D-02`, `WB-P1-06`).
 * @param {string} rawEntry
 */
export function extractQueryableTraceId(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'string') return '<trace-id>';
  const colonIdx = rawEntry.indexOf(':');
  const headerName = colonIdx >= 0 ? rawEntry.slice(0, colonIdx).trim().toLowerCase() : '';
  const valPart = colonIdx >= 0 ? rawEntry.slice(colonIdx + 1).trim() : rawEntry.trim();

  const w3cMatch = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(valPart);
  if (w3cMatch) return w3cMatch[1];

  const sw8Match = /^[01]-([A-Za-z0-9+/=_-]+)-/.exec(valPart);
  if (sw8Match && (headerName === 'sw8' || headerName === 'x-skywalking-traceid' || /^[01]-[A-Za-z0-9+/=_-]+-[A-Za-z0-9+/=_-]+/.test(valPart))) {
    try {
      const normalizedB64 = sw8Match[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalizedB64 + '='.repeat((4 - (normalizedB64.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
      if (decoded && /^[\x20-\x7E]+$/.test(decoded)) {
        return redactSecrets(decoded);
      }
    } catch {
      // fall through to raw value
    }
  }

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

const AUTH_EXPIRY_SIGNAL_RE =
  /(?:\/auth\/logout|refresh[-_]?token|\b401\s+unauthorized\b|未登录|未登陆|令牌为空|token\s*expired|session\s*expired|登录已过期|登录失效)/i;
const BARE_401_RE = /\b401\b/;
const TARGET_BLOCKED_ERROR_RE =
  /\[target safety blocked\]|\[ai test workbench network guard\]|\[ai test workbench request guard\]|\[ai test workbench target guard\]|\[ai test workbench config error\]|test_egress_mode|test_strict_readonly|blocked outbound request|blocked dangerous endpoint|blocked request to denied origin|econnrefused|enotfound|econnreset|etimedout|err_name_not_resolved|err_connection|err_blocked_by_client|net::err_|qa api login failed|target guard|test_allowed_hosts|storagestate/i;
const CLASS_C_TEXT_RE =
  /\[schema contract\]|expectapicontract|\[same-origin 5xx guard\]|\[uncaught pageerror guard\]|server 5xx|status 50\d|\b50[0234]\b.*(?:internal server error|bad gateway|service unavailable|gateway timeout)|got 50\d\b|expected http \d+.*got 5\d\d|pageerror|uncaught (?:typeerror|referenceerror|syntaxerror|rangeerror)|json schema contract violation|openapi contract drift/i;
const CLASS_A_LOCATOR_RE =
  /strict mode violation|resolved to \d+ elements|waiting for getby|waiting for locator|locator\(|timeout \d+ms exceeded.*(?:locator|getby|click|fill|visible)|element is not (?:visible|enabled|attached|stable)|element was detached|subtree intercepts pointer events/i;

/**
 * Evidence-first A/B/C/D failure classifier (`D-01`, `D-02`, `D-03`, `WB-P1-06`).
 * Evaluates primary `errorText` signals (auth expiry, contract/value assertions, locator/strict-mode)
 * BEFORE falling back to companion `guardSignals.blockedRequests`.
 * @param {string} errorText
 * @param {{ serverErrors?: string[], blockedRequests?: string[], pageErrors?: string[] } | null} [guardSignals]
 * @param {any} [errorObj]
 */
export function suggestFailureCategory(errorText, guardSignals = null, errorObj = null) {
  const ev = parsePlaywrightErrorEvidence(errorText, errorObj);
  const txt = ev.clean.toLowerCase();
  const hasBlockedReqs = Boolean(guardSignals && Array.isArray(guardSignals.blockedRequests) && guardSignals.blockedRequests.length > 0);
  const hasBlockedAuthSignal =
    hasBlockedReqs &&
    Boolean(guardSignals?.blockedRequests?.some((r) => /\/auth\/logout|refresh[-_]?token/i.test(String(r))));
  const expectedWas401 = Boolean(ev.expectedValue && /^\s*401\s*$/.test(ev.expectedValue) && ev.receivedValue && !/^\s*401\s*$/.test(ev.receivedValue));
  const hasAuthExpiredText =
    AUTH_EXPIRY_SIGNAL_RE.test(ev.clean) || (BARE_401_RE.test(ev.clean) && !expectedWas401);

  if (hasAuthExpiredText || hasBlockedAuthSignal) {
    return {
      categoryCode: 'B',
      category: 'B (Environment / Auth / Network — Session Expired)',
      confidence: 'high',
      candidates: ['B'],
      evidence: ['auth-session-expired', ...(hasBlockedAuthSignal ? ['runtime-guard:blockedRequests'] : [])],
      authExpiredHint:
        `Session appears expired or unauthenticated (401/logout/refresh-token). Run \`npx ai-test-workbench@${WORKBENCH_VERSION} auth-login\` to refresh storageState before re-running.`,
      guidance:
        `Authentication session expired or missing. Do NOT edit test assertions; refresh session via \`auth-login\` (\`npx ai-test-workbench@${WORKBENCH_VERSION} auth-login\`) and re-run.`,
    };
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
      authExpiredHint: null,
      guidance: 'Explicit specification ambiguity detected. Pause test edits and confirm expected behavior with user.',
    };
  }

  if (guardSignals && Array.isArray(guardSignals.serverErrors) && guardSignals.serverErrors.length > 0) {
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'high',
      candidates: ['C'],
      evidence: ['runtime-guard:serverErrors'],
      authExpiredHint: null,
      guidance:
        'Structured 5xx server error captured by runtime guard. NEVER weaken assertions or add test.skip/fixme; file a C-class defect with traceId.',
    };
  }

  if (CLASS_C_TEXT_RE.test(txt)) {
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'high',
      candidates: ['C'],
      evidence: ['backend-5xx-or-contract-error'],
      authExpiredHint: null,
      guidance:
        'Backend 5xx, uncaught frontend exception, or API contract violation. Do NOT weaken assertions or add test.skip/fixme; file a bug report with traceId.',
    };
  }

  if (TARGET_BLOCKED_ERROR_RE.test(txt)) {
    return {
      categoryCode: 'B',
      category: 'B (Environment / Auth / Network)',
      confidence: 'high',
      candidates: ['B'],
      evidence: ['network-auth-env-guard', ...(hasBlockedReqs ? ['runtime-guard:blockedRequests'] : [])],
      authExpiredHint: null,
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
        authExpiredHint: null,
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
      authExpiredHint: null,
      guidance:
        'Business value or contract assertion failed against expected oracle. Keep red and report product defect with traceId.',
    };
  }

  if (CLASS_A_LOCATOR_RE.test(txt)) {
    if (/\btobevisible\b/i.test(txt) && ev.elementNotFound) {
      return {
        categoryCode: 'C',
        category: 'C (Visibility Assertion Missing Element — Dual Candidate C/A)',
        confidence: 'medium',
        candidates: ['C', 'A'],
        evidence: ['matcher=toBeVisible', 'element-not-found'],
        authExpiredHint: null,
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
      authExpiredHint: null,
      guidance:
        'Inspect ARIA snapshot in error-context.md. If UI locator drifted legitimately without business regression, repair semantic locator (max 3 attempts via aitest_heal(action="begin"|"attempt")).',
    };
  }

  if (guardSignals && Array.isArray(guardSignals.pageErrors) && guardSignals.pageErrors.length > 0) {
    return {
      categoryCode: 'C',
      category: 'C (Suspected Product / Backend Defect)',
      confidence: 'medium-high',
      candidates: ['C'],
      evidence: ['runtime-guard:pageErrors'],
      authExpiredHint: null,
      guidance: 'Uncaught frontend exception captured by pageerror guard. Keep red and report product defect.',
    };
  }

  if (hasBlockedReqs) {
    return {
      categoryCode: 'B',
      category: 'B (Environment / Auth / Network)',
      confidence: 'high',
      candidates: ['B', 'A'],
      evidence: ['runtime-guard:blockedRequests'],
      authExpiredHint: null,
      guidance:
        'Request blocked by outbound/mutation safety guard. Check TEST_ALLOWED_HOSTS, TEST_EGRESS_MODE, or add @mutation if state write is intentional.',
    };
  }

  return {
    categoryCode: 'D',
    category: 'D (Needs Requirement / Spec Clarification)',
    confidence: 'low',
    candidates: ['D'],
    evidence: ['unclassified'],
    authExpiredHint: null,
    guidance:
      'Ambiguous failure signature. Compare actual app behavior against specs/*.md and confirm expected behavior with user.',
  };
}
