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
import { sha256 } from '@noble/hashes/sha2.js';
import {
    communityCopyFromRelease, isKeySealedCopy, openReleaseOnDevice, openSeedWithCopyKey, sealSeedToCopyKey,
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
import { setRecoveryCopies, NO_COPIES_HERE } from './config/recovery-copies.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { ensureRecoverySealKey, recoverySealKeyPath } from './services/recovery-seal-key.js';
import { BRING_BACK_NO_COPY, BRING_BACK_OWN_KEY, BRING_BACK_GONE, BRING_BACK_NEEDS_NUMBER } from './engine/bring-back.js';

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
            `under "BeanPool's key vault" the community-held copy isn't offered (VR4's shared placement is not built) (got ${atVault.status} ${atVault.json.code})`);
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

        const tom = join('TomMember');
        await turnOn(tom);
        const off = await signedReq(tom, 'DELETE', '/api/recovery/community-copy', {});
        assert(off.status === 200 && off.json.removed === 1 && !copyRow(tom.pubKeyHex) && tombstoned(tom.pubKeyHex),
            'turning it off deletes the copy here, with a tombstone so a standby drops it too');
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
        const pasted = await as(adminSession, 'POST', `/api/local/admin/members/${kim.pubKeyHex}/rekey/complete`, { code, newPubkey: thief.pubKeyHex });
        assert(pasted.status === 409 && pasted.json.error === BRING_BACK_NEEDS_NUMBER && memberRow(kim.pubKeyHex)?.status === 'active' && !memberRow(thief.pubKeyHex),
            `a pasted key never completes a bring-back, and moves nothing (got ${pasted.status})`);
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

    console.log(`\n${passed}/${run} checks passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

runTests().catch((e) => { console.error(e); process.exit(1); });
