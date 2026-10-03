import assert from 'node:assert';
import { initAdminPassword, verifyPasswordAsync, getLocalConfig } from './config/local-config.js';

console.log('Running #130 admin password query parameter security test...');

// 1. Setup admin password
const TEST_PASSWORD = 'SecureAdminPassword123!';
process.env.ADMIN_PASSWORD = TEST_PASSWORD;
initAdminPassword();

import { checkAdminAuth, PASSWORD_NEEDS_2FA_CODE } from './admin-auth.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';

async function runTests() {
    // Step 7c: with the node's 2FA off, the password alone (header or body) opens no admin route.
    const headerAloneCtx: any = {
        get: (h: string) => h.toLowerCase() === 'x-admin-password' ? TEST_PASSWORD : null,
        request: { headers: { 'x-admin-password': TEST_PASSWORD } }
    };
    assert.strictEqual(await checkAdminAuth(headerAloneCtx), false, 'With 2FA off, the X-Admin-Password header alone is refused');
    assert.strictEqual(headerAloneCtx.body?.code, PASSWORD_NEEDS_2FA_CODE, 'the header refusal is password_needs_2fa');
    const bodyAloneCtx: any = {
        requestBody: { password: TEST_PASSWORD },
        request: { body: { password: TEST_PASSWORD } }
    };
    assert.strictEqual(await checkAdminAuth(bodyAloneCtx), false, 'With 2FA off, the body password alone is refused');
    assert.strictEqual(bodyAloneCtx.body?.code, PASSWORD_NEEDS_2FA_CODE, 'the body refusal is password_needs_2fa');

    // From here the node's 2FA is on, and the password goes with a fresh code.
    const tfa = turnOn2faForTests(TEST_PASSWORD);

    // A. Header authentication -> ACCEPTED
    const headerTotp = tfa.code();
    const headerCtx = {
        get: (h: string) => h.toLowerCase() === 'x-admin-password' ? TEST_PASSWORD : h.toLowerCase() === 'x-admin-totp' ? headerTotp : null,
        request: { headers: { 'x-admin-password': TEST_PASSWORD, 'x-admin-totp': headerTotp } }
    };
    const headerAuthOk = await checkAdminAuth(headerCtx);
    assert.strictEqual(headerAuthOk, true, 'Header auth X-Admin-Password must succeed');

    // B. Request body authentication -> ACCEPTED
    const bodyTotp = tfa.code();
    const bodyCtx = {
        requestBody: { password: TEST_PASSWORD, totpCode: bodyTotp },
        request: { body: { password: TEST_PASSWORD, totpCode: bodyTotp } }
    };
    const bodyAuthOk = await checkAdminAuth(bodyCtx);
    assert.strictEqual(bodyAuthOk, true, 'Request body auth must succeed');

    // C. Query parameter authentication -> REJECTED (#130), even with a good code beside it
    const queryTotp = tfa.code();
    const queryCtx = {
        get: (h: string) => h.toLowerCase() === 'x-admin-totp' ? queryTotp : null,
        query: { password: TEST_PASSWORD },
        request: { query: { password: TEST_PASSWORD }, headers: { 'x-admin-totp': queryTotp } }
    };
    const queryAuthOk = await checkAdminAuth(queryCtx);
    assert.strictEqual(queryAuthOk, false, 'Query parameter password auth MUST BE REJECTED');

    console.log('✅ #130 admin password query parameter security test PASSED!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
