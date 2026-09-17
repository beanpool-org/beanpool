/**
 * test-admin-seed-invite.ts — Integration tests for Admin Seed Invite Generation (`POST /api/admin/seed-invite`).
 *
 * Verifies:
 * 1. Admin auth gate: 401 on missing or invalid password.
 * 2. Fresh node (0 members): generates genesis admin member and seed invite code.
 * 3. Redeeming the seed invite code creates a new member.
 * 4. Existing node (>0 members): generates tiered seed invite codes ('standard', 'trusted', 'ambassador', 'elder')
 *    from the genesis/admin member, defaulting invalid tier names to 'standard'.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';

const PORT = 8593;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdminPass123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function postJson(path: string, body: any): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let resBody: any = {};
    try { resBody = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: resBody };
}

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { publicKey, privateKey, pubKeyHex };
}

async function main() {
    console.log('--- TEST: Admin Seed Invite (`POST /api/admin/seed-invite`) ---');

    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // 1. Verify password authentication failure
    const badPwRes = await postJson('/api/admin/seed-invite', { password: 'wrong' });
    assert(badPwRes.status === 401, 'POST /api/admin/seed-invite with wrong password returns 401');

    const noPwRes = await postJson('/api/admin/seed-invite', {});
    assert(noPwRes.status === 401, 'POST /api/admin/seed-invite with missing password returns 401');

    // 2. Fresh node (0 members): generate seed invite
    const freshRes = await postJson('/api/admin/seed-invite', { password: PW, type: 'ambassador' });
    assert(freshRes.status === 200, 'POST /api/admin/seed-invite on fresh node returns 200');
    assert(freshRes.body.success === true, 'Response indicates success === true');
    assert(typeof freshRes.body.code === 'string' && freshRes.body.code.length > 0, 'Seed invite code is returned');
    assert(freshRes.body.type === 'ambassador', 'Invite type matches requested ambassador tier');

    const seedCode = freshRes.body.code;

    // 3. Verify redeeming the seed invite code registers a new member
    const alice = makeKeypair();
    const redeemRes = await postJson('/api/invite/redeem', {
        code: seedCode,
        publicKey: alice.pubKeyHex,
        callsign: 'AliceSeedUser',
    });
    assert(redeemRes.status === 200 && redeemRes.body.success === true, 'Redeeming seed invite registers Alice successfully');

    // 4. Node with members (>0 members): generate tiered seed invites
    const elderRes = await postJson('/api/admin/seed-invite', { password: PW, type: 'elder' });
    assert(elderRes.status === 200 && elderRes.body.success === true, 'Existing node generates elder tier invite');
    assert(elderRes.body.tierLabel.includes('Elder'), 'Tier label reflects Elder');

    const invalidTierRes = await postJson('/api/admin/seed-invite', { password: PW, type: 'superduper' });
    assert(invalidTierRes.status === 200 && invalidTierRes.body.success === true, 'Invalid tier name defaults to standard');
    assert(invalidTierRes.body.type === 'standard', 'Returned invite type is standard');

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed}/${run} assertions passed`);
    console.log(`========================================`);
    if (passed !== run) {
        throw new Error(`${run - passed} assertions failed`);
    }
}

main().then(() => process.exit(0)).catch(e => {
    console.error('Test failed with error:', e);
    process.exit(1);
});
