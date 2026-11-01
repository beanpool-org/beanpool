/**
 * Message requests clear themselves (R1: scratch/fable-design/DESIGN-reaching-across-fable.md "Decided for R1";
 * engine/request-limits.ts). Over REAL HTTPS through the real signature middleware, on the global profile, every line sealed
 * and signed on the member's side as the apps do it:
 *
 *   1. 3 different recipients report anything: nothing at 2, cleared at 3, for the waiting list of everyone it waits for
 *   2. 2 different recipients report the same wording: folded, so spacing and punctuation don't save it; never on a short line;
 *      different words don't add up
 *   3. 1 report for a 12-words newcomer on probation; a sign-in member isn't one
 *   4. one person's accounts count once, on either way: an invite tree, and a door's joins from one connection
 *   5. what a limit stops: an open and a line that would be a request, in words, the same whether or not they are blocked.
 *      What it leaves: answering someone who wrote first, an accepted chat, posting, their status
 *   6. a repeat lasts longer; reports from before the end don't count again; what was cleared stays cleared once it ends
 *   7. the moderators see it and undo it, and a moderator can't undo their own: requests back, new ones allowed, reports from
 *      before no longer count, the reports still in the queue. A dismissed report doesn't count
 *   8. a moderator's pause and mute clear them too, and lifting brings them back
 *   9. a report that counts for nothing: a non-recipient, an accepted chat, an open nobody wrote in, a post. A recipient's report
 *      of the person, with no line, counts
 *  10. the switch: where autoHideReports is off, reports clear nothing
 *  11. a standby copy carries the limit and the report's mark
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-request-limits node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost as rawCreatePost, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { setMemberPhoto } from '@beanpool/engine';
import { dmLineDisclosureFor, dmPublicKeyOf, newDmMessageId, sealDmLine, signDmLine } from '@beanpool/core';
import { REQUEST_LIMIT, requestLimitOf, requestReportsReach, wordingOf } from './engine/request-limits.js';
import { independentCircles } from './engine/auto-moderation.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
    const u = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return realFetch(url, init);
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as any;
};

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let BASE = '';
interface Id { pk: string; seedHex: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}
let owner: Id;
let names = 0;
/** A member here for two months, off probation, invited by the owner: a role ends a trace, so each is their own circle. */
function member(name: string, opts: { invitedBy?: Id; daysAgo?: number; settled?: boolean } = {}): Id {
    const id = newId(`${name}${++names}`);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, id.name, ago((opts.daysAgo ?? 60) * DAY), (opts.invitedBy ?? owner).pk);
    setMemberPhoto(db, id.pk, `https://example.org/${id.name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    if (opts.settled !== false) for (let i = 0; i < 3; i++) createPost('offer', 'other', `${id.name} kept ${i}`, 'An old offer', 0, 'fixed', id.pk);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', signer: Id | null, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...extra };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

const opened = (a: Id, b: Id) => call('POST', a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
async function open(a: Id, b: Id): Promise<string> {
    const r = await opened(a, b);
    if (!r.body?.conversation?.id) throw new Error(`setup: no conversation (${show(r)})`);
    return r.body.conversation.id;
}
interface Line { id: string; conversationId: string; ciphertext: string; nonce: string; metadata: string | undefined; text: string }
function sealed(from: Id, to: Id, conversationId: string, text: string): Line {
    const id = newDmMessageId();
    const seal = sealDmLine(text, { myEdPrivHex: from.seedHex, peerEdPubHex: to.pk, conversationId }, { senderPubHex: from.pk, messageId: id });
    const lineSig = signDmLine(seal, from.seedHex, { conversationId, senderPubHex: from.pk, recipientPubHex: to.pk, messageId: id, at: new Date().toISOString() });
    return { id, conversationId, ...seal, metadata: JSON.stringify({ lineSig }), text };
}
const sent = (from: Id, line: Line) => call('POST', from, '/api/messages/send', { id: line.id, conversationId: line.conversationId, authorPubkey: from.pk, ciphertext: line.ciphertext, nonce: line.nonce, metadata: line.metadata });
/** `from` writes a request to `to`: their line, signed. */
async function request(from: Id, to: Id, text: string): Promise<Line> {
    const line = sealed(from, to, await open(from, to), text);
    const r = await sent(from, line);
    if (r.status !== 200) throw new Error(`setup: ${from.name}'s line was not sent (${show(r)})`);
    return line;
}
const report = (who: Id, l: Line) => call('POST', who, '/api/messages/report', {
    messageId: l.id, reason: 'Spam', disclosure: dmLineDisclosureFor({ ciphertext: l.ciphertext, nonce: l.nonce, conversationId: l.conversationId, metadata: l.metadata }, l.text),
});
const waitingFor = async (id: Id): Promise<string[]> => ((await call('GET', id, `/api/messages/conversations/${id.pk}`)).body?.requests?.conversations ?? []).map((c: any) => c.id);
const limited = (id: Id) => requestLimitOf(id.pk) !== null;
const LONG = 'Earn five hundred Beans a day from your own home with this one simple trick';

