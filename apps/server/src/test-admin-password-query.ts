import assert from 'node:assert';
import { initAdminPassword, verifyPasswordAsync, getLocalConfig } from './config/local-config.js';

console.log('Running #130 admin password query parameter security test...');

// 1. Setup admin password
const TEST_PASSWORD = 'SecureAdminPassword123!';
process.env.ADMIN_PASSWORD = TEST_PASSWORD;
initAdminPassword();

import { checkAdminAuth } from './admin-auth.js';

async function runTests() {
    // A. Header authentication -> ACCEPTED
    const headerCtx = {
        get: (h: string) => h.toLowerCase() === 'x-admin-password' ? TEST_PASSWORD : null,
        request: { headers: { 'x-admin-password': TEST_PASSWORD } }
    };
    const headerAuthOk = await checkAdminAuth(headerCtx);
    assert.strictEqual(headerAuthOk, true, 'Header auth X-Admin-Password must succeed');

    // B. Request body authentication -> ACCEPTED
    const bodyCtx = {
        requestBody: { password: TEST_PASSWORD },
        request: { body: { password: TEST_PASSWORD } }
    };
    const bodyAuthOk = await checkAdminAuth(bodyCtx);
    assert.strictEqual(bodyAuthOk, true, 'Request body auth must succeed');

    // C. Query parameter authentication -> REJECTED (#130)
    const queryCtx = {
        query: { password: TEST_PASSWORD },
        request: { query: { password: TEST_PASSWORD } }
    };
    const queryAuthOk = await checkAdminAuth(queryCtx);
    assert.strictEqual(queryAuthOk, false, 'Query parameter password auth MUST BE REJECTED');

    console.log('✅ #130 admin password query parameter security test PASSED!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
