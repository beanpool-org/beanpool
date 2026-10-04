/**
 * Test Suite: an unused re-key code can be cancelled, and cancelling undoes exactly what making it did (queue item 22,
 * found live 2026-10-04: a code made by mistake against a member's current key stopped that key, suspended the member
 * and ended their sessions, and only a hand edit of the database undid it).
 *
 * issueRekeyCode (engine/member-wizards.ts) holds the key ('rekey_pending' in invalidated_keys), suspends the member and
 * ends their sessions; cancelRekeyCode (POST /api/local/admin/members/:pubkey/rekey/cancel) cancels the code, frees the
 * key and puts back the status the member had before the code (rekey_requests.prior_status), in one transaction.
 *
 * Every request goes over real HTTPS through the app's own middleware (startHttpsServer): operators sign in with a key
 * session as the app does (challenge, signature, handshake, session), members sign each request with their key.
 *
 *  A. A code made and cancelled: the code is cancelled, the key is free, the member is active and acts again, one log
 *     line; a second cancel is refused.
 *  B. Who may cancel: no session and a member's signature are refused; an admin can't cancel an admin's code (an owner
 *     made it) and nothing changes; the owner can, and the admin signs in again; an admin cancels a code they made.
 *  C. The live incident: a completed re-key, its code refused; opening the wizard on the new key (the status read)
 *     makes nothing; a code made against the new key, then cancelled: the member ends active on the new key.
 *  D. An expired code is refused, and the member is left as the code left them; a new code, cancelled, frees them.
 *  E. A code made before the prior status was kept puts a re-key-suspended member back to active, and says so.
 *  F. A member suspended by an admin ('disabled') stays so; two codes in a row put back the status before the first.
 *  G. A write that would touch an unexpected row changes nothing: the key freed meanwhile, the cancel is refused.
 *
 * Run (from apps/server): mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-rekey-cancel" node ../../scripts/run-server-suites.mjs
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, getMember } from './state-engine.js';
import { grantNodeRole } from './engine/node-roles.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';

// No host but this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { privateKey, pubKeyHex };
}
type Keypair = ReturnType<typeof makeKeypair>;

/** Key sign-in as the app does it: challenge → signature → handshake token → session. */
function keySession(kp: Keypair): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) throw new Error(`challenge refused: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`handshake refused: ${ex.error}`);
    return ex.sessionId!;
}
const signsIn = (kp: Keypair): boolean => {
    try { return !!keySession(kp); } catch { return false; }
};

const heldReason = (pk: string) => (db.prepare('SELECT reason FROM invalidated_keys WHERE public_key = ?').get(pk) as any)?.reason as string | undefined;
const latestRequest = (pk: string) => db.prepare('SELECT * FROM rekey_requests WHERE old_pubkey = ? ORDER BY id DESC LIMIT 1').get(pk) as any;
const requestCount = (pk: string) => (db.prepare('SELECT COUNT(*) AS c FROM rekey_requests WHERE old_pubkey = ?').get(pk) as any).c as number;
const cancelLogLines = (callsign: string) => (db.prepare("SELECT COUNT(*) AS c FROM system_logs WHERE message LIKE ?").get(`Re-enrolment code cancelled for member ${callsign} %`) as any).c as number;

async function runTests() {
    console.log('--- TEST: an unused re-key code can be cancelled, and the cancel undoes exactly what the code did ---');

    initStateEngine();
    const owner = makeKeypair();
    seedGenesisMember(owner.pubKeyHex, 'OwnerOlive');
    const join = (kp: Keypair, name: string) => {
        const inv = generateInvite(owner.pubKeyHex)!;
        const r = redeemInvite(inv.code, kp.pubKeyHex, name);
        if (!r.success) throw new Error(`join ${name} failed`);
    };

    initTls();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const ownerSession = keySession(owner);

    async function as(session: string | null, method: string, path: string, body?: unknown) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (session) headers['x-admin-session'] = session;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => ({})) as any };
    }
    async function signed(kp: Keypair, path: string, body: unknown) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const bodyStr = JSON.stringify(body);
        const signature = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${bodyStr}`), kp.privateKey).toString('base64');
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': kp.pubKeyHex, 'X-Signature': signature, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
            },
            body: bodyStr,
        });
        return { status: res.status, json: await res.json().catch(() => ({})) as any };
    }
    async function reEnroll(code: string, kp: Keypair) {
        const signature = crypto.sign(null, Buffer.from(code, 'utf8'), kp.privateKey).toString('base64');
        return signed(kp, '/api/member/re-enroll', { code, newPublicKey: kp.pubKeyHex, signature });
    }
    const issue = (session: string, pk: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/issue-code`);
    const cancel = (session: string | null, pk: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/cancel`);
    const acts = async (kp: Keypair, bio: string) => (await signed(kp, '/api/profile/update', { bio })).status < 400;

    // ── A. Made and cancelled ───────────────────────────────────────────────────────────────
    {
        const mia = makeKeypair();
        join(mia, 'MiaMember');
        assert(await acts(mia, 'before'), 'A: Mia acts before any code');
        const made = await issue(ownerSession, mia.pubKeyHex);
        assert(made.status === 200 && getMember(mia.pubKeyHex)?.status === 'suspended' && heldReason(mia.pubKeyHex) === 'rekey_pending',
            `A: the owner makes a code: Mia suspended, her key held (${made.status})`);
        assert(!(await acts(mia, 'held')), 'A: Mia can’t act while the code waits');

        const r = await cancel(ownerSession, mia.pubKeyHex);
        assert(r.status === 200 && r.json.cancelled === true && r.json.status === 'active', `A: the owner cancels it (${r.status} ${JSON.stringify(r.json)})`);
        assert(latestRequest(mia.pubKeyHex)?.status === 'cancelled', 'A: the code is cancelled');
        assert(heldReason(mia.pubKeyHex) === undefined, 'A: her key is no longer held');
        assert(getMember(mia.pubKeyHex)?.status === 'active', `A: Mia is active again (${getMember(mia.pubKeyHex)?.status})`);
        assert(await acts(mia, 'after'), 'A: Mia acts again with the same key');
        assert(cancelLogLines('MiaMember') === 1, 'A: one log line says the code was cancelled');
        const st = await as(ownerSession, 'GET', `/api/local/admin/members/${mia.pubKeyHex}/rekey/status`);
        assert(st.status === 200 && st.json.pendingRequest === null && st.json.isInvalidated === false, 'A: the status shows no code and a free key');
        const twice = await cancel(ownerSession, mia.pubKeyHex);
        assert(twice.status === 409 && /already cancelled/.test(twice.json.error), `A: a second cancel is refused (${twice.status} ${twice.json.error})`);
        assert(cancelLogLines('MiaMember') === 1, 'A: and writes no second log line');
    }

    // ── B. Who may cancel ───────────────────────────────────────────────────────────────────
    {
        const ada = makeKeypair(), bob = makeKeypair(), cal = makeKeypair(), mel = makeKeypair();
        join(ada, 'AdaAdmin');
        join(bob, 'BobAdmin');
        join(cal, 'CalMember');
        join(mel, 'MelMember');
        grantNodeRole(ada.pubKeyHex, 'admin', owner.pubKeyHex);
        grantNodeRole(bob.pubKeyHex, 'admin', owner.pubKeyHex);
        const bobSession = keySession(bob);
        assert(signsIn(ada), 'B: Ada (an admin) signs in before any code');

        const made = await issue(ownerSession, ada.pubKeyHex);
        assert(made.status === 200 && !signsIn(ada), `B: the owner makes a code for Ada; she can’t sign in while it waits (${made.status})`);

        const nobody = await cancel(null, ada.pubKeyHex);
        assert(nobody.status === 401, `B: no session: refused (${nobody.status})`);
        const member = await signed(cal, `/api/local/admin/members/${ada.pubKeyHex}/rekey/cancel`, {});
        assert(member.status === 401 || member.status === 403, `B: a member’s signature: refused (${member.status})`);
        const byAdmin = await cancel(bobSession, ada.pubKeyHex);
        assert(byAdmin.status === 403, `B: an admin can’t cancel an admin’s code (${byAdmin.status} ${byAdmin.json.error})`);
        assert(latestRequest(ada.pubKeyHex)?.status === 'pending' && heldReason(ada.pubKeyHex) === 'rekey_pending'
            && getMember(ada.pubKeyHex)?.status === 'suspended', 'B: the refusals changed nothing');

        const byOwner = await cancel(ownerSession, ada.pubKeyHex);
        assert(byOwner.status === 200 && getMember(ada.pubKeyHex)?.status === 'active', `B: the owner cancels it; Ada active (${byOwner.status})`);
        assert(signsIn(ada), 'B: Ada signs in again');

        const melCode = await issue(bobSession, mel.pubKeyHex);
        assert(melCode.status === 200, `B: an admin makes a code for a member (${melCode.status})`);
        const melCancel = await cancel(bobSession, mel.pubKeyHex);
        assert(melCancel.status === 200 && getMember(mel.pubKeyHex)?.status === 'active' && heldReason(mel.pubKeyHex) === undefined,
            `B: and cancels it (${melCancel.status})`);
    }

    // ── C. The live incident ────────────────────────────────────────────────────────────────
    {
        const nia = makeKeypair(), niaNew = makeKeypair();
        join(nia, 'NiaMoved');
        const made = await issue(ownerSession, nia.pubKeyHex);
        const done = await reEnroll(made.json.code, niaNew);
        assert(done.status === 200 && getMember(niaNew.pubKeyHex)?.status === 'active', `C: Nia’s re-key completes (${done.status})`);
        const usedCode = await cancel(ownerSession, nia.pubKeyHex);
        assert(usedCode.status === 409 && /already used/.test(usedCode.json.error), `C: the used code can’t be cancelled (${usedCode.status} ${usedCode.json.error})`);

        // Opening the wizard on Nia's member row (now the new key) reads the status: nothing is made.
        const opened = await as(ownerSession, 'GET', `/api/local/admin/members/${niaNew.pubKeyHex}/rekey/status`);
        assert(opened.status === 200 && opened.json.pendingRequest === null && opened.json.history?.[0]?.new_pubkey === niaNew.pubKeyHex,
            'C: opening the wizard on the new key reads the finished move');
        assert(requestCount(niaNew.pubKeyHex) === 0 && heldReason(niaNew.pubKeyHex) === undefined && getMember(niaNew.pubKeyHex)?.status === 'active',
            'C: opening made no code, held no key, suspended nobody');

        const mistake = await issue(ownerSession, niaNew.pubKeyHex);
        assert(mistake.status === 200 && getMember(niaNew.pubKeyHex)?.status === 'suspended' && heldReason(niaNew.pubKeyHex) === 'rekey_pending',
            `C: a code made against the new key holds it and suspends Nia (${mistake.status})`);
        const undo = await cancel(ownerSession, niaNew.pubKeyHex);
        assert(undo.status === 200, `C: the owner cancels it (${undo.status} ${JSON.stringify(undo.json)})`);
        assert(getMember(niaNew.pubKeyHex)?.status === 'active' && heldReason(niaNew.pubKeyHex) === undefined, 'C: Nia ends active, her new key free');
        assert(await acts(niaNew, 'back'), 'C: Nia acts with her new key');
        assert(heldReason(nia.pubKeyHex) === 'rekeyed', 'C: her old key stays replaced');
    }

    // ── D. Expired ──────────────────────────────────────────────────────────────────────────
    {
        const pia = makeKeypair();
        join(pia, 'PiaExpired');
        await issue(ownerSession, pia.pubKeyHex);
        db.prepare("UPDATE rekey_requests SET expires_at = ? WHERE old_pubkey = ?").run(new Date(Date.now() - 60_000).toISOString(), pia.pubKeyHex);
        const r = await cancel(ownerSession, pia.pubKeyHex);
        assert(r.status === 409 && /expired/.test(r.json.error), `D: an expired code can’t be cancelled (${r.status} ${r.json.error})`);
        assert(latestRequest(pia.pubKeyHex)?.status === 'expired' && heldReason(pia.pubKeyHex) === 'rekey_pending'
            && getMember(pia.pubKeyHex)?.status === 'suspended', 'D: the member is left as the code left them');
        // The way out the guide gives: a new code, then cancel it. It puts back the status before the first code.
        const again = await issue(ownerSession, pia.pubKeyHex);
        assert(again.status === 200 && latestRequest(pia.pubKeyHex)?.prior_status === 'active', `D: a new code keeps the status before the expired one (${again.status})`);
        const out = await cancel(ownerSession, pia.pubKeyHex);
        assert(out.status === 200 && getMember(pia.pubKeyHex)?.status === 'active' && heldReason(pia.pubKeyHex) === undefined,
            `D: cancelling it puts Pia back to active, her key free (${out.status} ${getMember(pia.pubKeyHex)?.status})`);
    }

    // ── E. A code made before the prior status was kept ─────────────────────────────────────
    {
        const lia = makeKeypair();
        join(lia, 'LiaLegacy');
        await issue(ownerSession, lia.pubKeyHex);
        // A node before this change has no prior_status column: its rows are the ones this case is about.
        try { db.prepare('UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ?').run(lia.pubKeyHex); } catch { /* no column */ }
        const r = await cancel(ownerSession, lia.pubKeyHex);
        assert(r.status === 200 && r.json.status === 'active' && /earlier status/.test(r.json.note ?? ''), `E: back to active, and the answer says why (${JSON.stringify(r.json)})`);
        assert(getMember(lia.pubKeyHex)?.status === 'active' && heldReason(lia.pubKeyHex) === undefined, 'E: Lia active, her key free');
    }

    // ── F. The status before the code ───────────────────────────────────────────────────────
    {
        const dee = makeKeypair(), rue = makeKeypair();
        join(dee, 'DeeDisabled');
        join(rue, 'RueTwice');
        db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(dee.pubKeyHex);
        await issue(ownerSession, dee.pubKeyHex);
        const r = await cancel(ownerSession, dee.pubKeyHex);
        assert(r.status === 200 && getMember(dee.pubKeyHex)?.status === 'disabled' && heldReason(dee.pubKeyHex) === undefined,
            `F: a member suspended by an admin stays suspended; the code’s hold is gone (${r.status} ${getMember(dee.pubKeyHex)?.status})`);

        await issue(ownerSession, rue.pubKeyHex);
        const second = await issue(ownerSession, rue.pubKeyHex);
        assert(second.status === 200 && latestRequest(rue.pubKeyHex)?.prior_status === 'active', 'F: a second code keeps the status before the first');
        const r2 = await cancel(ownerSession, rue.pubKeyHex);
        assert(r2.status === 200 && getMember(rue.pubKeyHex)?.status === 'active', `F: cancelling it puts Rue back to active (${getMember(rue.pubKeyHex)?.status})`);
    }

    // ── G. All or nothing ───────────────────────────────────────────────────────────────────
    {
        const zed = makeKeypair();
        join(zed, 'ZedRace');
        await issue(ownerSession, zed.pubKeyHex);
        db.prepare('DELETE FROM invalidated_keys WHERE public_key = ?').run(zed.pubKeyHex);
        const r = await cancel(ownerSession, zed.pubKeyHex);
        assert(r.status === 409 && /Nothing was changed/.test(r.json.error), `G: the cancel is refused (${r.status} ${r.json.error})`);
        assert(latestRequest(zed.pubKeyHex)?.status === 'pending' && getMember(zed.pubKeyHex)?.status === 'suspended' && cancelLogLines('ZedRace') === 0,
            'G: nothing changed: the code still waits, Zed still suspended, no log line');
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed}/${run} assertions passed`);
    console.log(`========================================`);
    process.exit(process.exitCode ?? 0);
}

runTests().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
