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
 *  H. A suspension something else made stays: a report's suspension while the code waits (and over an expired code),
 *     and an older server's code over a report's suspension (no prior status kept): the member stays suspended, and
 *     Lift suspension lifts it (not while a code holds the key). A report that suspended nobody changes nothing: the
 *     member ends active, under a code with a prior status (Sal) or an older one (Len).
 *  I. An admin's emergency suspension while the code alone holds the member is made, and outlasts the cancel; a
 *     report's suspension while the code waits is still refused as one.
 *  J. Completing the code keeps a report's suspension made while it waited on the new key (Lift suspension lifts it);
 *     the code's own 'suspended' ends as before.
 *
 * Run (from apps/server): mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-rekey-cancel" node ../../scripts/run-server-suites.mjs
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, getMember, submitReport } from './state-engine.js';
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
        // Both refusals name the way out that works (review 4176372949): a new code, then cancel it.
        assert(/make a new code/i.test(r.json.error ?? '') && /cancel it/.test(r.json.error ?? ''), `D: the cancel's refusal names the way out (${r.json.error})`);
        const liftUnder = await as(ownerSession, 'POST', `/api/local/admin/users/${pia.pubKeyHex}/status`, { status: 'active' });
        assert(liftUnder.status === 409 && /run out/.test(liftUnder.json.error ?? '') && /make a new code/i.test(liftUnder.json.error ?? '')
            && getMember(pia.pubKeyHex)?.status === 'suspended',
            `D: Lift suspension under the expired code's hold is refused and names the way out (${liftUnder.status} ${liftUnder.json.error})`);
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

    // ── H. A suspension something else made stays ───────────────────────────────────────────
    {
        const rep = makeKeypair();
        join(rep, 'RexReporter');
        const reportSuspends = async (pk: string) => {
            const report = submitReport(rep.pubKeyHex, pk, 'Repeated harassment in the market posts');
            if (!report) throw new Error('report refused');
            return as(ownerSession, 'POST', `/api/local/admin/reports/${report.id}/action`, { suspendUser: true });
        };

        // A report actioned with suspendUser while the code waits (review 4176252096).
        const pia = makeKeypair();
        join(pia, 'PiaReported');
        await issue(ownerSession, pia.pubKeyHex);
        const actioned = await reportSuspends(pia.pubKeyHex);
        assert(actioned.status === 200 && getMember(pia.pubKeyHex)?.status === 'suspended', `H: a report suspends Pia while the code waits (${actioned.status})`);
        const r = await cancel(ownerSession, pia.pubKeyHex);
        assert(r.status === 200 && r.json.status === 'suspended' && /report/.test(r.json.note ?? ''),
            `H: the cancel leaves Pia suspended and says why (${r.status} ${JSON.stringify(r.json)})`);
        assert(getMember(pia.pubKeyHex)?.status === 'suspended' && heldReason(pia.pubKeyHex) === undefined && latestRequest(pia.pubKeyHex)?.status === 'cancelled',
            `H: Pia stays suspended; the code is cancelled and its hold gone (${getMember(pia.pubKeyHex)?.status})`);
        // Where the report alone leaves a member: Pia, after the cancel, can do just what Kit can.
        const kit = makeKeypair();
        join(kit, 'KitReported');
        await reportSuspends(kit.pubKeyHex);
        const kitActs = await acts(kit, 'reported only'), piaActs = await acts(pia, 'after the cancel');
        assert(piaActs === kitActs && signsIn(pia) === signsIn(kit), `H: Pia is where the report alone leaves a member (acts ${piaActs}/${kitActs})`);

        // The same while an expired code holds her, and a new code is made over it: the report's suspension carries.
        const ivy = makeKeypair();
        join(ivy, 'IvyChain');
        await issue(ownerSession, ivy.pubKeyHex);
        await reportSuspends(ivy.pubKeyHex);
        db.prepare("UPDATE rekey_requests SET expires_at = ? WHERE old_pubkey = ?").run(new Date(Date.now() - 60_000).toISOString(), ivy.pubKeyHex);
        await cancel(ownerSession, ivy.pubKeyHex); // marks it expired, refused
        await issue(ownerSession, ivy.pubKeyHex);
        const ri = await cancel(ownerSession, ivy.pubKeyHex);
        assert(ri.status === 200 && getMember(ivy.pubKeyHex)?.status === 'suspended' && /report/.test(ri.json.note ?? ''),
            `H: a new code over the expired one, cancelled: Ivy stays suspended (${ri.status} ${JSON.stringify(ri.json)})`);

        // P2 (review 4176252098): an older server's code (no prior status) over a report's suspension.
        const quin = makeKeypair();
        join(quin, 'QuinLegacy');
        await reportSuspends(quin.pubKeyHex);
        await issue(ownerSession, quin.pubKeyHex);
        db.prepare('UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ?').run(quin.pubKeyHex);
        const rq = await cancel(ownerSession, quin.pubKeyHex);
        assert(rq.status === 200 && rq.json.status === 'suspended' && getMember(quin.pubKeyHex)?.status === 'suspended' && /report/.test(rq.json.note ?? ''),
            `H: P2: an older code over a report’s suspension: Quin stays suspended, and the answer says why (${JSON.stringify(rq.json)})`);

        // P3: the same, the older code expired with the key still held, and a new code made over it.
        const ren = makeKeypair();
        join(ren, 'RenLegacy');
        await reportSuspends(ren.pubKeyHex);
        await issue(ownerSession, ren.pubKeyHex);
        db.prepare("UPDATE rekey_requests SET prior_status = NULL, status = 'expired', expires_at = ? WHERE old_pubkey = ?")
            .run(new Date(Date.now() - 60_000).toISOString(), ren.pubKeyHex);
        const renew = await issue(ownerSession, ren.pubKeyHex);
        assert(renew.status === 200 && latestRequest(ren.pubKeyHex)?.prior_status !== 'active', `H: P3: a new code over the older expired hold doesn’t record active (${latestRequest(ren.pubKeyHex)?.prior_status})`);
        const rr = await cancel(ownerSession, ren.pubKeyHex);
        assert(rr.status === 200 && getMember(ren.pubKeyHex)?.status === 'suspended',
            `H: P3: cancelling it leaves Ren suspended (${rr.status} ${JSON.stringify(rr.json)})`);

        // A report's suspension the cancel kept, lifted from the member's page (review 4176287682): Lift suspension.
        const lift = (pk: string) => as(ownerSession, 'POST', `/api/local/admin/users/${pk}/status`, { status: 'active' });
        const lifted = await lift(pia.pubKeyHex);
        assert(lifted.status === 200 && getMember(pia.pubKeyHex)?.status === 'active' && await acts(pia, 'lifted'),
            `H: Lift suspension makes Pia active, and she acts (${lifted.status} ${JSON.stringify(lifted.json)})`);
        const reportActioned = async (pk: string) => {
            const report = submitReport(rep.pubKeyHex, pk, 'Spam links posted in the market listings');
            if (!report) throw new Error('report refused');
            return as(ownerSession, 'POST', `/api/local/admin/reports/${report.id}/action`, { suspendUser: false });
        };

        // FP: a report actioned without a suspension while the code waits: the code alone held Sal.
        const sal = makeKeypair();
        join(sal, 'SalNotSuspended');
        await issue(ownerSession, sal.pubKeyHex);
        const sa = await reportActioned(sal.pubKeyHex);
        const underCode = await lift(sal.pubKeyHex);
        assert(underCode.status === 409 && /re-key/.test(underCode.json.error ?? '') && getMember(sal.pubKeyHex)?.status === 'suspended',
            `H: while the code holds Sal's key, Lift suspension is refused and names the code (${underCode.status} ${underCode.json.error})`);
        const rs = await cancel(ownerSession, sal.pubKeyHex);
        assert(sa.status === 200 && rs.status === 200 && rs.json.status === 'active' && !rs.json.note && getMember(sal.pubKeyHex)?.status === 'active',
            `H: FP: a report that suspended nobody: the cancel makes Sal active (${sa.status} ${rs.status} ${JSON.stringify(rs.json)})`);
        assert(await acts(sal, 'free'), 'H: FP: Sal acts again with the same key');

        // LEG: an older code (no prior status) for a member with a past report that suspended nobody.
        const len = makeKeypair();
        join(len, 'LenLongStanding');
        await reportActioned(len.pubKeyHex);
        await issue(ownerSession, len.pubKeyHex);
        db.prepare('UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ?').run(len.pubKeyHex);
        const rl = await cancel(ownerSession, len.pubKeyHex);
        assert(rl.status === 200 && rl.json.status === 'active' && getMember(len.pubKeyHex)?.status === 'active',
            `H: LEG: an older code over a past report that suspended nobody: Len ends active (${rl.status} ${JSON.stringify(rl.json)})`);

        // Not known: a report actioned before the node kept whether it suspended, under an older code. Len's earlier
        // status can't be told, so he stays suspended, and Lift suspension lifts it as the answer says.
        const lou = makeKeypair();
        join(lou, 'LouUnknown');
        await reportActioned(lou.pubKeyHex);
        db.prepare('UPDATE abuse_reports SET suspended_member = NULL WHERE target_pubkey = ?').run(lou.pubKeyHex);
        await issue(ownerSession, lou.pubKeyHex);
        db.prepare('UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ?').run(lou.pubKeyHex);
        const ru = await cancel(ownerSession, lou.pubKeyHex);
        assert(ru.status === 200 && ru.json.status === 'suspended' && /Lift the suspension/.test(ru.json.note ?? ''),
            `H: not known: Lou stays suspended, and the answer says to lift it (${JSON.stringify(ru.json)})`);
        const lu = await lift(lou.pubKeyHex);
        assert(lu.status === 200 && getMember(lou.pubKeyHex)?.status === 'active' && await acts(lou, 'lifted'),
            `H: not known: Lift suspension makes Lou active, as the answer says (${lu.status} ${JSON.stringify(lu.json)})`);
        const liftLog = db.prepare("SELECT COUNT(*) AS c FROM system_logs WHERE message LIKE ?").get(`Lifted the suspension of ${lou.pubKeyHex.slice(0, 12)}%`) as any;
        assert(liftLog.c === 1, `H: the lift is logged (${liftLog.c})`);

        // A report's suspension under an expired code's hold (review 4176372949): the refusals name the way out, and it works.
        const max = makeKeypair();
        join(max, 'MaxExpiredHold');
        await reportSuspends(max.pubKeyHex);
        await issue(ownerSession, max.pubKeyHex);
        db.prepare("UPDATE rekey_requests SET expires_at = ? WHERE old_pubkey = ?").run(new Date(Date.now() - 60_000).toISOString(), max.pubKeyHex);
        const maxLift = await lift(max.pubKeyHex);
        assert(maxLift.status === 409 && /run out/.test(maxLift.json.error ?? '') && /make a new code/i.test(maxLift.json.error ?? ''),
            `H: Max: Lift suspension under the expired hold names the way out (${maxLift.status} ${maxLift.json.error})`);
        const maxCancel = await cancel(ownerSession, max.pubKeyHex);
        assert(maxCancel.status === 409 && /make a new code/i.test(maxCancel.json.error ?? ''), `H: Max: so does the cancel's (${maxCancel.json.error})`);
        await issue(ownerSession, max.pubKeyHex);
        const maxOut = await cancel(ownerSession, max.pubKeyHex);
        const maxLifted = await lift(max.pubKeyHex);
        assert(maxOut.status === 200 && maxOut.json.status === 'suspended' && maxLifted.status === 200 && getMember(max.pubKeyHex)?.status === 'active'
            && await acts(max, 'lifted'), `H: Max: a new code, cancelled, then Lift suspension: he is active and acts (${maxOut.status} ${maxLifted.status})`);

        // A later action on the same report never lowers what the first recorded (review 4176372892): a report suspends
        // Rae, and the same report is actioned again without suspendUser (a takedown after the fact sends none).
        const rae = makeKeypair(), raeNew = makeKeypair();
        join(rae, 'RaeActionedTwice');
        const raeReport = submitReport(rep.pubKeyHex, rae.pubKeyHex, 'Repeated harassment in the market posts')!;
        const suspendedMember = (id: string) => (db.prepare('SELECT suspended_member AS s FROM abuse_reports WHERE id = ?').get(id) as { s: number | null }).s;
        await as(ownerSession, 'POST', `/api/local/admin/reports/${raeReport.id}/action`, { suspendUser: true });
        const again = await as(ownerSession, 'POST', `/api/local/admin/reports/${raeReport.id}/action`, { suspendUser: false });
        assert(again.status === 200 && suspendedMember(raeReport.id) === 1,
            `H: Rae: actioning the report again without a suspension keeps its record that it suspended her (${again.status} ${suspendedMember(raeReport.id)})`);
        await issue(ownerSession, rae.pubKeyHex);
        db.prepare('UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ?').run(rae.pubKeyHex);
        const rc = await cancel(ownerSession, rae.pubKeyHex);
        assert(rc.status === 200 && rc.json.status === 'suspended' && getMember(rae.pubKeyHex)?.status === 'suspended' && /report/.test(rc.json.note ?? ''),
            `H: Rae: an older code over that report's suspension, cancelled: she stays suspended (${rc.status} ${JSON.stringify(rc.json)})`);
        const raeCode = await issue(ownerSession, rae.pubKeyHex);
        db.prepare("UPDATE rekey_requests SET prior_status = NULL WHERE old_pubkey = ? AND status = 'pending'").run(rae.pubKeyHex);
        const raeDone = await reEnroll(raeCode.json.code, raeNew);
        assert(raeDone.status === 200 && getMember(raeNew.pubKeyHex)?.status === 'suspended',
            `H: Rae: an older code over it, completed: her new key stays suspended (${raeDone.status} ${getMember(raeNew.pubKeyHex)?.status})`);
        // A report actioned before the node kept the record stays not known: a later action without a suspension
        // doesn't make it "suspended nobody".
        const roz = makeKeypair();
        join(roz, 'RozActionedTwice');
        const rozReport = submitReport(rep.pubKeyHex, roz.pubKeyHex, 'Repeated harassment in the market posts')!;
        await as(ownerSession, 'POST', `/api/local/admin/reports/${rozReport.id}/action`, { suspendUser: true });
        db.prepare('UPDATE abuse_reports SET suspended_member = NULL WHERE id = ?').run(rozReport.id);
        await as(ownerSession, 'POST', `/api/local/admin/reports/${rozReport.id}/action`, { suspendUser: false });
        assert(suspendedMember(rozReport.id) === null, `H: Roz: a later action leaves a not-known record not known (${suspendedMember(rozReport.id)})`);
        // And a later action that does suspend raises a record of none.
        const sid = makeKeypair();
        join(sid, 'SidActionedTwice');
        const sidReport = submitReport(rep.pubKeyHex, sid.pubKeyHex, 'Spam links posted in the market listings')!;
        await as(ownerSession, 'POST', `/api/local/admin/reports/${sidReport.id}/action`, { suspendUser: false });
        const sid0 = suspendedMember(sidReport.id);
        await as(ownerSession, 'POST', `/api/local/admin/reports/${sidReport.id}/action`, { suspendUser: true });
        assert(sid0 === 0 && suspendedMember(sidReport.id) === 1 && getMember(sid.pubKeyHex)?.status === 'suspended',
            `H: Sid: a first action records none, a later one that suspends records it (${sid0} → ${suspendedMember(sidReport.id)})`);
    }

    // ── I. An admin's emergency suspension while the code waits (review 4176287725) ────────────
    {
        const rep2 = makeKeypair();
        join(rep2, 'RayReporter');
        const suspend = (pk: string) => as(ownerSession, 'POST', `/api/local/admin/users/${pk}/suspend`, { reason: 'Threats made to another member at the market' });
        const tia = makeKeypair();
        join(tia, 'TiaHeld');
        await issue(ownerSession, tia.pubKeyHex);
        const s = await suspend(tia.pubKeyHex);
        assert(s.status === 200 && getMember(tia.pubKeyHex)?.status === 'disabled',
            `I: the code alone holds Tia: an admin's emergency suspension is made (${s.status} ${JSON.stringify(s.json.error ?? '')})`);
        const r = await cancel(ownerSession, tia.pubKeyHex);
        assert(r.status === 200 && r.json.status === 'disabled' && getMember(tia.pubKeyHex)?.status === 'disabled' && heldReason(tia.pubKeyHex) === undefined,
            `I: the cancel frees her key and leaves the admin's suspension (${r.status} ${JSON.stringify(r.json)})`);
        const lifted = await as(ownerSession, 'POST', `/api/local/admin/users/${tia.pubKeyHex}/status`, { status: 'active' });
        assert(lifted.status === 200 && getMember(tia.pubKeyHex)?.status === 'active' && await acts(tia, 'lifted'),
            `I: lifting it makes Tia active, and she acts (${lifted.status})`);

        // A report's suspension while the code waits is a suspension: still refused, as before.
        const uma = makeKeypair();
        join(uma, 'UmaReported');
        await issue(ownerSession, uma.pubKeyHex);
        const report = submitReport(rep2.pubKeyHex, uma.pubKeyHex, 'Repeated harassment in the market posts');
        await as(ownerSession, 'POST', `/api/local/admin/reports/${report!.id}/action`, { suspendUser: true });
        const su = await suspend(uma.pubKeyHex);
        assert(su.status === 409 && /already suspended/.test(su.json.error ?? '') && getMember(uma.pubKeyHex)?.status === 'suspended',
            `I: a report suspended Uma while the code waits: the emergency suspension is refused as already suspended (${su.status} ${su.json.error})`);
    }

    // ── J. Completing the code keeps a suspension it didn't make (review 4176287767) ────────────
    {
        const rep3 = makeKeypair();
        join(rep3, 'RoyReporter');
        const cora = makeKeypair(), coraNew = makeKeypair();
        join(cora, 'CoraReported');
        const made = await issue(ownerSession, cora.pubKeyHex);
        const report = submitReport(rep3.pubKeyHex, cora.pubKeyHex, 'Repeated harassment in the market posts');
        const actioned = await as(ownerSession, 'POST', `/api/local/admin/reports/${report!.id}/action`, { suspendUser: true });
        const done = await reEnroll(made.json.code, coraNew);
        assert(actioned.status === 200 && done.status === 200 && getMember(coraNew.pubKeyHex)?.status === 'suspended',
            `J: a report suspends Cora while the code waits; her re-key completes and the new key stays suspended (${done.status} ${getMember(coraNew.pubKeyHex)?.status})`);
        const lifted = await as(ownerSession, 'POST', `/api/local/admin/users/${coraNew.pubKeyHex}/status`, { status: 'active' });
        assert(lifted.status === 200 && getMember(coraNew.pubKeyHex)?.status === 'active' && await acts(coraNew, 'lifted'),
            `J: Lift suspension makes her new key active, and it acts (${lifted.status})`);

        // The code's own 'suspended' is undone, as before: the new key is active.
        const dot = makeKeypair(), dotNew = makeKeypair();
        join(dot, 'DotMoves');
        const dm = await issue(ownerSession, dot.pubKeyHex);
        const dd = await reEnroll(dm.json.code, dotNew);
        assert(dd.status === 200 && getMember(dotNew.pubKeyHex)?.status === 'active', `J: with nothing else, the new key is active (${getMember(dotNew.pubKeyHex)?.status})`);
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
