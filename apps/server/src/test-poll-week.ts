/**
 * A MEMBER STARTS ONE POLL A WEEK (Marty, 4 Nov 2026, brainstorming spam on the Market: "limit votes to 1 active owned voting
 * card per person ... and also 1 a week - otherwise people could just keep placing them and deleting them every day and their
 * voting card is always at the top every day"). The first half, one ACTIVE poll each, was already the rule
 * (engine/posts.ts assertActivePollRoom, held in test-owner-admin-limits and test-polls). This holds the second
 * (engine/poll-week.ts), on the real engine and its database, and the route both apps ask before they open the poll form,
 * through the real signed HTTPS middleware.
 *
 *   1. The week, counted from when each poll was STARTED: a second poll inside 7 days is refused in plain words naming the day
 *      it can start, 30 seconds inside the week is still refused, 30 seconds past it goes, and a member who never started one
 *      is told nothing.
 *   2. Whatever became of the first poll, it still counts: closed early, run out, taken down by its author (a cancel, the row
 *      stays), removed by a moderator, taken off the board by the retention archive, paused. The row is the log: none of them
 *      deletes it, which this checks so that a future hard delete cannot slip past.
 *   3. Owners and admins are not held to it (their Settings limit is, as before); their starts are counted all the same, so an
 *      admin made a member again is held by the poll they started the day before. A moderator is a member here.
 *   4. Not a new start: putting back up the poll a member paused (the same poll, with its own start). And pausing does not
 *      make room for another: pause, then a new poll inside the week is refused.
 *   5. The route the apps ask (GET /api/marketplace/polls/next-start): nothing for a member who may start one now, the date
 *      after a poll, nothing for an owner or an admin, a refusal for a request with no signature, never cached.
 *   6. The refusal on the way out, through the route that creates a poll: in English as written, and with X-Language: fr in
 *      French with the day written the French way (core's date tables), not as 11 Nov 2026.
 *
 * An owner's assistant makes its polls through this same door as the owner: test-mcp-owner-polls section 12c.
 *
 * Local only: nothing leaves the box.
 *
 * Run: SERVER_SUITES_ONLY=test-poll-week TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { formatDate, LANGUAGE_HEADER } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { initStateEngine, createPost, closePoll, removePost, adminDeletePost, pausePost, resumePost } from './state-engine.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { nextPollStartAt, POLL_START_WINDOW_MS } from './engine/poll-week.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60 * 1000;

interface Id { pub: string; priv: crypto.KeyObject }
function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at, invited_by, invite_code)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`)
        .run(pub, callsign, `INV-${callsign.toUpperCase()}-${crypto.randomBytes(3).toString('hex')}`);
    setMemberPhoto(db, pub, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return { pub, priv: privateKey };
}

/** What a call throws, or '' when it goes. */
function refusal(fn: () => unknown): string {
    try { fn(); return ''; } catch (e) { return (e as Error)?.message ?? String(e); }
}

let n = 0;
/** A poll from the app, as POST /api/marketplace/posts makes it. */
const newPoll = (author: string) => createPost('poll', 'community', `Which day ${++n}?`, '', 0, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
    { pollOptions: [{ id: '1', text: 'Saturday' }, { id: '2', text: 'Sunday' }] })!;
const startedAt = (id: string): string => (db.prepare('SELECT created_at FROM posts WHERE id = ?').get(id) as { created_at: string }).created_at;
/** The poll was started `ms` ago (its start and nothing else moves). */
const startedAgo = (id: string, ms: number): void => { db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), id); };
const status = (id: string): { status: string; active: number } => db.prepare('SELECT status, active FROM posts WHERE id = ?').get(id) as { status: string; active: number };
const WEEK = /^You can start one poll a week\. Your next one can start on (\d{1,2} [A-Z][a-z]{2} \d{4})\.$/;
/** The day of an instant as the node writes it into the sentence: English, the UTC day. */
const dayOf = (iso: string, lang: 'en' | 'fr' = 'en'): string => formatDate(new Date(iso), 'day-month-year', { utc: true, lang });

