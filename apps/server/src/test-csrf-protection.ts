/**
 * Regression test for Issue #133: Admin panel CSRF protection.
 *
 * Verifies:
 * A. issueCsrfToken() generates a unique 64-char hex token
 * B. validateCsrfToken() accepts a valid token
 * C. validateCsrfToken() rejects unknown/empty tokens
 * D. revokeCsrfToken() invalidates a previously valid token
 * E. Expired tokens are rejected (simulated via clock manipulation)
 * F. Expired tokens are eagerly deleted from the store on encounter
 */
import assert from 'node:assert';
import { issueCsrfToken, validateCsrfToken, revokeCsrfToken } from './admin-auth.js';

console.log('Running #133 CSRF protection test...');

function makeCtx(token: string | undefined) {
    return {
        get: (h: string) => h.toLowerCase() === 'x-csrf-token' ? token : undefined,
        request: { headers: { 'x-csrf-token': token } }
    };
}

// A. Token is a 64-char hex string
const token1 = issueCsrfToken();
assert.strictEqual(typeof token1, 'string', 'Token must be a string');
assert.strictEqual(token1.length, 64, 'Token must be 64 hex characters (32 bytes)');
assert.ok(/^[0-9a-f]+$/.test(token1), 'Token must be lowercase hex');

// Each call returns a unique token
const token2 = issueCsrfToken();
assert.notStrictEqual(token1, token2, 'Each token must be unique');

// B. Valid tokens are accepted
assert.strictEqual(validateCsrfToken(makeCtx(token1)), true, 'Valid token must be accepted');
assert.strictEqual(validateCsrfToken(makeCtx(token2)), true, 'Second valid token must be accepted');

// C. Unknown / empty tokens are rejected
assert.strictEqual(validateCsrfToken(makeCtx('not-a-real-token')), false, 'Unknown token must be rejected');
assert.strictEqual(validateCsrfToken(makeCtx(undefined)), false, 'Missing token must be rejected');
assert.strictEqual(validateCsrfToken(makeCtx('')), false, 'Empty token must be rejected');

// D. Revoked tokens are invalidated
revokeCsrfToken(token1);
assert.strictEqual(validateCsrfToken(makeCtx(token1)), false, 'Revoked token must be rejected');
// token2 should still be valid
assert.strictEqual(validateCsrfToken(makeCtx(token2)), true, 'Other tokens unaffected by single revocation');

// E. Expired tokens are rejected (simulate by monkey-patching Date.now)
const token3 = issueCsrfToken();
assert.strictEqual(validateCsrfToken(makeCtx(token3)), true, 'Fresh token3 must be valid before expiry');

const realDateNow = Date.now;
try {
    // Jump clock 5 hours into the future (past the 4-hour TTL)
    Date.now = () => realDateNow() + 5 * 60 * 60 * 1000;
    assert.strictEqual(validateCsrfToken(makeCtx(token3)), false, 'Expired token must be rejected');
} finally {
    Date.now = realDateNow;
}

// F. Expired token eagerly deleted — after expiry check above, token3 should be gone from the store
//    Restore real clock and verify it can't be re-validated even if clock is reset
assert.strictEqual(validateCsrfToken(makeCtx(token3)), false, 'Eagerly deleted expired token stays rejected after clock restore');

console.log('✅ #133 CSRF protection test PASSED!');
