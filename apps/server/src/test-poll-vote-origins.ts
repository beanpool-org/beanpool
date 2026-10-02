/**
 * Where a poll's votes came from, on the global profile (FABLE-sec-global-abuse LOW-7: many cheap accounts voting). Over
 * REAL HTTPS through the real signature middleware, the open door included: sign-ins are a test key primed into sso.ts's
 * cache and the 12-words door's work is solved here, so no provider is contacted. "The clock" is moved by moving rows
 * back in time (members.joined_at, a post's created_at), which is all the rules read.
 *
 * A poll on the public board says how many of its votes came from new or 12-word accounts (`pollNewOrWordsVotes`) and,
 * when both sides have at least POLL_ORIGINS_SPLIT_MIN votes, how many of each option's (`newOrWordsVotes`). Each vote
 * keeps its voter's kind as they voted (`poll_votes.voter_new_or_words`): new is on probation (engine/probation.ts); 12
 * words is a member who came in by the words door and added no sign-in. Every vote still counts, and nobody is named.
 *
 *   1. every vote is taken, a new account's and a 12-words account's like anyone's; the poll counts all 12, and says 6
 *      came from new or 12-word accounts, 4 / 1 / 1 by option: a sign-in newcomer, a 12-words newcomer, a 12-words member
 *      past probation and a member of 200 days with no kept post count; an established member, a sign-in member past
 *      probation and a moderator who joined yesterday by 12 words don't. The same on the board, by id, to a visitor, in
 *      the vote's own answer and in the /ws `post_updated`; each voter is counted as `probationState` says, and each vote
 *      keeps that kind. The poll is anonymous: nothing in it names a voter
 *   2. the split needs 3 on each side: 1 and 2 votes from new accounts show the total only, 3 shows the split; 4 against 1
 *      and 2 established show the total only, against 3 the split; 3 and none on the other side, the split. An open vote
 *      names its voters to members as before, with nothing about which kind of account each is. A stored split (a
 *      standby's poll_options from an old read) shows nothing where none may be shown
 *   3. at the time of the vote: two voters settling in afterwards (four days and 3 kept posts; eight days, 3 kept posts
 *      and a sign-in added) move nothing, so the poll never says at a public moment that they voted, or how; a changed vote
 *      keeps its first kind; a new poll counts them as they are now
 *   4. where nothing is said: a group's poll on the global node, and every poll on a local community, whose votes keep no kind
 *   5. copies: a stored split never speaks, the split is counted from the votes; a standby's copy carries each vote's
 *      kind; a vote with none kept (from before) counts, and not as a new account's
 *   6. cost: a poll with 2,000 votes is counted in one search of its votes
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-poll-vote-origins.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { solveDoorWorkSync } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, createPost, createGroup, joinGroup, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { nodeSha256 } from './services/door-work.js';
import * as probation from './engine/probation.js';
import { nodeRoleOf } from './engine/node-roles.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const GOOGLE_KID = 'test-poll-vote-origins-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 200)}`;

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
function openSocket(url: string): Promise<{ ws: WebSocket; events: any[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => resolve({ ws, events }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A read of what this change adds, so the suite runs to its end on a server without it and counts what fails there. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`   (${e?.message ?? e})`); return undefined; }
}

const DAY = 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const AVATAR = 'https://example.com/a.jpg';

/** Kept posts from two days ago, out of every window. */
function keptPosts(id: Id, count: number): void {
    for (let i = 0; i < count; i++) {
        const p = createPost('offer', 'other', `${id.name} old ${i}`, 'An old offer', 0, 'fixed', id.pk)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    }
}
/** A member of `daysAgo` days with a photo, written straight in, with `kept` kept posts. */
function oldMember(name: string, daysAgo: number, kept: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', ?, 'active')`).run(id.pk, name, ago(daysAgo * DAY), AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    keptPosts(id, kept);
    return id;
}
/** Joins by 12 words over HTTPS, with a photo. */
async function wordsMember(name: string): Promise<Id> {
    const id = newId(name);
    const w = await call('POST', id, '/api/join/work', { door: 'words' });
    const work = { challenge: w.body?.work?.challenge, counters: solveDoorWorkSync(w.body?.work?.challenge, nodeSha256) };
    const j = await call('POST', id, '/api/join', { door: 'words', callsign: name, work });
    if (j.status !== 200) throw new Error(`${name} did not join by 12 words: ${show(j)}`);
    db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, id.pk);
    return id;
}
/** Joins with a Google sign-in over HTTPS, with a photo. */
async function signInMember(name: string): Promise<Id> {
    const id = newId(name);
    const n = await call('POST', id, '/api/join/sso-nonce', {});
    const j = await call('POST', id, '/api/join', { callsign: name, provider: 'google', idToken: mint(`sub-${name}`, n.body?.nonce), nonce: n.body?.nonce });
    if (j.status !== 200) throw new Error(`${name} did not join with a sign-in: ${show(j)}`);
    db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, id.pk);
    return id;
}
const setJoined = (id: Id, ms: number) => db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(ms), id.pk);

