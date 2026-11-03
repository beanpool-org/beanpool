/**
 * Every way a poll goes, and what becomes of its typed answers (Marty, 2 Nov: a removed poll takes them with it), over real
 * HTTPS through the real middleware, on one server.
 *
 * Off (`active` 0, where no read finds the poll again): a maker's removal, a convenor's by both routes, a group's close, a
 * moderator's, an owner's bulk delete, a report acted on, the maker deleting their account, an admin removing them, the community
 * removing them, a paused poll's maker leaving, and a path nobody has written yet. After each: no words in the table, in state.db,
 * in its WAL or in what a standby is sent, the lines still counted, and no report waiting. The standby's own result, compared with
 * its main server's: test-takeover-parity.
 *
 * Not off, so the words stay and stay readable, and a report stays open: a maker's close, a closing by time, a pause, a hide by
 * reports and its restore, a suspended maker, a maker who leaves a poll already closed, a voter removed by an admin.
 *
 * A changed open vote takes its line, and a report of it closes with it.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-poll-other-goes.ts (through scripts/run-server-suites.mjs)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import { setMemberPhoto } from '@beanpool/engine';

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
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
type Reply = { status: number; text: string; body: any };
async function send(method: string, p: string, payload: unknown, headers: Record<string, string>): Promise<Reply> {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* */ }
    return { status: res.status, text, body };
}
const get = (p: string, id: Id) => send('GET', p, undefined, signedHeaders('GET', p, '', id));
const post = (p: string, payload: unknown, id: Id) => send('POST', p, payload, signedHeaders('POST', p, JSON.stringify(payload), id));
const del = (p: string, id: Id) => send('DELETE', p, undefined, signedHeaders('DELETE', p, '', id));

