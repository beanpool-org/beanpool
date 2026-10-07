/**
 * Admin-auth tests (audit findings A2-4 + A2-21 / SRV-14).
 *
 *   A2-21 verifyPasswordAsync runs scrypt OFF the event loop and verifies correctly.
 *   A2-4  checkAdminAuth still gates (wrong→401, right→200: since sign-in step 7c, right + a 2FA code; the right password
 *         alone with 2FA off → 403 password_needs_2fa) AND tarpits failed
 *         attempts with a growing delay (brute-force throttle), while a correct
 *         password is answered promptly.
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-admin-auth.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!'; // known strong pw (read by initAdminPassword)
process.env.BEANPOOL_SUITE_ENV_PASSWORD = '1';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword, getLocalConfig, verifyPasswordAsync, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';
const PW = 'TestAdmin123!';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function adminPost(path: string, password: string, headers: Record<string, string> = {}): Promise<{ status: number; ms: number; code?: string }> {
    const t0 = Date.now();
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password }),
    });
    let code: string | undefined;
    try { code = ((await res.json()) as any)?.code; } catch { /* */ }
    return { status: res.status, ms: Date.now() - t0, code };
}

async function main() {
    console.log('Running admin-auth tests (A2-4/A2-21)...\n');
    initAdminPassword();
    const cfg = getLocalConfig();
    if (!cfg.adminHash || !cfg.salt) throw new Error('setup: admin hash/salt not initialized');

    // A2-21 — async scrypt verifies correctly off-thread.
    assert(await verifyPasswordAsync(PW, cfg.adminHash, cfg.salt) === true, 'A2-21: verifyPasswordAsync accepts the correct password');
    assert(await verifyPasswordAsync('wrong', cfg.adminHash, cfg.salt) === false, 'A2-21: verifyPasswordAsync rejects a wrong password');
    assert(await verifyPasswordAsync(PW, 'deadbeef', cfg.salt) === false, 'A2-21: verifyPasswordAsync rejects a malformed/short stored hash (no throw)');
    assert(await verifyPasswordAsync(null as any, cfg.adminHash, cfg.salt) === false, 'A2-21: verifyPasswordAsync handles null password (no throw)');
    assert(await verifyPasswordAsync(PW, null as any, cfg.salt) === false, 'A2-21: verifyPasswordAsync handles null hash (no throw)');
    assert(await verifyPasswordAsync(PW, cfg.adminHash, null as any) === false, 'A2-21: verifyPasswordAsync handles null salt (no throw)');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    // A2-4 — gating still correct after the async conversion.
    // Step 7c: with 2FA off the right password alone opens no admin route (refused as needing 2FA, not as a wrong one).
    const alone = await adminPost('/api/local/admin/data', PW);
    assert(alone.status === 403 && alone.code === 'password_needs_2fa', `A2-4: the right password alone, 2FA off, is refused as needing 2FA (got ${alone.status} ${alone.code})`);
    // With 2FA on, the right password and a code are accepted; 2FA goes off again for the wrong-password checks.
    const tfa = turnOn2faForTests(PW);
    const okResp = await adminPost('/api/local/admin/data', PW, { 'X-Admin-TOTP': tfa.code() });
    updateLocalConfig({ totpEnabled: false, totpSecret: null });
    assert(okResp.status === 200, `A2-4: correct admin password accepted (got ${okResp.status})`);
    assert(okResp.ms < 1500, `A2-4: a correct password is answered promptly, not tarpitted (${okResp.ms}ms)`);

    const bad1 = await adminPost('/api/local/admin/data', 'nope1');
    assert(bad1.status === 401, `A2-4: wrong admin password rejected (got ${bad1.status})`);
    assert(bad1.ms >= 200, `A2-4: a failed attempt is tarpitted (${bad1.ms}ms ≥ ~250ms)`);

    const bad2 = await adminPost('/api/local/admin/data', 'nope2');
    assert(bad2.ms >= bad1.ms, `A2-4: tarpit delay grows with consecutive failures (${bad1.ms}ms → ${bad2.ms}ms)`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Admin-auth checks PASSED (A2-4/A2-21).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
