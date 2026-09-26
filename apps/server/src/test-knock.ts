/**
 * "Ask to join" (G6, routes/knocks.ts, engine/knocks.ts) over REAL HTTPS through the real signature middleware: a
 * route acting for a key that is not a member here has to be proven where the middleware runs (#1054).
 *
 *   1. unsigned → 401 on every route (the status read answers 401 itself; it is on the public list)
 *   2. a signed non-member knocks → 201 and a row under the signer's key (lower-case), with the name, message, the
 *      node it came from and the address hash; the avatar is stored with its metadata taken off; their status is
 *      `pending`; the same key in capitals is the same key (409); bad input → 400 and nothing written
 *   3. the actor is always the signer: a body `publicKey` naming someone else is refused by the middleware, and so is
 *      a body `from` (why the body says `fromNode`); nothing is written for either key
 *   4. who can't knock: a member's own key (409), a key a re-key replaced (403), a pruned account (403), a member who
 *      deleted their account (403); nothing is written
 *   5. a duplicate open knock → 409; 3 knocks from one address in a day, the 4th → 429 and no row; the address is
 *      cleared once a day old, and the next knock is let in
 *   6. members list open knocks (callsign, message, avatar, fromNode, the applicant's key); a non-member, the
 *      applicant, a pruned member and a suspended member can't; a key that has since joined is not listed
 *   7. approve: any member; the invite is written by that member for the applicant's key and recorded on the knock
 *      with who and when; the applicant's signed status returns it; a second answer → 409; a non-member can't answer,
 *      and a spoofed body key is refused; redeem refuses another key (nothing consumed) and admits the applicant's;
 *      then the applicant is a member and can't knock again
 *   8. decline ("not now"): the applicant's status is exactly what a waiting knock's is, a knock again gets exactly a
 *      duplicate's answer, for 30 days from the decline; after that the status is `none` and a knock is a new row
 *   9. a knock lapses 30 days after it was made: off the members' list, can't be answered, `none` to the applicant,
 *      and their next knock reopens the same row; an approved knock whose invite expired unused reads `none` too
 *  10. the operator: acceptKnocks=false (Settings) → every knock route 404 feature_off, /api/community/info says
 *      knocks false, the count still answers; a Settings save from before G6 (no acceptKnocks) keeps it off; a bad
 *      value is 400; back on, the override is gone; the global profile takes no knocks
 *  11. privacy: nothing about knocks is in a public read; the status read answers only for the signer
 *  12. a member who once knocked deletes their account: what they wrote goes, the record stays
 *  13. replication: every row reaches a standby (never the address hash), an approved knock's invite is made there
 *      (invite codes don't replicate) so the applicant can still redeem it after a take-over; one redeemed on the main
 *      still reads approved on the standby once its 30 days are up; the replica audit counts join_requests; and two of
 *      a key's knocks changed at one moment merge whatever order the copy lists them in
 *  14. a re-key (the lost-phone flow) moves the member's knocks to the new key, as applicant and as the member who
 *      answered: the deciding pass's reproduction (knock, let in by an ordinary invite, re-keyed, approve) gives the
 *      old key nothing; when the new key had knocked too, the old key's knock is closed; self-deletion and removal
 *      after a re-key wipe what they wrote, on the main server and a standby; an approver's and then the applicant's
 *      re-key keep the applicant's status approved through a take-over; and a knock on a replaced key is refused at
 *      every step (list, count, approve, decline, status, redeem, knock)
 *  15. the tidy-up (the main server's, every minute): a declined, lapsed, approved or joined knock loses the name,
 *      message, picture and node it carried (a declined one, who declined it too), and an open one keeps them; a declined knock in its 30 days still blocks
 *      and still looks like waiting, an approved one's invite still admits only its key; a standby copy loses them
 *      too; a row past every window is deleted, with its tombstone, on the main server and the standby, and neither a
 *      stale copy nor a full snapshot brings it back; a standby doesn't tidy by itself
 *  16. node-wide ceilings: the 31st knock in 24 hours, from a new address and a new key, and the 51st open knock each
 *      get the per-address limit's own 429; a reopened knock counts as a new one; answering one frees a slot
 *  17. a key a re-key replaced gets nothing from an ordinary invite or an offline ticket (no member row, no invites of
 *      its own), while the new key and newcomers are unaffected
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-knock.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, broadcast, seedGenesisMember, adminPruneUser, adminSetUserStatus, purgeMemberSelf,
    exportSyncState, importRemoteState, setNodeRole, clearReplicatedTables,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { registerMemberInternal } from './engine/members.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { forgetOldJoinAddresses } from './engine/open-join.js';
import * as knockEngine from './engine/knocks.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { getReplicaConsistency } from '@beanpool/engine';

const PORT = 8761;
const BASE = `https://localhost:${PORT}`;
const ADMIN_PW = 'Knock-Knock-Admin-Pw-62!';
const DAY_MS = 24 * 60 * 60 * 1000;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── identities and calls ──────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }

/** A request through the real stack. Signed by `id` when given (optionally sending its key in capitals). */
async function call(id: Id | null, method: 'GET' | 'POST', path: string, body?: unknown, opts: { upperKey?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signedPath = path.split('?')[0];
        headers['X-Public-Key'] = opts.upperKey ? id.pk.toUpperCase() : id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${signedPath}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const admin = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    call(null, method, path, body, { headers: { 'X-Admin-Password': ADMIN_PW } });

const knock = (id: Id, extra: Record<string, unknown> = {}, opts: { upperKey?: boolean } = {}) =>
    call(id, 'POST', '/api/join/knock', { callsign: id.name, message: `Hello from ${id.name}, I live nearby.`, fromNode: 'https://global.beanpool.org/', ...extra }, opts);
const status = (id: Id) => call(id, 'GET', '/api/join/knock/status');
const list = (id: Id | null, query = '') => call(id, 'GET', `/api/join/knocks${query}`);
const approve = (id: Id | null, knockId: string, body?: unknown) => call(id, 'POST', `/api/join/knocks/${knockId}/approve`, body);
const decline = (id: Id | null, knockId: string) => call(id, 'POST', `/api/join/knocks/${knockId}/decline`);

// ── the database, read without assuming the table exists (so this suite fails, not crashes, before G6) ──
function rowsFor(pk: string): any[] {
    try { return db.prepare('SELECT * FROM join_requests WHERE pubkey = ? ORDER BY created_at').all(pk.toLowerCase()) as any[]; } catch { return []; }
}
function knockCount(): number {
    try { return (db.prepare('SELECT COUNT(*) AS n FROM join_requests').get() as { n: number }).n; } catch { return -1; }
}
function setKnock(id: string, sets: Record<string, string | null>): void {
    const cols = Object.keys(sets);
    try { db.prepare(`UPDATE join_requests SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => sets[c]), id); } catch { /* no table */ }
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** A new day for the address limit: what the sweep does to a day-old hash. */
function freshAddress(): void {
    try { db.prepare('UPDATE join_requests SET ip_hash = NULL').run(); } catch { /* no table */ }
}
const sameAnswer = (a: Res, b: Res) => a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body);

// The main server's tidy-up and its timer (engine/knocks.ts), read without assuming they exist, so this suite fails,
// not crashes, on a build without them.
const { mergeReplicatedKnocks } = knockEngine;
const knockTidy = knockEngine as unknown as { tidyKnocks?: () => { cleared: number; deleted: number }; startTidyingKnocks?: (everyMs: number) => void };
const tidy = () => knockTidy.tidyKnocks?.() ?? { cleared: 0, deleted: 0 };
const tidyEvery = (ms: number) => knockTidy.startTidyingKnocks?.(ms);
/** Nothing of what the applicant sent is left on the row. */
const blank = (r: any) => !!r && r.callsign === '' && r.message === '' && r.avatar === null && r.from_node === null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeMember(id: Id, inviter: string): void {
    registerMemberInternal(broadcast, id.pk, id.name, inviter, null);
}

/** A tiny JPEG carrying an XMP block with a place in it: the metadata a node must not keep. */
function jpegWithXmp(marker: string): string {
    const seg = (m: number, body: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2); return Buffer.concat([Buffer.from([0xff, m]), len, body]); };
    const xmp = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(`<x:xmpmeta>${marker}</x:xmpmeta>`)]);
    const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.alloc(256, 0x41), Buffer.from([0xff, 0xd9])]);
    return `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, xmp), scan]).toString('base64')}`;
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    await startHttpsServer(PORT);
    // The tidy-up runs every minute by itself. Here it runs only when section 15 calls it: the sections before set a
    // knock's times by hand and read the row straight after.
    tidyEvery(DAY_MS);

    // The community: Mia (its first member), Max, a pruned member, a suspended member, one who will delete their account.
    const mia = newId('Mia');
    seedGenesisMember(mia.pk, mia.name);
    const max = newId('Max');
    const gone = newId('Gone');
    const quiet = newId('Quiet');
    const leaver = newId('Leaver');
    const rekeyed = newId('Rekeyed');
    const rekeyedNew = newId('RekeyedNew');
    for (const m of [max, gone, quiet, leaver, rekeyed]) makeMember(m, mia.pk);
    adminPruneUser(gone.pk, 'owner:password');
    adminSetUserStatus(quiet.pk, 'disabled');
    purgeMemberSelf(leaver.pk);
    completeRekey(rekeyed.pk, rekeyedNew.pk, issueRekeyCode(rekeyed.pk, 'owner:password').code, 'owner:password');

    // Applicants: nobody here.
    const ann = newId('Ann');      // approved, redeems
    const bob = newId('Bob');      // waits
    const carl = newId('Carl');    // declined
    const dee = newId('Dee');      // lapses
    const eve = newId('Eve');      // tries to use Ann's invite
    const fay = newId('Fay');      // approved, never redeems
    const spoof = newId('Spoof');

    console.log('── 1. unsigned ──');
    const unsignedKnock = await call(null, 'POST', '/api/join/knock', { callsign: 'Nobody', message: 'hi' });
    assert(unsignedKnock.status === 401, `an unsigned knock → 401 (${unsignedKnock.status})`);
    const unsignedStatus = await call(null, 'GET', '/api/join/knock/status');
    assert(unsignedStatus.status === 401, `an unsigned status read → 401: it answers only for a signer (${unsignedStatus.status})`);
    const unsignedList = await list(null);
    assert(unsignedList.status === 401, `an unsigned members' list → 401 (${unsignedList.status})`);
    const unsignedApprove = await approve(null, 'x');
    assert(unsignedApprove.status === 401, `an unsigned approve → 401 (${unsignedApprove.status})`);
    assert(knockCount() === 0, 'nothing is written');

    console.log('\n── 2. a signed non-member knocks ──');
    const bobNone = await status(bob);
    assert(bobNone.status === 200 && bobNone.body?.status === 'none', `before knocking, a signed status read says none (${bobNone.text})`);
    const marker = 'KNOCK-GPS-MARKER-51.5074';
    const bobKnock = await knock(bob, { avatar: jpegWithXmp(marker) });
    assert(bobKnock.status === 201 && bobKnock.body?.knock?.status === 'pending', `a signed non-member knocks → 201 pending (${bobKnock.status} ${bobKnock.text})`);
    const bobRow = rowsFor(bob.pk)[0];
    assert(bobRow?.pubkey === bob.pk && bobRow?.status === 'pending', 'a row under the signer\'s key, pending');
    assert(bobRow?.callsign === 'Bob' && bobRow?.message === 'Hello from Bob, I live nearby.' && bobRow?.from_node === 'global.beanpool.org',
        `with the name, the message, and the node it came from as a host name (${bobRow?.from_node})`);
    assert(typeof bobRow?.ip_hash === 'string' && bobRow.ip_hash.length > 20 && !bobRow.ip_hash.includes('127.0.0.1'), 'and a keyed hash of the address, never the address');
    assert(typeof bobRow?.avatar === 'string' && bobRow.avatar.startsWith('data:image/jpeg;base64,')
        && !Buffer.from(bobRow.avatar.split(',')[1], 'base64').includes(Buffer.from(marker)),
        'the avatar is stored with its metadata taken off (no place in it)');
    const bobPending = await status(bob);
    assert(bobPending.status === 200 && JSON.stringify(bobPending.body) === JSON.stringify({ status: 'pending' }), `their status: pending, and nothing else (${bobPending.text})`);
    const bobDupe = await knock(bob);
    assert(bobDupe.status === 409 && bobDupe.body?.code === 'knock_open', `the same key again while it is open → 409 knock_open (${bobDupe.text})`);
    const bobCaps = await knock(bob, {}, { upperKey: true });
    assert(bobCaps.status === 409 && bobCaps.body?.code === 'knock_open', `the same key sent in capitals is the same key → 409 (${bobCaps.status})`);
    assert(rowsFor(bob.pk).length === 1, 'still one row for Bob');

    const probe = newId('Probe');
    const bad: Array<[string, Record<string, unknown>]> = [
        ['no message', { message: '   ' }],
        ['a message over 280 characters', { message: 'x'.repeat(281) }],
        ['a one-letter name', { callsign: 'P' }],
        ['a name over 20 characters', { callsign: 'P'.repeat(21) }],
        ['an avatar that is not a picture', { avatar: 'data:text/html;base64,PHNjcmlwdD4=' }],
        ['an avatar that is a web address', { avatar: 'https://example.com/me.jpg' }],
        ['a fromNode that is not an address', { fromNode: 'not a host!' }],
    ];
    for (const [what, extra] of bad) {
        const r = await knock(probe, extra);
        assert(r.status === 400, `${what} → 400 (${r.status} ${r.body?.error})`);
    }
    const emojiName = await knock(probe, { callsign: '🌿'.repeat(20), message: '🌿'.repeat(280), avatar: null, fromNode: null });
    assert(emojiName.status === 201, `20 emoji as a name and 280 as a message fit: characters, not bytes (${emojiName.status} ${emojiName.body?.error})`);

    console.log('\n── 3. the actor is always the signer ──');
    const spoofed = await knock(spoof, { publicKey: ann.pk });
    assert(spoofed.status === 403, `a body publicKey naming someone else → refused by the middleware (${spoofed.status})`);
    const spoofedLower = await knock(spoof, { pubkey: ann.pk });
    assert(spoofedLower.status === 403, `a body pubkey naming someone else → refused (${spoofedLower.status})`);
    const fromField = await knock(spoof, { from: 'global.beanpool.org' });
    assert(fromField.status === 403, `a body "from" is read as the sender's key and refused, which is why the body says fromNode (${fromField.status})`);
    assert(rowsFor(spoof.pk).length === 0 && rowsFor(ann.pk).length === 0, 'nothing is written for either key');

    console.log('\n── 4. who can\'t knock ──');
    const memberKnock = await knock(max);
    assert(memberKnock.status === 409 && memberKnock.body?.code === 'already_member', `a member's own key → 409 already_member (${memberKnock.text})`);
    const oldKey = await knock(rekeyed);
    assert(oldKey.status === 403 && oldKey.body?.code === 'key_invalidated', `a key a re-key replaced → 403 key_invalidated (${oldKey.text})`);
    const pruned = await knock(gone);
    assert(pruned.status === 403 && pruned.body?.code === 'account_closed', `a pruned account → 403 account_closed (${pruned.text})`);
    const deleted = await knock(leaver);
    assert(deleted.status === 403 && deleted.body?.code === 'account_closed', `an account its owner deleted → 403 account_closed (${deleted.text})`);
    const suspended = await knock(quiet);
    assert(suspended.status === 409 && suspended.body?.code === 'already_member', `a suspended member is still a member → 409 (${suspended.status})`);
    assert([max, rekeyed, gone, leaver, quiet].every(m => rowsFor(m.pk).length === 0), 'none of them has a row');

    console.log('\n── 5. three from an address in a day ──');
    freshAddress();
    for (const a of [ann, carl, dee]) {
        const r = await knock(a);
        assert(r.status === 201, `${a.name} knocks (${r.status} ${r.body?.error ?? ''})`);
    }
    const fourth = await knock(fay);
    assert(fourth.status === 429 && fourth.body?.code === 'rate_limited' && /3/.test(fourth.body?.error ?? ''),
        `the 4th knock from the address today → 429 rate_limited (${fourth.text})`);
    assert(rowsFor(fay.pk).length === 0, 'and no row');
    for (const a of [ann, carl, dee]) setKnock(rowsFor(a.pk)[0]?.id, { created_at: ago(DAY_MS + 60_000) });
    forgetOldJoinAddresses();
    const cleared = [ann, carl, dee].every(a => rowsFor(a.pk)[0]?.ip_hash === null);
    assert(cleared, 'a day later the sweep has cleared those addresses');
    for (const a of [ann, carl, dee]) setKnock(rowsFor(a.pk)[0]?.id, { created_at: ago(60_000) });
    const fayKnock = await knock(fay);
    assert(fayKnock.status === 201, `and the next knock is let in (${fayKnock.status})`);
    freshAddress();

    console.log('\n── 6. members see open knocks ──');
    const miaList = await list(mia);
    const names = (miaList.body?.knocks ?? []).map((k: any) => k.callsign);
    assert(miaList.status === 200 && ['Ann', 'Bob', 'Carl', 'Dee', 'Fay'].every(n => names.includes(n)), `a member lists open knocks (${names.join(', ')})`);
    const bobListed = (miaList.body?.knocks ?? []).find((k: any) => k.callsign === 'Bob');
    assert(bobListed?.pubkey === bob.pk && bobListed?.message === 'Hello from Bob, I live nearby.' && bobListed?.fromNode === 'global.beanpool.org'
        && bobListed?.avatar === bobRow?.avatar && typeof bobListed?.id === 'string',
        'with the applicant\'s key, message, the node they came from and their avatar');
    assert(miaList.body?.total === miaList.body?.knocks?.length && miaList.body?.limit === 20, `and the count, "Wants to join (${miaList.body?.total})"`);
    const paged = await list(mia, '?limit=2&offset=1');
    assert(paged.status === 200 && paged.body?.knocks?.length === 2 && paged.body?.total === miaList.body?.total, 'a page of it');
    const badLimit = await list(mia, '?limit=500');
    assert(badLimit.status === 400, `a limit past 50 → 400 (${badLimit.status})`);
    const byApplicant = await list(bob);
    assert(byApplicant.status === 403, `the applicant can't list (${byApplicant.status})`);
    const byStranger = await list(newId('Stranger'));
    assert(byStranger.status === 403, `a signed non-member can't list (${byStranger.status})`);
    const byPruned = await list(gone);
    // Refused by the signature middleware before the route's own `not_member` (4109713263): a closed account signs nothing.
    assert(byPruned.status === 403 && byPruned.body?.code === 'account_closed', `a pruned member can't list (${byPruned.status} ${byPruned.body?.code})`);
    const bySuspended = await list(quiet);
    assert(bySuspended.status === 403 && bySuspended.body?.code === 'not_active', `a suspended member can't list (${bySuspended.status} ${bySuspended.body?.code})`);
    const byMax = await list(max);
    assert(byMax.status === 200 && byMax.body?.total === miaList.body?.total, 'any member can: tiers gate nothing');

    console.log('\n── 7. approve ──');
    const annId = rowsFor(ann.pk)[0]?.id as string;
    const byBob = await approve(bob, annId);
    assert(byBob.status === 403 && byBob.body?.code === 'not_member', `a non-member (another applicant) can't approve (${byBob.status})`);
    const spoofApprove = await approve(bob, annId, { publicKey: mia.pk });
    assert(spoofApprove.status === 403, `nor by naming a member in the body (${spoofApprove.status})`);
    const bySuspendedApprove = await approve(quiet, annId);
    assert(bySuspendedApprove.status === 403, `a suspended member can't approve (${bySuspendedApprove.status})`);
    assert(rowsFor(ann.pk)[0]?.status === 'pending', 'the knock is still pending');

    const approved = await approve(max, annId);
    const code = approved.body?.invite?.code as string;
    assert(approved.status === 200 && approved.body?.knock?.status === 'approved' && typeof code === 'string' && code.length > 4,
        `Max approves Ann → an invite (${approved.text})`);
    const annRow = rowsFor(ann.pk)[0];
    assert(annRow?.status === 'approved' && annRow?.decided_by === max.pk && annRow?.invite_code === code && typeof annRow?.decided_at === 'string',
        'the knock records the invite, who approved it and when');
    const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any;
    assert(invite?.created_by === max.pk && invite?.intended_for === ann.pk && !invite?.used_by, 'the invite is Max\'s, for Ann\'s key, unused');
    const annStatus = await status(ann);
    assert(annStatus.status === 200 && annStatus.body?.status === 'approved' && annStatus.body?.invite === code && typeof annStatus.body?.expiresAt === 'string',
        `Ann's signed status returns the invite (${annStatus.text})`);
    const again = await approve(mia, annId);
    assert(again.status === 409 && again.body?.code === 'answered', `a second answer → 409 answered (${again.status})`);
    const declineApproved = await decline(mia, annId);
    assert(declineApproved.status === 409, `and it can't be declined now (${declineApproved.status})`);
    const missing = await approve(mia, 'no-such-knock');
    assert(missing.status === 404, `an unknown knock → 404 (${missing.status})`);
    const annAgain = await knock(ann);
    assert(annAgain.status === 409 && annAgain.body?.code === 'knock_approved', `Ann knocking again while invited → 409 knock_approved (${annAgain.status})`);

    const byEve = await call(null, 'POST', '/api/invite/redeem', { code, publicKey: eve.pk, callsign: 'Eve' });
    assert(byEve.status === 400 && /someone else/.test(byEve.body?.error ?? ''), `redeeming Ann's invite with another key → refused (${byEve.text})`);
    const eveMember = db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(eve.pk);
    const stillUnused = (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as any)?.used_by;
    assert(!eveMember && !stillUnused, 'Eve is not a member and the invite is not used');
    const byMemberKey = await call(null, 'POST', '/api/invite/redeem', { code, publicKey: mia.pk, callsign: 'Mia' });
    assert(byMemberKey.status === 400, `nor with a member's key (${byMemberKey.status})`);
    const byAnn = await call(null, 'POST', '/api/invite/redeem', { code, publicKey: ann.pk, callsign: 'Ann' });
    assert(byAnn.status === 200 && byAnn.body?.success === true && !byAnn.body?.alreadyMember, `Ann redeems it with her key (${byAnn.status})`);
    const annMember = db.prepare('SELECT invited_by, invite_code FROM members WHERE public_key = ?').get(ann.pk) as any;
    assert(annMember?.invited_by === max.pk && annMember?.invite_code === code, 'she is a member, invited by Max with that code');
    const annAfter = await status(ann);
    assert(annAfter.body?.status === 'approved', `her status still says approved (${annAfter.text})`);
    const annMemberKnock = await knock(ann);
    assert(annMemberKnock.status === 409 && annMemberKnock.body?.code === 'already_member', 'and she can\'t knock: she is a member');
    const afterJoin = await list(mia);
    assert(!(afterJoin.body?.knocks ?? []).some((k: any) => k.pubkey === ann.pk), 'she is not on the list');

    console.log('\n── 8. decline ("not now") ──');
    const carlId = rowsFor(carl.pk)[0]?.id as string;
    const declined = await decline(mia, carlId);
    assert(declined.status === 200 && declined.body?.knock?.status === 'declined', `Mia declines Carl (${declined.text})`);
    const carlRow = rowsFor(carl.pk)[0];
    assert(carlRow?.status === 'declined' && carlRow?.decided_by === mia.pk && !carlRow?.invite_code, 'declined, by Mia, with no invite');
    const carlStatus = await status(carl);
    assert(sameAnswer(carlStatus, bobPending), `Carl's status is exactly a waiting knock's (${carlStatus.text})`);
    const carlAgain = await knock(carl);
    assert(sameAnswer(carlAgain, bobDupe), `knocking again gets exactly a duplicate's answer (${carlAgain.text})`);
    assert(!(await list(mia)).body?.knocks?.some((k: any) => k.pubkey === carl.pk), 'he is off the members\' list');
    setKnock(carlId, { decided_at: ago(29 * DAY_MS) });
    assert(sameAnswer(await knock(carl), bobDupe) && sameAnswer(await status(carl), bobPending), '29 days after the decline: still blocked, still looks like waiting');
    setKnock(carlId, { decided_at: ago(31 * DAY_MS), created_at: ago(35 * DAY_MS) });
    const carlLater = await status(carl);
    assert(carlLater.body?.status === 'none', `31 days after it: his status is none (${carlLater.text})`);
    const carlNew = await knock(carl);
    assert(carlNew.status === 201 && rowsFor(carl.pk).length === 2 && rowsFor(carl.pk)[1]?.status === 'pending', `and he may ask again: a new row (${carlNew.status})`);
    assert((await status(carl)).body?.status === 'pending', 'pending again');
    freshAddress();

    console.log('\n── 9. lapsing ──');
    const deeId = rowsFor(dee.pk)[0]?.id as string;
    setKnock(deeId, { created_at: ago(31 * DAY_MS) });
    assert(!(await list(mia)).body?.knocks?.some((k: any) => k.pubkey === dee.pk), 'a knock 31 days old is off the members\' list');
    const lateAnswer = await approve(mia, deeId);
    assert(lateAnswer.status === 409 && lateAnswer.body?.code === 'lapsed', `and can't be answered: lapsed (${lateAnswer.status})`);
    assert((await status(dee)).body?.status === 'none', 'Dee\'s status is none');
    const deeAgain = await knock(dee, { message: 'Still keen to join!' });
    const deeRows = rowsFor(dee.pk);
    assert(deeAgain.status === 201 && deeRows.length === 1 && deeRows[0].id === deeId && deeRows[0].message === 'Still keen to join!'
        && Date.now() - Date.parse(deeRows[0].created_at) < 60_000, `her next knock reopens the same row with what she sent (${deeAgain.status})`);
    assert((await list(mia)).body?.knocks?.some((k: any) => k.pubkey === dee.pk), 'and she is back on the list');

    const fayId = rowsFor(fay.pk)[0]?.id as string;
    const fayApproved = await approve(mia, fayId);
    const fayCode = fayApproved.body?.invite?.code as string;
    assert(fayApproved.status === 200 && (await status(fay)).body?.invite === fayCode, 'Fay is approved and her status has the invite');
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(ago(31 * DAY_MS), fayCode);
    assert((await status(fay)).body?.status === 'none', 'once that invite has expired unused, her status is none');
    const fayAgain = await knock(fay);
    assert(fayAgain.status === 201 && rowsFor(fay.pk).length === 2, `and she may ask again (${fayAgain.status})`);
    freshAddress();

    console.log('\n── 10. the operator ──');
    const count0 = await admin('GET', '/api/local/admin/knocks');
    const openNow = (await list(mia)).body?.total;
    assert(count0.status === 200 && count0.body?.acceptKnocks === true && count0.body?.takingKnocks === true && count0.body?.open === openNow,
        `Settings: knocks on, ${openNow} waiting (${count0.text})`);
    const noAuth = await call(null, 'GET', '/api/local/admin/knocks');
    assert(noAuth.status === 401, `the count is the operator's only (${noAuth.status})`);
    const cfg0 = await call(null, 'GET', '/api/node/config');
    assert(cfg0.body?.acceptKnocks === true, 'GET /api/node/config says acceptKnocks true');
    const badValue = await admin('POST', '/api/local/admin/node/config', { acceptKnocks: 'no' });
    assert(badValue.status === 400, `acceptKnocks "no" → 400 (${badValue.status})`);
    const off = await admin('POST', '/api/local/admin/node/config', { acceptKnocks: false });
    assert(off.status === 200 && off.body?.acceptKnocks === false, `the operator turns knocks off (${off.status})`);
    const info = await call(null, 'GET', '/api/community/info');
    assert(info.body?.features?.knocks === false, '/api/community/info says knocks false, so the apps hide the section');
    const offRoutes: Array<[string, Promise<Res>]> = [
        ['a knock', knock(newId('Late'))],
        ['the status read', status(bob)],
        ['the members\' list', list(mia)],
        ['an approve', approve(mia, rowsFor(bob.pk)[0]?.id)],
        ['a decline', decline(mia, rowsFor(bob.pk)[0]?.id)],
    ];
    for (const [what, p] of offRoutes) {
        const r = await p;
        assert(r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'knocks', `${what} → 404 feature_off (${r.status})`);
    }
    assert(rowsFor(bob.pk)[0]?.status === 'pending', 'Bob\'s knock is untouched');
    const countOff = await admin('GET', '/api/local/admin/knocks');
    assert(countOff.status === 200 && countOff.body?.acceptKnocks === false && countOff.body?.open === openNow, 'the operator still sees the count, beside the switch');
    const oldSettings = await admin('POST', '/api/local/admin/node/config', { publishLocation: true, publishMembers: true, publishContacts: true, publishHealth: true });
    assert(oldSettings.status === 200 && oldSettings.body?.acceptKnocks === false && (await call(null, 'GET', '/api/node/config')).body?.acceptKnocks === false,
        'a Settings save that doesn\'t send acceptKnocks (a page from before G6) leaves it off');
    const overrideRow = db.prepare("SELECT value FROM node_config WHERE key = 'nodeProfile.knocks'").get() as any;
    assert(overrideRow?.value === 'false', 'it is kept as the knocks switch\'s override, so it travels with the profile record');
    const on = await admin('POST', '/api/local/admin/node/config', { acceptKnocks: true });
    assert(on.status === 200 && on.body?.acceptKnocks === true && (await status(bob)).body?.status === 'pending', 'turned back on, the routes answer again');
    assert(!db.prepare("SELECT 1 FROM node_config WHERE key = 'nodeProfile.knocks'").get(), 'and matching the default, the override is gone');

    process.env.NODE_PROFILE = 'global';
    const onGlobal = await knock(newId('Lobby'));
    const globalInfo = await call(null, 'GET', '/api/community/info');
    assert(onGlobal.status === 404 && onGlobal.body?.code === 'feature_off' && globalInfo.body?.features?.knocks === false,
        `the global profile takes no knocks: 404, and /api/community/info says so (${onGlobal.status})`);
    delete process.env.NODE_PROFILE;

    console.log('\n── 11. privacy ──');
    const secret = 'Hello from Bob, I live nearby.';
    const publicReads = ['/api/community/info', '/api/node/config', '/api/node/info', '/api/directory/info', '/api/marketplace/posts', '/api/commons/decisions', `/api/community/membership/${bob.pk}`];
    for (const p of publicReads) {
        const r = await call(null, 'GET', p);
        assert(!r.text.includes(secret) && !r.text.includes('"Bob"') && !r.text.includes(bob.pk.slice(0, 16)) && !/join_requests|knocks"\s*:\s*\[/.test(r.text),
            `${p} (unsigned) says nothing about knocks (${r.status})`);
    }
    const strangerStatus = await status(newId('Nosy'));
    assert(strangerStatus.body?.status === 'none', 'a status read answers only for the signer: another key sees none');
    const feed = await call(newId('Outsider'), 'GET', '/api/activity/feed');
    assert(feed.status === 403 && !feed.text.includes(secret), `the activity feed is not a way in (${feed.status})`);

    console.log('\n── 12. a member who once knocked deletes their account ──');
    const purged = purgeMemberSelf(ann.pk);
    const annScrubbed = rowsFor(ann.pk)[0];
    assert(purged.ok && annScrubbed?.callsign === 'Deleted Member' && annScrubbed?.message === '' && annScrubbed?.avatar === null && annScrubbed?.from_node === null,
        'what Ann wrote when she knocked is gone');
    assert(annScrubbed?.status === 'approved' && annScrubbed?.invite_code === code && annScrubbed?.decided_by === max.pk, 'the record stays');

    console.log('\n── 13. replication to a standby ──');
    const p2p = await startP2P(4096, 4097);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4097/p2p/${nodeId}`, 'mirror', 'knock-standby-test');
    const expected = db.prepare('SELECT id, pubkey, callsign, message, avatar, from_node, status, created_at, decided_by, invite_code, decided_at, updated_at FROM join_requests ORDER BY id').all();
    const payload: any = await exportSyncState(nodeId);
    const carried = payload.joinRequests ?? [];
    assert(carried.length === expected.length && carried.length > 0, `the payload carries every knock (${carried.length}/${expected.length})`);
    assert(carried.every((r: any) => !('ipHash' in r) && !('ip_hash' in r)) && !JSON.stringify(carried).includes(rowsFor(carl.pk)[1]?.ip_hash ?? '~none~'),
        'and never the address hash');
    const bobId = rowsFor(bob.pk)[0]?.id;
    // A standby: empty replicated tables, and none of the main server's invite codes (they don't replicate).
    clearReplicatedTables();
    assert(knockCount() === 0, 'a force-resync clears join_requests');
    db.prepare('DELETE FROM invite_codes WHERE code = ?').run(fayCode);
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
    const replica = db.prepare('SELECT id, pubkey, callsign, message, avatar, from_node, status, created_at, decided_by, invite_code, decided_at, updated_at FROM join_requests ORDER BY id').all();
    assert(JSON.stringify(replica) === JSON.stringify(expected), 'every knock is back on the standby exactly as it was');
    assert(db.prepare('SELECT ip_hash FROM join_requests WHERE ip_hash IS NOT NULL').all().length === 0, 'with no address hash');
    // Fay's first knock was approved and its invite expired; her second is open. Approve it on the "main", then copy again.
    const fayOpen = rowsFor(fay.pk)[1]?.id as string;
    const fayApproved2 = await approve(mia, fayOpen);
    const fayCode2 = fayApproved2.body?.invite?.code as string;
    const payload2: any = await exportSyncState(nodeId);
    db.prepare('DELETE FROM invite_codes WHERE code = ?').run(fayCode2);
    setKnock(fayOpen, { status: 'pending', decided_by: null, decided_at: null, invite_code: null, updated_at: ago(DAY_MS) });
    setNodeRole('backup');
    await importRemoteState(payload2);
    setNodeRole('primary');
    const remade = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(fayCode2) as any;
    assert(rowsFor(fay.pk)[1]?.status === 'approved' && remade?.created_by === mia.pk && remade?.intended_for === fay.pk && !remade?.used_by,
        'the standby has the approval, and makes its invite: the same code, by the member who approved, for the applicant\'s key');
    const fayOnStandby = await status(fay);
    assert(fayOnStandby.body?.status === 'approved' && fayOnStandby.body?.invite === fayCode2, 'so after a take-over the applicant\'s status still has a working invite');
    const eveOnStandby = await call(null, 'POST', '/api/invite/redeem', { code: fayCode2, publicKey: eve.pk, callsign: 'Eve' });
    assert(eveOnStandby.status === 400, 'which still admits only her key');
    const fayRedeems = await call(null, 'POST', '/api/invite/redeem', { code: fayCode2, publicKey: fay.pk, callsign: 'Fay' });
    assert(fayRedeems.status === 200 && fayRedeems.body?.success === true, `and admits her (${fayRedeems.status})`);
    // She joined on the "main". A standby copies her member row and the approval, and makes the invite unused (the
    // redemption is not in the copy). Once that invite is 30 days old, her status must still say approved there.
    const payload3: any = await exportSyncState(nodeId);
    clearReplicatedTables();
    db.prepare('DELETE FROM invite_codes WHERE code = ?').run(fayCode2);
    setNodeRole('backup');
    await importRemoteState(payload3);
    setNodeRole('primary');
    const fayInviteOnStandby = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(fayCode2) as any;
    const fayMemberOnStandby = db.prepare('SELECT invite_code FROM members WHERE public_key = ?').get(fay.pk) as any;
    assert(!!fayInviteOnStandby && !fayInviteOnStandby.used_by && fayMemberOnStandby?.invite_code === fayCode2,
        'on a standby her invite is unused, and her member row says she joined with it');
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(ago(31 * DAY_MS), fayCode2);
    const fayLaterOnStandby = await status(fay);
    assert(fayLaterOnStandby.body?.status === 'approved' && fayLaterOnStandby.body?.invite === fayCode2,
        `after a take-over, an invite she used reads approved past its 30 days, as on the main (${fayLaterOnStandby.text})`);
    assert(!!bobId && rowsFor(bob.pk)[0]?.id === bobId && rowsFor(bob.pk)[0]?.status === 'pending', 'Bob\'s open knock is still open on the standby');
    const consistency = getReplicaConsistency(db, await exportSyncState(nodeId), 0);
    const jr = consistency.tables.find(t => t.name === 'join_requests');
    assert(jr?.match === true && jr.primary > 0, `the replica audit counts join_requests (${JSON.stringify(jr)})`);

    // A key's old knock, still open on a standby that fell behind, and the key's newer open knock arrive stamped with
    // one moment (a prune's scrub stamps all of a key's rows), the newer first: the standby must take both.
    const gil = newId('Gil');
    const gilOld = crypto.randomUUID();
    const gilNew = crypto.randomUUID();
    const stamp = new Date().toISOString();
    db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, updated_at) VALUES (?, ?, 'Gil', 'Hello', 'pending', ?, ?)`)
        .run(gilOld, gil.pk, ago(70 * DAY_MS), ago(70 * DAY_MS));
    const scrubbed = { callsign: 'Deleted Member', message: '', avatar: null, fromNode: null, updatedAt: stamp };
    const gilMerge = mergeReplicatedKnocks([
        { ...scrubbed, id: gilNew, pubkey: gil.pk, status: 'pending', createdAt: ago(20 * DAY_MS), decidedBy: null, inviteCode: null, decidedAt: null },
        { ...scrubbed, id: gilOld, pubkey: gil.pk, status: 'declined', createdAt: ago(70 * DAY_MS), decidedBy: mia.pk, inviteCode: null, decidedAt: ago(60 * DAY_MS) },
    ]);
    const gilRows = rowsFor(gil.pk);
    assert(gilMerge.written === 2 && gilMerge.invalid === 0 && gilRows.length === 2
        && gilRows.find((r) => r.id === gilOld)?.status === 'declined' && gilRows.find((r) => r.id === gilNew)?.status === 'pending',
        `two of a key's knocks changed at one moment: the decided one is written first, so the open one fits (${JSON.stringify(gilMerge)})`);

    console.log('\n── 14. a re-key moves the member\'s knocks to the new key ──');
    /** The lost-phone flow, as the operator runs it. False (and logged) if it was refused. */
    const reKey = (from: Id, to: Id): boolean => {
        try { completeRekey(from.pk, to.pk, issueRekeyCode(from.pk, 'owner:password').code, 'owner:password'); return true; } catch (e: any) {
            console.error(`  (the re-key of ${from.name} failed: ${e?.message || e})`);
            return false;
        }
    };
    const memberRow = (pk: string) => db.prepare('SELECT status, invited_by, invite_code FROM members WHERE public_key = ?').get(pk) as any;
    const knockById = (id: string) => db.prepare('SELECT * FROM join_requests WHERE id = ?').get(id) as any;
    const redeem = (code: string, id: Id) => call(null, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
    /** This database becomes a standby holding `copy`: the replicated tables cleared, then imported. */
    async function becomeCopyOf(copy: any, dropCodes: string[] = []): Promise<void> {
        clearReplicatedTables();
        // Invite codes don't replicate: a standby has none of the main server's.
        for (const c of dropCodes) db.prepare('DELETE FROM invite_codes WHERE code = ?').run(c);
        setNodeRole('backup');
        await importRemoteState(copy);
        setNodeRole('primary');
    }

    // The deciding pass's reproduction: Kit knocks, gets in through a member's ordinary invite while the knock waits,
    // then loses the phone and is re-keyed. The old knock must not come back for the old key.
    freshAddress();
    const kit = newId('Kit');
    const kitNew = newId('KitNew');
    assert((await knock(kit)).status === 201, 'Kit knocks');
    const kitId = rowsFor(kit.pk)[0]?.id as string;
    const ordinary = await call(max, 'POST', '/api/invite/generate', { publicKey: max.pk });
    const kitJoins = await redeem(ordinary.body?.invite?.code, kit);
    assert(kitJoins.status === 200 && memberRow(kit.pk)?.status === 'active', `and joins through Max's ordinary invite while it waits (${kitJoins.status})`);
    assert(reKey(kit, kitNew), 'Kit loses the phone and is re-keyed');
    const kitRows = rowsFor(kitNew.pk);
    assert(rowsFor(kit.pk).length === 0 && kitRows.length === 1 && kitRows[0].id === kitId && kitRows[0].callsign === 'Kit',
        'the knock moved to the new key with the member: the old key has none');
    assert(!(await list(mia)).body?.knocks?.some((k: any) => k.id === kitId), 'it is not back on the members\' list');
    const kitApprove = await approve(mia, kitId);
    assert(kitApprove.status === 409 && kitApprove.body?.code === 'already_member' && !kitApprove.body?.invite,
        `approving it → 409 already_member, and no invite (${kitApprove.status} ${kitApprove.body?.code})`);
    assert(rowsFor(kitNew.pk)[0]?.status === 'pending' && !db.prepare('SELECT 1 FROM invite_codes WHERE intended_for = ?').get(kit.pk),
        'nothing is made for the old key');
    const kitOldStatus = await status(kit);
    assert(kitOldStatus.status === 403 && kitOldStatus.body?.code === 'key_invalidated' && !/INV-/.test(kitOldStatus.text),
        `the old key's status read → 403 key_invalidated, and no invite (${kitOldStatus.status} ${kitOldStatus.text})`);
    // Before this fix the approval above made an invite for the old key, which its status read handed over.
    const kitCode = (kitApprove.body?.invite?.code ?? kitOldStatus.body?.invite) as string | undefined;
    if (kitCode) await redeem(kitCode, kit);
    assert(!memberRow(kit.pk) && memberRow(kitNew.pk)?.status === 'active', 'one member, on the new key: the old key never joins again');

    // The new phone asked to join as a stranger before the operator re-keyed: two open knocks meet on one key, and
    // only one may be open. The old key's is closed (declined, by nobody): the key is a member, so neither is answered.
    freshAddress();
    const lou = newId('Lou');
    const louNew = newId('LouNew');
    await knock(lou);
    makeMember(lou, max.pk);
    const louNewKnock = await knock(louNew);
    const louOld = rowsFor(lou.pk)[0]?.id as string;
    const louOwn = rowsFor(louNew.pk)[0]?.id as string;
    assert(louNewKnock.status === 201 && !!louOld && !!louOwn, 'Lou knocked, joined, and the new phone knocked too');
    const louMoved = reKey(lou, louNew);
    const louRows = rowsFor(louNew.pk);
    const louClosed = louRows.find((r) => r.id === louOld);
    assert(louMoved && rowsFor(lou.pk).length === 0 && louRows.length === 2 && louRows.find((r) => r.id === louOwn)?.status === 'pending'
        && louClosed?.status === 'declined' && louClosed?.decided_by === null && typeof louClosed?.decided_at === 'string',
        'the re-key moves both: the new key\'s own stays open, the old key\'s is closed (declined, by nobody)');
    assert(!(await list(mia)).body?.knocks?.some((k: any) => k.pubkey === lou.pk || k.pubkey === louNew.pk), 'neither is listed: Lou is a member');

    // Privacy: a member re-keys, then deletes their account (Lia) or is removed (Ned). What they wrote when they knocked
    // goes, on the main server and on a standby.
    freshAddress();
    const lia = newId('Lia');
    const liaNew = newId('LiaNew');
    const ned = newId('Ned');
    const nedNew = newId('NedNew');
    await knock(lia, { message: 'Lia here, 12 Smith St', avatar: jpegWithXmp('LIA') });
    await knock(ned, { message: 'Ned here, 3 Jones Rd' });
    const liaId = rowsFor(lia.pk)[0]?.id as string;
    const nedId = rowsFor(ned.pk)[0]?.id as string;
    const liaCode = (await approve(max, liaId)).body?.invite?.code as string;
    const nedCode = (await approve(mia, nedId)).body?.invite?.code as string;
    const liaJoins = await redeem(liaCode, lia);
    const nedJoins = await redeem(nedCode, ned);
    assert(liaJoins.status === 200 && nedJoins.status === 200 && knockById(liaId)?.avatar?.startsWith('data:image/') && !!knockById(nedId)?.from_node,
        'Lia and Ned knocked (with a photo and where they came from), were approved and joined');
    // A standby's copy from before the re-keys: both knocks, with what they wrote, on the old keys.
    const beforeRekeys: any = await exportSyncState(nodeId);
    assert(reKey(lia, liaNew) && reKey(ned, nedNew), 'both lose their phones and are re-keyed');
    const liaDeleted = purgeMemberSelf(liaNew.pk);
    adminPruneUser(nedNew.pk, 'owner:password');
    const wiped = (r: any, pk: string) => r?.pubkey === pk && r?.callsign === 'Deleted Member' && r?.message === '' && r?.avatar === null && r?.from_node === null;
    const theirWords = () => (db.prepare(`SELECT COUNT(*) AS n FROM join_requests
        WHERE pubkey IN (?, ?) OR callsign IN ('Lia', 'Ned') OR message LIKE '%Smith St%' OR message LIKE '%Jones Rd%'`).get(lia.pk, ned.pk) as { n: number }).n;
    assert(liaDeleted.ok && wiped(knockById(liaId), liaNew.pk), 'Lia deletes her account after the re-key: what she wrote when she knocked is gone');
    assert(wiped(knockById(nedId), nedNew.pk), 'Ned is removed after the re-key: what he wrote is gone');
    assert(knockById(liaId)?.status === 'approved' && knockById(liaId)?.invite_code === liaCode && knockById(nedId)?.invite_code === nedCode,
        'the records stay');
    assert(theirWords() === 0, 'no knock is left on the old keys, and their words are nowhere');
    const afterRemoval: any = await exportSyncState(nodeId);
    await becomeCopyOf(afterRemoval);
    assert(wiped(knockById(liaId), liaNew.pk) && wiped(knockById(nedId), nedNew.pk) && theirWords() === 0,
        'a standby set up after it has none of it');
    await becomeCopyOf(beforeRekeys);
    assert(knockById(liaId)?.message === 'Lia here, 12 Smith St', 'a standby that holds the copy from before has her words');
    const scrubMerge = mergeReplicatedKnocks(afterRemoval.joinRequests);
    assert(wiped(knockById(liaId), liaNew.pk) && wiped(knockById(nedId), nedNew.pk) && theirWords() === 0 && scrubMerge.invalid === 0,
        `and the next copy's knocks take them away there: the move and the scrub are stamped, so they travel (${JSON.stringify(scrubMerge)})`);
    await becomeCopyOf(afterRemoval);

    // The approver re-keys before the applicant redeems; later the applicant re-keys too. A standby set up after each
    // still makes the invite, so after a take-over the applicant still reads approved.
    freshAddress();
    const ola = newId('Ola');
    const olaNew = newId('OlaNew');
    const pam = newId('Pam');
    const pamNew = newId('PamNew');
    makeMember(pam, mia.pk);
    await knock(ola);
    const olaId = rowsFor(ola.pk)[0]?.id as string;
    const olaCode = (await approve(pam, olaId)).body?.invite?.code as string;
    assert(typeof olaCode === 'string' && reKey(pam, pamNew), 'Pam approves Ola, then loses her phone and is re-keyed');
    assert(knockById(olaId)?.decided_by === pamNew.pk, 'the approval now names Pam\'s new key');
    await becomeCopyOf(await exportSyncState(nodeId), [olaCode]);
    const olaInvite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(olaCode) as any;
    assert(olaInvite?.created_by === pamNew.pk && olaInvite?.intended_for === ola.pk && !olaInvite?.used_by,
        'a standby set up after the re-key makes the invite again, by Pam\'s new key, for Ola');
    const olaTakeover = await status(ola);
    assert(olaTakeover.body?.status === 'approved' && olaTakeover.body?.invite === olaCode,
        `after a take-over Ola's status still reads approved (${olaTakeover.text})`);
    const olaJoins = await redeem(olaCode, ola);
    assert(olaJoins.status === 200 && memberRow(ola.pk)?.invited_by === pamNew.pk, `and the invite admits her, invited by Pam's new key (${olaJoins.status})`);
    assert(reKey(ola, olaNew), 'then Ola loses her phone and is re-keyed');
    await becomeCopyOf(await exportSyncState(nodeId), [olaCode]);
    const olaRow = knockById(olaId);
    const olaInviteAgain = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(olaCode) as any;
    assert(olaRow?.pubkey === olaNew.pk && olaRow?.decided_by === pamNew.pk && rowsFor(ola.pk).length === 0
        && olaInviteAgain?.created_by === pamNew.pk && olaInviteAgain?.intended_for === olaNew.pk,
        'a standby set up after both re-keys has the knock on Ola\'s new key, decided by Pam\'s, and makes the invite for her new key');
    const olaNewStatus = await status(olaNew);
    assert(olaNewStatus.body?.status === 'approved' && olaNewStatus.body?.invite === olaCode, `her new key reads approved there (${olaNewStatus.text})`);
    const olaOldRedeem = await redeem(olaCode, ola);
    assert(olaOldRedeem.status === 400 && !memberRow(ola.pk), `and her old key can't use the invite (${olaOldRedeem.status})`);

    // The second lock: a knock on a key a re-key replaced, however it got there (the move leaves none; a node that ran
    // the code before it has them), is refused at every step, and its invite admits nobody.
    const staleId = crypto.randomUUID();
    db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, updated_at) VALUES (?, ?, 'Rekeyed', 'An old knock', 'pending', ?, ?)`)
        .run(staleId, rekeyed.pk, ago(60_000), ago(60_000));
    const staleList = await list(mia);
    assert(staleList.status === 200 && !staleList.body?.knocks?.some((k: any) => k.id === staleId), 'a replaced key\'s knock is not on the members\' list');
    const staleCount = await admin('GET', '/api/local/admin/knocks');
    assert(staleCount.body?.open === staleList.body?.total, `nor in the operator's count (${staleCount.body?.open})`);
    const staleApprove = await approve(mia, staleId);
    assert(staleApprove.status === 409 && staleApprove.body?.code === 'key_invalidated' && !staleApprove.body?.invite,
        `approving it → 409 key_invalidated (${staleApprove.status} ${staleApprove.body?.code})`);
    const staleDecline = await decline(mia, staleId);
    assert(staleDecline.status === 409 && staleDecline.body?.code === 'key_invalidated', `declining it → 409 key_invalidated (${staleDecline.status} ${staleDecline.body?.code})`);
    const staleCodes = () => (db.prepare('SELECT code FROM invite_codes WHERE intended_for = ?').all(rekeyed.pk) as any[]).map((r) => r.code as string);
    const staleMade = staleCodes();
    assert(knockById(staleId)?.status === 'pending' && staleMade.length === 0, 'nothing is written: still pending, and no invite for the old key');
    const staleStatus = await status(rekeyed);
    assert(staleStatus.status === 403 && staleStatus.body?.code === 'key_invalidated' && !/INV-/.test(staleStatus.text),
        `its status read → 403 key_invalidated (${staleStatus.status} ${staleStatus.text})`);
    // As a node before this fix would have it: approved, with an invite for the old key.
    const staleInvite = await call(mia, 'POST', '/api/invite/generate', { publicKey: mia.pk, intendedFor: rekeyed.pk });
    const staleCode = staleInvite.body?.invite?.code as string;
    setKnock(staleId, { status: 'approved', decided_by: mia.pk, decided_at: new Date().toISOString(), invite_code: staleCode });
    const staleApproved = await status(rekeyed);
    assert(staleApproved.status === 403 && !staleApproved.text.includes(staleCode), `approved, its status read still gives the old key nothing (${staleApproved.status})`);
    const staleRedeems = [staleCode, ...staleMade];
    for (const c of staleRedeems) {
        const r = await redeem(c, rekeyed);
        assert(r.status === 400 && /replaced/.test(r.body?.error ?? ''), `the old key redeeming that invite → refused (${r.status} ${r.body?.error})`);
    }
    const staleUsed = db.prepare('SELECT 1 FROM invite_codes WHERE code = ? AND used_by IS NOT NULL').get(staleCode);
    assert(!memberRow(rekeyed.pk) && !staleUsed, 'the old key is no member, and the invite is not used');
    const staleKnock = await knock(rekeyed);
    assert(staleKnock.status === 403 && staleKnock.body?.code === 'key_invalidated', 'and it can\'t knock again (403 key_invalidated)');

    console.log('\n── 15. what no member will read again leaves the disk ──');
    /** A new day for the whole node: every knock so far moves two days back, so none counts as made in the last 24 hours. */
    const newDay = () => {
        for (const r of db.prepare('SELECT id, created_at FROM join_requests').all() as { id: string; created_at: string }[]) {
            setKnock(r.id, { created_at: new Date(Date.parse(r.created_at) - 2 * DAY_MS).toISOString() });
        }
    };
    newDay();
    // The knocks the sections above left behind get their tidy-up first, so the counts below are this section's own.
    const settled = tidy();
    console.log(`  (the knocks left by the sections above: ${JSON.stringify(settled)})`);
    // Six applicants, each sending a name, a message with an address in it, a photo and the node they came from.
    const nia = newId('Nia');   // declined
    const oto = newId('Oto');   // lapses
    const pia = newId('Pia');   // approved, not redeemed yet
    const rex = newId('Rex');   // approved, and joins
    const sol = newId('Sol');   // still waiting
    const tam = newId('Tam');   // joins through an ordinary invite while the knock waits
    const tidied = [nia, oto, pia, rex, tam];
    const idOf = new Map<string, string>();
    for (const group of [[nia, oto, pia], [rex, sol, tam]]) {
        freshAddress();
        for (const a of group) {
            const r = await knock(a, { message: `${a.name} here, 1 Tidy Lane`, avatar: jpegWithXmp(a.name) });
            idOf.set(a.pk, rowsFor(a.pk)[0]?.id);
            assert(r.status === 201 && rowsFor(a.pk)[0]?.avatar?.startsWith('data:image/'), `${a.name} knocks, with a photo (${r.status})`);
        }
    }
    freshAddress();
    /** Whose knock, of the six, still holds anything they sent, and whose words are anywhere in the table. */
    const tidyWords = () => (db.prepare(`SELECT DISTINCT pubkey FROM join_requests WHERE message LIKE '%Tidy Lane%'
            OR (pubkey IN (${[...idOf.keys()].map(() => '?').join(', ')}) AND (callsign != '' OR avatar IS NOT NULL OR from_node IS NOT NULL))`)
        .all(...idOf.keys()) as { pubkey: string }[]).map((r) => r.pubkey);
    assert((await decline(mia, idOf.get(nia.pk)!)).status === 200, 'Mia declines Nia');
    setKnock(idOf.get(oto.pk)!, { created_at: ago(31 * DAY_MS) });
    const piaCode = (await approve(max, idOf.get(pia.pk)!)).body?.invite?.code as string;
    const rexCode = (await approve(mia, idOf.get(rex.pk)!)).body?.invite?.code as string;
    const rexJoins = await redeem(rexCode, rex);
    const tamInvite = (await call(max, 'POST', '/api/invite/generate', { publicKey: max.pk })).body?.invite?.code as string;
    const tamJoins = await redeem(tamInvite, tam);
    assert(!!piaCode && rexJoins.status === 200 && tamJoins.status === 200 && tidyWords().length === 6,
        'Oto\'s knock lapses, Pia and Rex are approved, Rex and Tam join; all six rows still hold what they sent');
    const beforeTidy: any = await exportSyncState(nodeId);

    const firstTidy = tidy();
    assert(firstTidy.cleared === 5 && firstTidy.deleted === 0, `the tidy-up clears five knocks and deletes none of them yet (${JSON.stringify(firstTidy)})`);
    const niaRow = knockById(idOf.get(nia.pk)!);
    assert(blank(niaRow) && niaRow?.status === 'declined' && niaRow?.decided_by === null && typeof niaRow?.decided_at === 'string',
        'the declined knock: no name, message, photo or node left, nor who declined it; still declined, and when');
    assert(blank(knockById(idOf.get(oto.pk)!)) && knockById(idOf.get(oto.pk)!)?.status === 'pending', 'the lapsed knock: nothing of it left');
    const piaRow = knockById(idOf.get(pia.pk)!);
    assert(blank(piaRow) && piaRow?.status === 'approved' && piaRow?.invite_code === piaCode && piaRow?.decided_by === max.pk,
        'the approved knock: nothing of it left, the invite and who made it kept');
    assert(blank(knockById(idOf.get(rex.pk)!)) && blank(knockById(idOf.get(tam.pk)!)), 'the knocks of the two who joined: nothing left');
    const solRow = knockById(idOf.get(sol.pk)!);
    const solListed = (await list(mia)).body?.knocks?.find((k: any) => k.pubkey === sol.pk);
    assert(solRow?.message === 'Sol here, 1 Tidy Lane' && solRow?.callsign === 'Sol' && solListed?.avatar === solRow?.avatar && solRow?.avatar?.startsWith('data:image/'),
        'the open knock keeps everything, and the members\' list still shows it with the photo');
    assert(JSON.stringify(tidyWords()) === JSON.stringify([sol.pk]), 'the words "Tidy Lane" and the photos are nowhere else in the table');
    assert(sameAnswer(await knock(nia), bobDupe) && sameAnswer(await status(nia), bobPending),
        'Nia, in her 30 days: a knock gets exactly a duplicate\'s answer, and her status is exactly a waiting knock\'s');
    const otoLate = await approve(mia, idOf.get(oto.pk)!);
    assert(otoLate.status === 409 && otoLate.body?.code === 'lapsed' && (await status(oto)).body?.status === 'none', 'a late answer to Oto\'s still reads lapsed, and his status none');
    const piaStatus = await status(pia);
    assert(piaStatus.body?.status === 'approved' && piaStatus.body?.invite === piaCode, `Pia's status still has her invite (${piaStatus.text})`);
    const piaByEve = await redeem(piaCode, eve);
    assert(piaByEve.status === 400 && /someone else/.test(piaByEve.body?.error ?? '') && !memberRow(eve.pk), 'and it still admits only her key');
    const secondTidy = tidy();
    assert(secondTidy.cleared === 0 && secondTidy.deleted === 0, `a second tidy-up changes nothing (${JSON.stringify(secondTidy)})`);

    // A standby holding the copy from before the tidy-up takes the clearing from the next copy.
    const afterTidy: any = await exportSyncState(nodeId);
    await becomeCopyOf(beforeTidy, [piaCode, rexCode]);
    assert(knockById(idOf.get(nia.pk)!)?.message === 'Nia here, 1 Tidy Lane' && tidyWords().length === 6, 'a standby with the copy from before the tidy-up has their words');
    setNodeRole('backup');
    await importRemoteState(afterTidy);
    setNodeRole('primary');
    assert(tidied.every((a) => blank(knockById(idOf.get(a.pk)!))) && JSON.stringify(tidyWords()) === JSON.stringify([sol.pk]),
        'the next copy clears them there too: the tidy-up stamps what it clears, so it travels');
    assert(knockById(idOf.get(pia.pk)!)?.invite_code === piaCode && !!db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(piaCode),
        'the standby still has the approval, and makes its invite');

    // A declined knock stays while its block runs, and every row goes once past each of its windows.
    setKnock(idOf.get(nia.pk)!, { decided_at: ago(29 * DAY_MS) });
    const blockTidy = tidy();
    assert(blockTidy.deleted === 0 && !!knockById(idOf.get(nia.pk)!) && sameAnswer(await knock(nia), bobDupe) && sameAnswer(await status(nia), bobPending),
        '29 days after the decline the row stays, and still blocks her the same way');
    setKnock(idOf.get(nia.pk)!, { decided_at: ago(31 * DAY_MS), created_at: ago(35 * DAY_MS) });
    setKnock(idOf.get(oto.pk)!, { created_at: ago(61 * DAY_MS) });
    setKnock(idOf.get(tam.pk)!, { created_at: ago(61 * DAY_MS) });
    for (const [a, c] of [[pia, piaCode], [rex, rexCode]] as const) {
        setKnock(idOf.get(a.pk)!, { decided_at: ago(31 * DAY_MS), created_at: ago(32 * DAY_MS) });
        db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(ago(31 * DAY_MS), c);
    }
    const beforeDelete: any = await exportSyncState(nodeId);
    const deleteTidy = tidy();
    const doomedIds = tidied.map((a) => idOf.get(a.pk)!);
    const tombstoned = new Set((db.prepare("SELECT row_key FROM tombstones WHERE table_name = 'join_requests'").all() as { row_key: string }[]).map((r) => r.row_key));
    assert(deleteTidy.deleted === 5 && doomedIds.every((id) => !knockById(id)) && doomedIds.every((id) => tombstoned.has(id)),
        `past their windows (31 days after the decline, 30 after the lapse, the invite's 30 days over, used or not) all five rows are deleted, each with a tombstone (${JSON.stringify(deleteTidy)})`);
    assert(!!knockById(idOf.get(sol.pk)!) && !!knockById(idOf.get(sol.pk)!)?.avatar, 'the open knock is still there, whole');
    assert((await status(nia)).body?.status === 'none' && (await status(pia)).body?.status === 'none', 'Nia\'s and Pia\'s status is none');
    const piaExpired = await redeem(piaCode, pia);
    assert(piaExpired.status === 400 && /expired/.test(piaExpired.body?.error ?? '') && !memberRow(pia.pk), `Pia's invite admits nobody: it has expired (${piaExpired.body?.error})`);
    const rexAgain = await knock(rex);
    assert(rexAgain.status === 409 && rexAgain.body?.code === 'already_member', 'Rex is a member: he can\'t knock');
    const niaAgain = await knock(nia);
    assert(niaAgain.status === 201 && rowsFor(nia.pk).length === 1 && rowsFor(nia.pk)[0].id !== idOf.get(nia.pk), `Nia may ask again: a new row (${niaAgain.status})`);
    freshAddress();

    // On a standby: the next copy's tombstones delete them, and neither a stale copy nor a full snapshot brings them back.
    const afterDelete: any = await exportSyncState(nodeId);
    await becomeCopyOf(beforeDelete, [piaCode, rexCode]);
    assert(doomedIds.every((id) => !!knockById(id)), 'a standby with the copy from before has the five rows');
    setNodeRole('backup');
    await importRemoteState(afterDelete);
    setNodeRole('primary');
    assert(doomedIds.every((id) => !knockById(id)) && !!knockById(idOf.get(sol.pk)!), 'the next copy deletes them there too; the open knock stays');
    const staleMerge = mergeReplicatedKnocks(beforeDelete.joinRequests);
    assert(doomedIds.every((id) => !knockById(id)), `a stale copy that still carries them doesn't bring them back (${JSON.stringify(staleMerge)})`);
    setNodeRole('backup');
    await importRemoteState(beforeDelete);
    setNodeRole('primary');
    assert(doomedIds.every((id) => !knockById(id)), 'nor does that stale copy as a whole import');
    await becomeCopyOf(afterDelete);
    assert(doomedIds.every((id) => !knockById(id)) && !!knockById(idOf.get(sol.pk)!) && rowsFor(nia.pk).length === 1,
        'a standby built fresh from a full snapshot has none of them, and has the rest');

    // The timer: on the main server it tidies by itself; a standby leaves it to the main server's copy.
    const uma = newId('Uma');
    await knock(uma, { message: 'Uma here, 1 Tidy Lane' });
    const umaId = rowsFor(uma.pk)[0]?.id as string;
    await decline(max, umaId);
    tidyEvery(20);
    setNodeRole('backup');
    await sleep(150);
    const umaOnStandby = knockById(umaId);
    setNodeRole('primary');
    await sleep(150);
    tidyEvery(DAY_MS);
    assert(umaOnStandby?.message === 'Uma here, 1 Tidy Lane' && blank(knockById(umaId)),
        'the timer clears a declined knock on the main server, and a standby\'s timer touches nothing');
    freshAddress();

    console.log('\n── 16. node-wide ceilings ──');
    newDay();
    const madeToday = () => (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE created_at >= ?').get(ago(DAY_MS)) as { n: number }).n;
    const listedNow = async () => (await list(mia)).body?.total as number;
    let lastAddress = 0;
    /** A knock from an address nobody has knocked from (the tunnel's header names it; loopback is a trusted proxy). */
    const knockFromNew = (id: Id) => call(id, 'POST', '/api/join/knock', { callsign: id.name, message: `Hello from ${id.name}.` },
        { headers: { 'CF-Connecting-IP': `198.51.${100 + Math.floor(++lastAddress / 250)}.${lastAddress % 250 + 1}` } });
    const open0 = await listedNow();
    assert(madeToday() === 0 && open0 + 30 < 50, `a fresh day: nothing made in 24 hours, ${open0} open`);
    const flood: Id[] = [];
    let taken = 0;
    for (let i = 0; i < 30; i++) {
        const f = newId(`Flood${i}`);
        flood.push(f);
        if ((await knockFromNew(f)).status === 201) taken++;
    }
    assert(taken === 30 && madeToday() === 30, `30 knocks in a day from 30 addresses and 30 keys are taken (${taken})`);
    const thirtyFirstKey = newId('Flood30');
    const thirtyFirst = await knockFromNew(thirtyFirstKey);
    assert(sameAnswer(thirtyFirst, fourth), `the 31st in 24 hours, from a new address and a new key → the per-address limit's own 429 (${thirtyFirst.status} ${thirtyFirst.text})`);
    assert(rowsFor(thirtyFirstKey.pk).length === 0 && madeToday() === 30, 'and no row');
    // A lapsed knock reopened is a new knock.
    const bobKnockId = rowsFor(bob.pk)[0]?.id as string;
    setKnock(bobKnockId, { created_at: ago(31 * DAY_MS) });
    const bobReopen = await knockFromNew(bob);
    assert(sameAnswer(bobReopen, fourth) && Date.now() - Date.parse(rowsFor(bob.pk)[0]?.created_at) > 30 * DAY_MS,
        `reopening a lapsed knock is a new knock: refused too, and the row stays lapsed (${bobReopen.status})`);

    // A day later the node takes knocks again, until 50 are open.
    for (const f of flood) setKnock(rowsFor(f.pk)[0]?.id, { created_at: ago(DAY_MS + 60 * 60_000) });
    assert(madeToday() === 0, 'a day on, none of the 30 counts');
    const nextDay = await knockFromNew(thirtyFirstKey);
    assert(nextDay.status === 201, `the next knock is taken (${nextDay.status})`);
    const bobReopened = await knockFromNew(bob);
    assert(bobReopened.status === 201 && rowsFor(bob.pk).length === 1 && rowsFor(bob.pk)[0].id === bobKnockId && madeToday() === 2,
        `Bob's lapsed knock reopens, and counts as a knock made today (${bobReopened.status}, ${madeToday()} today)`);
    const crowd: Id[] = [];
    while ((await listedNow()) < 50) {
        const c = newId(`Crowd${crowd.length}`);
        crowd.push(c);
        const r = await knockFromNew(c);
        if (r.status !== 201 || crowd.length > 50) break;
    }
    assert((await listedNow()) === 50 && madeToday() < 30, `50 knocks are open (${madeToday()} made today, under 30)`);
    const fiftyFirstKey = newId('Crowded');
    const fiftyFirst = await knockFromNew(fiftyFirstKey);
    assert(sameAnswer(fiftyFirst, fourth) && rowsFor(fiftyFirstKey.pk).length === 0 && (await listedNow()) === 50,
        `the 51st open knock → the same 429, and no row (${fiftyFirst.status} ${fiftyFirst.text})`);
    assert((await decline(mia, rowsFor(flood[0].pk)[0]?.id)).status === 200 && (await listedNow()) === 49, 'a member declines one: 49 open');
    const intoSlot = await knockFromNew(fiftyFirstKey);
    assert(intoSlot.status === 201 && (await listedNow()) === 50, `and the slot it freed is taken (${intoSlot.status})`);
    const overAgain = await knockFromNew(newId('Crowded2'));
    assert(sameAnswer(overAgain, fourth), 'full again: 429');
    assert((await approve(max, rowsFor(flood[1].pk)[0]?.id)).status === 200 && (await listedNow()) === 49, 'a member approves one: 49 open');
    const intoSlot2 = await knockFromNew(newId('Crowded3'));
    assert(intoSlot2.status === 201, `and that slot is taken too (${intoSlot2.status})`);

    console.log('\n── 17. a key a re-key replaced gets nothing from any invite ──');
    // The reviewer's reproduction: Olga is re-keyed K1 → K2, Mia makes an ordinary invite, and K1 redeems it.
    const olga = newId('Olga');
    const olgaNew = newId('OlgaNew');
    makeMember(olga, mia.pk);
    assert(reKey(olga, olgaNew), 'Olga loses her phone and is re-keyed');
    const ordinaryCode = (await call(mia, 'POST', '/api/invite/generate', { publicKey: mia.pk })).body?.invite?.code as string;
    const usedBy = (c: string) => (db.prepare('SELECT used_by FROM invite_codes WHERE code = ? COLLATE NOCASE').get(c) as any)?.used_by ?? null;
    const k1Redeem = await redeem(ordinaryCode, olga);
    assert(k1Redeem.status === 400 && /replaced/.test(k1Redeem.body?.error ?? ''), `her old key redeeming Mia's ordinary invite → refused (${k1Redeem.status} ${k1Redeem.body?.error})`);
    assert(!memberRow(olga.pk) && usedBy(ordinaryCode) === null, 'no member row for the old key, and the invite is not used');
    // A paper invite: an offline ticket Mia signed.
    const ticketPayload = JSON.stringify({ i: mia.pk, t: Date.now() });
    const ticket = Buffer.from(JSON.stringify({ p: ticketPayload, s: crypto.sign(null, Buffer.from(ticketPayload), mia.priv).toString('base64') })).toString('base64');
    const redeemTicket = (id: Id) => call(null, 'POST', '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: id.pk, callsign: id.name });
    const k1Ticket = await redeemTicket(olga);
    assert(k1Ticket.status === 400 && /replaced/.test(k1Ticket.body?.error ?? ''), `her old key redeeming Mia's offline ticket → refused (${k1Ticket.status} ${k1Ticket.body?.error})`);
    assert(!memberRow(olga.pk), 'still no member row for the old key');
    const k1Mint = await call(olga, 'POST', '/api/invite/generate', { publicKey: olga.pk });
    assert(k1Mint.status === 403 && !k1Mint.body?.invite, `and the old key can make no invite (${k1Mint.status})`);
    const k2Redeem = await redeem(ordinaryCode, olgaNew);
    assert(k2Redeem.status === 200 && k2Redeem.body?.alreadyMember === true, `her new key is a member as before (${k2Redeem.status})`);
    const k2Mint = await call(olgaNew, 'POST', '/api/invite/generate', { publicKey: olgaNew.pk });
    assert(k2Mint.status === 200 && typeof k2Mint.body?.invite?.code === 'string', `and makes invites as before (${k2Mint.status})`);
    const quinn = newId('Quinn');
    const rosa = newId('Rosa');
    const quinnJoins = await redeem(ordinaryCode, quinn);
    const rosaJoins = await redeemTicket(rosa);
    assert(quinnJoins.status === 200 && memberRow(quinn.pk)?.status === 'active' && usedBy(ordinaryCode) === quinn.pk,
        `a newcomer joins with the ordinary invite (${quinnJoins.status})`);
    assert(rosaJoins.status === 200 && memberRow(rosa.pk)?.status === 'active', `and another with the offline ticket (${rosaJoins.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        console.error(`❌ ${run - passed} check(s) failed`);
        process.exit(1);
    }
    console.log('⭐️ Knock checks PASSED.');
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ test-knock crashed:', e);
    process.exit(1);
});
