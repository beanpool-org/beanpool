/**
 * Where a poll's votes came from, on the global profile (FABLE-sec-global-abuse LOW-7: many cheap accounts voting). Over
 * REAL HTTPS through the real signature middleware, the open door included: sign-ins are a test key primed into sso.ts's
 * cache and the 12-words door's work is solved here, so no provider is contacted. "The clock" is moved by moving rows
 * back in time (members.joined_at, a post's created_at, a poll's poll_closes_at), which is all the rules read.
 *
 * An anonymous poll on the public board says, once it has CLOSED, how many of its votes came from new or 12-word accounts
 * (`pollNewOrWordsVotes`) and, when both sides have at least POLL_ORIGINS_SPLIT_MIN votes, how many of each option's
 * (`newOrWordsVotes`). Never while it is open, and never on an open vote (@beanpool/engine pollOriginsMayShow; the #1458
 * deciding review's two measured leaks). Each vote keeps its voter's kind as they voted (`poll_votes.voter_new_or_words`):
 * new is on probation (engine/probation.ts); 12 words is a member who came in by the words door and added no sign-in.
 * Every vote still counts, and nobody is named.
 *
 *   1. every vote is taken, a new account's and a 12-words account's like anyone's. While the poll is open nothing says
 *      where its votes came from: not the board (a member's or a visitor's), not by id, not the vote's own answer, not
 *      the /ws `post_updated` after each vote, not a delta sync. Once closed, it counts all 12 and says 6 came from new or
 *      12-word accounts, 4 / 1 / 1 by option: a sign-in newcomer, a 12-words newcomer, a 12-words member past probation
 *      and a member of 200 days with no kept post count; an established member, a sign-in member past probation and a
 *      moderator who joined yesterday by 12 words don't. Each vote keeps that kind. Nothing in it names a voter
 *   2. re-reading after each vote (the review's diff log: Ruth, 120 days, among six newcomers): no read says a vote's
 *      kind, and nothing but the counts moves; a paused poll says nothing either; past its closing time it says the
 *      honest closed counts (the total only: 1 settled vote is under the floor), and the minute sweep closes it for good,
 *      so a delta sync brings it
 *   3. the split needs 3 on each side, on the closed result too: 1 and 2 votes from new accounts show the total only, 3
 *      the split; 4 against 1 and 2 established the total only, against 3 the split. A stored split (a standby's
 *      poll_options from an old read) shows nothing where none may be shown
 *   4. an open vote never says where its votes came from, open or closed, to anyone (the review's Pax/Quill/Ada): its
 *      votes keep no kind, and a member matching each new name with the count learns nothing
 *   5. at the time of the vote: voters settling in afterwards move nothing; a changed vote keeps its first kind; a new
 *      poll counts them as they are now
 *   6. where nothing is said: a group's poll on the global node, and every poll on a local community, whose votes keep
 *      no kind
 *   7. copies: a stored split never speaks, the split is counted from the votes; a standby's copy carries each vote's
 *      kind; a vote with none kept (from before) counts, and not as a new account's
 *   8. cost: a poll with 2,000 votes is counted in one search of its votes
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
import * as stateEngine from './state-engine.js';
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
async function closeIt(author: Id, pollId: string): Promise<Res> {
    const r = await call('POST', author, `/api/marketplace/posts/${pollId}/close`, { authorPublicKey: author.pk });
    if (r.status !== 200) throw new Error(`${author.name} could not close a poll: ${show(r)}`);
    return r;
}
/** The poll as `reader` reads it on the board (null: unsigned, a visitor on the global node). */
async function onBoard(reader: Id | null, pollId: string): Promise<any> {
    const r = await call('GET', reader, '/api/marketplace/posts');
    return Array.isArray(r.body) ? r.body.find((p: any) => p.id === pollId) : undefined;
}
async function byId(reader: Id | null, pollId: string): Promise<any> {
    const r = await call('GET', reader, `/api/marketplace/posts?id=${encodeURIComponent(pollId)}`);
    return Array.isArray(r.body) ? r.body[0] : undefined;
}
/** The poll in a phone's delta sync since `after`. */
async function inDelta(reader: Id, pollId: string, after: string): Promise<any> {
    const r = await call('GET', reader, `/api/marketplace/posts?sync=true&updatedAfter=${encodeURIComponent(after)}`);
    return Array.isArray(r.body) ? r.body.find((p: any) => p.id === pollId) : undefined;
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
/** Anything in a served poll that says where its votes came from: the fields, or any word for them. */
const ORIGIN_WORDS = /new_?or_?words|NewOrWords|voter_?kind|fromNew/i;
const saysOrigins = (poll: any) => poll !== undefined && ORIGIN_WORDS.test(JSON.stringify(poll));
/** A poll as served, without where its votes came from: what a reader may see of it at any moment. */
const silent = (poll: any) => poll !== undefined && poll !== null && !saysOrigins(poll);
/** The JSON paths whose values differ between two reads of the same poll. */
function changedPaths(a: any, b: any, at = ''): string[] {
    if (a === b) return [];
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return [at || '.'];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap(k => changedPaths(a[k], b[k], at ? `${at}.${k}` : k));
}
/** What may move on an open anonymous poll when a vote comes in: the counts, and the time it changed. Nothing else. */
const COUNTS_ONLY = /^(totalVotes|updatedAt|pollOptions\.\d+\.(votes|percentage))$/;

/** Votes the ballot in, then the author closes the poll; returns what a member then reads on the board. */
async function closedResult(author: Id, title: string, ballot: Array<[Id, string]>): Promise<{ open: any; closed: any }> {
    const id = await makePoll(author, title);
    for (const [v, o] of ballot) {
        const r = await vote(v, id, o);
        if (r.status !== 200) throw new Error(`${v.name} could not vote: ${show(r)}`);
    }
    const open = await onBoard(ann, id);
    await closeIt(author, id);
    return { open, closed: await byId(ann, id) };
}
let ann: Id;

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
    const est = ['Ann', 'Ben', 'Cal', 'Dee', 'Pia', 'Quin', 'Ray', 'Sue', 'Tom', 'Uma', 'Vic', 'Xan', 'Yul'].map(n => oldMember(n, 150, 3));
    const [ann_, ben, cal, dee, pia, quin, ray, sue, tom, uma, vic, xan, yul] = est;
    ann = ann_;
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

    // ── 1. while open, nothing; once closed, the count ─────────────────────────────────────────────
    console.log('\n── 1. who counts, everywhere the poll goes: nothing while open, the count once closed ──');
    const cursor = new Date(Date.now() - 1000).toISOString();
    const pollA = await makePoll(pia, 'Should the lobby have a weekly swap day?');
    const ballot: Array<[Id, string]> = [
        [ann, 'opt_yes'], [ben, 'opt_yes'], [cal, 'opt_yes'], [dee, 'opt_no'], [mo, 'opt_no'], [sid, 'opt_maybe'],
        [gus, 'opt_yes'], [hal, 'opt_yes'], [wes, 'opt_yes'], [wyn, 'opt_no'], [wil, 'opt_yes'], [lou, 'opt_maybe'],
    ];
    const statuses: string[] = [];
    const openReads: Array<[string, any]> = [];
    const totals: number[] = [];
    const annSock = await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(ann)}`);
    await sleep(200);
    for (const [voter, option] of ballot) {
        const r = await vote(voter, pollA, option);
        statuses.push(`${voter.name}:${r.status}`);
        openReads.push([`${voter.name}'s own answer`, r.body?.post]);
        const visitor = await onBoard(null, pollA);
        totals.push(visitor?.totalVotes);
        openReads.push([`a visitor after ${voter.name}`, visitor]);
        openReads.push([`a member after ${voter.name}`, await onBoard(ann, pollA)]);
        openReads.push([`by id after ${voter.name}`, await byId(ann, pollA)]);
    }
    assert(statuses.every(s => s.endsWith(':200')), `every vote is taken, the newcomers' and the 12-words accounts' as anyone's (${statuses.join(' ')})`);
    assert(totals.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12', `every vote counts and shows as it comes in (${totals.join(',')})`);
    const loud = openReads.filter(([, p]) => !silent(p)).map(([who, p]) => `${who}: ${p === undefined ? 'missing' : JSON.stringify(shape(p))}`);
    assert(loud.length === 0, `while it is open, none of ${openReads.length} reads says where a vote came from: each voter's own answer, a visitor's board, a member's board, by id (${loud.slice(0, 4).join('; ') || 'none'})`);
    await sleep(300);
    const pushedOpen = annSock.events.filter(e => e?.type === 'post_updated' && (e?.post?.id === pollA || e?.id === pollA));
    assert(pushedOpen.length >= ballot.length && pushedOpen.every(e => !ORIGIN_WORDS.test(JSON.stringify(e))),
        `nor any of the ${pushedOpen.length} /ws post_updated events sent with the votes (${pushedOpen.filter(e => ORIGIN_WORDS.test(JSON.stringify(e))).length} say it)`);
    const deltaOpen = await inDelta(ann, pollA, cursor);
    assert(silent(deltaOpen) && deltaOpen?.totalVotes === 12, `nor a phone's delta sync (${JSON.stringify(shape(deltaOpen))})`);
    const annOpen = await onBoard(ann, pollA);
    assert(annOpen?.pollOptions?.map((o: any) => o.votes).join('/') === '7/3/2', `the counts are all there while it is open: 7/3/2 (${JSON.stringify(shape(annOpen))})`);

    const sockCount = annSock.events.length;
    const closedA = await closeIt(pia, pollA);
    const A1 = { total: 12, fromNew: 6, votes: '7/3/2', split: '4/1/1' };
    const annReads = await onBoard(ann, pollA);
    assert(shapeIs(annReads, A1), `closed, on the board: all 12 votes count (7/3/2), 6 came from new or 12-word accounts, 4/1/1 by option (${JSON.stringify(shape(annReads))})`);
    const annById = await byId(ann, pollA);
    assert(shapeIs(annById, A1), `read by id: the same (${JSON.stringify(shape(annById))})`);
    const visitorReads = await onBoard(null, pollA);
    assert(shapeIs(visitorReads, A1), `a visitor, unsigned, reads the same counts and the same split (${JSON.stringify(shape(visitorReads))})`);
    assert(shapeIs(closedA.body?.post, A1), `the author's close answer says the same (${JSON.stringify(shape(closedA.body?.post))})`);
    await sleep(300);
    const pushedClose = annSock.events.slice(sockCount).filter(e => e?.type === 'post_updated' && e?.post?.id === pollA).pop();
    assert(shapeIs(pushedClose?.post, A1), `and so does the /ws post_updated the close sent (${JSON.stringify(shape(pushedClose?.post))})`);
    const deltaClosed = await inDelta(ann, pollA, cursor);
    assert(shapeIs(deltaClosed, A1), `and a phone's delta sync (${JSON.stringify(shape(deltaClosed))})`);
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
        && openReads.every(([, p]) => names(p).length === 0),
        `the poll is anonymous: no voter's key or name in it, open or closed, to a member, a visitor or the voter (${JSON.stringify([names(annReads), names(visitorReads)])})`);

    // ── 2. re-reading after each vote ────────────────────────────────────────────────────────────
    console.log('\n── 2. re-reading after each vote says no vote\'s kind ──');
    // The review's case: the asker, a member of 120 days, among six newcomers. Read unsigned after each vote, as any
    // visitor's script could, and log what moved.
    const ruth = oldMember('Ruth', 120, 3);
    const pollR = await makePoll(ruth, 'Swap day: Saturday or Sunday?');
    const sequence: Array<[Id, string]> = [[gus, 'opt_yes'], [hal, 'opt_yes'], [ruth, 'opt_no'], [wes, 'opt_yes'], [wyn, 'opt_yes'], [wim, 'opt_no'], [lou, 'opt_yes']];
    let before = await onBoard(null, pollR);
    const log: string[] = [];
    const moved = new Set<string>();
    let kindsSaid = 0;
    for (const [v, o] of sequence) {
        await vote(v, pollR, o);
        const after = await onBoard(null, pollR);
        for (const path of changedPaths(before, after)) moved.add(path);
        const option = OPTIONS.find(x => (after?.pollOptions?.find((p: any) => p.id === x.id)?.votes ?? 0) !== (before?.pollOptions?.find((p: any) => p.id === x.id)?.votes ?? 0))?.id ?? '?';
        const kindMoved = (after?.pollNewOrWordsVotes ?? null) !== (before?.pollNewOrWordsVotes ?? null);
        if (saysOrigins(after)) kindsSaid++;
        log.push(`${option}:${saysOrigins(after) ? (kindMoved ? 'new/12w' : 'settled') : '?'}`);
        before = after;
    }
    assert(kindsSaid === 0 && log.every(e => e.endsWith(':?')), `the reader's log of differences says each vote's choice and never its kind (${log.join(' ')})`);
    const strayMoves = [...moved].filter(pth => !COUNTS_ONLY.test(pth));
    assert(moved.size > 0 && strayMoves.length === 0, `nothing moves with a vote but the counts and the time (${[...moved].sort().join(', ')}${strayMoves.length ? `; stray: ${strayMoves.join(', ')}` : ''})`);
    // Paused by its author: not closed, since it can be put back up, so still nothing.
    const paused = await call('POST', ruth, '/api/marketplace/posts/pause', { postId: pollR, authorPublicKey: ruth.pk });
    const pausedRead = await byId(ruth, pollR);
    assert(paused.status === 200 && pausedRead?.status === 'paused' && silent(pausedRead), `paused, it still says nothing: it can be put back up and voted on (${show(paused)}; ${JSON.stringify(shape(pausedRead))})`);
    const resumed = await call('POST', ruth, '/api/marketplace/posts/resume', { postId: pollR, authorPublicKey: ruth.pk });
    if (resumed.status !== 200) throw new Error(`Ruth could not put her poll back up: ${show(resumed)}`);
    // Its time runs out (the clock moved back on the row): closed for good, before anything has swept it.
    const sweepCursor = new Date().toISOString();
    db.prepare('UPDATE posts SET poll_closes_at = ? WHERE id = ?').run(ago(60_000), pollR);
    const R1 = { total: 7, fromNew: 6, votes: '5/2/0', split: '-/-/-' };
    const pastTime = await onBoard(null, pollR);
    assert(shapeIs(pastTime, R1) && pastTime?.status === 'completed',
        `past its closing time, the honest closed count: 6 of 7 from new or 12-word accounts, and no split, as Ruth's is the one settled vote (${JSON.stringify(shape(pastTime))}, ${pastTime?.status})`);
    const sweep = (stateEngine as any).closeExpiredPolls as ((nowIso?: string) => number) | undefined;
    const swept = attempt(() => { if (typeof sweep !== 'function') throw new Error('no closeExpiredPolls'); return sweep(); });
    const row = db.prepare('SELECT status, updated_at FROM posts WHERE id = ?').get(pollR) as { status: string; updated_at: string };
    assert(swept === 1 && row.status === 'completed' && row.updated_at >= sweepCursor,
        `the minute sweep closes it for good, with a new change time (${swept} closed; ${row.status}, ${row.updated_at})`);
    const deltaR = await inDelta(ann, pollR, sweepCursor);
    assert(shapeIs(deltaR, R1), `so a phone's next delta sync brings the closed count (${JSON.stringify(shape(deltaR))})`);
    assert(attempt(() => (sweep as any)()) === 0, 'and the sweep finds nothing more to close');

    // ── 3. the split needs 3 on each side, on the closed result too ─────────────────────────────
    console.log('\n── 3. the split needs 3 on each side ──');
    const b1 = await closedResult(quin, 'Lobby colour: green or blue?', [[ann, 'opt_yes'], [ben, 'opt_no'], [cal, 'opt_yes'], [dee, 'opt_no'], [gus, 'opt_yes']]);
    assert(silent(b1.open) && shapeIs(b1.closed, { total: 5, fromNew: 1, votes: '3/2/0', split: '-/-/-' }),
        `1 vote from a new account: nothing while open; closed, the total says so, no option says whose side it took (${JSON.stringify(shape(b1.closed))})`);
    // A copy that stored a split (a standby's poll_options from an old read) never speaks for it.
    const forged = (id: string) => db.prepare('UPDATE posts SET poll_options = ? WHERE id = ?')
        .run(JSON.stringify(OPTIONS.map(o => ({ ...o, votes: 99, percentage: 99, newOrWordsVotes: 99 }))), id);
    forged(b1.closed.id);
    const b1f = await onBoard(ann, b1.closed.id);
    assert(shapeIs(b1f, { total: 5, fromNew: 1, votes: '3/2/0', split: '-/-/-' }), `poll_options holding 99s: still no split where none may be shown (${JSON.stringify(shape(b1f))})`);
    const b2 = await closedResult(quin, 'Lobby colour, again', [[ann, 'opt_yes'], [ben, 'opt_no'], [cal, 'opt_yes'], [dee, 'opt_no'], [gus, 'opt_yes'], [hal, 'opt_no']]);
    assert(silent(b2.open) && shapeIs(b2.closed, { total: 6, fromNew: 2, votes: '3/3/0', split: '-/-/-' }), `2: still the total only (${JSON.stringify(shape(b2.closed))})`);
    const b3 = await closedResult(quin, 'Lobby colour, once more', [[ann, 'opt_yes'], [ben, 'opt_no'], [cal, 'opt_yes'], [dee, 'opt_no'], [gus, 'opt_yes'], [hal, 'opt_no'], [wes, 'opt_yes']]);
    assert(silent(b3.open) && shapeIs(b3.closed, { total: 7, fromNew: 3, votes: '4/3/0', split: '2/1/0' }), `3 from new accounts and 4 others: each option's split (${JSON.stringify(shape(b3.closed))})`);
    const c1 = await closedResult(ray, 'Move the swap table indoors?', [[ann, 'opt_yes'], [gus, 'opt_yes'], [hal, 'opt_no'], [wes, 'opt_no'], [wyn, 'opt_yes']]);
    assert(silent(c1.open) && shapeIs(c1.closed, { total: 5, fromNew: 4, votes: '3/2/0', split: '-/-/-' }), `4 from new accounts against 1 established: the total only, so the one established vote stays nobody's (${JSON.stringify(shape(c1.closed))})`);
    const c2 = await closedResult(ray, 'Indoors, again', [[ann, 'opt_yes'], [gus, 'opt_yes'], [hal, 'opt_no'], [wes, 'opt_no'], [wyn, 'opt_yes'], [ben, 'opt_no']]);
    assert(silent(c2.open) && shapeIs(c2.closed, { total: 6, fromNew: 4, votes: '3/3/0', split: '-/-/-' }), `against 2: still the total only (${JSON.stringify(shape(c2.closed))})`);
    const c3 = await closedResult(ray, 'Indoors, once more', [[ann, 'opt_yes'], [gus, 'opt_yes'], [hal, 'opt_no'], [wes, 'opt_no'], [wyn, 'opt_yes'], [ben, 'opt_no'], [cal, 'opt_yes']]);
    assert(silent(c3.open) && shapeIs(c3.closed, { total: 7, fromNew: 4, votes: '4/3/0', split: '2/2/0' }), `against 3: the split (${JSON.stringify(shape(c3.closed))})`);
    const c4 = await closedResult(ray, 'Indoors, the newcomers only', [[gus, 'opt_yes'], [hal, 'opt_yes'], [wim, 'opt_no']]);
    assert(silent(c4.open) && shapeIs(c4.closed, { total: 3, fromNew: 3, votes: '2/1/0', split: '2/1/0' }), `3 from new accounts and none from anyone else: the split, which is the count itself (${JSON.stringify(shape(c4.closed))})`);

    // ── 4. an open vote never says ───────────────────────────────────────────────────────────────
    console.log('\n── 4. an open vote names its voters, so it never says where its votes came from ──');
    // The review's case: Pax, settled with a sign-in; Quill, a 12-words member of 40 days with 4 kept posts, whom nothing
    // public marks as new; Ada, a newcomer. A member reads after each vote and matches the new name with the count.
    const pax = await signInMember('Pax');
    setJoined(pax, 40 * DAY);
    keptPosts(pax, 4);
    const quill = await wordsMember('Quill');
    setJoined(quill, 40 * DAY);
    keptPosts(quill, 4);
    const ada = await signInMember('Ada');
    assert((await pw(quill))?.onProbation === false && (await pw(quill))?.rules === 'words' && (await pw(pax))?.onProbation === false && (await pw(ada))?.onProbation === true,
        'setup: Quill (12 words, no sign-in) and Pax (a sign-in) both settled, Ada new');
    const openCursor = new Date(Date.now() - 1000).toISOString();
    const pollD = await makePoll(tom, 'Open vote: who brings the urn?', { pollOpenVote: true });
    const dSock = await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(ann)}`);
    await sleep(200);
    let prevFromNew: number | undefined;
    const attributed: string[] = [];
    const dReads: Array<[string, any]> = [];
    for (const [v, o] of [[pax, 'opt_yes'], [quill, 'opt_yes'], [ada, 'opt_no']] as Array<[Id, string]>) {
        const r = await vote(v, pollD, o);
        dReads.push([`${v.name}'s own answer`, r.body?.post]);
        const read = await onBoard(ann, pollD);
        dReads.push([`a member after ${v.name}`, read], [`a visitor after ${v.name}`, await onBoard(null, pollD)], [`by id after ${v.name}`, await byId(ann, pollD)]);
        const named = (read?.pollVotes ?? []).some((pv: any) => pv.voterCallsign === v.name);
        const fromNew = read?.pollNewOrWordsVotes as number | undefined;
        attributed.push(`${v.name}=${!named ? 'unnamed' : fromNew === undefined ? 'unknown' : fromNew !== (prevFromNew ?? 0) ? 'new-or-12-word' : 'neither'}`);
        prevFromNew = fromNew;
    }
    assert(attributed.join(' ') === 'Pax=unknown Quill=unknown Ada=unknown', `the member sees each voter named and learns no one's kind (${attributed.join(' ')})`);
    const dLoud = dReads.filter(([, p]) => !silent(p)).map(([who, p]) => `${who}: ${JSON.stringify(shape(p))}`);
    assert(dLoud.length === 0, `none of ${dReads.length} reads of the open vote says where its votes came from (${dLoud.slice(0, 3).join('; ') || 'none'})`);
    const dStamps = attempt(() => db.prepare('SELECT voter_new_or_words AS k FROM poll_votes WHERE post_id = ?').all(pollD)) as Array<{ k: number | null }> | undefined;
    assert(dStamps?.length === 3 && dStamps.every(r => r.k === null), `its votes keep no kind at all (${JSON.stringify(dStamps)})`);
    const closedD = await closeIt(tom, pollD);
    const dClosed = [await onBoard(ann, pollD), await onBoard(null, pollD), await byId(ann, pollD), await byId(tom, pollD), closedD.body?.post, await inDelta(ann, pollD, openCursor)];
    assert(dClosed.every(silent) && dClosed[0]?.pollVotes?.length === 3 && dClosed[0]?.totalVotes === 3,
        `closed, it still says nothing about it, to a member, a visitor, its author or a delta sync; it still names its 3 voters to a member (${dClosed.map(p => JSON.stringify(shape(p))).join(' ')})`);
    await sleep(300);
    const dPushed = dSock.events.filter(e => e?.type === 'post_updated' && (e?.post?.id === pollD || e?.id === pollD));
    assert(dPushed.length >= 4 && dPushed.every(e => !ORIGIN_WORDS.test(JSON.stringify(e))), `nor any of its ${dPushed.length} /ws post_updated events, open or closing`);
    dSock.ws.close();
    const voterFields = new Set<string>((dClosed[0]?.pollVotes ?? []).flatMap((v: any) => Object.keys(v)));
    assert([...voterFields].sort().join(',') === 'createdAt,optionId,voterCallsign,voterPubkey',
        `an open vote names its voters to a member as before, with nothing about which kind of account each is (${[...voterFields].sort().join(',')})`);

    // ── 5. at the time of the vote ───────────────────────────────────────────────────────────────
    console.log('\n── 5. each vote as its voter was when they voted ──');
    const pollF = await makePoll(sue, 'Swap day: bring a plate?');
    for (const [v, o] of [[gus, 'opt_yes'], [hal, 'opt_yes'], [wyn, 'opt_no'], [ann, 'opt_no'], [ben, 'opt_no'], [cal, 'opt_no']] as Array<[Id, string]>) await vote(v, pollF, o);
    setJoined(gus, 4 * DAY);
    keptPosts(gus, 3);
    setJoined(wes, 8 * DAY);
    keptPosts(wes, 3);
    const linkNonce = (await call('POST', wes, '/api/join/link/sso-nonce', {})).body?.nonce as string;
    const linked = await call('POST', wes, '/api/join/link', { provider: 'google', idToken: mint('wes-google-sub', linkNonce), nonce: linkNonce });
    assert(linked.status === 200 && (await pw(gus))?.onProbation === false && (await pw(wes))?.onProbation === false && (await pw(wes))?.rules === 'ordinary',
        `setup: Gus is past probation (four days, 3 kept posts); Wes too, and has added a Google sign-in (${show(linked)})`);
    const a2 = await onBoard(ann, pollA);
    assert(shapeIs(a2, A1), `the closed poll says what it said: a voter settling in later, at a moment anyone could see (a third post, the end of the first 72 hours), moves nothing (${JSON.stringify(shape(a2))})`);
    await vote(gus, pollF, 'opt_maybe');
    const gusStamp = attempt(() => (db.prepare('SELECT voter_new_or_words AS k FROM poll_votes WHERE post_id = ? AND voter_pubkey = ?').get(pollF, gus.pk) as any)?.k);
    const fOpen = await onBoard(ann, pollF);
    await closeIt(sue, pollF);
    const f1 = await onBoard(ann, pollF);
    assert(gusStamp === 1 && silent(fOpen) && shapeIs(f1, { total: 6, fromNew: 3, votes: '1/4/1', split: '1/1/1' }),
        `Gus changes his vote, settled now: it moves, still as a new account's, as he first voted; said once the poll closes (${JSON.stringify(shape(f1))})`);
    const e1 = await closedResult(ray, 'Swap day: mornings or evenings?', [[gus, 'opt_yes'], [wes, 'opt_yes'], [hal, 'opt_yes'], [wyn, 'opt_no'], [lou, 'opt_no'], [ann, 'opt_no']]);
    assert(silent(e1.open) && shapeIs(e1.closed, { total: 6, fromNew: 3, votes: '3/3/0', split: '1/2/0' }),
        `a new poll counts Gus and Wes as they are now, settled: 3 of 6 from new or 12-word accounts (Hal, Wyn, Lou) (${JSON.stringify(shape(e1.closed))})`);

    // ── 6. where nothing is said ─────────────────────────────────────────────────────────────────
    console.log('\n── 6. a group\'s poll, and a local community ──');
    const group = createGroup({ name: 'Swap day helpers', createdBy: uma.pk, joinPolicy: 'open' });
    for (const m of [ann, ben, gus, hal, wyn, wim]) joinGroup(group.id, m.pk);
    const pollG = await makePoll(uma, 'Helpers: start at 9 or 10?', { audienceScope: 'group', targetGroupId: group.id });
    for (const [v, o] of [[ann, 'opt_yes'], [ben, 'opt_no'], [hal, 'opt_yes'], [wyn, 'opt_yes'], [wim, 'opt_no']] as Array<[Id, string]>) await vote(v, pollG, o);
    await closeIt(uma, pollG);
    const g1 = await byId(ann, pollG);
    assert(g1?.totalVotes === 5 && silent(g1), `a group's poll says nothing about where its votes came from, closed: its people know each other (${JSON.stringify(shape(g1))})`);
    const pollL = await makePoll(vic, 'Swap day: tea or coffee?');
    delete process.env.NODE_PROFILE;
    const localInfo = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    const l1 = await onBoard(ann, pollA);
    const localVote = await vote(dee, pollL, 'opt_yes');
    const localStamp = attempt(() => (db.prepare('SELECT voter_new_or_words FROM poll_votes WHERE post_id = ? AND voter_pubkey = ?').get(pollL, dee.pk) as any)?.voter_new_or_words);
    assert(localInfo.probation === false && l1?.totalVotes === 12 && silent(l1) && localVote.status === 200 && localStamp === null,
        `a local community (no probation): the counts of a closed poll, nothing about where they came from, and a vote keeps no kind (${JSON.stringify({ ...shape(l1), stamp: localStamp })})`);
    process.env.NODE_PROFILE = 'global';
    await closeIt(vic, pollL);

    // ── 7. copies: a stored split never speaks; a standby's copy carries each vote's kind ──────────
    console.log('\n── 7. copies ──');
    forged(pollA);
    db.prepare('UPDATE posts SET poll_options = ? WHERE id = ?').run(JSON.stringify(OPTIONS.map(o => ({ ...o, newOrWordsVotes: 99 }))), pollG);
    const a5 = await onBoard(ann, pollA), g5 = await byId(ann, pollG);
    assert(shapeIs(a5, A1), `poll_options holding 99s: the split is counted from the votes (${JSON.stringify(shape(a5))})`);
    assert((g5?.pollOptions ?? []).every((o: any) => !('newOrWordsVotes' in o)), `nor does a group's poll say anything (${JSON.stringify(shape(g5))})`);
    // An open poll whose stored options hold a split from an old read: still nothing while it is open.
    const pollO = await makePoll(xan, 'Swap day: indoors or out?');
    await vote(gus, pollO, 'opt_yes');
    forged(pollO);
    const o1 = await onBoard(null, pollO);
    assert(silent(o1) && o1?.totalVotes === 1, `an open poll with 99s stored in its options says nothing either (${JSON.stringify(shape(o1))})`);
    await closeIt(xan, pollO);
    const payload = await exportSyncState('test');
    const sentA = (payload.pollVotes ?? []).filter((v: any) => v.postId === pollA);
    assert(sentA.length === 12 && sentA.filter((v: any) => v.voterNewOrWords === 1).length === 6 && sentA.every((v: any) => v.voterNewOrWords === stamps.get(v.voterPubkey)),
        `a copy for a standby carries each vote's kind, so a server that takes over says the same (${sentA.filter((v: any) => v.voterNewOrWords === 1).length} of ${sentA.length} new or 12-word)`);
    const sentD = (payload.pollVotes ?? []).filter((v: any) => v.postId === pollD);
    assert(sentD.length === 3 && sentD.every((v: any) => v.voterNewOrWords === null), `and an open vote's votes carry none (${JSON.stringify(sentD.map((v: any) => v.voterNewOrWords))})`);
    // A vote from before the stamp (NULL) is not counted as one: there is nothing to say it was.
    attempt(() => db.prepare('UPDATE poll_votes SET voter_new_or_words = NULL WHERE post_id = ? AND voter_pubkey = ?').run(pollA, lou.pk));
    const a6 = await onBoard(ann, pollA);
    assert(shapeIs(a6, { total: 12, fromNew: 5, votes: '7/3/2', split: '4/1/0' }), `a vote with no kind kept counts, and not as a new account's (${JSON.stringify(shape(a6))})`);

    // ── 8. cost ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. cost ──');
    const counter = (probation as any).pollVotesFromNewOrWords as ((conn: typeof db, ids: string[]) => Map<string, Map<string, number>> | null) | undefined;
    assert(typeof counter === 'function', 'the counter exists (engine/probation.ts pollVotesFromNewOrWords)');
    if (typeof counter === 'function') {
        const big = await makePoll(yul, 'Two thousand voters');
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
        const open = await byId(ann, big);
        await closeIt(yul, big);
        const r = await byId(ann, big);
        assert(silent(open) && open?.totalVotes === 2000 && r?.totalVotes === 2000 && r?.pollNewOrWordsVotes === 1000,
            `and read over HTTPS: 2,000 votes, nothing more while open; closed, 1,000 from new accounts (${JSON.stringify(shape(r))})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
