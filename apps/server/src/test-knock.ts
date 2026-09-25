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
import { mergeReplicatedKnocks } from './engine/knocks.js';
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
    assert(byPruned.status === 403 && byPruned.body?.code === 'not_member', `a pruned member can't list (${byPruned.status} ${byPruned.body?.code})`);
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