async function keySignIn(id: Id): Promise<Record<string, string>> {
    const chal = await send('POST', '/api/local/admin/auth/challenge', {}, {});
    const solved = await send('POST', '/api/local/admin/auth/verify-challenge', {
        challengeId: chal.body?.challengeId, memberPubkey: id.pubKeyHex,
        signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), id.privateKey).toString('hex'),
    }, {});
    const res = await fetch(`${BASE}/api/local/admin/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: solved.body?.handshakeToken }) });
    const session = res.headers.getSetCookie().find(c => c.startsWith('admin_session='))?.match(/^admin_session=([0-9a-f]{64})/)?.[1];
    if (!session) throw new Error(`no admin session for a key: ${res.status}`);
    return { 'X-Admin-Session': session };
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;

async function main() {
    console.log('Every way a poll goes, and its typed answers...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, exportSyncState, tickDecisions } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { closeExpiredPolls } = await import('./engine/posts.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { removalInGraceFromBefore } = await import('./decisions-from-before-test-fixture.js');

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const seed = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`).run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}-${crypto.randomBytes(3).toString('hex')}`);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const owner = seed('OwnerOona');
    const admin = seed('AdminAda');
    const typist = seed('TypistTess');
    const reporter = seed('ReporterRay');
    grantNodeRole(owner.pubKeyHex, 'owner', 'SYSTEM');
    grantNodeRole(admin.pubKeyHex, 'admin', 'SYSTEM');
    const ownerSession = await keySignIn(owner);
    const adminSession = await keySignIn(admin);

    const groupOf = (name: string, people: Array<{ id: Id; role: 'convenor' | 'member' }>): string => {
        const gid = crypto.randomUUID();
        const created = new Date(Date.now() - 10 * DAY).toISOString();
        db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                    VALUES (?, ?, ?, 'guild', ?, ?, 'open', ?, ?)`).run(gid, name, `${name.toLowerCase()}-${gid.slice(0, 6)}`, people[0].id.pubKeyHex, people[0].id.pubKeyHex, created, created);
        people.forEach((p, i) => {
            const at = new Date(Date.now() - (9 - i * 0.1) * DAY).toISOString();
            db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at)
                        VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(gid, p.id.pubKeyHex, p.role, at, at, at);
        });
        return gid;
    };

    type Poll = { id: string; words: string; otherId: string; plainId: string; lineId: string | null };
    /** A poll with Other and one typed line. On an open vote the maker reads the line and reports it. A sealed poll reads nothing yet. */
    const pollWithLine = async (maker: Id, extra: Record<string, unknown> = {}): Promise<Poll> => {
        // A member has one open poll and a node five: each poll here closes the ones before it, which are done with.
        db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll' AND status = 'active'").run();
        const made = await post('/api/marketplace/posts', {
            type: 'poll', category: 'community', title: `What is missing? ${crypto.randomBytes(3).toString('hex')}`, description: '', authorPublicKey: maker.pubKeyHex,
            pollOptions: [{ id: 'opt_1', text: 'Buses' }, { id: 'opt_2', text: 'Beans' }], durationDays: 7, pollOther: true, pollOpenVote: true, ...extra,
        }, maker);
        if (made.status !== 200) throw new Error(`no poll: ${made.status} ${made.text}`);
        const id = made.body.post.id as string;
        const otherId = made.body.post.pollOptions.find((o: any) => o.other).id as string;
        const plainId = made.body.post.pollOptions.find((o: any) => !o.other).id as string;
        const words = `Typed-line-${crypto.randomBytes(6).toString('hex')}`;
        const voted = await post(`/api/marketplace/posts/${id}/vote`, { optionId: otherId, otherWords: words }, typist);
        if (voted.status !== 200) throw new Error(`no vote: ${voted.status} ${voted.text}`);
        if (extra.pollOpenVote === false) return { id, words, otherId, plainId, lineId: null };
        const read = await get(`/api/marketplace/posts/${id}/other-answers`, maker);
        const lineId = read.body.answers[0].id as string;
        const reported = await post(`/api/marketplace/posts/${id}/other-answers/${lineId}/report`, {}, maker);
        if (reported.status !== 200) throw new Error(`no report: ${reported.status} ${reported.text}`);
        return { id, words, otherId, plainId, lineId };
    };

    const onDisk = (s: string) => ['', '-wal'].some(end => { try { return fs.readFileSync(db.name + end).includes(s); } catch { return false; } });
    const reportsOn = (id: string, status: string) => (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE json_extract(disclosure, '$.postId') = ? AND status = ?`).get(id, status) as { c: number }).c;
    const rowOf = (id: string) => db.prepare('SELECT active, status FROM posts WHERE id = ?').get(id) as { active: number; status: string };
    const linesOf = (id: string) => db.prepare('SELECT words, words_removed FROM poll_answers WHERE post_id = ?').all(id) as { words: string | null; words_removed: number }[];

    /** Off, and everything of its words with it. A sealed poll has no report to look at. */
    const wordsGone = async (p: Poll, how: string): Promise<void> => {
        const row = rowOf(p.id);
        assert(row.active === 0, `${how}: the poll is off (${JSON.stringify(row)})`);
        const lines = linesOf(p.id);
        assert(lines.length === 1 && lines[0].words === null && lines[0].words_removed === 1, `${how}: no words in the table, and the line still counts (${JSON.stringify(lines)})`);
        assert(!onDisk(p.words), `${how}: none in state.db or its WAL`);
        const copy = (await exportSyncState('test-node') as any).posts.find((c: any) => c.id === p.id);
        assert(Array.isArray(copy?.pollAnswers) && copy.pollAnswers.length === 1 && !copy.pollAnswers[0].words && copy.pollAnswers[0].wordsRemoved === 1 && !JSON.stringify(copy).includes(p.words),
            `${how}: a standby is sent the same, with no words`);
        if (p.lineId) {
            assert(reportsOn(p.id, 'pending') === 0 && reportsOn(p.id, 'actioned') === 1, `${how}: a report of the line waits for nobody`);
            const report = db.prepare(`SELECT reason, disclosure FROM abuse_reports WHERE json_extract(disclosure, '$.postId') = ?`).get(p.id) as { reason: string; disclosure: string };
            assert(!report.reason.includes(p.words) && !report.disclosure.includes(p.words) && !report.reason.includes(typist.pubKeyHex) && !report.disclosure.includes(typist.pubKeyHex),
                `${how}: and the report never held the words or a voter`);
        }
    };
    /** Not off: the words are where they were, an owner reads them, and a report still waits. */
    const wordsStay = async (p: Poll, how: string): Promise<void> => {
        assert(rowOf(p.id).active === 1, `${how}: the poll is still on`);
        const lines = linesOf(p.id);
        assert(lines.length === 1 && lines[0].words === p.words && lines[0].words_removed === 0, `${how}: the words stay`);
        const byOwner = await get(`/api/marketplace/posts/${p.id}/other-answers`, owner);
        assert(byOwner.status === 200 && byOwner.body.answers?.[0]?.words === p.words && byOwner.body.answers?.[0]?.reported === true, `${how}: an owner reads the line, marked reported`);
        assert(reportsOn(p.id, 'pending') === 1, `${how}: and the report waits`);
    };

    /** An admin removes a member only where the community doesn't vote (the operator's switch): state-engine removalVoteRefusal. */
    const adminRemoves = async (who: Id): Promise<Reply> => {
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.decisions`, 'false');
        const reply = await send('POST', `/api/local/admin/users/${who.pubKeyHex}/prune`, {}, adminSession);
        db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.decisions`);
        return reply;
    };

    console.log('── a removal ──');
    {
        const maker = seed('MakerMo');
        const p = await pollWithLine(maker);
        const r = await post('/api/marketplace/posts/remove', { id: p.id, authorPublicKey: maker.pubKeyHex }, maker);
        assert(r.status === 200 && r.body.success === true, `its maker removes it (${r.status})`);
        await wordsGone(p, "a maker's removal");
        assert((await get(`/api/marketplace/posts/${p.id}/other-answers`, owner)).status === 404, 'and nobody reads it again');
    }
    {
        const convenor = seed('ConvenorCas');
        const maker = seed('MemberMia');
        const group = groupOf('Weavers', [{ id: convenor, role: 'convenor' }, { id: maker, role: 'member' }, { id: typist, role: 'member' }]);
        const inGroup = { audienceScope: 'group', targetGroupId: group };
        const a = await pollWithLine(maker, inGroup);
        const viaGroup = await del(`/api/groups/${group}/posts/${a.id}`, convenor);
        assert(viaGroup.status === 200 && viaGroup.body.success === true, `a convenor deletes it from the group (${viaGroup.status} ${viaGroup.text.slice(0, 80)})`);
        await wordsGone(a, "a convenor's DELETE /api/groups/:id/posts/:postId");
        const b = await pollWithLine(maker, inGroup);
        const viaPost = await post('/api/marketplace/posts/remove', { id: b.id, authorPublicKey: convenor.pubKeyHex }, convenor);
        assert(viaPost.status === 200 && viaPost.body.success === true, `a convenor removes it from the post (${viaPost.status} ${viaPost.text.slice(0, 80)})`);
        await wordsGone(b, "a convenor's /posts/remove");

        const c = await pollWithLine(maker, inGroup);
        const opened = await post(`/api/groups/${group}/decisions`, { effect: 'close_group', title: 'Close the guild', description: 'Because the group needs to decide this.' }, convenor);
        const decision = opened.body?.decision?.id as string;
        for (const voter of [convenor, maker, typist]) await post(`/api/groups/${group}/decisions/${decision}/vote`, { support: true }, voter);
        tickDecisions();
        assert((db.prepare('SELECT status FROM decisions WHERE id = ?').get(decision) as any)?.status === 'executed', `the group votes to close (${(db.prepare('SELECT status FROM decisions WHERE id = ?').get(decision) as any)?.status})`);
        await wordsGone(c, "a group's close");
    }
    {
        const maker = seed('MakerMax');
        const a = await pollWithLine(maker);
        const one = await send('POST', `/api/local/admin/posts/${a.id}/delete`, {}, adminSession);
        assert(one.status === 200, `an admin removes it (${one.status} ${one.text.slice(0, 80)})`);
        await wordsGone(a, "an admin's removal");
        const b = await pollWithLine(maker);
        const bulk = await send('POST', '/api/local/admin/posts/bulk-delete', { postIds: [b.id] }, ownerSession);
        assert(bulk.status === 200 && bulk.body.deletedCount === 1, `an owner bulk-deletes it (${bulk.status} ${bulk.text.slice(0, 80)})`);
        await wordsGone(b, "an owner's bulk delete");
        const c = await pollWithLine(maker);
        const filed = await post('/api/reports', { reporterPubkey: reporter.pubKeyHex, targetPubkey: maker.pubKeyHex, targetPostId: c.id, reason: 'This poll is unkind' }, reporter);
        const reportId = (filed.body?.id ?? filed.body?.report?.id) as string;
        const acted = await send('POST', `/api/local/admin/reports/${reportId}/action`, { deletePost: true }, adminSession);
        assert(acted.status === 200, `a report of the poll is acted on, and the poll goes (${filed.status} ${acted.status} ${acted.text.slice(0, 80)})`);
        await wordsGone(c, 'a report acted on');
    }

    console.log('── its maker leaves while it is open ──');
    {
        const open = seed('LeaverLou');
        const a = await pollWithLine(open);
        const gone = await post('/api/member/purge', {}, open);
        assert(gone.status === 200, `the maker deletes their account (${gone.status} ${gone.text.slice(0, 80)})`);
        await wordsGone(a, 'a maker who deletes their account');
        assert(rowOf(a.id).status === 'completed', 'and the poll closes as it did, votes kept');

        const sealedMaker = seed('LeaverLia');
        const b = await pollWithLine(sealedMaker, { pollOpenVote: false });
        assert((await post('/api/member/purge', {}, sealedMaker)).status === 200, 'so does the maker of a sealed poll');
        await wordsGone(b, "a sealed poll's maker who deletes their account");

        const pausedMaker = seed('LeaverLeo');
        const c = await pollWithLine(pausedMaker);
        const paused = await post('/api/marketplace/posts/pause', { postId: c.id, authorPublicKey: pausedMaker.pubKeyHex }, pausedMaker);
        assert(paused.status === 200 && rowOf(c.id).status === 'paused', `and of a paused poll (${paused.status})`);
        assert((await post('/api/member/purge', {}, pausedMaker)).status === 200, 'who deletes their account');
        await wordsGone(c, "a paused poll's maker who deletes their account");

        const pruned = seed('RemovedRae');
        const d = await pollWithLine(pruned);
        const prune = await adminRemoves(pruned);
        assert(prune.status === 200, `an admin removes the maker (${prune.status} ${prune.text.slice(0, 80)})`);
        await wordsGone(d, 'a maker an admin removes');

        // A removal the community voted for, in its grace window, carried out by the real route. A vote only gets there from a
        // pause now (decisions-from-before-test-fixture.ts), which has its own suites.
        const voted = seed('VotedVal');
        const e = await pollWithLine(voted);
        const removal = removalInGraceFromBefore(owner.pubKeyHex, voted.pubKeyHex, 'Remove VotedVal');
        const carriedOut = await send('POST', `/api/local/admin/decisions/${removal}/accelerate`, {}, adminSession);
        const decisionNow = (db.prepare('SELECT status FROM decisions WHERE id = ?').get(removal) as { status: string }).status;
        assert(carriedOut.status === 200 && decisionNow === 'executed', `the community's removal runs (${carriedOut.status} ${decisionNow} ${carriedOut.text.slice(0, 80)})`);
        await wordsGone(e, 'a maker the community removes');
    }

    console.log('── a path nobody has written yet ──');
    {
        // One statement on its own, in no transaction: the rule is on the row. Every other way a poll could go off is this
        // statement in another file (an enterprise's wind-up, a shop's end: neither can hold a poll today).
        const p = await pollWithLine(seed('MakerMeg'));
        db.prepare("UPDATE posts SET active = 0, status = 'cancelled' WHERE id = ?").run(p.id);
        await sleep(20);
        await wordsGone(p, 'a bare UPDATE of the row');
        const noOther = db.prepare("SELECT COUNT(*) AS c FROM temp.sqlite_master WHERE name = 'poll_off_takes_its_words'").get() as { c: number };
        assert(noOther.c === 1, 'the rule is a TEMP trigger on this connection');
        assert((db.prepare("SELECT COUNT(*) AS c FROM main.sqlite_master WHERE sql LIKE '%poll_words_%'").get() as { c: number }).c === 0, 'and nothing in the file calls a connection function, so an older image boots on it');
    }

    console.log('── closing is not removing ──');
    {
        const maker = seed('MakerMoe');
        const a = await pollWithLine(maker);
        db.prepare('UPDATE posts SET active = 1 WHERE id = ?').run(a.id);
        await wordsStay(a, 'a statement that leaves it on');
        const closed = await post(`/api/marketplace/posts/${a.id}/close`, {}, maker);
        assert(closed.status === 200, `its maker closes it (${closed.status})`);
        await wordsStay(a, "a maker's close");
        const b = await pollWithLine(maker);
        db.prepare('UPDATE posts SET poll_closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), b.id);
        closeExpiredPolls();
        assert(rowOf(b.id).status === 'completed', 'its time runs out');
        await wordsStay(b, 'a closing by time');
        const c = await pollWithLine(maker);
        const paused = await post('/api/marketplace/posts/pause', { postId: c.id, authorPublicKey: maker.pubKeyHex }, maker);
        assert(paused.status === 200 && rowOf(c.id).status === 'paused', `its maker pauses it (${paused.status})`);
        await wordsStay(c, 'a pause');
        const resumed = await post('/api/marketplace/posts/resume', { postId: c.id, authorPublicKey: maker.pubKeyHex }, maker);
        assert(resumed.status === 200 && rowOf(c.id).status === 'active', `and puts it back (${resumed.status})`);
        await wordsStay(c, 'a poll put back');

        const d = await pollWithLine(maker);
        db.prepare("UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(d.id);
        await wordsStay(d, 'a poll hidden by reports');
        const restored = await send('POST', `/api/local/admin/posts/${d.id}/restore`, {}, adminSession);
        assert(restored.status === 200, `a moderator restores it (${restored.status} ${restored.text.slice(0, 80)})`);
        await wordsStay(d, 'a poll restored');
    }
    {
        const held = seed('HeldHal');
        const a = await pollWithLine(held);
        const suspended = await send('POST', `/api/local/admin/users/${held.pubKeyHex}/suspend`, { reason: 'Testing what a suspension leaves alone', reasonCategory: 'other' }, adminSession);
        assert(suspended.status === 200, `an admin suspends the maker (${suspended.status} ${suspended.text.slice(0, 80)})`);
        await wordsStay(a, 'a suspended maker');

        const done = seed('DoneDee');
        const b = await pollWithLine(done);
        await post(`/api/marketplace/posts/${b.id}/close`, {}, done);
        assert((await post('/api/member/purge', {}, done)).status === 200, 'a maker closes their poll, then deletes their account');
        await wordsStay(b, "a closed poll's maker who leaves");

        const voter = seed('VoterVic');
        const maker = seed('MakerMel');
        const c = await pollWithLine(maker);
        await post(`/api/marketplace/posts/${c.id}/vote`, { optionId: c.otherId, otherWords: 'A-voter-who-is-removed' }, voter);
        const pruned = await adminRemoves(voter);
        assert(pruned.status === 200, `an admin removes a voter (${pruned.status})`);
        assert(rowOf(c.id).active === 1 && linesOf(c.id).some(l => l.words === 'A-voter-who-is-removed'), 'their line stays: a vote can bring them back, and only their own deletion takes it');
    }

    console.log('── a changed open vote ──');
    {
        const maker = seed('MakerMay');
        const p = await pollWithLine(maker);
        const changed = await post(`/api/marketplace/posts/${p.id}/vote`, { optionId: p.plainId }, typist);
        assert(changed.status === 200, `the voter changes their vote (${changed.status})`);
        assert(linesOf(p.id).length === 0 && !onDisk(p.words), 'the line goes, from the disk too');
        assert(reportsOn(p.id, 'pending') === 0 && reportsOn(p.id, 'actioned') === 1, 'and a report of it waits for nobody');
        const read = await get(`/api/marketplace/posts/${p.id}/other-answers`, owner);
        assert(read.status === 200 && read.body.answers.length === 0, 'an owner has nothing left to go looking for');

        // Rewriting the line takes the old one the same way, and a report on another line is left alone.
        const q = await pollWithLine(maker);
        const again = seed('TypistTim');
        await post(`/api/marketplace/posts/${q.id}/vote`, { optionId: q.otherId, otherWords: 'A-second-line' }, again);
        const second = (await get(`/api/marketplace/posts/${q.id}/other-answers`, maker)).body.answers.find((a: any) => a.words === 'A-second-line');
        await post(`/api/marketplace/posts/${q.id}/other-answers/${second.id}/report`, {}, maker);
        await post(`/api/marketplace/posts/${q.id}/vote`, { optionId: q.otherId, otherWords: 'A-rewritten-line' }, typist);
        assert(reportsOn(q.id, 'pending') === 1 && reportsOn(q.id, 'actioned') === 1, "a rewritten line's report closes, and another line's stays open");
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
