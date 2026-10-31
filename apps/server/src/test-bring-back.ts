/**
 * Test Suite: "Your community's admins can bring you back", community-held placement (vault rethink VR3;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3, Marty's picks of 27 Oct).
 *
 * The member's app seals their key and 12 words under a random key (@beanpool/core sealSeedToCopyKey) and turns the path on
 * at their community, which keeps the copy and its key under its recovery seal (engine/community-copy.ts). An admin's Bring
 * back makes a BB- code; the new phone proposes on it with a throwaway key and shows two digits; the admin types them; the
 * node binds nothing and answers that throwaway key's own poll with the copy and its key, sealed to it (engine/bring-back.ts).
 *
 * Every request goes over real HTTPS through the app's own middleware (startHttpsServer): phones sign format 2 for this
 * community's host, operators use a key session as the manager does. Nothing here contacts a host but this machine; pushes
 * are caught where they would leave for Expo. No key, seal or code is printed.
 *
 *  A. Turning it on: kept only under the recovery seal, never in the clear; refused with nothing stored when this server
 *     has no seal key; offered only where the community keeps copies itself (`vault` and `none` refuse); status and remove.
 *  B. Bring back by an admin, end to end: the code, the phone's digits, the number typed, the release sealed to the phone's
 *     throwaway key only; it opens to the SAME key and the words; the account is untouched (no suspension, no move).
 *  C. Owner-only for an owner (and, as for a re-key, for an admin); never the operator's own account; no copy, no code.
 *  D. The audit row and the log: who and when, never the code; the admin's status says "can be brought back".
 *  E. The push kinds: the member's phones are told at the code (account.bring-back-started, its fixed words) and at the
 *     release (account.restored); no code, key or copy in any payload or kept detail.
 *  F. Declined, expired, wrong-number and pasted-key cases; a removed member is refused; a standby writes none.
 *  G. A re-key and deleting the account remove the copy (with a tombstone).
 *  H. A carried seal key (a take-over): copies locked with the key it replaced are locked again with the live one.
 *  I. A copy this server can't open (its seal key gone or another): no code is made or spent, the admin is told to
 *     re-key, and the phone's poll and lost-answer ask both answer 503.
 *  L. The shared placement (vault rethink VR4): under "BeanPool's key vault" this server keeps only its half, and the
 *     bring-back answers with that half and the community's voucher, signed by the node key; the half alone opens nothing,
 *     and joined to the vault's it gives the SAME key and the words. It removes and re-locks as a copy does.
 *
 * Run (from apps/server): SERVER_SUITES_ONLY="test-bring-back" TEST_ALL_JOBS=2 node ../../scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.EXPO_ACCESS_TOKEN;
// This community's one name: a statement or request signed for any other host is another community's.
process.env.BEANPOOL_ADDRESSES = 'mullum.test';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { generateKeyPair } from '@libp2p/crypto/keys';
import {
    checkVaultVoucher, communityCopyFromRelease, communityHalfFromRelease, isKeySealedCopy, joinCopyKeyHalves, openReleaseOnDevice, openSeedWithCopyKey,
    sealSeedToCopyKey, splitCopyKey, vaultCopyDigest,
    PUSH_NOTICE_KINDS,
} from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, adminPruneUser, purgeMemberSelf, COMMUNITY_DECISION_ACTOR } from './state-engine.js';
import { grantNodeRole } from './engine/node-roles.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { cleanRekeyCode, resetRekeyWrongCodesForTests } from './engine/rekey-redeem.js';
import { setNodeRole } from './config/node-role.js';
import { setPrivateKeyForTests } from './p2p.js';
import { setRecoveryCopies, NO_COPIES_HERE } from './config/recovery-copies.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { ensureRecoverySealKey, installCarriedRecoverySealKey, recoverySealKeyPath, rewrapCommunityCopiesFromRetiredKeys } from './services/recovery-seal-key.js';
import { BRING_BACK_NO_COPY, BRING_BACK_OWN_KEY, BRING_BACK_GONE, BRING_BACK_NEEDS_NUMBER, BRING_BACK_CANT_OPEN } from './engine/bring-back.js';

const HOST = 'mullum.test';

// No host but this machine; pushes are caught where they would leave for Expo.
const pushed: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'exp.host' || url.hostname.endsWith('expo.dev')) {
        const batch = JSON.parse(String(init?.body ?? '[]'));
        pushed.push(...batch);
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
function section(name: string) { console.log(`\n${name}`); }

/** A key the suite can sign with, and (for a member) the seed and words its app would seal. */
interface Keypair { privateKey: crypto.KeyObject; pubKeyHex: string; seed: Uint8Array; pkcs8Hex: string; words?: string[] }
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function fromSeed(seed: Uint8Array, words?: string[]): Keypair {
    const der = Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]);
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return { privateKey, pubKeyHex: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), seed, pkcs8Hex: der.toString('hex'), words };
}
const makeKeypair = (): Keypair => fromSeed(new Uint8Array(crypto.randomBytes(32)));
// Test phrases only (a BIP-39 vector), never a real account's: the apps' derivation, seed = SHA256(SHA256(words)).
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const wordsAccount = (): Keypair => fromSeed(sha256(sha256(Buffer.from(WORDS.join(' '), 'utf8'))), WORDS);
const bound = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);

function keySession(kp: Keypair): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) throw new Error(`challenge refused: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!, Date.now(), {});
    if (!ex.ok) throw new Error(`handshake refused: ${ex.error}`);
    return ex.sessionId!;
}
const freshMinute = () => { pruneAuthAttempts(Date.now() + 61_000); resetGatewayRateLimit(); };

let BASE = '';
interface Answer { status: number; json: any }

/** A request signed by `kp` (format 2, for this community's host), as the apps send it; the query is not signed. */
async function signedReq(kp: Keypair, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Answer> {
    freshMinute();
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const text = `beanpool-request/2\n${HOST}\n${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyStr}`;
    headers['X-Public-Key'] = kp.pubKeyHex;
    headers['X-Signature'] = crypto.sign(null, bound(text), kp.privateKey).toString('base64');
    headers['X-Timestamp'] = ts;
    headers['X-Nonce'] = nonce;
    headers['X-Signed-For'] = HOST;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyStr });
    return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function as(session: string, method: string, path: string, body?: unknown): Promise<Answer> {
    freshMinute();
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-session': session }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
}

const turnOn = (kp: Keypair, made = sealSeedToCopyKey(kp.seed, { words: kp.words ?? null })) =>
    signedReq(kp, 'POST', '/api/recovery/community-copy', made);
const copyStatus = (kp: Keypair) => signedReq(kp, 'POST', '/api/recovery/community-copy/status', {});
const ask = (kp: Keypair, code: string) => signedReq(kp, 'POST', '/api/member/re-enroll', {
    code, newPublicKey: kp.pubKeyHex, signedFor: HOST,
    signature: crypto.sign(null, bound(`beanpool-re-enroll/2\n${HOST}\n${cleanRekeyCode(code)}`), kp.privateKey).toString('base64'),
});
const poll = (kp: Keypair, code: string) => signedReq(kp, 'GET', `/api/member/re-enroll/status?code=${encodeURIComponent(code)}`);
const issueBringBack = (session: string, pk: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/issue-code`, { kind: 'bring_back' });
const issueRekey = (session: string, pk: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/issue-code`, {});
const adminStatus = (session: string, pk: string) => as(session, 'GET', `/api/local/admin/members/${pk}/rekey/status`);
const bindByNumber = (session: string, pk: string, code: string, match: unknown) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/complete`, { code, match });
const copyRow = (pk: string) => db.prepare('SELECT * FROM community_copies WHERE owner_pubkey = ?').get(pk) as Record<string, string> | undefined;
const memberRow = (pk: string) => db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined;
const tombstoned = (pk: string) => !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'community_copies' AND row_key = ?").get(pk);

