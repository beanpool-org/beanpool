/**
 * A MEMBER STARTS ONE COMMUNITY POLL A WEEK (Marty, 4 Nov 2026, brainstorming spam on the Market: "limit votes to 1 active owned voting
 * card per person ... and also 1 a week - otherwise people could just keep placing them and deleting them every day and their
 * voting card is always at the top every day"). The first half, one ACTIVE poll each, was already the rule
 * (engine/posts.ts assertActivePollRoom, held in test-owner-admin-limits and test-polls). This holds the second
 * (engine/poll-week.ts), on the real engine and its database, and the route both apps ask before they open the poll form,
 * through the real signed HTTPS middleware.
 *
 *   1. The week, counted from when each poll was STARTED: a second poll inside 7 days is refused in plain words saying how long
 *      to wait (hours up to two days, days after, rounded UP so it is never early, and never a calendar day: a node has no time
 *      zone), 30 seconds inside the week is still refused, 30 seconds past it goes, and a member who never started one is told
 *      nothing. The refusal is the same for a start at 09:00 in Sydney (UTC+11, the live nodes) as for any other hour.
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
 *      French, from the server's own catalog (the plural form for the number).
 *   7. ONLY A POLL FOR THE WHOLE COMMUNITY COUNTS (Marty, 4 Nov ~22:40: the limit is about "real estate in the market place"): a
 *      poll for one of the author's groups (audience_scope 'group') or for one person ('direct') is neither held nor counted, in
 *      either order with a community poll; the one-open-poll rule still counts every audience; the route answers for community
 *      polls only.
 *   8. A Decision is no poll: the other kinds of vote (Decisions, removal and jury votes, a group's convenor vote, rekey and
 *      enterprise succession) are not rows of `posts`. A member held to the week by a community poll starts a Decision, and one
 *      who started a Decision starts a poll.
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_HEADER, pluralKey } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { initStateEngine, createPost, closePoll, removePost, adminDeletePost, pausePost, resumePost, createGroup, joinGroup, createDecision } from './state-engine.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { assertPollStartRoom, nextPollStartAt, POLL_START_WINDOW_MS } from './engine/poll-week.js';

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
/** A poll for a group or for one person, as POST /api/marketplace/posts makes it. */
const newScopedPoll = (author: string, options: Record<string, unknown>) => createPost('poll', 'community', `Which day ${++n}?`, '', 0, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
    { pollOptions: [{ id: '1', text: 'Saturday' }, { id: '2', text: 'Sunday' }], ...options })!;