const OPTIONS = [{ id: 'opt_yes', text: 'Yes' }, { id: 'opt_no', text: 'No' }, { id: 'opt_maybe', text: 'Maybe' }];
async function makePoll(author: Id, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await call('POST', author, '/api/marketplace/posts', {
        type: 'poll', category: 'community', title, description: '', authorPublicKey: author.pk, pollOptions: OPTIONS, durationDays: 7, ...extra,
    });
    if (r.status !== 200 || !r.body?.post?.id) throw new Error(`${author.name} could not make a poll: ${show(r)}`);
    return r.body.post.id as string;
}
const vote = (voter: Id, pollId: string, optionId: string) => call('POST', voter, `/api/marketplace/posts/${pollId}/vote`, { optionId });
/** The poll as `reader` reads it on the board (null: unsigned, a visitor on the global node). */
async function onBoard(reader: Id | null, pollId: string): Promise<any> {
    const r = await call('GET', reader, '/api/marketplace/posts');
    return Array.isArray(r.body) ? r.body.find((p: any) => p.id === pollId) : undefined;
}
async function byId(reader: Id | null, pollId: string): Promise<any> {
    const r = await call('GET', reader, `/api/marketplace/posts?id=${encodeURIComponent(pollId)}`);
    return Array.isArray(r.body) ? r.body[0] : undefined;
}
/** Each option's votes and its new-or-12-words share, in OPTIONS order (`-` where the poll gives none). */
const shape = (poll: any) => ({
    total: poll?.totalVotes,
    fromNew: poll?.pollNewOrWordsVotes,
    votes: OPTIONS.map(o => poll?.pollOptions?.find((p: any) => p.id === o.id)?.votes ?? '-').join('/'),
    split: OPTIONS.map(o => poll?.pollOptions?.find((p: any) => p.id === o.id)?.newOrWordsVotes ?? '-').join('/'),
});
const shapeIs = (poll: any, want: { total: number; fromNew: number | undefined; votes: string; split: string }) =>
    JSON.stringify(shape(poll)) === JSON.stringify(want);

