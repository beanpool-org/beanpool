/**
 * Admin-auth tests (audit findings A2-4 + A2-21 / SRV-14).
 *
 *   A2-21 verifyPasswordAsync runs scrypt OFF the event loop and verifies correctly.
 *   A2-4  checkAdminAuth still gates (wrong→401, right→200) AND tarpits failed
 *         attempts with a growing delay (brute-force throttle), while a correct
 *         password is answered promptly.
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-admin-auth.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!'; // known strong pw (read by initAdminPassword)

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword, getLocalConfig, verifyPasswordAsync } from './config/local-config.js';

const PORT = 8547;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function adminPost(path: string, password: string): Promise<{ status: number; ms: number }> {
    const t0 = Date.now();
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    try { await res.json(); } catch { /* */ }
    return { status: res.status, ms: Date.now() - t0 };
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

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // A2-4 — gating still correct after the async conversion.
    const okResp = await adminPost('/api/local/admin/data', PW);
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