const P = 'You can start one community poll a week. Your next one can start in ';
const WEEK = /^You can start one community poll a week\. Your next one can start in (\d+) (hours?|days?)\.$/;
/** How long the refusal says to wait, in ms, or null when the text is not that sentence. */
const saidWait = (message: string): number | null => { const m = WEEK.exec(message); return m ? Number(m[1]) * (m[2].startsWith('hour') ? HOUR : DAY) : null; };

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
    assert(said?.[1] === '7' && said?.[2] === 'days', `saying how long to wait: 7 days from when the first was started (${said?.[1]} ${said?.[2]})`);
    startedAgo(first.id, POLL_START_WINDOW_MS - 30_000);
    assert(refusal(() => newPoll(ann.pub)) === 'You can start one community poll a week. Your next one can start in 1 hour.', '30 seconds inside the week it is still refused, in 1 hour (singular, and never "0 hours"): the week is counted from the start, to the second');
    startedAgo(first.id, POLL_START_WINDOW_MS + 30_000);
    assert(nextPollStartAt(ann.pub) === null && refusal(() => newPoll(ann.pub)) === '', '30 seconds past the week a second poll goes');
    const second = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'poll' AND status = 'active'").get(ann.pub) as { id: string };
    assert(!!second, 'and is up');
    // The one-active-poll rule keeps its words, ahead of the week's: a member with a poll up is told that, as before.
    assert(/^Rate limit: You can only have 1 active poll at a time$/.test(refusal(() => newPoll(ann.pub))), 'a member with a poll still up is told that first, in the words it always had');

    // ── 1b. The wait is said in hours and days, rounded up, and never as a calendar day ──────────
    console.log('\n--- 1b. How long, never which day ---');
    const syd = makeMember('Syd');
    const sydPoll = newPoll(syd.pub);
    closePoll(sydPoll.id, syd.pub);
    // Wed 4 Nov 2026 09:00 in Sydney (UTC+11) is 22:00 UTC the day before: a node on UTC named 10 Nov for a poll that frees on
    // Wed 11 Nov at 09:00 Sydney (the deciding review of this PR, first round). It names no day now.
    const sydStart = Date.parse('2026-11-03T22:00:00.000Z');
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(sydStart).toISOString(), sydPoll.id);
    const sentenceAt = (nowMs: number): string => refusal(() => assertPollStartRoom(syd.pub, null, 'public', nowMs));
    const oldTz = process.env.TZ;
    try {
        for (const tz of ['Australia/Sydney', 'Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
            process.env.TZ = tz;
            const early = sentenceAt(Date.parse('2026-11-04T00:00:00.000Z'));          // Wed 4 Nov 11:00 Sydney
            const evening = sentenceAt(Date.parse('2026-11-10T06:00:00.000Z'));        // Tue 10 Nov 17:00 Sydney: the day the old sentence named
            assert(early === 'You can start one community poll a week. Your next one can start in 7 days.', `${tz}: two hours after a 09:00 Sydney start the wait is 7 days, rounded up from 6 days 22 hours (${early})`);
            assert(evening === 'You can start one community poll a week. Your next one can start in 16 hours.', `${tz}: on Tue 10 Nov at 17:00 Sydney, the day the UTC sentence named and refused, it says 16 hours (${evening})`);
            assert(!/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|20\d\d/.test(early + evening), `${tz}: neither names a day, a month or a year`);
        }
    } finally {
        if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
    }
    const edge = (leftMs: number): string => sentenceAt(sydStart + POLL_START_WINDOW_MS - leftMs);
    assert(edge(48 * HOUR) === 'You can start one community poll a week. Your next one can start in 48 hours.', 'two days to the millisecond is still counted in hours');
    assert(edge(48 * HOUR + 1) === 'You can start one community poll a week. Your next one can start in 3 days.', 'one millisecond more is 3 days, rounded up');
    assert(edge(HOUR) === 'You can start one community poll a week. Your next one can start in 1 hour.' && edge(HOUR + 1) === 'You can start one community poll a week. Your next one can start in 2 hours.', 'an hour exactly is 1 hour, a millisecond more is 2 hours');
    let neverEarly = true, fine = true;
    for (let left = 1; left < POLL_START_WINDOW_MS; left += 37 * 60_000 + 11_111) {
        const said = saidWait(edge(left));
        const unit = left <= 48 * HOUR ? HOUR : DAY;
        if (said === null || said < left) neverEarly = false;
        if (said !== null && said - left >= unit) fine = false;
    }
    assert(neverEarly, 'across the whole week, what it says is never less than the time left (never early)');
    assert(fine, 'and never more than one hour (up to two days) or one day (after) too much');

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
    const demotedLeft = Date.parse(startedAt(lastAdminPoll.id)) + POLL_START_WINDOW_MS - Date.now();
    assert((saidWait(demoted) ?? 0) >= demotedLeft && (saidWait(demoted) ?? Infinity) - demotedLeft < DAY, 'counted from the latest of their starts');
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
    const english = await post('/api/marketplace/posts', body, cy);
    assert(english.status === 400 && english.body?.error === 'You can start one community poll a week. Your next one can start in 7 days.', `in English: the sentence as written (${english.status} ${JSON.stringify(english.body)})`);
    const french = await post('/api/marketplace/posts', body, cy, { [LANGUAGE_HEADER]: 'fr' });
    const frCatalog = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../words/fr.json'), 'utf8'));
    const frForms = frCatalog[pluralKey(
        'You can start one community poll a week. Your next one can start in {n} day.',
        'You can start one community poll a week. Your next one can start in {n} days.',
    )] as { other?: string } | undefined;
    assert(!!frForms?.other && french.status === 400 && french.body?.error === frForms.other.replace('{n}', '7'),
        `with X-Language: fr, the server's own French for 7 days (${french.body?.error})`);
    assert(french.body?.error !== english.body?.error && !/^You can start/.test(french.body?.error ?? ''), 'and the sentence is French');
    // The plural form is the language's own for the number: Russian and Arabic have four and six. 20.5 hours left is 21 hours.
    const forms = (lang: string, one: string, other: string) => JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../words/${lang}.json`), 'utf8'))[pluralKey(one, other)] as Record<string, string>;
    const HOURS = [P + '{n} hour.', P + '{n} hours.'] as const;
    const hoursLeft = async (hours: number, lang: string) => {
        startedAgo(cyPoll.id, POLL_START_WINDOW_MS - Math.round((hours - 0.5) * HOUR));
        return (await post('/api/marketplace/posts', body, cy, { [LANGUAGE_HEADER]: lang })).body?.error;
    };
    const ru = forms('ru', ...HOURS), ar = forms('ar', ...HOURS);
    assert(await hoursLeft(21, 'ru') === ru.one.replace('{n}', '21'), `Russian 21 hours takes the "one" form (${ru.one})`);
    assert(await hoursLeft(2, 'ru') === ru.few.replace('{n}', '2'), `2 hours the "few" form (${ru.few})`);
    assert(await hoursLeft(5, 'ru') === ru.many.replace('{n}', '5'), `5 hours the "many" form (${ru.many})`);
    assert(await hoursLeft(2, 'ar') === ar.two, `Arabic 2 hours the "two" form, which writes the number in words (${ar.two})`);
    assert(await hoursLeft(5, 'ar') === ar.few.replace('{n}', '5'), `and 5 hours the "few" form (${ar.few})`);
    assert(await hoursLeft(3, 'ja') === forms('ja', ...HOURS).other.replace('{n}', '3'), 'and Japanese, with no plural forms, its one');

    // ── 7. Only a poll for the whole community counts ────────────────────────────────────────────
    console.log('\n--- 7. A group\'s poll and one person\'s are not the community\'s ---');
    const gil = makeMember('Gil');
    const ned = makeMember('Ned');
    const garden = createGroup({ name: 'Garden Crew', createdBy: gil.pub, joinPolicy: 'open' });
    const inGarden = { audienceScope: 'group', targetGroupId: garden.id };
    const toNed = { audienceScope: 'direct', targetPubkey: ned.pub };
    const closeAll = (author: string) => db.prepare("UPDATE posts SET status = 'completed' WHERE author_pubkey = ? AND type = 'poll'").run(author);
    const comm = newPoll(gil.pub);
    closePoll(comm.id, gil.pub);
    assert(WEEK.test(refusal(() => newPoll(gil.pub))), 'setup: Gil started a community poll, so a second one is refused');
    const g1Said = refusal(() => newScopedPoll(gil.pub, inGarden));
    assert(g1Said === '', `but a poll for his group goes straight after (${g1Said})`);
    const g1 = db.prepare("SELECT id, audience_scope AS scope, target_group_id AS gid FROM posts WHERE author_pubkey = ? AND type = 'poll' AND audience_scope = 'group'").get(gil.pub) as { id: string; scope: string; gid: string };
    assert(g1?.scope === 'group' && g1.gid === garden.id, 'and it is stored as the group\'s (audience_scope group, the group\'s id)');
    assert(/^Rate limit: You can only have 1 active poll at a time$/.test(refusal(() => newScopedPoll(gil.pub, inGarden))) && /^Rate limit: You can only have 1 active poll at a time$/.test(refusal(() => newScopedPoll(gil.pub, toNed))),
        'the one-open-poll rule still counts it: a second poll of any audience is refused while the group\'s is up, in the words it always had');
    closePoll(g1.id, gil.pub);
    assert(refusal(() => newScopedPoll(gil.pub, inGarden)) === '', 'once it is closed, another for the group goes: a group\'s polls are not held to the week');
    closeAll(gil.pub);
    assert(refusal(() => newScopedPoll(gil.pub, toNed)) === '', 'and one for a single person');
    closeAll(gil.pub);
    assert(nextPollStartAt(gil.pub) === new Date(Date.parse(startedAt(comm.id)) + POLL_START_WINDOW_MS).toISOString(),
        'his next community poll is counted from the community poll, not from the group\'s or the person\'s that came after');
    assert(WEEK.test(refusal(() => newPoll(gil.pub))), 'and a community poll is still refused, after all of them');

    const hana = makeMember('Hana');
    joinGroup(garden.id, hana.pub);
    const hg = newScopedPoll(hana.pub, inGarden);
    closePoll(hg.id, hana.pub);
    assert(nextPollStartAt(hana.pub) === null, 'a member whose only poll was for a group is told nothing');
    assert(refusal(() => newPoll(hana.pub)) === '', 'and starts a community poll straight after the group\'s (the other order)');
    closeAll(hana.pub);
    assert(WEEK.test(refusal(() => newPoll(hana.pub))), 'which then counts: a second community poll is refused');

    const ivo = makeMember('Ivo');
    const toNedPoll = newScopedPoll(ivo.pub, toNed);
    closePoll(toNedPoll.id, ivo.pub);
    assert((db.prepare('SELECT audience_scope AS s, target_pubkey AS t FROM posts WHERE id = ?').get(toNedPoll.id) as { s: string; t: string }).s === 'direct', 'setup: a poll for one person is stored as direct');
    assert(nextPollStartAt(ivo.pub) === null && refusal(() => newPoll(ivo.pub)) === '', 'a poll for one person is not counted: Ivo starts a community poll straight after');

    const olga = makeMember('Olga');
    const olgaPoll = newPoll(olga.pub);
    closePoll(olgaPoll.id, olga.pub);
    assert((db.prepare('SELECT audience_scope AS s FROM posts WHERE id = ?').get(olgaPoll.id) as { s: string }).s === 'public' && nextPollStartAt(olga.pub) !== null,
        'a poll started with no audience named is stored as public (the community\'s), and counts');
    const lola = makeMember('Lola');
    const lolaPoll = newPoll(lola.pub);
    closePoll(lolaPoll.id, lola.pub);
    db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = ? WHERE id = ?").run(garden.id, lolaPoll.id);
    assert(nextPollStartAt(lola.pub) === null, 'a poll stored for a group is not counted, however it began');

    const hanaComm = db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND type = 'poll' AND audience_scope = 'public'").get(hana.pub) as { id: string };
    const route = await get(NEXT_START, hana);
    assert(route.status === 200 && route.body?.nextAt === new Date(Date.parse(startedAt(hanaComm.id)) + POLL_START_WINDOW_MS).toISOString(),
        `the route answers for community polls: Hana is told when her community poll's week ends (${JSON.stringify(route.body)})`);
    const jon = makeMember('Jon');
    joinGroup(garden.id, jon.pub);
    closePoll(newScopedPoll(jon.pub, toNed).id, jon.pub);
    closePoll(newScopedPoll(jon.pub, inGarden).id, jon.pub);
    const jonRoute = await get(NEXT_START, jon);
    assert(jonRoute.status === 200 && jonRoute.body?.nextAt === null, 'and tells Jon, who only started one for a person and one for a group, nothing');

    // ── 8. A Decision is no poll ─────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Decisions and the other votes are not polls ---');
    const trade = (a: string, b: string) => {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at) VALUES (?, ?, ?, ?, 20, 'completed', ?, ?)")
            .run(`tx-${crypto.randomBytes(4).toString('hex')}`, `post-${crypto.randomBytes(4).toString('hex')}`, a, b, now, now);
    };
    const dee = makeMember('Dee');
    trade(dee.pub, ned.pub);
    const deePoll = newPoll(dee.pub);
    closePoll(deePoll.id, dee.pub);
    const deeWaits = nextPollStartAt(dee.pub);
    assert(WEEK.test(refusal(() => newPoll(dee.pub))) && deeWaits !== null, 'setup: Dee started a community poll this week, so another poll is refused');
    const postsBefore = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c;
    let decisionId = '';
    const decisionSaid = refusal(() => { decisionId = createDecision({ authorPubkey: dee.pub, title: 'Freeze Ned\'s credit', description: 'He did not deliver the tools', touches: 'member', effect: 'freeze_credit', subject: ned.pub }).id; });
    assert(decisionSaid === '' && decisionId !== '', `and the same week she starts a Decision: the week does not hold it (${decisionSaid})`);
    assert((db.prepare('SELECT COUNT(*) AS c FROM decisions WHERE id = ?').get(decisionId) as { c: number }).c === 1
        && (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c === postsBefore
        && (db.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ?').get(decisionId) as { c: number }).c === 0,
        'the Decision is a row of decisions and adds no row to posts: it is no poll');
    assert(nextPollStartAt(dee.pub) === deeWaits, 'it moves nothing of Dee\'s week');
    const eli = makeMember('Eli');
    trade(eli.pub, ned.pub);
    const eliDecision = refusal(() => createDecision({ authorPubkey: eli.pub, title: 'Pause the lending shelf', description: 'Until the tools are counted', touches: 'member', effect: 'suspend_member', subject: ned.pub }));
    assert(eliDecision === '' && nextPollStartAt(eli.pub) === null && refusal(() => newPoll(eli.pub)) === '', `and a member who started a Decision starts a poll straight after (${eliDecision})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && !process.exitCode ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