/** Each writes to `recipients`, each reporting a different line. */
async function reportedBy(sender: Id, recipients: Id[]): Promise<Line[]> {
    const lines: Line[] = [];
    for (const r of recipients) {
        const line = await request(sender, r, `Words only ${r.name} got, ${crypto.randomUUID()}`);
        lines.push(line);
        const filed = await report(r, line);
        if (filed.status !== 200) throw new Error(`setup: ${r.name}'s report was refused (${show(filed)})`);
    }
    return lines;
}

async function main(): Promise<void> {
    console.log('R1: message requests clear themselves\n');
    await initTls();
    initStateEngine();
    const p2p = await startP2P(0, 0);
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4099/p2p/${p2p.peerId.toString()}`);
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const admin = ownerTokenHeaders('admin');

    console.log('── 1. three different recipients, anything ──');
    {
        const sam = member('Sam');
        const [a, b, c, d] = [member('A'), member('B'), member('C'), member('D')];
        const toD = await request(sam, d, 'Hello, I saw your offer of a bicycle');
        const lines = await reportedBy(sam, [a, b]);
        assert(!limited(sam) && (await waitingFor(d)).includes(toD.conversationId), 'two reports clear nothing: the request still waits for someone else');
        await reportedBy(sam, [c]);
        assert(limited(sam), 'the third clears them');
        assert(!(await waitingFor(d)).includes(toD.conversationId), 'and the request waiting for someone who reported nothing leaves their list');
        assert((await call('GET', d, `/api/messages/conversations/${d.pk}`)).body?.requests?.count === 0, 'it is not counted either');
        assert(!(await waitingFor(a)).includes(lines[0].conversationId), 'nor is it in a reporter\'s list');
        assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(sam.pk) as any).status === 'active', 'it is not a pause: their status is unchanged');
        const days = (Date.parse(requestLimitOf(sam.pk)!.until) - Date.now()) / DAY;
        assert(days > 6.9 && days <= 7, `for 7 days (${days.toFixed(2)})`);
        const told = db.prepare('SELECT title, body FROM moderation_notices WHERE recipient = ?').all(sam.pk) as { title: string; body: string }[];
        assert(told.some(n => /message requests/.test(n.title) && /answer people who wrote to you, and post/.test(n.body)), `they are told in words (${told[0]?.body})`);
        assert(!told.some(n => [a, b, c].some(r => n.body.includes(r.name))), 'never who reported them');
    }

    console.log('\n── 2. two different recipients, the same wording ──');
    {
        const sam = member('Sam');
        const [a, b] = [member('A'), member('B')];
        await report(a, await request(sam, a, LONG));
        assert(!limited(sam), 'one report of a long line clears nothing');
        await report(b, await request(sam, b, `  ${LONG.toUpperCase().replace(/ /g, '   ')}!!! 🤑`));
        assert(limited(sam) && requestLimitOf(sam.pk)!.how === 'same_wording', 'the second clears them, whatever its case, spacing, punctuation or emoji');
    }
    {
        const sam = member('Sam');
        const short = 'Hi, is this still available?';
        assert(wordingOf(short) === null, `a short line has no wording to compare (${short.length} characters)`);
        assert(wordingOf('x'.repeat(REQUEST_LIMIT.sameWordingMinChars - 1) + '!!!!!') === null && wordingOf('x'.repeat(REQUEST_LIMIT.sameWordingMinChars)) !== null,
            'and padding with punctuation doesn\'t lengthen one: 40 letters or digits');
        const [a, b] = [member('A'), member('B')];
        await report(a, await request(sam, a, short));
        await report(b, await request(sam, b, short));
        assert(!limited(sam), 'two reports of the same short line clear nothing');
        const c = member('C');
        await report(c, await request(sam, c, short));
        assert(limited(sam) && requestLimitOf(sam.pk)!.how === 'many_reports', 'and they still count towards the three');
    }
    {
        const sam = member('Sam');
        const [a, b] = [member('A'), member('B')];
        await report(a, await request(sam, a, LONG));
        await report(b, await request(sam, b, `${LONG} and then some more`));
        assert(!limited(sam), 'two long lines with different words clear nothing');
    }

    console.log('\n── 3. a 12-words newcomer on probation ──');
    {
        const wren = member('Wren', { daysAgo: 1, settled: false });
        db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, join_cohort) VALUES (?, 'words', ?, ?, NULL)`).run(wren.pk, `hash-${wren.pk}`, ago(DAY));
        const a = member('A');
        await report(a, await request(wren, a, 'Short and nasty'));
        assert(limited(wren) && requestLimitOf(wren.pk)!.how === 'words_newcomer', 'one report clears them');
        const signIn = member('Sid', { daysAgo: 1, settled: false });
        const b = member('B');
        await report(b, await request(signIn, b, 'Short and nasty'));
        assert(!limited(signIn), 'one report of a newcomer who signed in clears nothing');
    }

    console.log('\n── 4. one person\'s accounts count once ──');
    {
        const boss = member('Boss');
        const socks = [1, 2, 3, 4].map(() => member('Sock', { invitedBy: boss }));
        const sam = member('Sam');
        assert(independentCircles(socks.map(s => s.pk)).length === 1, 'four accounts from one invite tree are one circle');
        await reportedBy(sam, socks);
        assert(!limited(sam), 'so four reports from them clear nothing, on anything');
        const sam2 = member('Sam');
        for (const s of socks.slice(0, 2)) await report(s, await request(sam2, s, LONG));
        assert(!limited(sam2), 'nor on the same wording');
        const cohort = crypto.randomUUID();
        const door = [1, 2, 3].map(() => member('Door'));
        for (const d of door) db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, join_cohort) VALUES (?, 'google', ?, ?, ?)`).run(d.pk, `hash-${d.pk}`, ago(60 * DAY), cohort);
        const sam3 = member('Sam');
        await reportedBy(sam3, door);
        assert(!limited(sam3), 'nor three who joined from one connection within a day');
        const other = member('A');
        const sam4 = member('Sam');
        await reportedBy(sam4, [socks[0], door[0], other]);
        assert(limited(sam4), 'one of each and a stranger are three');
    }

    console.log('\n── 5. what a limit stops, and what it leaves ──');
    {
        const sam = member('Sam');
        const friend = member('Friend');
        const wroteFirst = member('Wrote');
        const accepted = member('Accepted');
        const blocker = member('Blocker');
        const unwritten = member('Unwritten');
        const conv = await open(wroteFirst, sam);
        await sent(wroteFirst, sealed(wroteFirst, sam, conv, 'Are you selling that bike?'));
        const acceptedLine = await request(sam, accepted, 'Would you like a lift on Saturday?');
        await call('POST', accepted, '/api/messages/request', { conversationId: acceptedLine.conversationId, decision: 'accept' });
        assert((await call('POST', friend, '/api/friends/add', { ownerPubkey: friend.pk, friendPubkey: sam.pk })).status === 200, 'a friend adds them');
        assert((await call('POST', blocker, '/api/blocks', { targetPubkey: sam.pk })).status === 200, 'someone blocks them');
        const noLine = await open(sam, unwritten);
        await reportedBy(sam, [member('A'), member('B'), member('C')]);
        assert(limited(sam), 'they are limited');

        const stranger = member('Stranger');
        const refused = await opened(sam, stranger);
        assert(refused.status === 403 && refused.body?.code === 'dm_requests_limited' && /can't send new ones until/.test(refused.body?.error ?? ''),
            `a chat that would be a request is refused in words (${show(refused)})`);
        assert(!db.prepare('SELECT 1 FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id WHERE p.public_key = ? AND c.created_by = ?').get(stranger.pk, sam.pk),
            'and nothing is written');
        const toBlocker = await opened(sam, blocker);
        assert(toBlocker.status === 403 && toBlocker.body?.error === refused.body?.error, 'the same answer from someone who blocked them');
        const line = await sent(sam, sealed(sam, unwritten, noLine, 'First line in a chat already open'));
        assert(line.status === 403 && line.body?.code === 'dm_requests_limited', `a line that would be a request is refused too (${show(line)})`);
        assert((await waitingFor(unwritten)).length === 0, 'and reaches nobody');

        assert((await sent(sam, sealed(sam, wroteFirst, conv, 'Yes, it is still here'))).status === 200, 'they can still answer someone who wrote to them');
        assert((await sent(sam, sealed(sam, accepted, acceptedLine.conversationId, 'Great, see you at nine'))).status === 200, 'and go on in an accepted chat');
        const toFriend = await opened(sam, friend);
        assert(toFriend.status === 200 && (await sent(sam, sealed(sam, friend, toFriend.body.conversation.id, 'Thanks for adding me'))).status === 200, 'and write to someone who added them');
        const posted = await call('POST', sam, '/api/marketplace/posts', { type: 'offer', category: 'other', title: 'A limited member\'s offer', description: 'Still allowed', credits: 0, authorPublicKey: sam.pk, photos: TEST_PHOTOS });
        assert(posted.status === 200, `and post (${show(posted)})`);
    }

    console.log('\n── 6. a repeat lasts longer ──');
    {
        const sam = member('Sam');
        const first = [member('A'), member('B'), member('C')];
        const clearedLines = await reportedBy(sam, first);
        // Eight days on: the limit has ended, and the reports that made it are from before it did.
        const lapse = () => {
            db.prepare(`UPDATE request_limits SET until = ?, made_at = ? WHERE sender_pubkey = ?`).run(ago(1000), ago(8 * DAY), sam.pk);
            db.prepare('UPDATE abuse_reports SET created_at = ? WHERE target_pubkey = ?').run(ago(8 * DAY), sam.pk);
        };
        const stillWaiting = member('D');
        const toD = await request(member('Sam'), stillWaiting, 'Someone else\'s line');
        // The request before the limit, in the past with it.
        db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id IN (SELECT value FROM json_each(?))').run(ago(9 * DAY), JSON.stringify(clearedLines.map(l => l.conversationId)));
        db.prepare('UPDATE messages SET timestamp = ? WHERE conversation_id IN (SELECT value FROM json_each(?))').run(ago(9 * DAY), JSON.stringify(clearedLines.map(l => l.conversationId)));
        lapse();
        assert(!limited(sam), 'it ends by itself');
        assert(requestReportsReach(sam.pk) === null, 'reports from before it ended no longer count');
        assert(!(await waitingFor(first[0])).includes(clearedLines[0].conversationId) && (await waitingFor(stillWaiting)).includes(toD.conversationId),
            'and what it cleared stays cleared');
        const fresh = member('E');
        const after = await request(sam, fresh, 'Hello again, a real question this time');
        assert((await waitingFor(fresh)).includes(after.conversationId), 'they can send a new request, and it reaches its person');
        await report(fresh, after);
        await reportedBy(sam, [member('F'), member('G')]);
        const days = (Date.parse(requestLimitOf(sam.pk)!.until) - Date.now()) / DAY;
        assert(days > 13.9 && days <= 14, `the second limit is 14 days (${days.toFixed(2)})`);
        for (let i = 0; i < 5; i++) {
            db.prepare(`INSERT INTO request_limits (id, sender_pubkey, made_at, until, how) VALUES (?, ?, ?, ?, 'many_reports')`).run(crypto.randomUUID(), sam.pk, ago(200 * DAY), ago(190 * DAY));
        }
        lapse();
        await reportedBy(sam, [member('H'), member('I'), member('J')]);
        const longest = (Date.parse(requestLimitOf(sam.pk)!.until) - Date.now()) / DAY;
        assert(longest > 89.9 && longest <= REQUEST_LIMIT.longestDays, `and it stops at 90 (${longest.toFixed(2)})`);
    }

    console.log('\n── 7. a moderator sees it and undoes it ──');
    {
        const sam = member('Sam');
        const d = member('D');
        const toD = await request(sam, d, 'Hello, I saw your offer of a bicycle');
        await reportedBy(sam, [member('A'), member('B'), member('C')]);
        const list = await call('GET', null, '/api/local/admin/members/request-limits', undefined, admin);
        const row = (list.body?.limits ?? []).find((l: any) => l.publicKey === sam.pk);
        assert(list.status === 200 && row?.callsign === sam.name && row?.how === 'many_reports' && !!row?.until, `the moderators see it (${JSON.stringify(row)})`);
        assert((await call('GET', member('Nosy'), '/api/local/admin/members/request-limits')).status >= 401, 'a member doesn\'t');
        const open3 = (await call('GET', null, '/api/local/admin/reports?status=open&limit=500', undefined, admin)).body?.pendingCount;
        const undo = await call('POST', null, `/api/local/admin/members/${sam.pk}/request-limit/undo`, {}, admin);
        assert(undo.status === 200 && !limited(sam), `a moderator undoes it (${show(undo)})`);
        assert((await waitingFor(d)).includes(toD.conversationId), 'the request comes back');
        const stranger = member('Stranger');
        assert((await opened(sam, stranger)).status === 200, 'they can send new ones');
        assert((await call('GET', null, '/api/local/admin/reports?status=open&limit=500', undefined, admin)).body?.pendingCount === open3, 'the reports stay in the queue, for a moderator to decide');
        assert(requestReportsReach(sam.pk) === null, 'and none of them counts again');
        const told = db.prepare('SELECT body FROM moderation_notices WHERE recipient = ? ORDER BY created_at DESC LIMIT 1').get(sam.pk) as { body: string };
        assert(/moderator looked at the reports/.test(told.body), `they are told (${told.body})`);
        assert((await call('POST', null, `/api/local/admin/members/${sam.pk}/request-limit/undo`, {}, admin)).status === 409, 'undoing what no limit holds answers 409');
        assert((await call('POST', null, `/api/local/admin/members/${'0'.repeat(64)}/request-limit/undo`, {}, admin)).status === 404, 'and someone who isn\'t here 404');
    }
    {
        const sam = member('Sam');
        const [a, b, c] = [member('A'), member('B'), member('C')];
        const l1 = await request(sam, a, 'Line one for a person who reports it');
        const filed = await report(a, l1);
        await call('POST', null, `/api/local/admin/reports/${filed.body.report.id}/dismiss`, {}, admin);
        await reportedBy(sam, [b, c]);
        assert(!limited(sam), 'a report a moderator dismissed doesn\'t count');
    }

    console.log('\n── 8. a moderator\'s pause or mute clears them too ──');
    {
        const sam = member('Sam');
        const d = member('D');
        const toD = await request(sam, d, 'Hello, I saw your offer of a bicycle');
        db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run('9999-12-31T23:59:59.999Z', sam.pk);
        assert(!(await waitingFor(d)).includes(toD.conversationId), 'a mute takes it out of the list');
        assert((await call('POST', null, `/api/local/admin/members/${sam.pk}/unmute`, {}, admin)).status === 200 && (await waitingFor(d)).includes(toD.conversationId), 'and lifting it brings it back');
        const paused = await call('POST', null, `/api/local/admin/users/${sam.pk}/suspend`, { reason: 'Sending the same message to everyone here' }, admin);
        assert(paused.status === 200 && !(await waitingFor(d)).includes(toD.conversationId), `a pause takes it out of the list (${show(paused)})`);
        const back = await call('POST', null, `/api/local/admin/users/${sam.pk}/status`, { status: 'active' }, admin);
        assert(back.status === 200 && (await waitingFor(d)).includes(toD.conversationId), `and lifting it brings it back (${show(back)})`);
    }

    console.log('\n── 9. only a person who received a request ──');
    {
        const sam = member('Sam');
        const [a, b, c] = [member('A'), member('B'), member('C')];
        // A chat a recipient opened: no request.
        const conv = await open(a, sam);
        await sent(a, sealed(a, sam, conv, 'Are you selling that bike?'));
        const inChat = sealed(sam, a, conv, 'Yes, come by on Saturday morning');
        await sent(sam, inChat);
        await report(a, inChat);
        // An accepted one.
        const accepted = await request(sam, b, 'Would you like a lift on Saturday?');
        await call('POST', b, '/api/messages/request', { conversationId: accepted.conversationId, decision: 'accept' });
        await report(b, accepted);
        // An open nobody wrote in, and a report of the person from their profile.
        await open(sam, c);
        await call('POST', c, '/api/reports', { reporterPubkey: c.pk, targetPubkey: sam.pk, reason: 'Spam' });
        // A report of a post of theirs.
        const d = member('D');
        const post = createPost('offer', 'other', 'Sam offer', 'An offer', 0, 'fixed', sam.pk)!;
        await call('POST', d, '/api/reports', { reporterPubkey: d.pk, targetPubkey: sam.pk, targetPostId: post.id, reason: 'Spam' });
        const counted = (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports WHERE target_pubkey = ? AND request_conversation_id IS NOT NULL').get(sam.pk) as any).c;
        const all = (db.prepare('SELECT COUNT(*) AS c FROM abuse_reports WHERE target_pubkey = ?').get(sam.pk) as any).c;
        assert(all === 4 && counted === 0 && !limited(sam), `four reports from people with no request from them count for nothing (${counted} of ${all})`);
    }
    {
        const sam = member('Sam');
        const [a, b, c] = [member('A'), member('B'), member('C')];
        await reportedBy(sam, [a, b]);
        const gone = await request(sam, c, 'A line its sender takes back straight away');
        await call('POST', sam, '/api/messages/delete', { messageId: gone.id });
        const person = await call('POST', c, '/api/reports', { reporterPubkey: c.pk, targetPubkey: sam.pk, reason: 'Spam' });
        assert(person.status === 200 && limited(sam), `a recipient's report of the person, the line deleted, counts (${show(person)})`);
    }

    console.log('\n── 10. the switch ──');
    {
        const sam = member('Sam');
        const [a, b, c] = [member('A'), member('B'), member('C')];
        const off = await call('POST', null, '/api/local/admin/community-shape', { changes: { autoHide: false } }, ownerSessionHeaders(owner.pk));
        assert(off.status === 200, `an owner turns automatic moderation off (${show(off)})`);
        const lines = await reportedBy(sam, [a, b, c]);
        assert(!limited(sam) && (await waitingFor(a)).includes(lines[0].conversationId), 'three reports then reach the moderators and clear nothing');
        const on = await call('POST', null, '/api/local/admin/community-shape', { changes: { autoHide: true } }, ownerSessionHeaders(owner.pk));
        assert(on.status === 200 && !limited(sam), `turned on again, nothing changes until a report (${show(on)})`);
    }

    console.log('\n── 11. a standby copy ──');
    {
        const state: any = await exportSyncState(p2p.peerId.toString());
        const limit = (state.plainTables?.request_limits ?? [])[0];
        assert(!!limit?.sender_pubkey && !!limit?.how, `the limit travels (${Object.keys(limit ?? {}).join(' ')})`);
        const marked = (state.abuseReports ?? []).find((r: any) => r.requestConversationId);
        assert(!!marked, 'and so does a report\'s mark');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
