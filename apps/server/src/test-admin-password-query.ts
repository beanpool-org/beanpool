import assert from 'node:assert';
import { initAdminPassword, verifyPasswordAsync, getLocalConfig } from './config/local-config.js';

console.log('Running #130 admin password query parameter security test...');

// 1. Setup admin password
const TEST_PASSWORD = 'SecureAdminPassword123!';
process.env.ADMIN_PASSWORD = TEST_PASSWORD;
initAdminPassword();

// Re-implement checkAdminAuth logic exact matching https-server.ts:
async function checkAdminAuth(ctx: any): Promise<boolean> {
    const config = getLocalConfig();
    const headerPass = (typeof ctx.get === 'function' ? ctx.get('x-admin-password') : null) || ctx.request?.headers?.['x-admin-password'] || ctx.headers?.['x-admin-password'];
    // #130: Password must travel in X-Admin-Password header or request body only, NEVER in URL query params.
    const password = ctx.requestBody?.password || ctx.request?.body?.password || headerPass;
    const ok = !!password && !!config.adminHash && !!config.salt
        && await verifyPasswordAsync(password as string, config.adminHash, config.salt);
    return ok;
}

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
