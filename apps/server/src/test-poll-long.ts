/**
 * Polls that run 30 or 90 days (Damo's ask, Marty's yes, 12 Nov 2026): over real HTTPS through the real middleware, for the
 * owner or admin who makes one, the member who may not, the maker who closes it and the member whose Decide card shows it.
 *
 * What it holds:
 *   1. The length by role. A member (and a moderator, who is a member here) chooses 3, 7 or 14 days; 30 and 90 are refused to
 *      them in plain words and nothing is stored. An admin and an owner choose 30 and 90 as well, and the poll closes that long
 *      after it began. A length in between (5, 31) is refused to everyone, and the words an admin gets name all five.
 *   2. The role is read now. An admin made a member again is refused a long poll; the long poll they started as admin runs on,
 *      and they may still close it.
 *   3. The door both apps use, POST /api/marketplace/posts, answers the same, and GET /api/node-admin/me (the picker's source)
 *      names an admin an admin and a member no one.
 *   4. Close now. Only the poll's maker closes it, by either route the apps use; another member, a moderator, an admin and
 *      an owner are refused in words and the poll stays open. Closing keeps the votes as cast and the poll reads as ended:
 *      no more votes, and closing again is no change.
 *   5. Decide. The card's first open poll is the soonest closing, except that a 30- or 90-day poll the signer has answered
 *      (an open vote's choice, or a sealed poll's mark) sits below every poll still waiting for their vote. A short poll they
 *      answered keeps its place, and a voted long poll that is alone is still the card's poll.
 *
 * An owner's assistant makes its polls through the same door: test-mcp-owner-polls.
 *
 * Local only: nothing leaves the box.
 *
 * Run: SERVER_SUITES_ONLY=test-poll-long TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { initStateEngine, createPost, closePoll, getPosts, votePoll } from './state-engine.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Id { pub: string; priv: crypto.KeyObject }
function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at, invited_by, invite_code)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', '-60 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`)
        .run(pub, callsign, `INV-${callsign.toUpperCase()}-${crypto.randomBytes(3).toString('hex')}`);
    setMemberPhoto(db, pub, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return { pub, priv: privateKey };
}

/** What a call throws, or '' when it goes. */
function refusal(fn: () => unknown): string {
    try { fn(); return ''; } catch (e) { return (e as Error)?.message ?? String(e); }
}

