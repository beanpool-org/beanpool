/**
 * A poll's typed Other (Marty, 2 Nov), over real HTTPS through the real middleware: a maker, an owner, an admin, a member and
 * a control (a member of nothing here), on one server.
 *
 * What it holds: Other is off unless the maker asks; everyone who can see the poll sees its count; the words go only to the
 * maker and the owners; an anonymous poll's stored answer has no link to its voter that any reader, database readers
 * included, can follow; nothing keeps when or in what order it arrived; a report names nobody; an edit can't turn an anonymous
 * Other into a named one; an old app can't store a broken vote; a standby's copy keeps all of that.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-poll-other.ts (through scripts/run-server-suites.mjs)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { setMemberPhoto } from '@beanpool/engine';
import { POLL_OTHER_WORDS_MAX } from '@beanpool/core';
import { aWeekPasses } from './post-test-helper.js';
import { signRequest, signSocket, socketBinding, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = { method, path: p.split('?')[0], timestamp: ts, nonce, body };
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, canonical),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
async function get(p: string, id?: Id): Promise<{ status: number; text: string; body: any }> {
    const res = await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* */ }
    return { status: res.status, text, body };
}
async function post(p: string, payload: unknown, id: Id): Promise<{ status: number; text: string; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', p, body, id) }, body });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, text, body: json };
}
function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = signSocket(id.privateKey, ts, nonce);
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}&${socketBinding()}`;
}
function openSocket(url: string): Promise<{ ws: WebSocket; raw: string[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', d => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

/** A read by id's one post. */
const first = (body: any): any => (Array.isArray(body) ? body[0] : body?.posts?.[0] ?? body?.post);

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const WORDS = 'Fix-the-bus-timetable-please';
const WORDS_2 = 'More-seedlings-on-Saturdays';
const WORDS_OPEN = 'Named-answer-on-an-open-vote';

async function main() {
    console.log('A poll\'s typed Other...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, closePoll, getReports, actionReport, getMember, exportSyncState, adminDeletePost, purgeMemberSelf } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { closeExpiredPolls } = await import('./engine/posts.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`).run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const owner = seed('OwnerOona');
    const admin = seed('AdminAda');
    const maker = seed('MakerMo');
    const typist = seed('TypistTess');
    const typist2 = seed('TypistTim');
    const plain = seed('PlainPam');
    const reader = seed('ReaderRay');
    const control = keypair(); // signs, but is not a member here
    grantNodeRole(owner.pubKeyHex, 'owner', 'SYSTEM');
    grantNodeRole(admin.pubKeyHex, 'admin', 'SYSTEM');

    // A member has one open poll and a node five: each poll here closes the ones before it, but the one being read.
    let keep = '';
    // Room for the next poll: the others closed, and a week on, so it is Other this suite holds and not the week a member waits
    // between polls (engine/poll-week.ts, held in test-poll-week.ts).
    const clearRoom = () => { db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll' AND status = 'active' AND id != ?").run(keep); aWeekPasses(db); };
    const makePoll = async (extra: Record<string, unknown>, by: Id = maker) => (clearRoom(), post('/api/marketplace/posts', {
        type: 'poll', category: 'community', title: `What is missing? ${crypto.randomBytes(3).toString('hex')}`, description: '', authorPublicKey: by.pubKeyHex,
        pollOptions: [{ id: 'opt_1', text: 'Buses' }, { id: 'opt_2', text: 'Beans' }], durationDays: 7, ...extra,
    }, by));
    const vote = (id: string, optionId: string, by: Id, otherWords?: unknown, extra: Record<string, unknown> = {}) =>
        post(`/api/marketplace/posts/${id}/vote`, { optionId, ...(otherWords === undefined ? {} : { otherWords }), ...extra }, by);

    console.log('── the node says it can, and Other is off by default ──');
    const info = await get('/api/community/info');
    assert(info.body?.pollOther === true, '/api/community/info says a poll here can offer Other');
    {
        const made = await makePoll({});
        assert(made.status === 200 && made.body.post?.pollOptions?.length === 2 && !made.body.post.pollOptions.some((o: any) => o.other), 'a poll that does not ask has no Other');
        const v = await vote(made.body.post.id, 'opt_1', plain);
        assert(v.status === 200 && v.body.post.userVotedOptionId === 'opt_1', 'and votes as before: the voter is told their choice');
        const row = db.prepare('SELECT option_id FROM poll_votes WHERE post_id = ?').get(made.body.post.id) as any;
        assert(row.option_id === 'opt_1', 'and its vote row keeps the choice, as every poll before this');
        const again = await vote(made.body.post.id, 'opt_2', plain);
        assert(again.status === 200 && again.body.post.userVotedOptionId === 'opt_2', 'and a vote on it can still be changed');
        const word = await vote(made.body.post.id, 'opt_1', plain, 'words on a plain poll');
        assert(word.status === 400, 'a poll with no Other takes no typed words');
        const stringy = await makePoll({ pollOther: 'true' });
        assert(!stringy.body.post.pollOptions.some((o: any) => o.other), 'only `true` offers Other');
    }

    console.log('── an anonymous poll with Other ──');
    const made = await makePoll({ pollOther: true });
    assert(made.status === 200, `the maker makes a poll with Other (got ${made.status} ${made.text.slice(0, 120)})`);
    const pollId = made.body.post.id as string;
    keep = pollId;
    const otherOption = made.body.post.pollOptions.find((o: any) => o.other === true);
    assert(made.body.post.pollOptions.length === 3 && made.body.post.pollOptions[2].id === otherOption?.id, 'Other is the last answer');
    assert(otherOption?.text === 'Other' && /^[a-zA-Z0-9_-]{1,32}$/.test(otherOption.id), 'its id fits the id rule');
    clearRoom();
    const forged = await post('/api/marketplace/posts', { type: 'poll', category: 'community', title: 'forged other', description: '', authorPublicKey: reader.pubKeyHex,
        pollOptions: [{ id: 'a', text: 'A', other: true }, { id: 'b', text: 'B' }], durationDays: 3 }, reader);
    assert(forged.status === 200 && !forged.body.post.pollOptions.some((o: any) => o.other), 'a client cannot mark an answer as Other: only the node does');
    const named = await makePoll({ pollOther: true, pollOptions: [{ id: 'a', text: 'Buses' }, { id: 'b', text: 'other' }] }, plain);
    assert(named.status === 400 && /already offers Other/.test(named.body?.error ?? ''), `an answer called Other beside Other is refused (${named.text.slice(0, 80)})`);

    const sockets = {
        member: await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(reader)}`),
        control: await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(control)}`),
        unsigned: await openSocket(`${BASE.replace('https', 'wss')}/ws`),
    };
    await sleep(200);

    {
        const oldApp = await vote(pollId, otherOption.id, typist);
        assert(oldApp.status === 400 && /update the app/.test(oldApp.body.error), `an app too old to type gets words, not a broken vote (got ${oldApp.text.slice(0, 100)})`);
        const blank = await vote(pollId, otherOption.id, typist, '   ​  ');
        assert(blank.status === 400, 'words that are only spaces are no words');
        const long = await vote(pollId, otherOption.id, typist, 'x'.repeat(POLL_OTHER_WORDS_MAX + 1));
        assert(long.status === 400, `a typed answer over ${POLL_OTHER_WORDS_MAX} characters is refused`);
        const onPlain = await vote(pollId, 'opt_1', typist, 'words on a plain answer');
        assert(onPlain.status === 400, 'a plain answer takes no words');
        assert((db.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE post_id = ?').get(pollId) as any).c === 0
            && (db.prepare('SELECT COUNT(*) AS c FROM poll_answers WHERE post_id = ?').get(pollId) as any).c === 0, 'and none of those stored anything');
    }

    const v1 = await vote(pollId, otherOption.id, typist, `  ${WORDS}\n`, { signature: undefined });
    assert(v1.status === 200, `a member answers Other with typed words (got ${v1.status} ${v1.text.slice(0, 120)})`);
    assert(v1.body.post.pollAnswered === true && v1.body.post.userVotedOptionId === undefined, 'they are told they answered, and not which: nothing here can say');
    assert(!v1.text.includes(WORDS), 'the vote answer does not repeat the words');
    const v2 = await vote(pollId, otherOption.id, typist2, WORDS_2);
    const v3 = await vote(pollId, 'opt_1', plain);
    assert(v2.status === 200 && v3.status === 200, 'another Other and a plain answer go in');
    await sleep(300);

    console.log('── the database: no link from a voter to an answer ──');
    {
        const ballots = db.prepare('SELECT * FROM poll_votes WHERE post_id = ?').all(pollId) as any[];
        assert(ballots.length === 3 && ballots.every(b => b.option_id === 'sealed'), 'each ballot says only that its voter answered: a plain answer and Other look the same');
        assert(ballots.every(b => b.signature === ''), 'no ballot keeps a signature, which could be tested against each answer');
        assert(ballots.every(b => b.other_answer_id === null), 'no ballot points at an answer');
        const columns = (db.prepare(`SELECT name FROM pragma_table_info('poll_answers')`).all() as any[]).map(c => c.name).sort();
        assert(JSON.stringify(columns) === JSON.stringify(['id', 'option_id', 'post_id', 'words', 'words_removed']), `poll_answers has no voter and no time: ${columns.join(' ')}`);
        const made2 = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'poll_answers'`).get() as any).sql as string;
        assert(/WITHOUT ROWID/i.test(made2), 'and no rowid, which would keep the order of arrival');
        const rows = db.prepare('SELECT id FROM poll_answers WHERE post_id = ?').all(pollId) as any[];
        assert(rows.every(r => /^[0-9a-f]{32}$/.test(r.id)), 'each answer has a random id');
        const dump = JSON.stringify(db.prepare('SELECT * FROM poll_answers WHERE post_id = ?').all(pollId));
        assert(!dump.includes(typist.pubKeyHex) && !dump.includes('TypistTess'), 'and no row carries the voter');
        const twice = await vote(pollId, 'opt_2', typist);
        assert(twice.status === 400 && /already answered/.test(twice.body.error), 'a second answer is refused, in words: nothing can find the first to change it');
        assert((db.prepare('SELECT COUNT(*) AS c FROM poll_answers WHERE post_id = ?').get(pollId) as any).c === 3, 'and stored nothing');
    }

    console.log('── every read: the count, and never the words ──');
    {
        const byIdPath = `/api/marketplace/posts?id=${pollId}`;
        const byId = await get(byIdPath, reader);
        const voterRead = await get(byIdPath, typist);
        const reads: Record<string, { status: number; text: string }> = {
            board: await get('/api/marketplace/posts', reader), typeFilter: await get('/api/marketplace/posts?type=poll', reader),
            sync: await get('/api/marketplace/posts?sync=true', reader), delta: await get('/api/marketplace/posts?updatedAfter=2000-01-01T00:00:00.000Z', reader),
            search: await get(`/api/marketplace/posts?q=${WORDS.slice(0, 12)}&type=poll`, reader),
            byId, voterRead, makerRead: await get(byIdPath, maker), ownerRead: await get(byIdPath, owner), adminRead: await get(byIdPath, admin),
            unsigned: await get(byIdPath), stranger: await get(byIdPath, control),
        };
        for (const [name, r] of Object.entries(reads)) {
            assert(!r.text.includes(WORDS) && !r.text.includes(WORDS_2), `${name}: no words (status ${r.status})`);
        }
        assert(reads.board.text.includes(pollId) && reads.sync.text.includes(pollId) && reads.delta.text.includes(pollId), 'and those reads did carry the poll (the checks above can fail)');
        assert(!reads.search.text.includes(pollId), 'a search for the words finds no poll');
        const opts = first(byId.body)?.pollOptions ?? [];
        assert(opts.find((o: any) => o.other)?.votes === 2 && opts[0].votes === 1, `a member sees how many chose Other: ${JSON.stringify(opts.map((o: any) => o.votes))}`);
        assert(first(byId.body)?.totalVotes === 3, 'the total counts every answer');
        assert(!(byId.text.includes('pollAnswered')), "a member who hasn't answered isn't told they have");
        assert(first(voterRead.body)?.pollAnswered === true, 'the voter is, on a fresh read');
        for (const [name, s] of Object.entries(sockets)) {
            const all = s.raw.join('\n');
            assert(!all.includes(WORDS) && !all.includes(WORDS_2) && !all.includes('pollAnswered') && !all.includes('userVotedOptionId'), `socket ${name}: no words, nothing of the voter's own`);
        }
        assert(sockets.member.raw.join('').includes(pollId), 'the member socket did hear of the poll (the check above can fail)');
    }

    console.log('── the words: maker and owners, and on an anonymous poll only once closed ──');
    const wordsPath = `/api/marketplace/posts/${pollId}/other-answers`;
    {
        const reads = { member: await get(wordsPath, reader), voter: await get(wordsPath, typist), admin: await get(wordsPath, admin), control: await get(wordsPath, control), unsigned: await get(wordsPath) };
        assert(reads.member.status === 403 && reads.voter.status === 403 && reads.admin.status === 403, 'a member, the voter and an admin are refused');
        assert(reads.control.status === 401 || reads.control.status === 403, `a key from nowhere is refused (${reads.control.status})`);
        assert(reads.unsigned.status === 401 || reads.unsigned.status === 403, `nobody is refused (${reads.unsigned.status})`);
        for (const r of Object.values(reads)) assert(!r.text.includes(WORDS), 'and gets no words');
        const held = await get(wordsPath, maker);
        assert(held.status === 200 && held.body.state === 'held' && held.body.answers.length === 0 && held.body.count === 2, 'while it is open the maker gets the count, and no words');
        const heldOwner = await get(wordsPath, owner);
        assert(heldOwner.body.state === 'held' && heldOwner.body.answers.length === 0 && !heldOwner.text.includes(WORDS), 'and so does an owner');
    }
    closePoll(pollId, maker.pubKeyHex);
    {
        const open = await get(wordsPath, maker);
        assert(open.status === 200 && open.body.state === 'open' && open.body.answers.length === 2, 'once closed the maker reads them');
        const texts = open.body.answers.map((a: any) => a.words).sort();
        assert(JSON.stringify(texts) === JSON.stringify([WORDS_2, WORDS].sort()), `the words as typed, trimmed: ${texts.join(' | ')}`);
        assert(open.body.answers.every((a: any) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(['id', 'reported', 'words'])), 'each line is its id, its words and whether it is reported: no time, no person');
        assert(JSON.stringify(Object.keys(open.body).sort()) === JSON.stringify(['answers', 'canRemove', 'count', 'removed', 'state']), 'the answer has no other field');
        const ids = open.body.answers.map((a: any) => a.id);
        assert(JSON.stringify(ids) === JSON.stringify([...ids].sort()), 'they come in the order of their random ids, not of arrival');
        assert(!open.text.includes(typist.pubKeyHex) && !open.text.includes('Tess'), 'nothing names the voter');
        const ownerRead = await get(wordsPath, owner);
        assert(ownerRead.body.answers.length === 2 && ownerRead.body.canRemove === true, 'an owner reads them too, and may remove one');
        assert(open.body.canRemove === false, 'the maker may not');
        const afterMember = await get(wordsPath, reader);
        const afterAdmin = await get(wordsPath, admin);
        assert(afterMember.status === 403 && afterAdmin.status === 403 && !afterMember.text.includes(WORDS) && !afterAdmin.text.includes(WORDS), 'closed, a member and an admin are still refused');
    }

    console.log('── a report names the line, never a person, and holds no words ──');
    {
        const open = await get(wordsPath, maker);
        const line = open.body.answers.find((a: any) => a.words === WORDS);
        const byMember = await post(`${wordsPath}/${line.id}/report`, {}, reader);
        assert(byMember.status === 403, 'a member cannot report what they cannot read');
        const byAdmin = await post(`${wordsPath}/${line.id}/report`, {}, admin);
        assert(byAdmin.status === 403, 'nor an admin');
        const filed = await post(`${wordsPath}/${line.id}/report`, {}, maker);
        assert(filed.status === 200 && filed.body.duplicate === false, 'the maker reports a line');
        const again = await post(`${wordsPath}/${line.id}/report`, {}, maker);
        assert(again.status === 200 && again.body.duplicate === true, 'once');
        const row = db.prepare(`SELECT * FROM abuse_reports WHERE reporter_pubkey = ?`).get(maker.pubKeyHex) as any;
        const raw = JSON.stringify(row);
        assert(row.target_pubkey === 'SYSTEM' && row.target_post_id === null, 'the report is about nobody, and no post of the maker\'s');
        assert(!raw.includes(WORDS) && !raw.includes(typist.pubKeyHex), 'it holds no words and no voter');
        const queue = JSON.stringify(getReports('pending'));
        assert(!queue.includes(WORDS) && !queue.includes(typist.pubKeyHex) && queue.includes('typed answer'), 'the queue an admin reads says a typed answer was reported, and not what it says');
        const list = await get(wordsPath, owner);
        assert(list.body.answers.find((a: any) => a.id === line.id).reported === true, 'the owner sees which line is reported');
        const beforeStatus = getMember(maker.pubKeyHex)?.status;
        await actionReport(row.id, false, true);
        assert(getMember(maker.pubKeyHex)?.status === beforeStatus && getMember('SYSTEM')?.status !== 'disabled', 'actioning it with a suspension pauses nobody');
        db.prepare(`UPDATE abuse_reports SET status = 'pending' WHERE id = ?`).run(row.id);
    }

    console.log('── an owner removes a line; the vote still counts ──');
    {
        const open = await get(wordsPath, owner);
        const line = open.body.answers.find((a: any) => a.words === WORDS);
        const byMaker = await post(`${wordsPath}/${line.id}/remove`, {}, maker);
        assert(byMaker.status === 403, 'the maker cannot remove one');
        const byAdmin = await post(`${wordsPath}/${line.id}/remove`, {}, admin);
        assert(byAdmin.status === 403, 'nor an admin');
        const before = (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(pollId) as any).updated_at;
        await sleep(5);
        const removed = await post(`${wordsPath}/${line.id}/remove`, {}, owner);
        assert(removed.status === 200, 'an owner removes it');
        const row = db.prepare('SELECT words, words_removed FROM poll_answers WHERE post_id = ? AND id = ?').get(pollId, line.id) as any;
        assert(row.words === null && row.words_removed === 1, 'its words are gone from the row');
        assert((db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(pollId) as any).updated_at > before, 'the poll moves, so a standby hears');
        const after = await get(wordsPath, maker);
        assert(after.body.answers.length === 1 && after.body.removed === 1 && !after.text.includes(WORDS), 'the maker no longer reads it, and is told one was removed');
        const count = await get(`/api/marketplace/posts?id=${pollId}`, reader);
        assert(first(count.body).pollOptions.find((o: any) => o.other).votes === 2, 'the count stays');
        const reports = db.prepare(`SELECT status FROM abuse_reports WHERE reporter_pubkey = ?`).get(maker.pubKeyHex) as any;
        assert(reports.status === 'actioned', 'and its report is done');
        const gone = await post(`${wordsPath}/${line.id}/remove`, {}, owner);
        assert(gone.status === 404, 'a removed line is not there to remove');
    }

    console.log('── an open vote: named anyway, so its words read at once, and a changed vote takes them ──');
    {
        const openPoll = await makePoll({ pollOther: true, pollOpenVote: true });
        const id = openPoll.body.post.id as string;
        const other = openPoll.body.post.pollOptions.find((o: any) => o.other);
        const v = await vote(id, other.id, typist, WORDS_OPEN);
        assert(v.status === 200 && v.body.post.userVotedOptionId === other.id && !v.text.includes(WORDS_OPEN), 'an open vote keeps the choice, and the answer repeats no words');
        const row = db.prepare('SELECT option_id, other_answer_id FROM poll_votes WHERE post_id = ?').get(id) as any;
        assert(row.option_id === other.id && !!row.other_answer_id, 'its vote row names the answer: it is an open vote');
        const list = await get(`/api/marketplace/posts/${id}/other-answers`, maker);
        assert(list.body.state === 'open' && list.body.answers[0]?.words === WORDS_OPEN, 'the maker reads it while the poll is open');
        const member = await get(`/api/marketplace/posts/${id}/other-answers`, reader);
        assert(member.status === 403 && !member.text.includes(WORDS_OPEN), 'a member sees who chose Other on an open vote, and still not the words');
        const board = await get(`/api/marketplace/posts?id=${id}`, reader);
        assert(!board.text.includes(WORDS_OPEN) && board.text.includes(typist.pubKeyHex), 'the voters list names them, with no words');
        const changed = await vote(id, 'opt_1', typist);
        assert(changed.status === 200, 'a vote on an open vote can change');
        assert((db.prepare('SELECT COUNT(*) AS c FROM poll_answers WHERE post_id = ?').get(id) as any).c === 0, 'and the words go with it');
        assert((db.prepare('SELECT other_answer_id FROM poll_votes WHERE post_id = ?').get(id) as any).other_answer_id === null, 'and the link');
    }

    console.log('── switching Other, before the first vote ──');
    {
        const p = await makePoll({});
        const id = p.body.post.id as string;
        const patch = (updates: Record<string, unknown>) => post('/api/marketplace/posts/update', { id, authorPublicKey: maker.pubKeyHex, ...updates }, maker);
        const read = async () => first((await get(`/api/marketplace/posts?id=${id}`, maker)).body);
        await patch({ pollOther: true });
        const on = await read();
        const added = on.pollOptions.find((o: any) => o.other);
        assert(!!added && on.pollOptions.length === 3 && !on.pollOptions.some((o: any) => o.id === 'opt_1'), 'Other can be added: every answer takes a new id');
        await patch({ pollOptions: [{ id: 'n1', text: 'Trains' }, { id: 'n2', text: 'Beans' }] });
        const edited = await read();
        const kept = edited.pollOptions.find((o: any) => o.other);
        assert(!!kept && kept.id !== added.id && edited.pollOptions.length === 3, 'a new list of answers keeps Other, under a new id');
        await patch({ pollOther: false });
        const off = await read();
        assert(!off.pollOptions.some((o: any) => o.other) && off.pollOptions.length === 2, 'and it can be taken away');
    }

    console.log('── a poll changed after a vote can\'t turn an anonymous Other into a named one ──');
    {
        const p = await makePoll({ pollOther: true });
        const id = p.body.post.id as string;
        const other = p.body.post.pollOptions.find((o: any) => o.other);
        const patch = (updates: Record<string, unknown>) => post('/api/marketplace/posts/update', { id, authorPublicKey: maker.pubKeyHex, ...updates }, maker);
        const flip = await patch({ pollOpenVote: true });
        assert(flip.status === 200, `before any vote the ballot can flip (${flip.status} ${flip.text.slice(0, 100)})`);
        const afterFlip = flip.body.post ?? first((await get(`/api/marketplace/posts?id=${id}`, maker)).body);
        const newOther = afterFlip.pollOptions.find((o: any) => o.other);
        assert(!!newOther && newOther.id !== other.id, 'and Other gets a new id');
        assert(!afterFlip.pollOptions.some((o: any) => o.id === 'opt_1'), 'and so does every answer');
        const stale = await vote(id, other.id, typist, 'from a card that said anonymous');
        assert(stale.status === 400 && (db.prepare('SELECT COUNT(*) AS c FROM poll_answers WHERE post_id = ?').get(id) as any).c === 0, 'a card that said Anonymous is refused, and stores nothing');
        const staleRegular = await vote(id, 'opt_1', typist);
        assert(staleRegular.status === 400, 'so is its plain answer');
        const back = await patch({ pollOpenVote: false });
        const backOther = (back.body.post ?? first((await get(`/api/marketplace/posts?id=${id}`, maker)).body)).pollOptions.find((o: any) => o.other);
        const v = await vote(id, backOther.id, typist, WORDS);
        assert(v.status === 200, 'a fresh card votes');
        const flipAfter = await patch({ pollOpenVote: true });
        assert(flipAfter.status === 400, 'from the first vote the ballot is fixed');
        const off = await patch({ pollOther: false });
        assert(off.status === 400, 'and so is whether it offers Other');
        const options = await patch({ pollOptions: [{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }] });
        assert(options.status === 400, 'and its answers');
        assert((db.prepare('SELECT poll_open_vote FROM posts WHERE id = ?').get(id) as any).poll_open_vote === 0, 'it is still anonymous');
    }

    console.log('── closing, and a poll past its time ──');
    {
        const p = await makePoll({ pollOther: true });
        const id = p.body.post.id as string;
        const other = p.body.post.pollOptions.find((o: any) => o.other);
        await vote(id, other.id, typist, WORDS);
        db.prepare(`UPDATE posts SET poll_closes_at = '2001-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
        const read = await get(`/api/marketplace/posts/${id}/other-answers`, maker);
        assert(read.body.state === 'open' && read.body.answers.length === 1, 'past its closing time the words read, before the sweep reaches it');
        // A paused poll's status never reads as closed, so the time alone says it.
        db.prepare(`UPDATE posts SET status = 'paused' WHERE id = ?`).run(id);
        const paused = await get(`/api/marketplace/posts/${id}/other-answers`, maker);
        assert(paused.body.state === 'open', 'and so do a poll paused past its time');
        db.prepare(`UPDATE posts SET status = 'active' WHERE id = ?`).run(id);
        closeExpiredPolls();
    }

    console.log('── a removed poll, and a group nobody here can see ──');
    {
        const p = await makePoll({ pollOther: true });
        const id = p.body.post.id as string;
        const other = p.body.post.pollOptions.find((o: any) => o.other);
        await vote(id, other.id, typist, WORDS);
        closePoll(id, maker.pubKeyHex);
        db.prepare(`UPDATE posts SET active = 0, status = 'cancelled' WHERE id = ?`).run(id);
        const read = await get(`/api/marketplace/posts/${id}/other-answers`, owner);
        assert(read.status === 404 && !read.text.includes(WORDS), 'a removed poll has no words to read');
    }

    console.log('── a removed poll takes its words ──');
    {
        // Nothing hard-deletes a poll and foreign keys are off (db/db.ts), so its rows outlive it: the words have to be taken.
        const wordsLeft = (id: string) => (db.prepare('SELECT COUNT(*) AS c FROM poll_answers WHERE post_id = ? AND words IS NOT NULL').get(id) as any).c;
        const openWithLine = async (by: Id) => {
            const p = await makePoll({ pollOther: true, pollOpenVote: true }, by);
            const id = p.body.post.id as string;
            await vote(id, p.body.post.pollOptions.find((o: any) => o.other).id, typist, WORDS);
            assert(wordsLeft(id) === 1, 'a line is there to start with');
            return id;
        };

        const byMaker = await openWithLine(maker);
        const list = await get(`/api/marketplace/posts/${byMaker}/other-answers`, maker);
        await post(`/api/marketplace/posts/${byMaker}/other-answers/${list.body.answers[0].id}/report`, {}, maker);
        const before = (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(byMaker) as any).updated_at;
        await sleep(5);
        const removed = await post('/api/marketplace/posts/remove', { id: byMaker, authorPublicKey: maker.pubKeyHex }, maker);
        assert(removed.status === 200 && removed.body?.success === true, `its maker removes the poll (${removed.status})`);
        assert(wordsLeft(byMaker) === 0, 'and the words go from the table');
        assert(!JSON.stringify((await exportSyncState('test-node') as any).posts.find((p: any) => p.id === byMaker)).includes(WORDS), 'and from what a standby is sent');
        assert((db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(byMaker) as any).updated_at > before, 'and the poll moves, so a standby hears');
        const pendingReports = (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE json_extract(disclosure, '$.postId') = ? AND status = 'pending'`).get(byMaker) as any).c;
        assert(pendingReports === 0, 'and a report of its line waits for nobody');

        const byAdmin = await openWithLine(maker);
        adminDeletePost(byAdmin);
        assert(wordsLeft(byAdmin) === 0, "an admin's removal takes them too");
    }

    console.log('── gone for good: from the disk too ──');
    {
        // The WAL holds a row as it was until a checkpoint, on a quiet node for days (db/wal-truncate.ts).
        const onDisk = (s: string) => ['', '-wal'].some(end => { try { return fs.readFileSync(db.name + end).includes(s); } catch { return false; } });
        const lineOf = async (words: string) => {
            const p = await makePoll({ pollOther: true, pollOpenVote: true });
            const id = p.body.post.id as string;
            await vote(id, p.body.post.pollOptions.find((o: any) => o.other).id, typist, words);
            assert(onDisk(words), 'a line is on the disk to start with');
            return { id, plain: p.body.post.pollOptions.find((o: any) => !o.other).id as string };
        };
        const byOwner = await lineOf('Removed-by-an-owner-so-gone');
        const listed = await get(`/api/marketplace/posts/${byOwner.id}/other-answers`, owner);
        await post(`/api/marketplace/posts/${byOwner.id}/other-answers/${listed.body.answers[0].id}/remove`, {}, owner);
        assert(!onDisk('Removed-by-an-owner-so-gone'), "an owner's Remove leaves no copy in the database or its WAL");
        const takenBack = await lineOf('Taken-back-by-changing-the-vote');
        await vote(takenBack.id, takenBack.plain, typist);
        assert(!onDisk('Taken-back-by-changing-the-vote'), 'nor does a changed vote');
        const withPoll = await lineOf('Went-with-the-poll-it-was-on');
        await post('/api/marketplace/posts/remove', { id: withPoll.id, authorPublicKey: maker.pubKeyHex }, maker);
        assert(!onDisk('Went-with-the-poll-it-was-on'), 'nor does removing the poll');
    }

    console.log('── an account deleted ──');
    {
        const leaver = seed('LeaverLou');
        const open = await makePoll({ pollOther: true, pollOpenVote: true });
        const openId = open.body.post.id as string;
        const openOther = open.body.post.pollOptions.find((o: any) => o.other);
        await vote(openId, openOther.id, leaver, 'Named-by-the-vote-row');
        await vote(openId, openOther.id, typist, WORDS_OPEN);
        const sealed = await makePoll({ pollOther: true }, typist2);
        const sealedId = sealed.body.post.id as string;
        await vote(sealedId, sealed.body.post.pollOptions.find((o: any) => o.other).id, leaver, 'Nothing-says-whose');
        const leaverLine = (await get(`/api/marketplace/posts/${openId}/other-answers`, maker)).body.answers.find((a: any) => a.words === 'Named-by-the-vote-row');
        await post(`/api/marketplace/posts/${openId}/other-answers/${leaverLine.id}/report`, {}, maker);
        const keptLine = (await get(`/api/marketplace/posts/${openId}/other-answers`, maker)).body.answers.find((a: any) => a.words === WORDS_OPEN);
        await post(`/api/marketplace/posts/${openId}/other-answers/${keptLine.id}/report`, {}, maker);
        const before = (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(openId) as any).updated_at;
        await sleep(5);
        purgeMemberSelf(leaver.pubKeyHex);
        const openWords = (db.prepare('SELECT words FROM poll_answers WHERE post_id = ?').all(openId) as any[]).map(r => r.words);
        assert(!openWords.includes('Named-by-the-vote-row') && openWords.includes(WORDS_OPEN), "an open vote's row says which line was theirs: only that line goes");
        const read = await get(`/api/marketplace/posts/${openId}/other-answers`, maker);
        assert(read.body.count === 2 && read.body.answers.length === 1 && read.body.removed === 1, 'their vote still counts, and the panel says one was removed');
        assert((db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(openId) as any).updated_at > before, 'and the poll moves, so a standby hears');
        const leaverReports = (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE json_extract(disclosure, '$.answerId') = ? AND status = 'pending'`).get(leaverLine.id) as any).c;
        const keptReports = (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE json_extract(disclosure, '$.answerId') = ? AND status = 'pending'`).get(keptLine.id) as any).c;
        assert(leaverReports === 0 && keptReports === 1, "and a report of that line waits for nobody, while another line's still does");
        const sealedWords = (db.prepare('SELECT words FROM poll_answers WHERE post_id = ?').all(sealedId) as any[]).map(r => r.words);
        assert(sealedWords.includes('Nothing-says-whose'), 'a sealed line stays: nothing says it was theirs, as the guide tells them');
    }

    console.log("── a line keeps the letters it is written in ──");
    {
        const p = await makePoll({ pollOther: true, pollOpenVote: true });
        const id = p.body.post.id as string;
        const other = p.body.post.pollOptions.find((o: any) => o.other);
        const persian = 'می\u200cخواهم';
        const farmer = '\u{1F469}\u200d\u{1F33E}';
        await vote(id, other.id, typist, `${persian} ${farmer}`);
        const kept = (await get(`/api/marketplace/posts/${id}/other-answers`, maker)).body.answers[0]?.words;
        assert(kept === `${persian} ${farmer}`, 'a joiner stays: Persian words and emoji are written with them');
        await vote(id, other.id, typist, 'left\u202Eright\u2066\u200Band\u061Cmore\nnext');
        const cleaned = (await get(`/api/marketplace/posts/${id}/other-answers`, maker)).body.answers[0]?.words as string;
        assert(!/[\u202E\u2066\u200B\u061C\n]/.test(cleaned), 'what changes how a line reads without showing still goes');
    }

    console.log('── a standby\'s copy ──');
    {
        const openOne = await makePoll({ pollOther: true, pollOpenVote: true });
        const standbyOpenPoll = openOne.body.post.id as string;
        await vote(standbyOpenPoll, openOne.body.post.pollOptions.find((o: any) => o.other).id, typist, WORDS_OPEN);
        const payload = await exportSyncState('test-node') as any;
        const copied = payload.posts.find((p: any) => p.id === pollId);
        assert(Array.isArray(copied?.pollAnswers) && copied.pollAnswers.length === 3, 'a poll carries its answers to a standby');
        const raw = JSON.stringify(copied.pollAnswers);
        assert(!raw.includes(typist.pubKeyHex) && !raw.includes('createdAt') && !raw.includes('created_at'), 'with no voter and no time');
        const ids = copied.pollAnswers.map((a: any) => a.id);
        assert(JSON.stringify(ids) === JSON.stringify([...ids].sort()), 'in random-id order');
        assert(!raw.includes(WORDS), 'and a removed line stays removed there');
        assert(raw.includes(WORDS_2), 'the rest of the words go, since a standby holds the whole node');
        const ballots = payload.pollVotes.filter((v: any) => v.postId === pollId);
        assert(ballots.length === 3 && ballots.every((b: any) => b.optionId === 'sealed' && !b.otherAnswerId && b.signature === ''), 'and its ballots go as they are: no choice');
        // An open vote's link to its words goes too, or a changed vote after a take-over leaves the old words behind.
        const openBallot = payload.pollVotes.find((v: any) => v.postId === standbyOpenPoll);
        assert(typeof openBallot?.otherAnswerId === 'string' && openBallot.otherAnswerId.length === 32, 'an open vote carries its link to its words');
        // The importer writes them back: test-takeover-parity, on a standby that takes over.
        const plainAnswer = openOne.body.post.pollOptions.find((o: any) => !o.other).id;
        await vote(standbyOpenPoll, plainAnswer, typist);
        const emptied = (await exportSyncState('test-node') as any).posts.find((p: any) => p.id === standbyOpenPoll);
        assert(Array.isArray(emptied?.pollAnswers) && emptied.pollAnswers.length === 0, 'with its last line gone a poll says it holds none, so a standby drops it too');
        const noOther = await makePoll({});
        const noOtherCopy = (await exportSyncState('test-node') as any).posts.find((p: any) => p.id === noOther.body.post.id);
        assert(noOtherCopy && !('pollAnswers' in noOtherCopy), 'a poll with no Other carries no such field');
    }

    console.log('── a report of another kind is never parsed for a poll ──');
    {
        // A DM line's report keeps what its reporter handed over, up to ~1.25 MB with a voice part (engine/dm-line-report.ts),
        // and reports are never deleted. A read of a poll's lines, the archive sweep's wait and the trigger a removed poll fires
        // test how a disclosure begins before a JSON function reads it. SQLite's own json_valid and json_extract are wrapped
        // here to count what they are handed; each still answers as SQLite's own, from a second connection.
        const { default: Database } = await import('better-sqlite3');
        const { pollLineReportWaitsSql } = await import('./engine/poll-other.js');
        const side = new Database(':memory:');
        const realValid = side.prepare('SELECT json_valid(?)').pluck();
        const realExtract = side.prepare('SELECT json_extract(?, ?)').pluck();
        const dmShaped = JSON.stringify({ kind: 'dm-line', v: 1, ciphertext: 'A'.repeat(100_000), nonce: 'n', conversationId: 'c', words: 'planted', voice: { ciphertext: 'B'.repeat(100_000), nonce: 'n' } });
        const groupShaped = JSON.stringify({ epoch: 1, mk: 'planted' });
        const plantedIds = [crypto.randomUUID(), crypto.randomUUID()];
        const plantRow = db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at, status)
            VALUES (?, ?, ?, ?, ?, 'Harassment', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending')`);
        plantRow.run(plantedIds[0], reader.pubKeyHex, typist.pubKeyHex, crypto.randomUUID(), dmShaped);
        plantRow.run(plantedIds[1], reader.pubKeyHex, typist2.pubKeyHex, crypto.randomUUID(), groupShaped);
        const parsed = { others: 0, polls: 0 };
        const seen = (d: unknown) => {
            if (d === dmShaped || d === groupShaped) parsed.others++;
            else if (typeof d === 'string' && d.startsWith('{"kind":"poll-answer",')) parsed.polls++;
        };
        db.function('json_valid', { deterministic: true }, (d: unknown) => (seen(d), realValid.get(d)));
        db.function('json_extract', { deterministic: true }, (d: unknown, p: unknown) => (seen(d), realExtract.get(d, p)));
        const counted = async <T>(f: () => T | Promise<T>): Promise<{ value: T; others: number; polls: number }> => {
            parsed.others = 0;
            parsed.polls = 0;
            const value = await f();
            return { value, ...parsed };
        };

        const p = await makePoll({ pollOther: true, pollOpenVote: true });
        const id = p.body.post.id as string;
        await vote(id, p.body.post.pollOptions.find((o: any) => o.other).id, typist, 'Parsed-only-as-a-poll-line');
        const line = (await get(`/api/marketplace/posts/${id}/other-answers`, maker)).body.answers[0];
        const filed = await post(`/api/marketplace/posts/${id}/other-answers/${line.id}/report`, {}, maker);
        assert(filed.status === 200 && filed.body?.duplicate === false, `the maker reports the line (${filed.status})`);
        const filedDisclosure = JSON.stringify({ kind: 'poll-answer', postId: id, answerId: line?.id });

        const read = await counted(() => get(`/api/marketplace/posts/${id}/other-answers`, maker));
        assert(read.value.body.answers[0]?.reported === true && read.polls > 0 && read.others === 0,
            `a read of the poll's lines finds its reported line, parsing ${read.polls} poll report value(s) and ${read.others} of another kind`);
        // The sweep asks it of every poll it might archive, most with no report: an EXISTS that finds none reads every report.
        const waitsFor = db.prepare(`SELECT ${pollLineReportWaitsSql('?')} AS w`).pluck();
        const waits = await counted(() => [waitsFor.get(id), waitsFor.get(crypto.randomBytes(16).toString('hex'))]);
        assert(JSON.stringify(waits.value) === '[1,0]' && waits.polls > 0 && waits.others === 0,
            `the archive sweep's wait finds the report, and none for a poll without one, parsing ${waits.polls} poll report value(s) and ${waits.others} of another kind`);
        const removed = await counted(() => post('/api/marketplace/posts/remove', { id, authorPublicKey: maker.pubKeyHex }, maker));
        const status = (db.prepare('SELECT status FROM abuse_reports WHERE disclosure = ?').get(filedDisclosure) as any)?.status;
        assert(removed.value.status === 200 && status === 'actioned' && removed.polls > 0 && removed.others === 0,
            `the trigger a removed poll fires closes the report, parsing ${removed.polls} poll report value(s) and ${removed.others} of another kind (${removed.value.status}, ${status})`);
        db.prepare(`DELETE FROM abuse_reports WHERE id IN (?, ?)`).run(...plantedIds);
    }

    console.log('── the only code that reads the words ──');
    {
        // Every source file that selects from poll_answers. A new reader of the words has to be added here on purpose.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const pkgEngine = path.resolve(here, '../../../packages/beanpool-engine/src');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(path.join(dir, e.name))) : e.name.endsWith('.ts') && !e.name.startsWith('test-') ? [path.join(dir, e.name)] : []);
        const readers = [...walk(here), ...walk(pkgEngine)]
            .filter(f => /poll_answers/.test(fs.readFileSync(f, 'utf8')))
            .map(f => path.relative(path.resolve(here, '../../..'), f)).sort();
        const allowed = ['apps/server/src/engine/poll-other.ts', 'apps/server/src/engine/posts.ts', 'apps/server/src/engine/replication-manifest.ts', 'apps/server/src/engine/sync.ts', 'apps/server/src/services/standby-report.ts', 'packages/beanpool-engine/src/posts.ts', 'packages/beanpool-engine/src/sync.ts'];
        assert(JSON.stringify(readers) === JSON.stringify(allowed.sort()), `only these name poll_answers: ${readers.join(', ')}`);
        const countOnly = fs.readFileSync(path.join(pkgEngine, 'posts.ts'), 'utf8');
        assert(/SELECT post_id, option_id, COUNT\(\*\) AS c FROM poll_answers/.test(countOnly) && !/words FROM poll_answers/.test(countOnly), "a read of a post counts answers and never selects their words");
    }

    for (const s of Object.values(sockets)) s.ws.close();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