/** The admin brings `member` back to a new phone: code, ask, number. Returns the phone and the code. */
async function bringBack(session: string, member: Keypair): Promise<{ phone: Keypair; code: string; bind: Answer }> {
    const code = (await issueBringBack(session, member.pubKeyHex)).json.code as string;
    const phone = makeKeypair();
    const a = await ask(phone, code);
    const bind = await bindByNumber(session, member.pubKeyHex, code, a.json.match);
    return { phone, code, bind };
}

async function runTests() {
    console.log('--- TEST: your community\'s admins can bring you back (community-held placement) ---');
    initStateEngine();
    const owner = makeKeypair();
    seedGenesisMember(owner.pubKeyHex, 'OwnerOlive');
    const join = (name: string, kp: Keypair = makeKeypair()): Keypair => {
        const inv = generateInvite(owner.pubKeyHex)!;
        const r = redeemInvite(inv.code, kp.pubKeyHex, name);
        if (!r.success) throw new Error(`join ${name} failed: ${r.error}`);
        return kp;
    };
    const admin = join('AdminAda');
    grantNodeRole(admin.pubKeyHex, 'admin', owner.pubKeyHex);
    const coOwner = join('CoOwnerCal');
    grantNodeRole(coOwner.pubKeyHex, 'owner', owner.pubKeyHex);

    initTls();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const ownerSession = keySession(owner);
    const adminSession = keySession(admin);
    setRecoveryCopies('server');

    // ── A ──
    section('A. Turning it on: kept only under the recovery seal, only where the community keeps copies itself');
    const mia = join('MiaMember', wordsAccount());
    {
        // No seal key on this server: nothing is kept, and the answer says why.
        try { fs.unlinkSync(recoverySealKeyPath()); } catch { /* none yet */ }
        const noKey = await turnOn(mia);
        assert(noKey.status === 503 && !copyRow(mia.pubKeyHex), `a server with no recovery-seal key keeps nothing (got ${noKey.status}, row ${!!copyRow(mia.pubKeyHex)})`);
        ensureRecoverySealKey();

        setRecoveryCopies('vault');
        const atVault = await turnOn(mia);
        assert(atVault.status === 409 && atVault.json.code === 'not_offered' && !copyRow(mia.pubKeyHex),
            `under "BeanPool's key vault" the community-held copy isn't offered: the shared placement keeps a half, section L (got ${atVault.status} ${atVault.json.code})`);
        setRecoveryCopies('none');
        const atNone = await turnOn(mia);
        assert(atNone.status === 409 && atNone.json.code === NO_COPIES_HERE && !copyRow(mia.pubKeyHex), `under "Nowhere" nothing is kept (got ${atNone.status} ${atNone.json.code})`);
        setRecoveryCopies('server');
        const offStatus = await copyStatus(mia);
        assert(offStatus.status === 200 && offStatus.json.kept === false && offStatus.json.since === null && offStatus.json.offered === true,
            `before: not kept, and offered here (got ${JSON.stringify(offStatus.json)})`);

        const made = sealSeedToCopyKey(mia.seed, { words: WORDS });
        const on = await turnOn(mia, made);
        assert(on.status === 200 && on.json.kept === true && !!on.json.since, `under "This server" the copy is kept, with since when (got ${on.status})`);
        const row = copyRow(mia.pubKeyHex)!;
        const rowText = JSON.stringify(row);
        assert(!!row && JSON.parse(row.kdf_params).alg === 'node-wrap-xc20p-v1' && JSON.parse(row.kdf_params).inner === 'copykey-xc20p-v1',
            'the stored row is the recovery seal\'s wrap, naming the copy\'s scheme');
        assert(!rowText.includes(made.copyKey) && !rowText.includes(made.copy.encryptedShare) && !rowText.includes(Buffer.from(mia.seed).toString('hex')),
            'neither the copy\'s key, nor the copy, nor the seed is in the stored row in the clear');
        const bad = await signedReq(mia, 'POST', '/api/recovery/community-copy', { copy: { ...made.copy, kdfParams: '{"alg":"scrypt-xc20p-single-v1"}' }, copyKey: made.copyKey });
        assert(bad.status === 400 && bad.json.code === 'bad_copy', `a copy of another scheme is refused (got ${bad.status})`);
        const st = await copyStatus(mia);
        assert(st.json.kept === true && st.json.since === on.json.since, 'the status says kept, since the turn-on');
        // "Where your account can be brought back from" (VR1) reads every community's copies from one signed status.
        const shares = await signedReq(mia, 'POST', '/api/recovery/shares/status', {});
        assert(shares.status === 200 && shares.json.communityCopy?.since === on.json.since && Array.isArray(shares.json.enrolledSso),
            `the copies' status lists the community copy, since the turn-on (got ${JSON.stringify(shares.json.communityCopy)})`);

        const tom = join('TomMember');
        await turnOn(tom);
        const off = await signedReq(tom, 'DELETE', '/api/recovery/community-copy', {});
        assert(off.status === 200 && off.json.removed === 1 && !copyRow(tom.pubKeyHex) && tombstoned(tom.pubKeyHex),
            'turning it off deletes the copy here, with a tombstone so a standby drops it too');
        const sharesOff = await signedReq(tom, 'POST', '/api/recovery/shares/status', {});
        assert(sharesOff.status === 200 && sharesOff.json.communityCopy === null, `...and the copies' status lists none (got ${JSON.stringify(sharesOff.json.communityCopy)})`);
    }

    // ── B ──
    section('B. Bring back by an admin: the release goes only to the phone whose number was typed, and it is the same key');
    {
        pushed.length = 0;
        const code = (await issueBringBack(adminSession, mia.pubKeyHex)).json.code as string;
        assert(/^BB-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code), 'the admin makes a bring-back code, with its own prefix');
        assert(memberRow(mia.pubKeyHex)?.status === 'active' && !db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(mia.pubKeyHex),
            'making it suspends nobody and holds no key');
        const thief = makeKeypair();
        const phone = makeKeypair();
        const t = await ask(thief, code);
        const p = await ask(phone, code);
        assert(t.json.state === 'waiting' && p.json.state === 'waiting' && t.json.match !== p.json.match, 'two phones wait on it, with different digits');
        const early = await poll(phone, code);
        assert(early.json.state === 'waiting' && !('release' in early.json), 'before the number is typed, the phone is told only that it waits');

        const bind = await bindByNumber(adminSession, mia.pubKeyHex, code, p.json.match);
        assert(bind.status === 200 && bind.json.broughtBack === true && bind.json.callsign === 'MiaMember', `typing the phone's number confirms it (got ${bind.status} ${JSON.stringify(bind.json)})`);
        assert(memberRow(mia.pubKeyHex)?.status === 'active' && !memberRow(phone.pubKeyHex), 'nothing was bound: the account is on its own key, and the phone\'s throwaway key is no member');

        const thiefPoll = await poll(thief, code);
        assert(thiefPoll.json.state === 'gone' && !('release' in thiefPoll.json), 'the other phone gets nothing');
        const got = await poll(phone, code);
        assert(got.status === 200 && got.json.state === 'released' && got.json.memberKey === mia.pubKeyHex && got.json.callsign === 'MiaMember',
            `the phone's own poll gets the release (got ${got.status} ${got.json.state})`);
        let reopened: ReturnType<typeof openSeedWithCopyKey> | null = null;
        try {
            const released = openReleaseOnDevice(got.json.release, phone.pkcs8Hex, { collectionId: code, holderType: 'community' });
            const copy = communityCopyFromRelease(released);
            assert(isKeySealedCopy(copy.copy.kdfParams), 'the release holds the community copy');
            reopened = openSeedWithCopyKey(copy.copy, copy.copyKey, got.json.memberKey);
        } catch (e) { assert(false, `the release opens with the phone's throwaway key (${(e as Error).message})`); }
        assert(!!reopened && Buffer.from(reopened.seed).equals(Buffer.from(mia.seed)), 'it opens to the member\'s SAME key');
        assert(reopened?.wordsStatus === 'carried' && reopened.words?.join(' ') === WORDS.join(' '), 'and the 12 words come back with it');
        let otherKey = '';
        try { openReleaseOnDevice(got.json.release, thief.pkcs8Hex, { collectionId: code, holderType: 'community' }); otherKey = 'opened'; } catch { otherKey = 'refused'; }
        assert(otherKey === 'refused', 'another key cannot open the release');
        const again = await ask(phone, code);
        assert(again.json.state === 'released', 'a lost answer: the same phone asking again gets the release again');
        const me = await signedReq(mia, 'GET', '/api/community/me');
        assert(me.status === 200, `the member's own key still works everywhere it did (got ${me.status})`);
    }

    // ── C ──
    section('C. Who may: owner-only for an owner (and an admin, as for a re-key); never your own; no copy, no code');
    {
        const ownerCopy = await turnOn(coOwner);
        assert(ownerCopy.status === 200, 'an owner turns it on');
        const byAdmin = await issueBringBack(adminSession, coOwner.pubKeyHex);
        assert(byAdmin.status === 403 && !db.prepare("SELECT 1 FROM rekey_requests WHERE old_pubkey = ? AND kind = 'bring_back'").get(coOwner.pubKeyHex),
            `an admin cannot bring back an owner, and no code is made (got ${byAdmin.status})`);
        const admin2 = join('AdminAbe');
        grantNodeRole(admin2.pubKeyHex, 'admin', owner.pubKeyHex);
        await turnOn(admin2);
        const adminOnAdmin = await issueBringBack(adminSession, admin2.pubKeyHex);
        assert(adminOnAdmin.status === 403, `nor another admin, as a re-key asks (got ${adminOnAdmin.status})`);
        // The kind is read before the owner's fresh proof is asked, so a misspelt one never spends a code (#2018 NB2): an
        // owner's key session making an owner's code is asked the proof (from their phone), and a misspelt kind is not.
        const proofAsked = await issueBringBack(ownerSession, coOwner.pubKeyHex);
        const misspeltKind = await as(ownerSession, 'POST', `/api/local/admin/members/${coOwner.pubKeyHex}/rekey/issue-code`, { kind: 'bring-back' });
        assert(proofAsked.status === 403 && proofAsked.json.phoneRequired === true && misspeltKind.status === 400 && /^kind must be/.test(misspeltKind.json.error ?? ''),
            `a misspelt kind is refused before the owner's fresh proof is asked (got ${misspeltKind.status} ${misspeltKind.json.error}; a right one is asked the proof: ${proofAsked.status})`);
        // An owner's key session asks for the fresh proof each time for an owner's or admin's (rekeyProof); the engine's
        // own rule is what this pins, so the owner's call is made as the engine sees it.
        const { issueBringBackCode } = await import('./engine/bring-back.js');
        const byOwner = issueBringBackCode(coOwner.pubKeyHex, owner.pubKeyHex);
        assert(/^BB-/.test(byOwner.code), 'an owner can');
        let own: any = null;
        try { issueBringBackCode(owner.pubKeyHex, owner.pubKeyHex); } catch (e) { own = e; }
        assert(own?.message === BRING_BACK_OWN_KEY || own?.status === 409 || own?.status === 403, `never on the operator's own account (got ${own?.status} ${own?.code})`);
        const noCopy = join('NoCopyNed');
        const none = await issueBringBack(adminSession, noCopy.pubKeyHex);
        assert(none.status === 409 && none.json.code === 'no_copy' && none.json.error === BRING_BACK_NO_COPY, `a member with no copy here gets no code (got ${none.status} ${none.json.code})`);
        // A row a door stored under another spelling (the key in capitals) before the one-spelling rule is not the member
        // whose key it is: Bring back pressed on it is refused, as Re-key is, and brings that member back on no code.
        const sam = join('SamMember');
        await turnOn(sam);
        const SAM = sam.pubKeyHex.toUpperCase();
        db.prepare("INSERT INTO members (public_key, callsign, status) VALUES (?, 'Stray Sam', 'active')").run(SAM);
        const stray = await issueBringBack(adminSession, SAM);
        assert(stray.status === 400 && /isn’t written the way this community keeps keys/.test(stray.json.error ?? '')
            && !db.prepare("SELECT 1 FROM rekey_requests WHERE old_pubkey IN (?, ?) AND kind = 'bring_back'").get(sam.pubKeyHex, SAM),
            `Bring back on a row stored under another spelling is refused, and no code is made for the member (got ${stray.status} ${stray.json.error})`);
        db.prepare('DELETE FROM members WHERE public_key = ?').run(SAM);
    }

    // ── D ──
    section('D. The audit row: who and when, never the code; the admin sees "can be brought back"');
    {
        const log = db.prepare('SELECT * FROM bring_back_log WHERE member_pubkey = ?').all(mia.pubKeyHex) as any[];
        assert(log.length === 1 && log[0].operator_pubkey === admin.pubKeyHex && !!log[0].released_at && log[0].released_to.length < 20,
            'one row for the bring-back: the admin, the time, and a prefix of the phone\'s throwaway key');
        const lines = db.prepare("SELECT message, metadata FROM system_logs WHERE message LIKE '%ring-back%' OR message LIKE '%brought back%'").all() as any[];
        const codes = db.prepare("SELECT code FROM rekey_requests WHERE kind = 'bring_back'").all() as { code: string }[];
        assert(lines.length >= 2 && codes.every(c => !JSON.stringify(lines).includes(c.code)), `the log says it was made and done, and never names a code (${lines.length} lines)`);
        const st = await adminStatus(adminSession, mia.pubKeyHex);
        assert(st.status === 200 && st.json.communityCopy?.kept === true && st.json.bringBacks?.length === 1 && st.json.bringBacks[0].operatorPubkey === admin.pubKeyHex,
            'the admin\'s status says the member can be brought back here, and lists the bring-back');
        const stNone = await adminStatus(adminSession, (db.prepare("SELECT public_key FROM members WHERE callsign = 'NoCopyNed'").get() as any).public_key);
        assert(stNone.json.communityCopy?.kept === false, '...and "no" for a member without a copy');
    }

    // ── E ──
    section('E. The pushes: fixed words, nothing secret');
    {
        const pia = join('PiaMember', makeKeypair());
        putPushTokenRow(pia.pubKeyHex, 'ExponentPushToken[pia-old-phone]', 'android');
        const made = sealSeedToCopyKey(pia.seed);
        await turnOn(pia, made);
        pushed.length = 0;
        const code = (await issueBringBack(adminSession, pia.pubKeyHex)).json.code as string;
        await flush();
        assert(pushed.length === 1 && pushed[0].to === 'ExponentPushToken[pia-old-phone]' && pushed[0].body === PUSH_NOTICE_KINDS['account.bring-back-started'].body,
            `making the code pushes the member's phone with the bring-back kind's fixed words (got ${pushed.length}: "${pushed[0]?.body}")`);
        const phone = makeKeypair();
        const a = await ask(phone, code);
        await bindByNumber(adminSession, pia.pubKeyHex, code, a.json.match);
        await flush();
        assert(pushed.length === 2 && pushed[1].body === PUSH_NOTICE_KINDS['account.restored'].body, 'the release pushes it again, as "restored"');
        const kept = JSON.stringify(db.prepare('SELECT title, body, data FROM push_notices WHERE recipient = ?').all(pia.pubKeyHex));
        const sent = JSON.stringify(pushed);
        for (const [what, secret] of [['code', code], ['copy key', made.copyKey], ['copy', made.copy.encryptedShare], ['phone key', phone.pubKeyHex]] as const) {
            assert(!sent.includes(secret) && !kept.includes(secret), `no ${what} in a push or its kept details`);
        }
    }

    // ── F ──
    section('F. Declined, expired, wrong numbers, a pasted key, a removed member, a standby');
    {
        resetRekeyWrongCodesForTests();
        const kim = join('KimMember');
        await turnOn(kim);
        const code = (await issueBringBack(adminSession, kim.pubKeyHex)).json.code as string;
        const thief = makeKeypair();
        const t = await ask(thief, code);
        const declined = await as(adminSession, 'POST', `/api/local/admin/members/${kim.pubKeyHex}/rekey/proposals/${thief.pubKeyHex}/decline`, {});
        assert(declined.status === 200, `the admin declines a phone that isn't theirs (got ${declined.status})`);
        const viaDeclined = await bindByNumber(adminSession, kim.pubKeyHex, code, t.json.match);
        assert(viaDeclined.status === 409 && (await poll(thief, code)).json.state === 'declined', 'a declined phone\'s number releases nothing');
        // A fresh key, never declined, so nothing but the bring-back rule stands between it and the account.
        const pastedKey = makeKeypair();
        const pasted = await as(adminSession, 'POST', `/api/local/admin/members/${kim.pubKeyHex}/rekey/complete`, { code, newPubkey: pastedKey.pubKeyHex });
        assert(pasted.status === 409 && pasted.json.error === BRING_BACK_NEEDS_NUMBER && memberRow(kim.pubKeyHex)?.status === 'active' && !memberRow(pastedKey.pubKeyHex),
            `a pasted key never completes a bring-back, and moves nothing (got ${pasted.status}, member ${memberRow(kim.pubKeyHex)?.status ?? 'moved'})`);
        const unused = [...Array(100).keys()].map(n => String(n).padStart(2, '0')).filter(n => n !== t.json.match);
        for (let i = 0; i < 3; i++) await bindByNumber(adminSession, kim.pubKeyHex, code, unused[i]);
        assert((db.prepare('SELECT status FROM rekey_requests WHERE code = ?').get(code) as any).status === 'expired', 'three wrong numbers stop the code');

        const code2 = (await issueBringBack(adminSession, kim.pubKeyHex)).json.code as string;
        const late = makeKeypair();
        const l = await ask(late, code2);
        db.prepare('UPDATE rekey_requests SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), code2);
        const lateBind = await bindByNumber(adminSession, kim.pubKeyHex, code2, l.json.match);
        assert(lateBind.status === 404 && (await poll(late, code2)).json.state === 'gone', 'an expired code releases nothing');

        const code3 = (await issueBringBack(adminSession, kim.pubKeyHex)).json.code as string;
        const p3 = makeKeypair();
        const a3 = await ask(p3, code3);
        adminPruneUser(kim.pubKeyHex, COMMUNITY_DECISION_ACTOR);
        const afterPrune = await bindByNumber(adminSession, kim.pubKeyHex, code3, a3.json.match);
        assert(afterPrune.status >= 400 && (await poll(p3, code3)).json.state !== 'released', `a member removed since the code is not brought back (got ${afterPrune.status})`);
        const prunedIssue = await issueBringBack(adminSession, kim.pubKeyHex);
        assert(prunedIssue.status >= 400 && prunedIssue.json.error !== undefined, 'and no new code is made for them');
        void BRING_BACK_GONE;

        const hal = join('HalMember');
        await turnOn(hal);
        setNodeRole('backup');
        try {
            const before = copyRow(hal.pubKeyHex)?.created_at;
            const sOn = await turnOn(hal);
            const sIssue = await issueBringBack(adminSession, hal.pubKeyHex);
            assert(sOn.status >= 400 && sIssue.status >= 400, `a standby refuses a turn-on and a code (got ${sOn.status}, ${sIssue.status})`);
            assert(copyRow(hal.pubKeyHex)?.created_at === before, '...keeps the copy it holds as it was');
            assert(!db.prepare("SELECT 1 FROM rekey_requests WHERE old_pubkey = ? AND kind = 'bring_back'").get(hal.pubKeyHex), '...and writes none');
        } finally {
            setNodeRole('primary');
        }
    }

    // ── G ──
    section('G. A re-key and deleting the account remove the copy');
    {
        const rex = join('RexMember');
        await turnOn(rex);
        const code = (await issueRekey(adminSession, rex.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        const a = await ask(phone, code);
        const done = await bindByNumber(adminSession, rex.pubKeyHex, code, a.json.match);
        assert(done.status === 200 && !copyRow(rex.pubKeyHex) && !copyRow(phone.pubKeyHex) && tombstoned(rex.pubKeyHex),
            'a re-key to a new key removes the copy of the old one (it holds the replaced seed), with a tombstone');
        const bound2 = await poll(phone, code);
        assert(bound2.json.state === 'bound' && bound2.json.linkSignInAgain === false,
            'the new phone is not told a sign-in was removed: the community copy is no sign-in (Account Protection shows it off)');

        const del = join('DelMember');
        await turnOn(del);
        purgeMemberSelf(del.pubKeyHex);
        assert(!copyRow(del.pubKeyHex) && tombstoned(del.pubKeyHex), 'deleting the account removes the copy, with a tombstone');
        void ownerSession;
    }

    // ── H ──
    section('H. A take-over brings the community\'s seal key: copies locked with the key it replaced are locked again with it');
    {
        const ivy = join('IvyMember');
        await turnOn(ivy);
        const before = copyRow(ivy.pubKeyHex)!.copy_ct;
        // As a take-over or a sealed-backup restore installs the key it carries: the one here is kept as a retired key.
        installCarriedRecoverySealKey(crypto.randomBytes(32).toString('base64'));
        const relocked = rewrapCommunityCopiesFromRetiredKeys();
        assert(relocked >= 1 && copyRow(ivy.pubKeyHex)!.copy_ct !== before, `the copy is locked again with the live key (${relocked} relocked)`);
        assert(rewrapCommunityCopiesFromRetiredKeys() === 0, 'a second run locks nothing');
        const { phone, code, bind } = await bringBack(adminSession, ivy);
        const got = await poll(phone, code);
        assert(bind.status === 200 && got.json.state === 'released', `and it is still brought back (got ${bind.status}, ${got.json.state})`);
    }

    // ── I ──
    section('I. A copy this server can\'t open: no code made, none spent, and the admin is told to re-key');
    {
        const una = join('UnaMember');
        await turnOn(una);
        const keyFile = recoverySealKeyPath();
        const liveKey = fs.readFileSync(keyFile);
        const putKeyBack = () => fs.writeFileSync(keyFile, liveKey, { mode: 0o600 });
        const bringBackCodes = () => db.prepare("SELECT COUNT(*) AS n FROM rekey_requests WHERE old_pubkey = ? AND kind = 'bring_back'").get(una.pubKeyHex) as { n: number };
        try {
            // The seal key gone since the turn-on (a restore that didn't carry data/recovery-seal.key): the row is still here.
            fs.unlinkSync(keyFile);
            const noKey = await issueBringBack(adminSession, una.pubKeyHex);
            assert(noKey.status === 409 && noKey.json.code === 'copy_unopenable' && noKey.json.error === BRING_BACK_CANT_OPEN && bringBackCodes().n === 0,
                `no code is made for a copy this server can't open, and the admin is told to re-key (got ${noKey.status} ${noKey.json.code})`);
            // Another key in its place (a standby promoted without it): the same.
            fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
            const otherKey = await issueBringBack(adminSession, una.pubKeyHex);
            assert(otherKey.status === 409 && otherKey.json.code === 'copy_unopenable' && bringBackCodes().n === 0,
                `...nor under a seal key that didn't lock it (got ${otherKey.status} ${otherKey.json.code})`);

            // The key goes between the code and the number: the code isn't spent, and the admin is told, not "they're back".
            putKeyBack();
            const code = (await issueBringBack(adminSession, una.pubKeyHex)).json.code as string;
            const phone = makeKeypair();
            const a = await ask(phone, code);
            fs.unlinkSync(keyFile);
            const bind = await bindByNumber(adminSession, una.pubKeyHex, code, a.json.match);
            const req = db.prepare('SELECT status, wrong_matches FROM rekey_requests WHERE code = ?').get(code) as { status: string; wrong_matches: number | null };
            assert(bind.status === 409 && bind.json.error === BRING_BACK_CANT_OPEN && bind.json.broughtBack !== true && req.status === 'pending' && !req.wrong_matches,
                `the number typed is refused with the reason, the code still waits and no wrong number is counted (got ${bind.status}, code ${req.status})`);
            assert(!db.prepare('SELECT 1 FROM bring_back_log WHERE member_pubkey = ?').get(una.pubKeyHex) && (await poll(phone, code)).json.state === 'waiting',
                '...nothing is logged as brought back, and the phone still waits');
            putKeyBack();
            const again = await bindByNumber(adminSession, una.pubKeyHex, code, a.json.match);
            assert(again.status === 200 && again.json.broughtBack === true, `with its key back, the same number brings them back (got ${again.status})`);

            // The key goes after the number: the phone's poll and its lost-answer ask both say "not now", never a refusal.
            fs.unlinkSync(keyFile);
            const pollNoKey = await poll(phone, code);
            const askNoKey = await ask(phone, code);
            assert(pollNoKey.status === 503 && askNoKey.status === 503 && askNoKey.json.code === 'recovery_seal_key_missing',
                `the poll and the ask again both answer 503, so the phone asks again (got ${pollNoKey.status}, ${askNoKey.status})`);
            putKeyBack();
            const got = await poll(phone, code);
            assert(got.json.state === 'released', `...and collects the release once the key is back (got ${got.json.state})`);
        } finally {
            putKeyBack();
        }
    }

    // ── J ──
    section('J. The member is told a copy is kept only when this server can open it, and why when it can\'t (both answers, and the admin\'s)');
    {
        const vic = join('VicMember', wordsAccount());
        const on = await turnOn(vic);
        const keyFile = recoverySealKeyPath();
        const liveKey = fs.readFileSync(keyFile);
        const putKeyBack = () => fs.writeFileSync(keyFile, liveKey, { mode: 0o600 });
        const answers = async () => {
            const st = await copyStatus(vic);
            const shares = await signedReq(vic, 'POST', '/api/recovery/shares/status', {});
            const adm = await adminStatus(adminSession, vic.pubKeyHex);
            return { st: st.json, shares: shares.json, sharesStatus: shares.status, admin: adm.json.communityCopy };
        };
        try {
            // It opens here: kept, since the turn-on, on every answer.
            const opens = await answers();
            assert(on.status === 200 && opens.st.kept === true && opens.st.since === on.json.since && opens.st.unopenable === null,
                `a copy this server opens is kept, since the turn-on (got ${JSON.stringify(opens.st)})`);
            assert(opens.shares.communityCopy?.since === on.json.since && opens.shares.communityCopyUnopenable === null,
                `...the copies' status lists it as a way back (got ${JSON.stringify([opens.shares.communityCopy, opens.shares.communityCopyUnopenable])})`);
            assert(opens.admin?.kept === true && opens.admin?.unopenable === null, '...and the admin is told they can be brought back');

            // The seal key gone since the turn-on (a restore that didn't carry data/recovery-seal.key): the row is still here.
            fs.unlinkSync(keyFile);
            const gone = await answers();
            assert(gone.st.kept === false && gone.st.since === null && gone.st.unopenable?.reason === 'recovery_seal_key_missing'
                && gone.st.unopenable?.since === on.json.since && !!copyRow(vic.pubKeyHex),
            `with the seal key gone the copy is never "kept": it is kept but can't be opened, since when and why (got ${JSON.stringify(gone.st)})`);
            assert(gone.sharesStatus === 200 && gone.shares.communityCopy === null && gone.shares.communityCopyUnopenable?.reason === 'recovery_seal_key_missing',
                `...the copies' status lists no way back there, and says what is kept (got ${gone.sharesStatus} ${JSON.stringify([gone.shares.communityCopy, gone.shares.communityCopyUnopenable])})`);
            assert(gone.admin?.kept === false && gone.admin?.unopenable?.reason === 'recovery_seal_key_missing',
                `...and the admin is not told they can be brought back (got ${JSON.stringify(gone.admin)})`);
            const noKeyAgain = await turnOn(vic);
            assert(noKeyAgain.status === 503 && noKeyAgain.json.code === 'recovery_seal_key_missing' && (await copyStatus(vic)).json.unopenable?.reason === 'recovery_seal_key_missing',
                `...turning it on again can't fix that here: refused, nothing changed (got ${noKeyAgain.status} ${noKeyAgain.json.code})`);

            // Another key in its place (a standby promoted without it): the same, with its own why.
            fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
            const other = await answers();
            assert(other.st.kept === false && other.st.since === null && other.st.unopenable?.reason === 'recovery_seal_unopenable' && other.st.offered === true,
                `under a seal key that didn't lock it, the copy is not "kept" either, with its own why (got ${JSON.stringify(other.st)})`);
            assert(other.sharesStatus === 200 && other.shares.communityCopy === null && other.shares.communityCopyUnopenable?.reason === 'recovery_seal_unopenable',
                `...the copies' status lists no way back there (got ${other.sharesStatus} ${JSON.stringify([other.shares.communityCopy, other.shares.communityCopyUnopenable])})`);
            assert(other.admin?.kept === false && other.admin?.unopenable?.reason === 'recovery_seal_unopenable',
                `...nor does the admin's (got ${JSON.stringify(other.admin)})`);
            // The member's repair: turning it on again locks a new copy with the key this server has.
            const again = await turnOn(vic);
            const fixed = await answers();
            assert(again.status === 200 && fixed.st.kept === true && fixed.st.unopenable === null && fixed.st.since === again.json.since
                && fixed.shares.communityCopy?.since === again.json.since && fixed.admin?.kept === true,
            `turning it on again makes a copy this server opens: kept again, on every answer (got ${again.status} ${JSON.stringify(fixed.st)})`);
        } finally {
            putKeyBack();
        }
    }

    // ── K ──
    section('K. A refusal in the bring-back flow is said as a bring-back, never as a re-key; a re-key\'s stay its own');
    {
        const { issueBringBackCode } = await import('./engine/bring-back.js');
        const { bindRekeyByMatch, declineRekeyProposal, REKEY_KEY_HAS_ACCOUNT, BRING_BACK_KEY_HAS_ACCOUNT, REKEY_NO_LIVE_CODE, BRING_BACK_NO_LIVE_CODE } = await import('./engine/rekey-redeem.js');
        const { cancelRekeyCode } = await import('./engine/member-wizards.js');
        const thrown = (f: () => unknown): any => { try { f(); return null; } catch (e) { return e; } };
        const OWNER_ONLY = 'Only an owner can bring back an owner or admin';

        // An admin, for an owner's account: the window is Bring back, and so is the sentence, at each of its steps. (The
        // number, Not theirs and Cancel are asked of the engine: the routes ask an owner's fresh proof before them.)
        const byAdmin = await issueBringBack(adminSession, coOwner.pubKeyHex);
        assert(byAdmin.status === 403 && byAdmin.json.error === OWNER_ONLY, `an admin's Bring back for an owner is refused in bring-back's words (got ${byAdmin.status} ${byAdmin.json.error})`);
        const pending = db.prepare("SELECT code FROM rekey_requests WHERE old_pubkey = ? AND kind = 'bring_back' AND status = 'pending'").get(coOwner.pubKeyHex) as { code: string } | undefined;
        const ownersCode = pending?.code ?? issueBringBackCode(coOwner.pubKeyHex, owner.pubKeyHex).code;
        const steps = [
            thrown(() => bindRekeyByMatch(coOwner.pubKeyHex, ownersCode, '00', admin.pubKeyHex)),
            thrown(() => declineRekeyProposal(coOwner.pubKeyHex, makeKeypair().pubKeyHex, admin.pubKeyHex)),
            thrown(() => cancelRekeyCode(coOwner.pubKeyHex, admin.pubKeyHex)),
        ];
        assert(steps.every(e => e?.status === 403 && e?.message === OWNER_ONLY), `...and so are its number, Not theirs and Cancel (got ${steps.map(e => e?.message).join(' | ')})`);

        // A phone that already has an account here, typing a bring-back's code: never sent to ask for a pasted key, which a
        // bring-back never takes. A re-key's code keeps its own sentence.
        const bbHasAccount = await ask(mia, 'BB-0000-0000');
        const rkHasAccount = await ask(mia, 'RK-0000-0000');
        assert(bbHasAccount.status === 409 && bbHasAccount.json.error === BRING_BACK_KEY_HAS_ACCOUNT && !/paste/.test(bbHasAccount.json.error ?? ''),
            `a phone with an account here typing BB- is told to use a phone with no account, never to have its key pasted (got ${bbHasAccount.status} ${bbHasAccount.json.error})`);
        assert(rkHasAccount.status === 409 && rkHasAccount.json.error === REKEY_KEY_HAS_ACCOUNT, `...and RK- still gets the re-key sentence (got ${rkHasAccount.json.error})`);

        // The number typed on a code that isn't waiting any more: a bring-back's is said as one, a re-key's as before.
        const bbGone = await bindByNumber(adminSession, mia.pubKeyHex, 'BB-0000-0000', '12');
        const rkGone = await bindByNumber(adminSession, mia.pubKeyHex, 'RK-0000-0000', '12');
        assert(bbGone.status === 404 && bbGone.json.error === BRING_BACK_NO_LIVE_CODE && rkGone.status === 404 && rkGone.json.error === REKEY_NO_LIVE_CODE,
            `no code waiting: "bring-back code" for BB-, "re-key code" for RK- (got ${bbGone.json.error} | ${rkGone.json.error})`);

        // Not theirs, after the member's bring-back code was cancelled: said as a bring-back's too.
        const wes = join('WesMember');
        await turnOn(wes);
        const wesCode = (await issueBringBack(adminSession, wes.pubKeyHex)).json.code as string;
        const cancelled = await as(adminSession, 'POST', `/api/local/admin/members/${wes.pubKeyHex}/rekey/cancel`, {});
        const lateDecline = await as(adminSession, 'POST', `/api/local/admin/members/${wes.pubKeyHex}/rekey/proposals/${makeKeypair().pubKeyHex}/decline`, {});
        assert(/^BB-/.test(wesCode ?? '') && cancelled.status === 200 && lateDecline.status === 404 && lateDecline.json.error === BRING_BACK_NO_LIVE_CODE,
            `Not theirs on a cancelled bring-back code says no bring-back code is waiting (got ${cancelled.status}, ${lateDecline.status} ${lateDecline.json.error})`);
    }

    // ── L ──
    section('L. The shared placement: this server keeps only its half; a bring-back answers with it and the community\'s voucher');
    {
        const nodeIdentity = await generateKeyPair('Ed25519');
        setPrivateKeyForTests(nodeIdentity);
        const nodeKey = Buffer.from(nodeIdentity.publicKey.raw).toString('hex');
        const halfOf = (kp: Keypair) => {
            const made = sealSeedToCopyKey(kp.seed, { words: kp.words ?? null });
            return { made, ...splitCopyKey(made.copyKey), digest: vaultCopyDigest(made.copy) };
        };
        const putHalf = (kp: Keypair, half: unknown, copy: unknown) => signedReq(kp, 'POST', '/api/recovery/community-copy/half', { half, copy });

        const lea = join('LeaMember', fromSeed(sha256(Buffer.from('lea')), undefined));
        const m = halfOf(lea);
        setRecoveryCopies('server');
        const atServer = await copyStatus(lea);
        assert(atServer.json.offered === true && atServer.json.sharedOffered === false && atServer.json.nodeKey === nodeKey,
            'under "This server" the whole copy is offered, not the half, and the status says the node key');
        const refusedAtServer = await putHalf(lea, m.nodeHalf, m.digest);
        assert(refusedAtServer.status === 409 && refusedAtServer.json.code === 'not_offered' && !copyRow(lea.pubKeyHex), 'under "This server" a half is refused, and nothing kept');
        setRecoveryCopies('none');
        const refusedAtNone = await putHalf(lea, m.nodeHalf, m.digest);
        assert(refusedAtNone.status === 409 && refusedAtNone.json.code === NO_COPIES_HERE && !copyRow(lea.pubKeyHex), 'under "Nowhere" a half is refused, and nothing kept');
        setRecoveryCopies('vault');
        const atVault = await copyStatus(lea);
        assert(atVault.json.offered === false && atVault.json.sharedOffered === true && atVault.json.kept === false,
            'under "BeanPool\'s key vault" the half is offered, and the whole copy (an app from before it, the web) is not');
        process.env.NODE_PROFILE = 'global';
        const openDoor = await putHalf(lea, m.nodeHalf, m.digest);
        const openStatus = await copyStatus(lea);
        assert(openDoor.status === 409 && openDoor.json.code === 'not_offered' && openStatus.json.sharedOffered === false && !copyRow(lea.pubKeyHex),
            'never where anyone can walk in: an admin must have seen the person');
        delete process.env.NODE_PROFILE;
        for (const [half, copy] of [['short', m.digest], [m.nodeHalf, 'short'], [undefined, undefined], [m.made.copyKey + 'x', m.digest]]) {
            const bad = await putHalf(lea, half, copy);
            assert(bad.status === 400 && bad.json.code === 'bad_half' && !copyRow(lea.pubKeyHex), `a half of the wrong shape is refused (${bad.status})`);
        }

        const on = await putHalf(lea, m.nodeHalf, m.digest);
        assert(on.status === 200 && on.json.kept === true && !!on.json.since, `the half is kept, with since when (got ${on.status})`);
        const row = copyRow(lea.pubKeyHex)!;
        assert(JSON.parse(row.kdf_params).alg === 'node-wrap-xc20p-v1' && JSON.parse(row.kdf_params).inner === 'copykey-half-v1',
            'the stored row is the recovery seal\'s wrap, naming a half');
        const rowText = JSON.stringify(row);
        assert(!rowText.includes(m.nodeHalf) && !rowText.includes(m.digest), 'the half and its digest are not in the stored row in the clear');
        const st = await copyStatus(lea);
        assert(st.json.kept === true && st.json.placement === 'shared' && st.json.copy === m.digest && st.json.since === on.json.since,
            'the status says a half is kept, of which copy');
        const shares = await signedReq(lea, 'POST', '/api/recovery/shares/status', {});
        assert(shares.json.communityCopy?.since === on.json.since && shares.json.communityCopy?.placement === 'shared' && shares.json.communityCopy?.copy === m.digest && shares.json.nodeKey === nodeKey,
            'the copies\' status lists it as a half, of which copy, with the node key the phone matches the vault\'s copy by');
        const admin0 = await adminStatus(ownerSession, lea.pubKeyHex);
        assert(admin0.json.communityCopy?.kept === true && admin0.json.communityCopy?.placement === 'shared', 'the admin sees it can be brought back');

        // A bring-back: the code and the number as for a whole copy.
        putPushTokenRow(lea.pubKeyHex, 'ExponentPushToken[lea-old-phone]', 'android');
        pushed.length = 0;
        const issued = await issueBringBack(ownerSession, lea.pubKeyHex);
        assert(issued.status === 200 && /^BB-/.test(issued.json.code ?? ''), `a half is enough for a bring-back code (got ${issued.status})`);
        const code = issued.json.code as string;
        const phone = makeKeypair();
        const a = await ask(phone, code);
        const bound_ = await bindByNumber(ownerSession, lea.pubKeyHex, code, a.json.match);
        assert(bound_.status === 200 && bound_.json.broughtBack === true && bound_.json.placement === 'shared', `the number confirms it, and says the placement (got ${bound_.status})`);
        await flush();
        assert(pushed.length === 1 && pushed[0].body === PUSH_NOTICE_KINDS['account.bring-back-started'].body,
            `the phones are told at the code, and never told it is back: the vault holds it a day, and tells them itself (got ${pushed.length})`);

        const answer = await poll(phone, code);
        assert(answer.status === 200 && answer.json.state === 'released' && answer.json.memberKey === lea.pubKeyHex && typeof answer.json.voucher === 'string' && !('voucherFor' in answer.json),
            `the phone's poll has its release and a voucher (got ${answer.status} ${answer.json.state})`);
        const binding = { collectionId: code, holderType: 'community-half' };
        const released = communityHalfFromRelease(openReleaseOnDevice(answer.json.release, phone.seed, binding));
        assert(released.half === m.nodeHalf && released.copy === m.digest, 'the release opens, with this phone\'s key, to this server\'s half and the digest of its copy');
        let otherOpened = false;
        try { openReleaseOnDevice(answer.json.release, makeKeypair().seed, binding); otherOpened = true; } catch { /* as it should */ }
        let asWhole = false;
        try { openReleaseOnDevice(answer.json.release, phone.seed, { collectionId: code, holderType: 'community' }); asWhole = true; } catch { /* as it should */ }
        assert(!otherOpened && !asWhole, 'it opens for no other key, and never as a whole copy');
        const nothing = (() => { try { openSeedWithCopyKey(m.made.copy, released.half, lea.pubKeyHex); return false; } catch { return true; } })();
        assert(nothing, 'this server\'s half, with the copy in hand, opens nothing');
        const joined = openSeedWithCopyKey(m.made.copy, joinCopyKeyHalves(m.vaultHalf, released.half), lea.pubKeyHex);
        assert(Buffer.from(joined.seed).equals(Buffer.from(lea.seed)), 'joined to the vault\'s half, it opens to the same key');

        const expires = new Date(issued.json.expiresAt).getTime();
        const voucher = checkVaultVoucher(answer.json.voucher, { now: Date.now(), key: phone.pubKeyHex });
        assert(voucher.ok && voucher.voucher.community === nodeKey && voucher.voucher.member === lea.pubKeyHex && voucher.voucher.phone === phone.pubKeyHex
            && voucher.voucher.copy === m.digest && voucher.voucher.exp === expires,
            'the voucher is signed by the node key, for this member, this phone and this copy, until the code\'s end');
        assert(checkVaultVoucher(answer.json.voucher, { now: Date.now(), key: makeKeypair().pubKeyHex }).ok === false, 'it is no use to any other phone');
        const again = await poll(phone, code);
        const lost = await ask(phone, code);
        assert(again.json.voucher === answer.json.voucher && lost.json.voucher === answer.json.voucher, 'a poll and a lost answer get the same voucher: one code, one hold at the vault');
        const log = db.prepare('SELECT operator_pubkey FROM bring_back_log WHERE member_pubkey = ?').all(lea.pubKeyHex) as { operator_pubkey: string }[];
        assert(log.length === 1, 'the log row names who and when');
        assert(memberRow(lea.pubKeyHex)?.status === 'active', 'the account is untouched');

        // No node key to sign with (still starting): the phone is told to ask again, never handed a release without one.
        setPrivateKeyForTests(undefined);
        const noKey = await poll(phone, code);
        const noKeyStatus = await copyStatus(lea);
        assert(noKey.status === 503 && noKey.json.code === 'node_key_not_ready' && noKeyStatus.json.nodeKey === null, `no node key yet: 503, and asked again (got ${noKey.status} ${noKey.json.code})`);
        setPrivateKeyForTests(nodeIdentity);

        // A carried seal key locks a half again like any copy, under its own holder type.
        const rae = join('RaeMember');
        const r = halfOf(rae);
        await putHalf(rae, r.nodeHalf, r.digest);
        const before = copyRow(rae.pubKeyHex)!;
        installCarriedRecoverySealKey(crypto.randomBytes(32).toString('base64'));
        const relocked = rewrapCommunityCopiesFromRetiredKeys();
        const after = await copyStatus(rae);
        assert(relocked >= 1 && copyRow(rae.pubKeyHex)!.copy_ct !== before.copy_ct && after.json.kept === true && after.json.copy === r.digest,
            `a carried seal key: the half is locked again with it, and still opens (${relocked} relocked)`);

        // Its name in the clear says which holder it is bound to; a row that lies about it doesn't open.
        const liar = join('LiamMember');
        const l = halfOf(liar);
        await putHalf(liar, l.nodeHalf, l.digest);
        db.prepare('UPDATE community_copies SET kdf_params = ? WHERE owner_pubkey = ?').run(JSON.stringify({ alg: 'node-wrap-xc20p-v1', inner: 'copykey-xc20p-v1' }), liar.pubKeyHex);
        const liarStatus = await copyStatus(liar);
        assert(liarStatus.json.kept === false && liarStatus.json.unopenable?.reason === 'recovery_seal_unopenable', 'a half can\'t be read as a whole copy: said as a copy this server can\'t open');

        // Removals are a copy's: the member's own, a re-key and deleting the account.
        const off = await signedReq(rae, 'DELETE', '/api/recovery/community-copy', {});
        assert(off.status === 200 && off.json.removed === 1 && !copyRow(rae.pubKeyHex) && tombstoned(rae.pubKeyHex), 'turning it off deletes the half, with a tombstone');
        const nia = join('NiaMember');
        const n = halfOf(nia);
        await putHalf(nia, n.nodeHalf, n.digest);
        const rkCode = (await issueRekey(ownerSession, nia.pubKeyHex)).json.code as string;
        const rkPhone = makeKeypair();
        const rkAsk = await ask(rkPhone, rkCode);
        const moved = await bindByNumber(ownerSession, nia.pubKeyHex, rkCode, rkAsk.json.match);
        assert(moved.status === 200 && !copyRow(nia.pubKeyHex) && tombstoned(nia.pubKeyHex), `a re-key removes the half with the key it opened (got ${moved.status})`);
    }

    console.log(`\n${passed}/${run} checks passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

runTests().catch((e) => { console.error(e); process.exit(1); });