async function main(): Promise<void> {
    console.log('\n=== Where a poll\'s votes came from ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
    process.env.NODE_PROFILE = 'global';
    const f = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    assert(f.probation === true && f.openJoin === true, `setup: the global profile, with probation and the open door (${JSON.stringify({ p: f.probation, d: f.openJoin })})`);

    const owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    // Established: 150 days, 3 kept posts each.
    const [ann, ben, cal, dee, pia, quin, ray, sue, tom] = ['Ann', 'Ben', 'Cal', 'Dee', 'Pia', 'Quin', 'Ray', 'Sue', 'Tom'].map(n => oldMember(n, 150, 3));
    // 200 days a member and not one post: still on probation (fewer than 3 kept posts), so "new" as the app says it.
    const lou = oldMember('Lou', 200, 0);
    // Through the door: two sign-in newcomers, three 12-words newcomers.
    const gus = await signInMember('Gus');
    const hal = await signInMember('Hal');
    const wes = await wordsMember('Wes');
    const wyn = await wordsMember('Wyn');
    const wim = await wordsMember('Wim');
    // A 12-words member past probation: eight days, 3 kept posts.
    const wil = await wordsMember('Wil');
    setJoined(wil, 8 * DAY);
    keptPosts(wil, 3);
    // A sign-in member past probation: four days, 3 kept posts.
    const sid = await signInMember('Sid');
    setJoined(sid, 4 * DAY);
    keptPosts(sid, 3);
    // A moderator who joined yesterday by 12 words: a node role is neither new nor 12 words, as for probation.
    const mo = await wordsMember('Mo');
    setJoined(mo, 1 * DAY);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const pw = async (id: Id) => (await call('GET', id, '/api/community/me')).body?.probation;
    const states = { gus: await pw(gus), wes: await pw(wes), wil: await pw(wil), sid: await pw(sid), lou: await pw(lou), ann: await pw(ann) };
    assert(states.gus?.onProbation === true && states.wes?.onProbation === true && states.wes?.rules === 'words'
        && states.wil?.onProbation === false && states.wil?.rules === 'words' && states.sid?.onProbation === false
        && states.lou?.onProbation === true && states.ann?.onProbation === false,
        `setup: Gus and Wes on probation, Wil (12 words) and Sid past it, Lou still on it with no kept post, Ann established (${JSON.stringify(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, `${v?.onProbation}/${v?.rules}`])))})`);

    // ── 1. every vote counts; the poll says how many came from new or 12-word accounts ─────────
    console.log('\n── 1. who counts, everywhere the poll goes ──');
    const pollA = await makePoll(pia, 'Should the lobby have a weekly swap day?');
    const ballot: Array<[Id, string]> = [
        [ann, 'opt_yes'], [ben, 'opt_yes'], [cal, 'opt_yes'], [dee, 'opt_no'], [mo, 'opt_no'], [sid, 'opt_maybe'],
        [gus, 'opt_yes'], [hal, 'opt_yes'], [wes, 'opt_yes'], [wyn, 'opt_no'], [wil, 'opt_yes'], [lou, 'opt_maybe'],
    ];
    const statuses: string[] = [];
    let lastVote: Res | null = null;
    const annSock = await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(ann)}`);
    await sleep(200);
    for (const [voter, option] of ballot) {
        lastVote = await vote(voter, pollA, option);
        statuses.push(`${voter.name}:${lastVote.status}`);
    }
    assert(statuses.every(s => s.endsWith(':200')), `every vote is taken, the newcomers' and the 12-words accounts' as anyone's (${statuses.join(' ')})`);
    const A1 = { total: 12, fromNew: 6, votes: '7/3/2', split: '4/1/1' };
    const annReads = await onBoard(ann, pollA);
    assert(shapeIs(annReads, A1), `on the board: all 12 votes count (7/3/2), 6 came from new or 12-word accounts, 4/1/1 by option (${JSON.stringify(shape(annReads))})`);
    const annById = await byId(ann, pollA);
    assert(shapeIs(annById, A1), `read by id: the same (${JSON.stringify(shape(annById))})`);
    const visitorReads = await onBoard(null, pollA);
    assert(shapeIs(visitorReads, A1), `a visitor, unsigned, reads the same counts and the same split (${JSON.stringify(shape(visitorReads))})`);
    assert(shapeIs(lastVote?.body?.post, A1), `the last vote's own answer says the same (${JSON.stringify(shape(lastVote?.body?.post))})`);
    await sleep(300);
    const pushed = annSock.events.filter(e => e?.type === 'post_updated' && e?.post?.id === pollA).pop();
    assert(shapeIs(pushed?.post, A1), `and so does the /ws post_updated it sent (${JSON.stringify(shape(pushed?.post))})`);
    annSock.ws.close();

    // Each voter counted as probation reads them: on probation now, or 12 words with no sign-in; never a node role.
    const expected = new Map<string, number>();
    for (const [voter, option] of ballot) {
        const kind = !nodeRoleOf(voter.pk) && (probation.probationState(voter.pk).onProbation || probation.probationRuleSet(voter.pk) === 'words');
        if (kind) expected.set(option, (expected.get(option) ?? 0) + 1);
    }
    const fromRules = OPTIONS.map(o => expected.get(o.id) ?? 0).join('/');
    assert(fromRules === shape(annReads).split, `each voter is counted exactly as probationState says (rules ${fromRules}, served ${shape(annReads).split})`);
    const stamps = new Map((attempt(() => db.prepare('SELECT voter_pubkey, voter_new_or_words FROM poll_votes WHERE post_id = ?').all(pollA)) as any[] ?? [])
        .map(r => [r.voter_pubkey as string, r.voter_new_or_words as number | null]));
    const stampNames = (k: number) => ballot.filter(([v]) => stamps.get(v.pk) === k).map(([v]) => v.name).join(',');
    assert(stampNames(1) === 'Gus,Hal,Wes,Wyn,Wil,Lou' && stampNames(0) === 'Ann,Ben,Cal,Dee,Mo,Sid',
        `each vote keeps its voter's kind as they voted (new or 12-word: ${stampNames(1)}; neither: ${stampNames(0)})`);

    // Anonymous: nothing in the poll names a voter, to a member or a visitor.
    const names = (poll: any) => {
        const text = JSON.stringify(poll ?? {});
        return ballot.filter(([v]) => text.includes(v.pk) || text.includes(`"${v.name}"`)).map(([v]) => v.name);
    };
    assert(annReads?.pollOpenVote === false && !('pollVotes' in (annReads ?? {})) && names(annReads).length === 0 && names(visitorReads).length === 0
        && names(lastVote?.body?.post).length === 0,
        `the poll is anonymous: no voter's key or name in it, to a member, a visitor or the voter (${JSON.stringify([names(annReads), names(visitorReads), names(lastVote?.body?.post)])})`);

    // ── 2. the split needs 3 on each side ────────────────────────────────────────────────────────
    console.log('\n── 2. the split needs 3 on each side ──');
    const pollB = await makePoll(quin, 'Lobby colour: green or blue?');
    for (const [v, o] of [[ann, 'opt_yes'], [ben, 'opt_no'], [cal, 'opt_yes'], [dee, 'opt_no'], [gus, 'opt_yes']] as Array<[Id, string]>) await vote(v, pollB, o);
    const b1 = await onBoard(ann, pollB);
    assert(shapeIs(b1, { total: 5, fromNew: 1, votes: '3/2/0', split: '-/-/-' }), `1 vote from a new account: the total says so, no option says whose side it took (${JSON.stringify(shape(b1))})`);
    // A copy that stored a split (a standby's poll_options from an old read) never speaks for it.
    const forged = (id: string) => db.prepare('UPDATE posts SET poll_options = ? WHERE id = ?')
        .run(JSON.stringify(OPTIONS.map(o => ({ ...o, votes: 99, percentage: 99, newOrWordsVotes: 99 }))), id);
    forged(pollB);
    const b1f = await onBoard(ann, pollB);
    assert(shapeIs(b1f, { total: 5, fromNew: 1, votes: '3/2/0', split: '-/-/-' }), `poll_options holding 99s: still no split where none may be shown (${JSON.stringify(shape(b1f))})`);
    await vote(hal, pollB, 'opt_no');
    const b2 = await onBoard(ann, pollB);
    assert(shapeIs(b2, { total: 6, fromNew: 2, votes: '3/3/0', split: '-/-/-' }), `2: still the total only (${JSON.stringify(shape(b2))})`);
    await vote(wes, pollB, 'opt_yes');
    const b3 = await onBoard(ann, pollB);
    assert(shapeIs(b3, { total: 7, fromNew: 3, votes: '4/3/0', split: '2/1/0' }), `3 from new accounts and 4 others: each option's split (${JSON.stringify(shape(b3))})`);

    const pollC = await makePoll(ray, 'Move the swap table indoors?');
    for (const [v, o] of [[ann, 'opt_yes'], [gus, 'opt_yes'], [hal, 'opt_no'], [wes, 'opt_no'], [wyn, 'opt_yes']] as Array<[Id, string]>) await vote(v, pollC, o);
    const c1 = await onBoard(ann, pollC);
    assert(shapeIs(c1, { total: 5, fromNew: 4, votes: '3/2/0', split: '-/-/-' }), `4 from new accounts against 1 established: the total only, so the one established vote stays nobody's (${JSON.stringify(shape(c1))})`);
    await vote(ben, pollC, 'opt_no');
    const c2 = await onBoard(ann, pollC);
    assert(shapeIs(c2, { total: 6, fromNew: 4, votes: '3/3/0', split: '-/-/-' }), `against 2: still the total only (${JSON.stringify(shape(c2))})`);
    await vote(cal, pollC, 'opt_yes');
    const c3 = await onBoard(ann, pollC);
    assert(shapeIs(c3, { total: 7, fromNew: 4, votes: '4/3/0', split: '2/2/0' }), `against 3: the split (${JSON.stringify(shape(c3))})`);

    // An open vote: members see who chose what, as before, and nothing about which kind of account each is.
    const pollD = await makePoll(tom, 'Open vote: who brings the urn?', { pollOpenVote: true });
    for (const [v, o] of [[gus, 'opt_yes'], [hal, 'opt_yes'], [wim, 'opt_no']] as Array<[Id, string]>) await vote(v, pollD, o);
    const d1 = await onBoard(ann, pollD);
    assert(shapeIs(d1, { total: 3, fromNew: 3, votes: '2/1/0', split: '2/1/0' }), `3 from new accounts and none from anyone else: the split, which is the count itself (${JSON.stringify(shape(d1))})`);
    const voterFields = new Set<string>((d1?.pollVotes ?? []).flatMap((v: any) => Object.keys(v)));
    assert(d1?.pollOpenVote === true && d1?.pollVotes?.length === 3 && [...voterFields].sort().join(',') === 'createdAt,optionId,voterCallsign,voterPubkey',
        `an open vote names its voters to a member as before, with nothing about which kind of account each is (${[...voterFields].sort().join(',')})`);

    // ── 3. at the time of the vote ───────────────────────────────────────────────────────────────
    console.log('\n── 3. each vote as its voter was when they voted ──');
    setJoined(gus, 4 * DAY);
    keptPosts(gus, 3);
    setJoined(wes, 8 * DAY);
    keptPosts(wes, 3);
    const linkNonce = (await call('POST', wes, '/api/join/link/sso-nonce', {})).body?.nonce as string;
    const linked = await call('POST', wes, '/api/join/link', { provider: 'google', idToken: mint('wes-google-sub', linkNonce), nonce: linkNonce });
    assert(linked.status === 200 && (await pw(gus))?.onProbation === false && (await pw(wes))?.onProbation === false && (await pw(wes))?.rules === 'ordinary',
        `setup: Gus is past probation (four days, 3 kept posts); Wes too, and has added a Google sign-in (${show(linked)})`);
    const a2 = await onBoard(ann, pollA);
    assert(shapeIs(a2, A1), `the poll says what it said: a voter settling in later, at a moment anyone could see (a third post, the end of the first 72 hours), moves nothing, so it never says they voted, or how (${JSON.stringify(shape(a2))})`);
    await vote(gus, pollA, 'opt_no');
    const a3 = await onBoard(ann, pollA);
    assert(shapeIs(a3, { total: 12, fromNew: 6, votes: '6/4/2', split: '3/2/1' }), `Gus changes his vote: it moves, still as a new account's, as he first voted (${JSON.stringify(shape(a3))})`);
    // A node holds 5 open polls at most: Ray closes his and asks again.
    const closedC = await call('POST', ray, `/api/marketplace/posts/${pollC}/close`, { authorPublicKey: ray.pk });
    if (closedC.status !== 200) throw new Error(`Ray could not close his poll: ${show(closedC)}`);
    const pollE = await makePoll(ray, 'Swap day: mornings or evenings?');
    for (const [v, o] of [[gus, 'opt_yes'], [wes, 'opt_yes'], [hal, 'opt_yes'], [wyn, 'opt_no'], [lou, 'opt_no'], [ann, 'opt_no']] as Array<[Id, string]>) await vote(v, pollE, o);
    const e1 = await onBoard(ann, pollE);
    assert(shapeIs(e1, { total: 6, fromNew: 3, votes: '3/3/0', split: '1/2/0' }), `a new poll counts Gus and Wes as they are now, settled: 3 of 6 from new or 12-word accounts (Hal, Wyn, Lou) (${JSON.stringify(shape(e1))})`);

    // ── 4. where nothing is said ─────────────────────────────────────────────────────────────────
    console.log('\n── 4. a group\'s poll, and a local community ──');
    const group = createGroup({ name: 'Swap day helpers', createdBy: sue.pk, joinPolicy: 'open' });
    for (const m of [ann, ben, gus, hal, wyn, wim]) joinGroup(group.id, m.pk);
    const pollG = await makePoll(sue, 'Helpers: start at 9 or 10?', { audienceScope: 'group', targetGroupId: group.id });
    for (const [v, o] of [[ann, 'opt_yes'], [ben, 'opt_no'], [hal, 'opt_yes'], [wyn, 'opt_yes'], [wim, 'opt_no']] as Array<[Id, string]>) await vote(v, pollG, o);
    const g1 = await byId(ann, pollG);
    assert(g1?.totalVotes === 5 && !('pollNewOrWordsVotes' in (g1 ?? {})) && (g1?.pollOptions ?? []).every((o: any) => !('newOrWordsVotes' in o)),
        `a group's poll says nothing about where its votes came from: its people know each other (${JSON.stringify(shape(g1))})`);
    delete process.env.NODE_PROFILE;
    const localInfo = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    const l1 = await onBoard(ann, pollA);
    const localVote = await vote(dee, pollE, 'opt_yes');
    const localStamp = attempt(() => (db.prepare('SELECT voter_new_or_words FROM poll_votes WHERE post_id = ? AND voter_pubkey = ?').get(pollE, dee.pk) as any)?.voter_new_or_words);
    assert(localInfo.probation === false && l1?.totalVotes === 12 && !('pollNewOrWordsVotes' in (l1 ?? {})) && (l1?.pollOptions ?? []).every((o: any) => !('newOrWordsVotes' in o))
        && localVote.status === 200 && localStamp === null,
        `a local community (no probation): the counts, nothing about where they came from, and a vote keeps no kind (${JSON.stringify({ ...shape(l1), stamp: localStamp })})`);
    process.env.NODE_PROFILE = 'global';

    // ── 5. copies: a stored split never speaks; a standby's copy carries each vote's kind ──────────
    console.log('\n── 5. copies ──');
    forged(pollA);
    db.prepare('UPDATE posts SET poll_options = ? WHERE id = ?').run(JSON.stringify(OPTIONS.map(o => ({ ...o, newOrWordsVotes: 99 }))), pollG);
    const a5 = await onBoard(ann, pollA), g5 = await byId(ann, pollG);
    assert(shapeIs(a5, { total: 12, fromNew: 6, votes: '6/4/2', split: '3/2/1' }), `poll_options holding 99s: the split is counted from the votes (${JSON.stringify(shape(a5))})`);
    assert((g5?.pollOptions ?? []).every((o: any) => !('newOrWordsVotes' in o)), `nor does a group's poll say anything (${JSON.stringify(shape(g5))})`);
    const payload = await exportSyncState('test');
    const sentA = (payload.pollVotes ?? []).filter((v: any) => v.postId === pollA);
    assert(sentA.length === 12 && sentA.filter((v: any) => v.voterNewOrWords === 1).length === 6 && sentA.every((v: any) => v.voterNewOrWords === stamps.get(v.voterPubkey)),
        `a copy for a standby carries each vote's kind, so a server that takes over says the same (${sentA.filter((v: any) => v.voterNewOrWords === 1).length} of ${sentA.length} new or 12-word)`);
    // A vote from before the stamp (NULL) is not counted as one: there is nothing to say it was.
    attempt(() => db.prepare('UPDATE poll_votes SET voter_new_or_words = NULL WHERE post_id = ? AND voter_pubkey = ?').run(pollA, lou.pk));
    const a6 = await onBoard(ann, pollA);
    assert(shapeIs(a6, { total: 12, fromNew: 5, votes: '6/4/2', split: '3/2/0' }), `a vote with no kind kept counts, and not as a new account's (${JSON.stringify(shape(a6))})`);

    // ── 6. cost ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. cost ──');
    const counter = (probation as any).pollVotesFromNewOrWords as ((conn: typeof db, ids: string[]) => Map<string, Map<string, number>> | null) | undefined;
    assert(typeof counter === 'function', 'the counter exists (engine/probation.ts pollVotesFromNewOrWords)');
    if (typeof counter === 'function') {
        // A node holds 5 open polls at most: Quin closes his.
        const closedB = await call('POST', quin, `/api/marketplace/posts/${pollB}/close`, { authorPublicKey: quin.pk });
        if (closedB.status !== 200) throw new Error(`Quin could not close his poll: ${show(closedB)}`);
        const big = await makePoll(ann, 'Two thousand voters');
        const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`);
        const insertVote = db.prepare(`INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature, created_at, voter_new_or_words) VALUES (?, ?, ?, '', ?, ?)`);
        db.transaction(() => {
            for (let i = 0; i < 2000; i++) {
                const pk = crypto.randomBytes(32).toString('hex');
                insertMember.run(pk, `Bulk${i}`, ago(DAY));
                insertVote.run(big, pk, OPTIONS[i % 3].id, ago(1000), i % 2 === 0 ? 1 : 0);
            }
        })();
        const SQL_PLAN = db.prepare(`EXPLAIN QUERY PLAN ${probation.pollVoteOriginsSql(1)}`).all(big) as { detail: string }[];
        const scans = SQL_PLAN.map(r => r.detail).filter(d => /^SCAN\b/.test(d));
        assert(scans.length === 0, `the count searches the votes by poll, no table scan (${SQL_PLAN.map(r => r.detail).join(' | ')})`);
        const t0 = performance.now();
        const counted = counter(db, [big]);
        const ms = performance.now() - t0;
        const bigNew = [...(counted?.get(big)?.values() ?? [])].reduce((a, b) => a + b, 0);
        assert(bigNew === 1000, `of 2,000 votes, the 1,000 stamped as from new accounts are counted (${bigNew})`);
        console.log(`   (2,000 votes counted in ${ms.toFixed(1)} ms)`);
        assert(ms < 2000, `in well under a couple of seconds on a loaded machine (${ms.toFixed(1)} ms)`);
        const r = await byId(ann, big);
        assert(r?.totalVotes === 2000 && r?.pollNewOrWordsVotes === 1000, `and read over HTTPS: 2,000 votes, 1,000 from new accounts (${JSON.stringify(shape(r))})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