let BASE = '';
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pub, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.priv).toString('base64'),
    };
}
async function send(method: string, p: string, payload: unknown, headers: Record<string, string>): Promise<{ status: number; cache: string | null; body: any }> {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* the plain text */ }
    return { status: res.status, cache: res.headers.get('cache-control'), body };
}
const get = (p: string, id: Id | null) => send('GET', p, undefined, id ? signedHeaders('GET', p, '', id) : {});
const post = (p: string, payload: unknown, id: Id, extra: Record<string, string> = {}) => send('POST', p, payload, { ...signedHeaders('POST', p, JSON.stringify(payload), id), ...extra });
const NEXT_START = '/api/marketplace/polls/next-start';

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { startHttpsServer } = await import('./https-server.js');
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const owner = makeMember('Olive');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');

    // ── 1. The week, from when each poll was started ─────────────────────────────────────────────
    console.log('\n--- 1. The week ---');
    const ann = makeMember('Ann');
    assert(nextPollStartAt(ann.pub) === null, 'a member who never started a poll is told nothing');
    const first = newPoll(ann.pub);
    assert(!!first && status(first.id).status === 'active', 'a member starts a poll');
    const closed = closePoll(first.id, ann.pub);
    assert(closed?.status === 'completed', 'and closes it');
    const again = refusal(() => newPoll(ann.pub));
    const said = WEEK.exec(again);
    assert(!!said, `a second poll straight after is refused in plain words (${again})`);
    assert(said?.[1] === dayOf(new Date(Date.parse(startedAt(first.id)) + POLL_START_WINDOW_MS).toISOString()),
        `naming the day it can start, 7 days from when the first was started (${said?.[1]})`);
    startedAgo(first.id, POLL_START_WINDOW_MS - 30_000);
    assert(WEEK.test(refusal(() => newPoll(ann.pub))), '30 seconds inside the week it is still refused: the week is counted from the start, to the second');
    startedAgo(first.id, POLL_START_WINDOW_MS + 30_000);
    assert(nextPollStartAt(ann.pub) === null && refusal(() => newPoll(ann.pub)) === '', '30 seconds past the week a second poll goes');
    const second = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'poll' AND status = 'active'").get(ann.pub) as { id: string };
    assert(!!second, 'and is up');
    // The one-active-poll rule keeps its words, ahead of the week's: a member with a poll up is told that, as before.
    assert(/^Rate limit: You can only have 1 active poll at a time$/.test(refusal(() => newPoll(ann.pub))), 'a member with a poll still up is told that first, in the words it always had');

    // ── 2. Whatever became of the poll, it counts ────────────────────────────────────────────────
    console.log('\n--- 2. Taken down, it still counts ---');
    const each: Array<[string, (id: string, author: string) => void]> = [
        ['closed early by its author', (id, a) => { closePoll(id, a); }],
        ['run out (past its closing time, swept)', (id) => { db.prepare("UPDATE posts SET poll_closes_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id); }],
        ['deleted by its author (removePost)', (id, a) => { removePost(id, a); }],
        ['removed by a moderator (adminDeletePost)', (id) => { adminDeletePost(id); }],
        ['paused by its author', (id, a) => { pausePost(id, a); }],
        ['taken off the board as the retention archive leaves a closed poll (active 0, completed)', (id) => { db.prepare("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?").run(id); }],
    ];
    for (const [how, undo] of each) {
        const m = makeMember(`Sam${++n}`);
        const p = newPoll(m.pub);
        undo(p.id, m.pub);
        // Run out: the next create sweeps it; any other is already off the board.
        const tried = refusal(() => newPoll(m.pub));
        assert(WEEK.test(tried), `a poll ${how}: its maker still waits the week (${tried})`);
        const rows = (db.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ?').get(p.id) as { c: number }).c;
        assert(rows === 1, `and its row is still there to count: no way of taking a poll down deletes it (${how})`);
        assert(nextPollStartAt(m.pub) === new Date(Date.parse(startedAt(p.id)) + POLL_START_WINDOW_MS).toISOString(), `and the day is 7 days from its start, not from the removal (${how})`);
    }
    const gone = makeMember('Gus');
    const goneAt = newPoll(gone.pub);
    removePost(goneAt.id, gone.pub);
    assert(status(goneAt.id).status === 'cancelled' && status(goneAt.id).active === 0, 'a removal is a cancel: the row stays, inactive');
    const stays = makeMember('Stu');
    const stayAt = newPoll(stays.pub);
    const before = startedAt(stayAt.id);
    pausePost(stayAt.id, stays.pub);
    resumePost(stayAt.id, stays.pub);
    closePoll(stayAt.id, stays.pub);
    assert(startedAt(stayAt.id) === before, 'and what is done to a poll later (a pause, a resume, a close) never moves its start');

    // ── 3. Owners and admins are not held; their starts count ────────────────────────────────────
    console.log('\n--- 3. Owners and admins ---');
    const adm = makeMember('Ada');
    grantNodeRole(adm.pub, 'admin', owner.pub);
    const closeOwn = (author: string) => db.prepare("UPDATE posts SET status = 'completed' WHERE author_pubkey = ? AND type = 'poll'").run(author);
    newPoll(owner.pub); closeOwn(owner.pub);
    assert(refusal(() => newPoll(owner.pub)) === '', 'an owner starts a second poll straight after closing the first');
    closeOwn(owner.pub);
    assert(refusal(() => newPoll(owner.pub)) === '', 'and a third: the Settings limit is theirs, not the week');
    newPoll(adm.pub); closeOwn(adm.pub);
    assert(refusal(() => newPoll(adm.pub)) === '', 'an admin the same');
    closeOwn(adm.pub);
    const lastAdminPoll = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'poll' ORDER BY created_at DESC LIMIT 1").get(adm.pub) as { id: string };
    revokeNodeRole(adm.pub, 'admin', owner.pub);
    const demoted = refusal(() => newPoll(adm.pub));
    assert(WEEK.test(demoted), `an admin made a member again is held by the poll they started as admin (${demoted})`);
    assert(WEEK.exec(demoted)?.[1] === dayOf(new Date(Date.parse(startedAt(lastAdminPoll.id)) + POLL_START_WINDOW_MS).toISOString()), 'from the latest of their starts');
    grantNodeRole(adm.pub, 'admin', owner.pub);
    assert(refusal(() => newPoll(adm.pub)) === '', 'and made admin again, they are not held again at once');
    const moe = makeMember('Moe');
    grantNodeRole(moe.pub, 'moderator', owner.pub);
    newPoll(moe.pub); closeOwn(moe.pub);
    assert(WEEK.test(refusal(() => newPoll(moe.pub))), 'a moderator is a member here: held to the week');

    // ── 4. Resume is not a new start; pause makes no room ────────────────────────────────────────
    console.log('\n--- 4. Pause and resume ---');
    const pat = makeMember('Pat');
    const paused = newPoll(pat.pub);
    const startBefore = startedAt(paused.id);
    assert(pausePost(paused.id, pat.pub) && status(paused.id).status === 'paused', 'a member pauses their poll');
    assert(WEEK.test(refusal(() => newPoll(pat.pub))), 'pausing does not make room for another inside the week');
    assert(resumePost(paused.id, pat.pub) && status(paused.id).status === 'active', 'they put the same poll back up');
    assert(startedAt(paused.id) === startBefore && nextPollStartAt(pat.pub) === new Date(Date.parse(startBefore) + POLL_START_WINDOW_MS).toISOString(),
        'which is not a new start: its start, and so the day, is where it was');
    startedAgo(paused.id, POLL_START_WINDOW_MS + 30_000);
    pausePost(paused.id, pat.pub);
    assert(resumePost(paused.id, pat.pub), 'and an old poll a week on is put back up as before');

    // ── 5. The route both apps ask ───────────────────────────────────────────────────────────────
    console.log('\n--- 5. GET /api/marketplace/polls/next-start ---');
    // The community's 5 open polls are not what is held here: every poll so far closed (their starts stay).
    db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll' AND status = 'active'").run();
    const bea = makeMember('Bea');
    const none = await get(NEXT_START, bea);
    assert(none.status === 200 && none.body?.nextAt === null, `a member who may start one now is told nothing (${none.status} ${JSON.stringify(none.body)})`);
    const beaPoll = newPoll(bea.pub);
    const told = await get(NEXT_START, bea);
    assert(told.status === 200 && told.body?.nextAt === new Date(Date.parse(startedAt(beaPoll.id)) + POLL_START_WINDOW_MS).toISOString(),
        `after a poll she is told when she can start the next (${JSON.stringify(told.body)})`);
    assert(/no-store/.test(told.cache ?? ''), 'and never from a cache: it is hers alone');
    startedAgo(beaPoll.id, POLL_START_WINDOW_MS + 30_000);
    assert((await get(NEXT_START, bea)).body?.nextAt === null, 'a week on, told nothing again');
    const ownerTold = await get(NEXT_START, owner);
    assert(ownerTold.status === 200 && ownerTold.body?.nextAt === null, 'an owner is told nothing, whatever they started');
    const admTold = await get(NEXT_START, adm);
    assert(admTold.status === 200 && admTold.body?.nextAt === null, 'and an admin');
    const unsigned = await get(NEXT_START, null);
    assert(unsigned.status === 401 || unsigned.status === 403, `a request with no signature is refused (${unsigned.status})`);
    const otherQuery = await get(`${NEXT_START}?member=${ann.pub}`, bea);
    assert(otherQuery.body?.nextAt === null, 'and a member reads only their own: another key in the query is not read');

    // ── 6. The refusal on the way out ────────────────────────────────────────────────────────────
    console.log('\n--- 6. The refusal, through the create route ---');
    const cy = makeMember('Cy');
    const cyPoll = newPoll(cy.pub);
    closePoll(cyPoll.id, cy.pub);
    const body = { type: 'poll', category: 'community', title: 'Again?', description: '', authorPublicKey: cy.pub, pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], durationDays: 7 };
    const due = new Date(Date.parse(startedAt(cyPoll.id)) + POLL_START_WINDOW_MS).toISOString();
    const day = dayOf(due);
    const english = await post('/api/marketplace/posts', body, cy);
    assert(english.status === 400 && english.body?.error === `You can start one poll a week. Your next one can start on ${day}.`, `in English: the sentence as written (${english.status} ${JSON.stringify(english.body)})`);
    const french = await post('/api/marketplace/posts', body, cy, { [LANGUAGE_HEADER]: 'fr' });
    const frDate = dayOf(due, 'fr');
    assert(french.status === 400 && typeof french.body?.error === 'string' && french.body.error.includes(frDate) && !french.body.error.includes(day) && frDate !== day,
        `with X-Language: fr, in French with the day the French way, ${frDate}, not ${day} (${french.body?.error})`);
    assert(french.body?.error !== english.body?.error && !/^You can start/.test(french.body?.error ?? ''), 'and the sentence is French');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && !process.exitCode ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