let n = 0;
/** The node holds 5 open polls at once, so each poll made here closes the earlier ones first, except where `keepOpen` is on (section 5). */
let keepOpen = false;
const closeAllPolls = (): void => { db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll' AND status = 'active'").run(); };
/** A poll from the app, as POST /api/marketplace/posts makes it. */
const newPoll = (author: string, durationDays?: number, extra: Record<string, unknown> = {}) =>
    (keepOpen ? undefined : closeAllPolls()) ?? createPost('poll', 'community', `Which day ${++n}?`, '', 0, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
        { pollOptions: [{ id: '1', text: 'Saturday' }, { id: '2', text: 'Sunday' }], ...(durationDays === undefined ? {} : { durationDays }), ...extra })!;
const rowOf = (id: string) => db.prepare('SELECT status, active, created_at AS createdAt, poll_closes_at AS closesAt FROM posts WHERE id = ?').get(id) as { status: string; active: number; createdAt: string; closesAt: string };
const pollCount = (author: string) => (db.prepare("SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ? AND type = 'poll'").get(author) as { c: number }).c;
/** How long the poll was made to run, in days, to the nearest hour. */
const ranDays = (id: string): number => { const r = rowOf(id); return Math.round((Date.parse(r.closesAt) - Date.parse(r.createdAt)) / HOUR) / 24; };

const LONG_REFUSAL = 'Polls that run 30 or 90 days are for owners and admins. Choose 3, 7, or 14 days';
const MEMBER_LENGTHS = 'Poll duration must be 3, 7, or 14 days';
const FIVE_LENGTHS = 'Poll duration must be 3, 7, 14, 30, or 90 days';

let BASE = '';
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pub, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': signRequest(id.priv, { method, path: p.split('?')[0], timestamp: ts, nonce, body }),
        [SIGNED_FOR_HEADER]: signedForHost(),
    };
}
async function send(method: string, p: string, payload: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* the plain text */ }
    return { status: res.status, body };
}
const get = (p: string, id: Id) => send('GET', p, undefined, signedHeaders('GET', p, '', id));
const post = (p: string, payload: unknown, id: Id) => send('POST', p, payload, signedHeaders('POST', p, JSON.stringify(payload), id));
const pollBody = (id: Id, durationDays: unknown) => ({
    type: 'poll', category: 'community', title: `Which month ${++n}?`, description: '', authorPublicKey: id.pub,
    pollOptions: [{ id: 'a', text: 'March' }, { id: 'b', text: 'June' }], durationDays,
});

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { startHttpsServer } = await import('./https-server.js');
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const owner = makeMember('Olive');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    const adm = makeMember('Ada');
    grantNodeRole(adm.pub, 'admin', owner.pub);
    const moe = makeMember('Moe');
    grantNodeRole(moe.pub, 'moderator', owner.pub);

    // ── 1. The length, by role ───────────────────────────────────────────────────────────────────
    console.log('\n--- 1. The length, by role ---');
    for (const days of [30, 90]) {
        const m = makeMember(`Mem${days}`);
        const said = refusal(() => newPoll(m.pub, days));
        assert(said === LONG_REFUSAL, `a member asking for ${days} days is told plainly (${said})`);
        assert(pollCount(m.pub) === 0, `and nothing is stored for the ${days}-day ask`);
    }
    for (const days of [3, 7, 14]) {
        const m = makeMember(`Mem${days}`);
        const p = newPoll(m.pub, days);
        assert(!!p && ranDays(p.id) === days, `a member still chooses ${days} days, and it closes ${days} days after it began`);
    }
    const dflt = newPoll(makeMember('Dee').pub);
    assert(ranDays(dflt.id) === 7, 'with no length the default is 7 days, as before');
    const moeSaid = refusal(() => newPoll(moe.pub, 30));
    assert(moeSaid === LONG_REFUSAL, `a moderator is a member here: refused 30 days (${moeSaid})`);
    const stringAsk = refusal(() => newPoll(makeMember('Sam').pub, '90' as unknown as number));
    assert(stringAsk === LONG_REFUSAL, `a member cannot get 90 by sending it as text (${stringAsk})`);
    const memberOdd = makeMember('Odd');
    assert(refusal(() => newPoll(memberOdd.pub, 5)) === MEMBER_LENGTHS && refusal(() => newPoll(memberOdd.pub, 31)) === MEMBER_LENGTHS,
        'a length in between is refused a member in the words it always had');
    const zeroAsk = newPoll(memberOdd.pub, 0);
    assert(ranDays(zeroAsk.id) === 7, 'and 0 still means the default 7, as before');

    const admin30 = newPoll(adm.pub, 30);
    assert(!!admin30 && ranDays(admin30.id) === 30 && admin30.pollClosesAt === rowOf(admin30.id).closesAt, 'an admin starts a 30-day poll, and it closes 30 days after it began');
    const owner90 = newPoll(owner.pub, 90);
    assert(!!owner90 && ranDays(owner90.id) === 90, 'an owner starts a 90-day poll, and it closes 90 days after it began');
    assert(refusal(() => newPoll(owner.pub, 14)) === '' && refusal(() => newPoll(adm.pub, 3)) === '', 'and the short ones are theirs too');
    const odd = [5, 15, 29, 31, 60, 89, 91, 365, -30];
    const oddSaid = odd.map(d => refusal(() => newPoll(adm.pub, d)));
    assert(oddSaid.every(s => s === FIVE_LENGTHS), `a length that is not one of the five is refused an admin, naming all five (${oddSaid[0]})`);
    assert(refusal(() => newPoll(owner.pub, 60)) === FIVE_LENGTHS, 'and an owner');
    const adminRows = pollCount(adm.pub);
    assert(adminRows === 2, `and none of those stored a poll (the admin has ${adminRows}: the 30-day one and the 3-day one)`);

    // ── 2. The role is read now ──────────────────────────────────────────────────────────────────
    console.log('\n--- 2. The role is read at the create ---');
    const ben = makeMember('Ben');
    grantNodeRole(ben.pub, 'admin', owner.pub);
    const benLong = newPoll(ben.pub, 90);
    assert(ranDays(benLong.id) === 90, 'setup: Ben, an admin, starts a 90-day poll');
    revokeNodeRole(ben.pub, 'admin', owner.pub);
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(benLong.id);
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * DAY).toISOString(), benLong.id);
    const benSaid = refusal(() => newPoll(ben.pub, 30));
    assert(benSaid === LONG_REFUSAL, `Ben made a member again is refused a long poll (${benSaid})`);
    assert(refusal(() => newPoll(ben.pub, 7)) === '', 'and starts a short one');
    const cyd = makeMember('Cyd');
    grantNodeRole(cyd.pub, 'admin', owner.pub);
    const cydLong = newPoll(cyd.pub, 30);
    revokeNodeRole(cyd.pub, 'admin', owner.pub);
    assert(rowOf(cydLong.id).status === 'active' && ranDays(cydLong.id) === 30, 'a long poll an admin started runs on after they are a member again');
    const cydClosed = closePoll(cydLong.id, cyd.pub);
    assert(cydClosed?.status === 'completed', 'and they may still close it');

    // ── 3. The door both apps use, and the role the picker reads ─────────────────────────────────
    console.log('\n--- 3. POST /api/marketplace/posts and GET /api/node-admin/me ---');
    const vic = makeMember('Vic');
    closeAllPolls();
    const refused = await post('/api/marketplace/posts', pollBody(vic, 30), vic);
    assert(refused.status === 400 && refused.body?.error === LONG_REFUSAL, `through the route a member's 30 days is a 400 in plain words (${refused.status} ${JSON.stringify(refused.body)})`);
    const refused90 = await post('/api/marketplace/posts', pollBody(vic, 90), vic);
    assert(refused90.status === 400 && refused90.body?.error === LONG_REFUSAL && pollCount(vic.pub) === 0, 'and 90 days, with nothing stored');
    const okShort = await post('/api/marketplace/posts', pollBody(vic, 14), vic);
    assert(okShort.status === 200 || okShort.status === 201, `while 14 days goes through (${okShort.status} ${JSON.stringify(okShort.body)?.slice(0, 120)})`);
    const eve = makeMember('Eve');
    grantNodeRole(eve.pub, 'admin', owner.pub);
    const adminRoute = await post('/api/marketplace/posts', pollBody(eve, 30), eve);
    const adminPostId = adminRoute.body?.post?.id ?? adminRoute.body?.id;
    assert((adminRoute.status === 200 || adminRoute.status === 201) && !!adminPostId && ranDays(adminPostId) === 30,
        `an admin's 30 days goes through the route (${adminRoute.status} ${JSON.stringify(adminRoute.body)?.slice(0, 120)})`);
    const ownerRoute = await post('/api/marketplace/posts', pollBody(owner, 90), owner);
    const ownerPostId = ownerRoute.body?.post?.id ?? ownerRoute.body?.id;
    assert((ownerRoute.status === 200 || ownerRoute.status === 201) && !!ownerPostId && ranDays(ownerPostId) === 90, `and an owner's 90 days (${ownerRoute.status})`);
    const adminOdd = await post('/api/marketplace/posts', pollBody(eve, 45), eve);
    assert(adminOdd.status === 400 && adminOdd.body?.error === FIVE_LENGTHS, `an admin's 45 days is refused naming all five (${JSON.stringify(adminOdd.body)})`);
    const roleOf = async (id: Id) => (await get('/api/node-admin/me', id)).body?.role ?? null;
    assert(await roleOf(eve) === 'admin' && await roleOf(owner) === 'owner' && await roleOf(vic) === null && await roleOf(moe) === 'moderator',
        'the role both apps read to fill the picker: an admin is an admin, an owner an owner, a member no one, a moderator a moderator');

    // ── 4. Close now: the maker's only ───────────────────────────────────────────────────────────
    console.log('\n--- 4. Close now ---');
    const maker = makeMember('Mia');
    grantNodeRole(maker.pub, 'admin', owner.pub);
    const long = newPoll(maker.pub, 90);
    const v1 = makeMember('Vee'), v2 = makeMember('Wes');
    votePoll(long.id, v1.pub, '1');
    votePoll(long.id, v2.pub, '2');
    const votesOf = (id: string) => getPosts({ id, includeAllScopes: true, viewerPubkey: v1.pub })[0]!;
    assert(votesOf(long.id).totalVotes === 2, 'setup: two members voted in the 90-day poll');
    const closers: Array<[string, Id]> = [['a member', v1], ['a moderator', moe], ['another admin', adm], ['an owner', owner]];
    for (const [who, id] of closers) {
        const said = refusal(() => closePoll(long.id, id.pub));
        assert(said === 'Only the author can close a poll', `${who} cannot close it (${said})`);
    }
    for (const [who, id] of closers) {
        for (const route of [`/api/marketplace/posts/${long.id}/close`, '/api/marketplace/polls/close']) {
            const r = await post(route, { postId: long.id, id: long.id }, id);
            assert(r.status === 400 && r.body?.error === 'Only the author can close a poll', `${who} gets a plain 400 from ${route} (${r.status} ${JSON.stringify(r.body)})`);
        }
    }
    assert(rowOf(long.id).status === 'active' && votesOf(long.id).status === 'active', 'and the poll is still open after every refusal');
    const closed = await post('/api/marketplace/polls/close', { postId: long.id }, maker);
    assert(closed.status === 200 && closed.body?.success === true && closed.body?.post?.status === 'completed', `its maker closes it (${closed.status} ${closed.body?.post?.status})`);
    const after = votesOf(long.id);
    assert(after.status === 'completed' && after.totalVotes === 2, 'the votes stay as cast (2) and the poll reads as ended');
    assert(after.pollOptions?.map((o: any) => o.votes).join() === '1,1', `each answer keeps its vote (${after.pollOptions?.map((o: any) => o.votes).join()})`);
    assert(rowOf(long.id).closesAt === long.pollClosesAt, 'closing moves nothing else of the poll: its closing time is as it was made');
    const lateVote = refusal(() => votePoll(long.id, makeMember('Xan').pub, '1'));
    assert(lateVote !== '' && votesOf(long.id).totalVotes === 2, `no more votes once it is closed (${lateVote})`);
    const again = await post('/api/marketplace/posts/' + long.id + '/close', { postId: long.id }, maker);
    assert(again.status === 200 && again.body?.post?.status === 'completed' && votesOf(long.id).totalVotes === 2, 'closing it again is no change');
    const fresh = newPoll(makeMember('Yan').pub, 7);
    const strangerClose = await post('/api/marketplace/polls/close', { postId: fresh.id }, makeMember('Zed'));
    assert(strangerClose.status === 400 && rowOf(fresh.id).status === 'active', 'and a short poll is no different: a stranger cannot close it');

    // ── 5. Decide ────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Decide: the card\'s poll ---');
    const viewer = makeMember('Vera');
    const decide = async () => (await get('/api/home?cards=needs,decide', viewer)).body?.cards?.decide;
    const stateOf = async () => { const d = await decide(); return d?.poll?.id ?? null; };
    // The previous sections left polls open on this node: close them so the card holds only this section's.
    db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll'").run();
    keepOpen = true;
    const maker2 = makeMember('Max');
    grantNodeRole(maker2.pub, 'admin', owner.pub);
    const mk = (days: number, extra: Record<string, unknown> = {}) => newPoll(maker2.pub, days, extra);
    const A = mk(14), B = mk(30), C = mk(90);
    assert(await stateOf() === A.id, 'setup: with nothing answered the card shows the soonest closing poll (14 days)');
    votePoll(A.id, viewer.pub, '1');
    assert(await stateOf() === A.id, 'the short poll Vera answered keeps its place: only a long one moves down');
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(A.id);
    assert(await stateOf() === B.id, 'with the 14-day poll over, the 30-day poll she has not answered is first');
    votePoll(B.id, viewer.pub, '1');
    const afterB = await stateOf();
    assert(afterB === C.id, `once she answers the 30-day poll, the 90-day one she has not answered sits above it (${afterB})`);
    votePoll(C.id, viewer.pub, '2');
    assert(await stateOf() === B.id, 'once she has answered both, the sooner closing is first again');
    const D = mk(3);
    assert(await stateOf() === D.id, 'a new 3-day poll waiting for her vote is above both she has answered');
    votePoll(D.id, viewer.pub, '1');
    assert(await stateOf() === D.id, 'and answered, it keeps its place above the long ones: it closes soon enough to clear itself');
    db.prepare("UPDATE posts SET status = 'completed' WHERE id IN (?, ?)").run(D.id, C.id);
    assert(await stateOf() === B.id, 'a voted long poll that is alone is still the card\'s poll');
    const card = await decide();
    assert(card?.polls === 1, `and the card still counts it open (${card?.polls})`);
    // A sealed poll (an anonymous poll with a typed Other): the node knows only that she answered, and that moves it down too.
    db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll'").run();
    const S = mk(30, { pollOther: true });
    const W = mk(90);
    assert(await stateOf() === S.id, 'setup: a sealed 30-day poll is first before she answers');
    votePoll(S.id, viewer.pub, '1');
    assert(await stateOf() === W.id, 'answered, a sealed long poll sits below the poll still waiting for her vote');
    // Someone else's answer moves nothing of hers.
    const other = makeMember('Olga');
    votePoll(W.id, other.pub, '1');
    assert(await stateOf() === W.id, 'and another member\'s answer to the waiting poll does not move it for her');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && !process.exitCode ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
