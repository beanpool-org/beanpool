/**
 * test-admin-seed-invite.ts — Integration tests for Admin Seed Invite Generation (`POST /api/admin/seed-invite`).
 *
 * Verifies:
 * 1. Admin auth gate: 401 on missing or invalid password.
 * 2. Fresh node (0 members): generates genesis admin member and seed invite code.
 * 3. Redeeming the seed invite code creates a new member.
 * 4. Existing node (>0 members): generates tiered seed invite codes ('standard', 'trusted', 'ambassador', 'elder')
 *    from the genesis/admin member, defaulting invalid tier names to 'standard'.
 * 5. Key-signed sessions (the app's 'Manage' button): an admin's session issues an invite that redeems, and the
 *    invite records who issued it; a member with no role cannot get a session; a moderator gets one (it reaches
 *    reports only) but is refused invites; a made-up session is refused; an admin removed from node_roles loses the
 *    power at once.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

const PORT = 8593;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdminPass123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
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

/** Signs the node's challenge with the member's key, as the app does, and returns the verify-challenge response. */
async function solveChallenge(kp: ReturnType<typeof makeKeypair>): Promise<{ status: number; body: any }> {
    const chal = await postJson('/api/local/admin/auth/challenge', {});
    const signature = crypto.sign(null, Buffer.from(chal.body.challenge, 'utf-8'), kp.privateKey).toString('hex');
    return postJson('/api/local/admin/auth/verify-challenge', {
        challengeId: chal.body.challengeId, memberPubkey: kp.pubKeyHex, signature,
    });
}

/** Full key sign-in: challenge → signature → handshake token → admin session id. */
async function keySession(kp: ReturnType<typeof makeKeypair>): Promise<string> {
    const solved = await solveChallenge(kp);
    if (solved.status !== 200) throw new Error(`verify-challenge refused: ${solved.status} ${JSON.stringify(solved.body)}`);
    const ex = await postJson('/api/local/admin/auth/exchange', { token: solved.body.handshakeToken });
    if (ex.status !== 200) throw new Error(`exchange refused: ${ex.status}`);
    return ex.body.sessionId;
}

function issuedByOf(code: string): string | null {
    const row = db.prepare('SELECT issued_by FROM invite_codes WHERE code = ?').get(code) as { issued_by: string | null } | undefined;
    return row ? row.issued_by : null;
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
    assert(issuedByOf(elderRes.body.code) === 'owner:password', "Password-issued invite records issued_by = 'owner:password'");

    // 5. Key-signed sessions
    const pwHeader = { 'X-Admin-Password': PW };
    const bob = makeKeypair();      // will be admin
    const mo = makeKeypair();       // will be moderator
    const charlie = makeKeypair();  // member, no role
    for (const [kp, callsign] of [[bob, 'BobAdmin'], [mo, 'MoModerator'], [charlie, 'CharlieMember']] as const) {
        const inv = await postJson('/api/admin/seed-invite', { password: PW });
        const red = await postJson('/api/invite/redeem', { code: inv.body.code, publicKey: kp.pubKeyHex, callsign });
        assert(red.status === 200 && red.body.success === true, `${callsign} joins the node`);
    }
    const grantBob = await postJson('/api/local/admin/node-roles', { pubkey: bob.pubKeyHex, role: 'admin' }, pwHeader);
    assert(grantBob.status === 200, 'Owner (password) makes Bob an admin');
    const grantMo = await postJson('/api/local/admin/node-roles', { pubkey: mo.pubKeyHex, role: 'moderator' }, pwHeader);
    assert(grantMo.status === 200, 'Owner (password) makes Mo a moderator');

    const bobSession = await keySession(bob);
    const keyRes = await postJson('/api/admin/seed-invite', { type: 'trusted' }, { 'x-admin-session': bobSession });
    assert(keyRes.status === 200 && keyRes.body.success === true, 'Admin key session (no password) → seed-invite 200');
    assert(typeof keyRes.body.code === 'string' && keyRes.body.code.length > 0, 'Admin key session gets a code');
    assert(keyRes.body.type === 'trusted', 'Admin key session invite has the requested tier');
    assert(issuedByOf(keyRes.body.code) === bob.pubKeyHex, "Key-issued invite records the admin's own key as issued_by");
    const dave = makeKeypair();
    const daveRedeem = await postJson('/api/invite/redeem', { code: keyRes.body.code, publicKey: dave.pubKeyHex, callsign: 'DaveViaKey' });
    assert(daveRedeem.status === 200 && daveRedeem.body.success === true, 'The code from the key session redeems');

    const charlieSolve = await solveChallenge(charlie);
    assert(charlieSolve.status === 403, 'Member without a role cannot get an admin session (403)');
    const moSession = await keySession(mo);
    assert(!!moSession, 'A moderator gets a key session (it reaches reports only)');
    const moInvite = await postJson('/api/admin/seed-invite', { type: 'trusted' }, { 'x-admin-session': moSession });
    assert(moInvite.status === 403 && !moInvite.body.code, `Moderator key session → seed-invite 403, no code (got ${moInvite.status})`);
    const fakeSession = await postJson('/api/admin/seed-invite', {}, { 'x-admin-session': 'not-a-real-session' });
    assert(fakeSession.status === 401, 'Made-up admin session → seed-invite 401');
    assert(!fakeSession.body.code, 'Made-up admin session gets no code');

    const demote = await fetch(`${BASE}/api/local/admin/node-roles/${bob.pubKeyHex}/admin`, { method: 'DELETE', headers: pwHeader });
    assert(demote.status === 200, "Owner removes Bob's admin role");
    const afterDemote = await postJson('/api/admin/seed-invite', {}, { 'x-admin-session': bobSession });
    assert(afterDemote.status === 401, 'Removed admin: the same session → seed-invite 401');
    assert(!afterDemote.body.code, 'Removed admin gets no code');

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
