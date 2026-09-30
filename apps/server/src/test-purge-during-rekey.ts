/**
 * Test Suite: a removal or a deletion while a re-key is pending does not bring the member back (Fable review, 2026-09-24:
 * "a purge during a pending re-key resurrects a pruned member").
 *
 * A re-key is two steps (engine/member-wizards.ts): issueRekeyCode suspends the member and invalidates the old key, and
 * completeRekey moves every row the old key names to the new one. Completing used to set the row back to 'active' and
 * hand it to the new key, so an account removed or deleted between the two steps came back. completeRekey now refuses a
 * pruned account before any write (REKEY_ACCOUNT_GONE, #1177); this suite holds that, end to end.
 *
 * Every request goes over real HTTPS through the app's own middleware (startHttpsServer): the owner signs in with a key
 * session as the app does (challenge, signature, handshake, session), members sign each request with their key.
 *
 *  A. Pat (40 Beans) has a re-key pending; the owner removes Pat (POST /api/local/admin/users/:pubkey/prune). Pat's new
 *     phone then redeems the code (POST /api/member/re-enroll), and the owner tries to complete it by hand: both refused.
 *  B. Sam (25 Beans) has a re-key pending; the owner removes Sam, and Sam then tries to delete the account with the old
 *     key (refused: a replaced key has no exception, not even a closed account's Delete account). The re-key is refused.
 *  C. Tia (15 Beans) has a re-key pending and signs POST /api/member/purge with the old key: refused (the key is
 *     replaced from the moment the code is issued), the account untouched, and the re-key then hands it, Beans and all,
 *     to the new key; the old key can't act or delete the moved account.
 * For A and B, after the refused re-key: the old row is still pruned (no row revived), no row exists for the new key, no
 * Beans reappear on either key, a new code can't be issued, the ledger audit holds and the network's sum is unchanged,
 * and neither the old key nor the new key can send Beans or edit a profile.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) npx tsx src/test-purge-during-rekey.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, getBalance, getMember, payFromCommons } from './state-engine.js';
import { runLedgerAudit } from './engine/audit.js';
import { REKEY_ACCOUNT_GONE } from './engine/member-wizards.js';
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

const sumOfAccounts = () => (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as any).s as number;
const memberRows = (pk: string) => (db.prepare('SELECT COUNT(*) AS c FROM members WHERE public_key = ? COLLATE NOCASE').get(pk) as any).c as number;
const accountBalance = (pk: string) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ? COLLATE NOCASE').get(pk) as any)?.balance ?? 0;

async function runTests() {
    console.log('--- TEST: a removal or deletion during a pending re-key does not bring the member back ---');

    initStateEngine();
    const owner = makeKeypair();
    seedGenesisMember(owner.pubKeyHex, 'OwnerOlive');
    const rex = makeKeypair();
    const join = (kp: Keypair, name: string) => {
        const inv = generateInvite(owner.pubKeyHex)!;
        const r = redeemInvite(inv.code, kp.pubKeyHex, name);
        if (!r.success) throw new Error(`join ${name} failed`);
    };
    join(rex, 'RexReceiver');

    initTls();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const session = keySession(owner);

    async function admin(method: string, path: string, body?: unknown) {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-admin-session': session },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
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
    /** The new phone redeems the code: the request signed by the new key, with its proof of possession of the code. */
    async function reEnroll(code: string, kp: Keypair) {
        const signature = crypto.sign(null, Buffer.from(code, 'utf8'), kp.privateKey).toString('base64');
        return signed(kp, '/api/member/re-enroll', { code, newPublicKey: kp.pubKeyHex, signature });
    }

    async function issue(name: string, pk: string): Promise<string> {
        const r = await admin('POST', `/api/local/admin/members/${pk}/rekey/issue-code`);
        assert(r.status === 200 && typeof r.json.code === 'string', `${name}: the owner issues a re-enrolment code (${r.status})`);
        assert(getMember(pk)?.status === 'suspended', `${name}: suspended while the re-key is pending`);
        return r.json.code;
    }

    /** Neither key acts: no Beans sent, no profile edited. */
    async function neitherKeyActs(name: string, old: Keypair, fresh: Keypair) {
        for (const [which, kp] of [['old', old], ['new', fresh]] as const) {
            const send = await signed(kp, '/api/ledger/transfer', { to: rex.pubKeyHex, amount: 1, memo: 'after the re-key' });
            assert(send.status >= 400, `${name}: the ${which} key can't send Beans (${send.status})`);
            const edit = await signed(kp, '/api/profile/update', { bio: 'I am back' });
            assert(edit.status >= 400, `${name}: the ${which} key can't edit a profile (${edit.status})`);
        }
    }

    /** After a refused re-key of a pruned account: nothing came back. */
    async function nothingCameBack(name: string, old: Keypair, fresh: Keypair, sumBefore: number) {
        const row = getMember(old.pubKeyHex);
        assert(row?.status === 'pruned', `${name}: the old row is still pruned (${row?.status})`);
        assert(memberRows(fresh.pubKeyHex) === 0, `${name}: no member row for the new key`);
        assert(accountBalance(old.pubKeyHex) === 0 && getBalance(old.pubKeyHex).balance === 0, `${name}: no Beans on the old key`);
        assert(accountBalance(fresh.pubKeyHex) === 0, `${name}: no Beans on the new key`);
        const inv = db.prepare('SELECT reason, rekeyed_to FROM invalidated_keys WHERE public_key = ?').get(old.pubKeyHex) as any;
        assert(!inv?.rekeyed_to, `${name}: the old key was not re-keyed to anything`);
        const again = await admin('POST', `/api/local/admin/members/${old.pubKeyHex}/rekey/issue-code`);
        assert(again.status >= 400, `${name}: a new code can't be issued for the pruned account (${again.status})`);
        assert(runLedgerAudit().ok, `${name}: the ledger audit holds`);
        assert(sumOfAccounts() === sumBefore, `${name}: the network's sum is unchanged (${sumOfAccounts()} vs ${sumBefore})`);
        await neitherKeyActs(name, old, fresh);
    }

    // ── A. Removed by the owner while the re-key is pending ─────────────────────────────────
    {
        const pat = makeKeypair(), patNew = makeKeypair();
        join(pat, 'PatPruned');
        payFromCommons(pat.pubKeyHex, 40, 'Grant to Pat', { allowDeficit: true });
        const sumBefore = sumOfAccounts();
        const code = await issue('A', pat.pubKeyHex);

        const prune = await admin('POST', `/api/local/admin/users/${pat.pubKeyHex}/prune`);
        assert(prune.status === 200, `A: the owner removes Pat while the re-key is pending (${prune.status} ${prune.json.error ?? ''})`);
        assert(getMember(pat.pubKeyHex)?.status === 'pruned' && getBalance(pat.pubKeyHex).balance === 0, 'A: Pat is pruned, the 40 Beans gone to the Commons');

        const phone = await reEnroll(code, patNew);
        assert(phone.status === 400 && phone.json.error === REKEY_ACCOUNT_GONE, `A: the new phone's re-enrolment is refused (${phone.status} ${phone.json.error})`);
        const byHand = await admin('POST', `/api/local/admin/members/${pat.pubKeyHex}/rekey/complete`, { code, newPubkey: patNew.pubKeyHex });
        assert(byHand.status === 400 && byHand.json.error === REKEY_ACCOUNT_GONE, `A: the owner completing it by hand is refused (${byHand.status} ${byHand.json.error})`);
        await nothingCameBack('A', pat, patNew, sumBefore);
    }

    // ── B. Removed, then deleted by its owner with the old key, while the re-key is pending ─────
    {
        const sam = makeKeypair(), samNew = makeKeypair();
        join(sam, 'SamSelfPurge');
        payFromCommons(sam.pubKeyHex, 25, 'Grant to Sam', { allowDeficit: true });
        const sumBefore = sumOfAccounts();
        const code = await issue('B', sam.pubKeyHex);

        const prune = await admin('POST', `/api/local/admin/users/${sam.pubKeyHex}/prune`);
        assert(prune.status === 200, `B: the owner removes Sam (${prune.status})`);
        const purge = await signed(sam, '/api/member/purge', { action: 'purge_account' });
        console.log(`  (B: Sam's old key deleting the closed account answered ${purge.status} ${JSON.stringify(purge.json)})`);
        assert(getMember(sam.pubKeyHex)?.status === 'pruned', 'B: Sam stays pruned after the delete');

        const phone = await reEnroll(code, samNew);
        assert(phone.status === 400 && phone.json.error === REKEY_ACCOUNT_GONE, `B: the re-enrolment is refused (${phone.status} ${phone.json.error})`);
        await nothingCameBack('B', sam, samNew, sumBefore);
    }

    // ── C. The member deletes the account with the old key while the re-key is pending ─────
    {
        const tia = makeKeypair(), tiaNew = makeKeypair();
        join(tia, 'TiaPending');
        payFromCommons(tia.pubKeyHex, 15, 'Grant to Tia', { allowDeficit: true });
        const sumBefore = sumOfAccounts();
        const code = await issue('C', tia.pubKeyHex);

        // The old key is replaced from the moment the code is issued (https-server.ts REPLACED_KEY_REFUSAL): it can't delete
        // the account, so there is no deletion for the re-key to undo.
        const purge = await signed(tia, '/api/member/purge', { action: 'purge_account' });
        assert(purge.status === 403 && purge.json.code === 'key_invalidated', `C: the old key can't delete the account while the re-key is pending (${purge.status} ${purge.json.code})`);
        assert(getMember(tia.pubKeyHex)?.status === 'suspended' && getMember(tia.pubKeyHex)?.callsign === 'TiaPending', 'C: the account is untouched');

        const phone = await reEnroll(code, tiaNew);
        // The account was never deleted: the re-key is the member's own, and moves it whole.
        assert(phone.status === 200 && phone.json.success === true, `C: the re-key then completes (${phone.status})`);
        assert(getMember(tiaNew.pubKeyHex)?.status === 'active' && getMember(tiaNew.pubKeyHex)?.callsign === 'TiaPending', 'C: the account, name and all, is on the new key');
        assert(getBalance(tiaNew.pubKeyHex).balance === 15 && accountBalance(tia.pubKeyHex) === 0, 'C: the 15 Beans moved with it, none left on the old key');
        assert(memberRows(tia.pubKeyHex) === 0, 'C: no member row is left on the old key');
        assert(runLedgerAudit().ok && sumOfAccounts() === sumBefore, 'C: the ledger audit holds and the sum is unchanged');
        const send = await signed(tia, '/api/ledger/transfer', { to: rex.pubKeyHex, amount: 1, memo: 'old key' });
        assert(send.status >= 400, `C: the old key can't send Beans (${send.status})`);
        const again = await signed(tia, '/api/member/purge', { action: 'purge_account' });
        assert(again.status >= 400 && getMember(tiaNew.pubKeyHex)?.status === 'active', `C: the old key can't delete the moved account (${again.status})`);
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
