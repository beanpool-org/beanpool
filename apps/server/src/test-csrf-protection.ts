/**
 * Regression test for Issue #133: Admin panel CSRF protection.
 *
 * Verifies:
 * A. issueCsrfToken(SESSION) generates a unique 64-char hex token
 * B. validateCsrfToken() accepts a valid token
 * C. validateCsrfToken() rejects unknown/empty tokens
 * D. revokeCsrfToken() invalidates a previously valid token
 * E. Expired tokens are rejected (simulated via clock manipulation)
 * F. Expired tokens are eagerly deleted from the store on encounter
 */
import assert from 'node:assert';
import { issueCsrfToken, validateCsrfToken, revokeCsrfToken } from './admin-auth.js';

console.log('Running #133 CSRF protection test...');

// Every token is bound to the admin session it was issued to (admin-auth.ts, CSRF TOKEN STORE): one session stands in
// for all of them here, and G checks a token never validates for another.
const SESSION = 'a'.repeat(64);
const OTHER_SESSION = 'b'.repeat(64);

function makeCtx(token: string | undefined) {
    return {
        get: (h: string) => h.toLowerCase() === 'x-csrf-token' ? token : undefined,
        request: { headers: { 'x-csrf-token': token } }
    };
}

// A. Token is a 64-char hex string
const token1 = issueCsrfToken(SESSION);
assert.strictEqual(typeof token1, 'string', 'Token must be a string');
assert.strictEqual(token1.length, 64, 'Token must be 64 hex characters (32 bytes)');
assert.ok(/^[0-9a-f]+$/.test(token1), 'Token must be lowercase hex');

// Each call returns a unique token
const token2 = issueCsrfToken(SESSION);
assert.notStrictEqual(token1, token2, 'Each token must be unique');

// B. Valid tokens are accepted
assert.strictEqual(validateCsrfToken(makeCtx(token1), SESSION), true, 'Valid token must be accepted');
assert.strictEqual(validateCsrfToken(makeCtx(token2), SESSION), true, 'Second valid token must be accepted');

// C. Unknown / empty tokens are rejected
assert.strictEqual(validateCsrfToken(makeCtx('not-a-real-token'), SESSION), false, 'Unknown token must be rejected');
assert.strictEqual(validateCsrfToken(makeCtx(undefined), SESSION), false, 'Missing token must be rejected');
assert.strictEqual(validateCsrfToken(makeCtx(''), SESSION), false, 'Empty token must be rejected');

// D. Revoked tokens are invalidated
revokeCsrfToken(token1);
assert.strictEqual(validateCsrfToken(makeCtx(token1), SESSION), false, 'Revoked token must be rejected');
// token2 should still be valid
assert.strictEqual(validateCsrfToken(makeCtx(token2), SESSION), true, 'Other tokens unaffected by single revocation');

// E. Expired tokens are rejected (simulate by monkey-patching Date.now)
const token3 = issueCsrfToken(SESSION);
assert.strictEqual(validateCsrfToken(makeCtx(token3), SESSION), true, 'Fresh token3 must be valid before expiry');

const realDateNow = Date.now;
try {
    // Jump clock 5 hours into the future (past the 4-hour TTL)
    Date.now = () => realDateNow() + 5 * 60 * 60 * 1000;
    assert.strictEqual(validateCsrfToken(makeCtx(token3), SESSION), false, 'Expired token must be rejected');
} finally {
    Date.now = realDateNow;
}

// F. Expired token eagerly deleted — after expiry check above, token3 should be gone from the store
//    Restore real clock and verify it can't be re-validated even if clock is reset
assert.strictEqual(validateCsrfToken(makeCtx(token3), SESSION), false, 'Eagerly deleted expired token stays rejected after clock restore');

// G. A token counts only for the session it was issued to (Fable's web review, L4)
const token4 = issueCsrfToken(SESSION);
assert.strictEqual(validateCsrfToken(makeCtx(token4), OTHER_SESSION), false, "A session's token is refused for another session");
assert.strictEqual(validateCsrfToken(makeCtx(token4), SESSION), true, '… and still valid for its own');

console.log('✅ #133 CSRF protection test PASSED!');

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
