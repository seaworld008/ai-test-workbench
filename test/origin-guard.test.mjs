import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  evaluateTargetSafety,
} from '../src/origin-guard.mjs';
import { redactEnvEntries, redactSecrets } from '../src/proc.mjs';

test('evaluateTargetSafety blocks production TEST_ENV', () => {
  const res = evaluateTargetSafety({
    TEST_ENV: 'production',
    TEST_BASE_URL: 'http://127.0.0.1:5899',
    TEST_ALLOWED_HOSTS: '127.0.0.1',
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /Production environments are blocked/i);
});

test('evaluateTargetSafety blocks wildcard host patterns and untrusted hosts', () => {
  const wildcard = evaluateTargetSafety({
    TEST_ENV: 'staging',
    TEST_BASE_URL: 'https://staging.example.com',
    TEST_ALLOWED_HOSTS: '*.example.com',
  });
  assert.equal(wildcard.ok, false);
  assert.match(wildcard.errors.join(' '), /Wildcard host pattern is forbidden/i);

  const untrusted = evaluateTargetSafety({
    TEST_ENV: 'staging',
    TEST_BASE_URL: 'https://evil.example.org',
    TEST_ALLOWED_HOSTS: '127.0.0.1,localhost',
  });
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.errors.join(' '), /not in TEST_ALLOWED_HOSTS/i);
});

test('evaluateTargetSafety enforces REQUIRE_TEST_TARGET=1 and TEST_DENIED_ORIGINS', () => {
  const missingUrl = evaluateTargetSafety({
    TEST_ENV: 'staging',
    REQUIRE_TEST_TARGET: '1',
    TEST_BASE_URL: '',
  });
  assert.equal(missingUrl.ok, false);
  assert.match(missingUrl.errors.join(' '), /REQUIRE_TEST_TARGET=1/i);

  const denied = evaluateTargetSafety({
    TEST_ENV: 'staging',
    TEST_BASE_URL: 'https://prod.example.com',
    TEST_ALLOWED_HOSTS: 'prod.example.com',
    TEST_DENIED_ORIGINS: 'https://prod.example.com',
  });
  assert.equal(denied.ok, false);
  assert.match(denied.errors.join(' '), /TEST_DENIED_ORIGINS/i);
});

test('evaluateTargetSafety allows valid localhost demo URL', () => {
  const okRes = evaluateTargetSafety({
    TEST_ENV: 'local',
    TEST_BASE_URL: 'http://127.0.0.1:5899',
    TEST_ALLOWED_HOSTS: '127.0.0.1,localhost',
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.baseURL, 'http://127.0.0.1:5899');
});

test('checkOutgoingRequestSafety blocks dangerous endpoints and strict readonly writes except safe login', () => {
  const blockedRules = compileBlockedEndpointRules('POST /api/pay*,POST /api/sms*,DELETE /api/prod*');

  const payCheck = checkOutgoingRequestSafety('POST', 'http://127.0.0.1:5899/api/pay/charge', {
    blockedRules,
  });
  assert.equal(payCheck.blocked, true);
  assert.match(payCheck.reason, /Blocked dangerous endpoint/i);

  const roLogin = checkOutgoingRequestSafety('POST', 'http://127.0.0.1:5899/api/login', {
    strictReadonly: true,
    safeWritePaths: ['/api/login', '/graphql'],
  });
  assert.equal(roLogin.blocked, false);

  const roEnroll = checkOutgoingRequestSafety('POST', 'http://127.0.0.1:5899/api/enroll', {
    strictReadonly: true,
    safeWritePaths: ['/api/login', '/graphql'],
  });
  assert.equal(roEnroll.blocked, true);
});

test('redactSecrets strips passwords, tokens, cookies, and URL basic auth', () => {
  const dirty = [
    'E2E_PASSWORD=mySuperSecretPassword123',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
    'cookie: session_id=abc987xyz',
    'Connecting to https://admin:topsecret@staging.internal/api',
  ].join('\n');

  const clean = redactSecrets(dirty);
  assert.equal(clean.includes('mySuperSecretPassword123'), false);
  assert.equal(clean.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false);
  assert.equal(clean.includes('abc987xyz'), false);
  assert.equal(clean.includes('topsecret'), false);
  assert.match(clean, /\[REDACTED\]/);

  const envClean = redactEnvEntries({ E2E_PASSWORD: '123', TEST_ENV: 'local' });
  assert.equal(envClean.E2E_PASSWORD, '[REDACTED]');
  assert.equal(envClean.TEST_ENV, 'local');
});
