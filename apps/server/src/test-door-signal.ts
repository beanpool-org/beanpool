/**
 * The door's signal (the two-doors design §4, §2.4: scratch/global-node/DESIGN-global-two-doors-fable.md): the work a
 * join asks for, and the only refusals left for a network, over REAL HTTPS through the real signature middleware. The
 * joins before the ones that matter are written as rows (as test-open-join writes them): a thousand real joins would
 * test the door's speed, not its numbers. No provider is contacted.
 *
 *   1. levels at the numbers, one address, both doors' joins counted: the 9th 12-words join is asked level 0, the 10th
 *      level 1, the 29th 1, the 30th 2, the 99th 2, the 100th 3, the 199th 3, the 200th 4; the 10th, 30th, 100th and
 *      200th join for real with the work they were given
 *   2. one network, one count: two IPv4 addresses don't affect each other; two addresses in one IPv6 /64 share a count,
 *      and another /64 does not
 *   3. node steps: the 500th 12-words join on the node in 10 minutes is a level up for everyone, the 2,000th two, the
 *      5,000th three; the cap is 5; joins older than 10 minutes and a restart count for nothing; the sign-in door has none
 *   4. the sign-in door: the 29th join from an address in the hour asks no work, the 30th level 0, the 100th 1, the 200th
 *      2, the 1,000th 2
 *   5. no refusal below the ceiling: every count from the 1st to the 500th 12-words join in the hour is under it, and the
 *      500th joins for real; the 501st → 429 network_busy with Retry-After (when the hour's oldest leaves it) and the
 *      sentence that names the sign-in door, the work route says so first, and a sign-in join from that address still
 *      joins; the day's 2,000 the same, naming the day
 *   6. a removed newcomer's network (§2.4): a 12-words member a moderator removes minutes after joining keeps their row's
 *      address hash for 7 days from the join; a 12-words join from that network is asked level 4 meanwhile, a sign-in
 *      join no more than before; the sweep a day on keeps it, a week on clears it. Removed more than a day after joining,
 *      or deleted by their own hand: nothing kept. A copy for a standby and the take-over record carry neither the hash
 *      nor how long it is kept
 *   7. overrides: node_config doorNumbers.* reach the door (a ceiling of 3, steps at 2,4,6,8); a value that isn't one is
 *      ignored and the default kept
 *   8. local profile: every door route is 404, and the name check keeps the auth limiter's 15 a minute
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-door-signal.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;

import crypto from 'node:crypto';
import { solveDoorWorkSync, type DoorWorkDoor } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, adminPruneUser, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { forgetOldJoinAddresses, openJoinAddressHash, readOpenJoinRecord } from './engine/open-join.js';
import {
    DOOR_NUMBERS, REMOVED_NEWCOMER_KEEP_MS, _resetWordsJoinsForTests, doorCeilingReached, doorLevel, doorNumbers, noteWordsJoin,
} from './engine/door-signal.js';
import { nodeSha256 } from './services/door-work.js';
import { limiterKeyForIp } from './client-ip.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const GOOGLE_KID = 'test-door-signal-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

interface Res { status: number; body: any; headers: Headers }
let holdLimiters = false;
async function call(method: 'GET' | 'POST', id: Id | null, path: string, ip: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    if (!holdLimiters) pruneAuthAttempts(Date.now() + 120_000);
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'CF-Connecting-IP': ip };
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
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, headers: res.headers };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)}`;
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** The work the door hands a new key from `ip` now: the answer, and its level (null for none, or the status refused). */
async function askWork(door: DoorWorkDoor, ip: string, id: Id = newId()): Promise<Res & { level: number | null }> {
    const r = await call('POST', id, '/api/join/work', ip, { door });
    return { ...r, level: r.status === 200 ? (r.body?.work?.level ?? null) : null };
}
/** A real 12-words join from `ip`: the work asked for, solved here, and the join. */
async function joinByWords(ip: string, callsign: string, id: Id = newId()): Promise<{ id: Id; level: number | null; res: Res }> {
    const w = await askWork('words', ip, id);
    if (w.status !== 200 || !w.body?.work) return { id, level: null, res: w };
    const work = { challenge: w.body.work.challenge, counters: solveDoorWorkSync(w.body.work.challenge, nodeSha256) };
    return { id, level: w.level, res: await call('POST', id, '/api/join', ip, { door: 'words', callsign, work }) };
}
/** A real sign-in join from `ip`, with the work the door asks for, if any. */
async function joinBySignIn(ip: string, sub: string, callsign: string, id: Id = newId()): Promise<Res> {
    const w = await askWork('sign-in', ip, id);
    if (w.status !== 200) return w;
    const work = w.body?.work ? { challenge: w.body.work.challenge, counters: solveDoorWorkSync(w.body.work.challenge, nodeSha256) } : undefined;
    const n = await call('POST', id, '/api/join/sso-nonce', ip, {});
    return call('POST', id, '/api/join', ip, { callsign, provider: 'google', idToken: mint(sub, n.body?.nonce), nonce: n.body?.nonce, work });
}

const hashOf = (ip: string) => openJoinAddressHash(limiterKeyForIp(ip));
/** `count` joins from `ip` at `at`, as rows: alternately a sign-in's and a 12-words member's unless `provider` says. */
function addJoins(ip: string, count: number, at = new Date(), provider?: 'google' | 'words'): void {
    const ipHash = hashOf(ip);
    const insertRow = db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const p = provider ?? (i % 2 ? 'words' : 'google');
            insertRow.run(crypto.randomBytes(32).toString('hex'), p, p === 'words' ? `words:${crypto.randomBytes(16).toString('hex')}` : crypto.randomBytes(32).toString('base64url'), at.toISOString(), ipHash);
        }
    })();
}
const joinsFrom = (ip: string, sinceMs = 3600_000, provider?: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM open_joins WHERE ip_hash = ? AND joined_at >= ? ${provider ? 'AND provider = ?' : ''}`)
        .get(...[hashOf(ip), new Date(Date.now() - sinceMs).toISOString(), ...(provider ? [provider] : [])]) as any).n as number;
/** Top up the hour's joins from `ip` until the next join is the `nth`. */
const upTo = (ip: string, nth: number, provider?: 'google' | 'words') => addJoins(ip, nth - 1 - joinsFrom(ip), new Date(), provider);
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
const setConfig = (key: string, value: string | null) => {
    if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

async function main(): Promise<void> {
    console.log('\n=== The door\'s signal: work by the numbers, and the ceilings ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
    _resetWordsJoinsForTests();
    process.env.NODE_PROFILE = 'global';
    const N = DOOR_NUMBERS.global;

    // ── 1. levels at the numbers ─────────────────────────────────────────────────────────────────
    console.log('── 1. levels at the numbers, one address ──');
    const HALL = '203.0.113.10';
    const asked: string[] = [];
    const want: [number, number][] = [[1, 0], [9, 0], [10, 1], [29, 1], [30, 2], [99, 2], [100, 3], [199, 3], [200, 4]];
    let levelsRight = true;
    for (const [nth, level] of want) {
        upTo(HALL, nth);
        const got = (await askWork('words', HALL)).level;
        asked.push(`${ord(nth)}→${got}`);
        if (got !== level) levelsRight = false;
    }
    assert(levelsRight, `the Nth 12-words join from one address in the hour, both doors' joins counted, is asked: ${asked.join(', ')} (want ${want.map(([n, l]) => `${ord(n)}→${l}`).join(', ')})`);
    // Real joins at each step, from a fresh address, with the work they were given.
    const STEPS = '203.0.113.11';
    const real: string[] = [];
    for (const [nth, level] of [[10, 1], [30, 2], [100, 3], [200, 4]] as const) {
        upTo(STEPS, nth);
        const j = await joinByWords(STEPS, `Step ${nth}`);
        real.push(`${ord(nth)}: level ${j.level}, ${j.res.status}`);
        if (j.level !== level || j.res.status !== 200) levelsRight = false;
    }
    assert(levelsRight, `the 10th, 30th, 100th and 200th join for real with the work they were given (${real.join('; ')})`);

    // ── 2. one network, one count ────────────────────────────────────────────────────────────────
    console.log('\n── 2. one network, one count ──');
    assert((await askWork('words', '203.0.113.12')).level === 0, `another IPv4 address is not the hall: level 0 (the hall has ${joinsFrom(HALL)} joins this hour)`);
    addJoins('2001:db8:1:2::abcd', 9);
    const sameSixtyFour = await askWork('words', '2001:db8:1:2:ffff:1:2:3');
    const otherSixtyFour = await askWork('words', '2001:db8:1:3::1');
    assert(sameSixtyFour.level === 1 && otherSixtyFour.level === 0,
        `IPv6 by its /64: 9 joins from 2001:db8:1:2::abcd make the next from 2001:db8:1:2:ffff:1:2:3 the 10th (level ${sameSixtyFour.level}); 2001:db8:1:3::1 is another network (level ${otherSixtyFour.level})`);

    // ── 3. node steps ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. node steps: 12-words joins on the whole node in 10 minutes ──');
    const QUIET = '203.0.113.13';
    _resetWordsJoinsForTests();
    const nodeLevels: string[] = [];
    let nodeRight = true;
    for (const [before, level] of [[498, 0], [499, 1], [1_999, 2], [4_999, 3]] as const) {
        _resetWordsJoinsForTests();
        noteWordsJoin(Date.now(), before);
        const got = (await askWork('words', QUIET)).level;
        nodeLevels.push(`${ord(before + 1)}→${got}`);
        if (got !== level) nodeRight = false;
    }
    assert(nodeRight, `the Nth 12-words join on the node in 10 minutes, from a quiet network: ${nodeLevels.join(', ')}`);
    const capped = (await askWork('words', STEPS)).level;
    assert(capped === 5, `a network at its 4th step on a node at its 3rd is asked the cap, level 5 (got ${capped})`);
    const signInHere = await askWork('sign-in', QUIET);
    assert(signInHere.status === 200 && signInHere.body?.work === null, 'the sign-in door has no node steps: a quiet network signs in with no work');
    _resetWordsJoinsForTests();
    noteWordsJoin(Date.now() - 11 * 60_000, 6_000);
    assert((await askWork('words', QUIET)).level === 0, 'joins more than 10 minutes old count for nothing');
    noteWordsJoin(Date.now(), 4_999);
    _resetWordsJoinsForTests();
    assert((await askWork('words', QUIET)).level === 0, 'and a restart (the count is in memory) only ever lowers the level');

    // ── 4. the sign-in door ──────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the sign-in door ──');
    const OFFICE = '203.0.113.14';
    const signIn: string[] = [];
    let signInRight = true;
    for (const [nth, level] of [[29, null], [30, 0], [99, 0], [100, 1], [199, 1], [200, 2], [1_000, 2]] as const) {
        upTo(OFFICE, nth, 'google');
        const got = await askWork('sign-in', OFFICE);
        signIn.push(`${ord(nth)}→${got.level}`);
        if (got.status !== 200 || got.level !== level) signInRight = false;
    }
    assert(signInRight, `the Nth sign-in join from one address in the hour is asked: ${signIn.join(', ')} (no work before the 30th; then the network steps less 2)`);

    // ── 5. the ceiling ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. no refusal below the ceiling ──');
    const CAMPUS = '203.0.113.15';
    const campus = hashOf(CAMPUS);
    // Every count on the way to the ceiling, each as the door reads it: the 1st to the 500th join are all under it.
    const firstRefusedAt: number[] = [];
    const tick = Date.now() - 50 * 60_000; // the hour's joins, 50 minutes ago: the oldest leaves the hour in 10 minutes
    for (let nth = 1; nth <= N.wordsPerHour; nth++) {
        if (doorCeilingReached('words', campus)) firstRefusedAt.push(nth);
        if (nth < N.wordsPerHour) addJoins(CAMPUS, 1, new Date(tick), 'words');
    }
    assert(firstRefusedAt.length === 0, `the 1st to the ${ord(N.wordsPerHour)} 12-words join from one address in the hour: none is refused (${firstRefusedAt.length ? `refused from the ${ord(firstRefusedAt[0])}` : 'all under the ceiling'})`);
    const fiveHundredth = await joinByWords(CAMPUS, 'Five Hundred');
    assert(fiveHundredth.res.status === 200 && fiveHundredth.level === 4 && joinsFrom(CAMPUS, 3600_000, 'words') === N.wordsPerHour,
        `the ${ord(N.wordsPerHour)} joins for real, at level ${fiveHundredth.level} (${fiveHundredth.res.status})`);
    const busyWork = await askWork('words', CAMPUS);
    const over = await call('POST', newId(), '/api/join', CAMPUS, { door: 'words', callsign: 'Over', work: { challenge: 'x', counters: [] } });
    const retry = Number(over.headers.get('retry-after'));
    assert(busyWork.status === 429 && busyWork.body?.code === 'network_busy' && busyWork.body?.door === 'words',
        `the work route says so first, before any work is done (${show(busyWork)})`);
    assert(over.status === 429 && over.body?.code === 'network_busy' && over.body?.window === 'hour' && retry >= 590 && retry <= 601 && over.body?.retryAfterSeconds === retry
        && /12-words accounts were made from your network in the last hour\. Sign in to join now, or try again in about 10 minutes\./.test(over.body?.error),
        `the ${ord(N.wordsPerHour + 1)} → 429 network_busy, Retry-After ${retry} s (when the hour's oldest leaves it), naming the sign-in door (${show(over)})`);
    const signInStill = await joinBySignIn(CAMPUS, 'campus-google-sub', 'Campus Sign-in');
    assert(signInStill.status === 200 && signInStill.body?.provider === 'google', `and a sign-in join from that address still joins, with the work its door asks (${show(signInStill)})`);
    // The day: 2,000 12-words joins from one address, none of them in the last hour.
    db.prepare("UPDATE open_joins SET joined_at = ? WHERE ip_hash = ? AND provider = 'words'").run(new Date(Date.now() - 2 * 3600_000).toISOString(), campus);
    const notToday = await askWork('words', CAMPUS);
    addJoins(CAMPUS, N.wordsPerDay - joinsFrom(CAMPUS, 24 * 3600_000, 'words'), new Date(Date.now() - 3 * 3600_000), 'words');
    const today = await askWork('words', CAMPUS);
    assert(notToday.status === 200 && today.status === 429 && today.body?.window === 'day' && /today/.test(today.body?.error),
        `the hour's moved back: allowed again; ${N.wordsPerDay} in the day → 429 naming the day (${notToday.status}, ${show(today)})`);

    // ── 6. a removed newcomer's network ──────────────────────────────────────────────────────────
    console.log('\n── 6. a removed newcomer\'s network ──');
    const CAFE = '203.0.113.16';
    const cafe = hashOf(CAFE);
    const jo = await joinByWords(CAFE, 'Jo');
    assert(jo.res.status === 200 && jo.level === 0, `Jo joins by 12 words from a café's network, at level 0 (${show(jo.res)})`);
    adminPruneUser(jo.id.pk, 'owner:password');
    const joRow = joinRow(jo.id.pk);
    const joinedMs = Date.parse(joRow?.joined_at);
    assert(joRow?.ip_hash === cafe && Date.parse(joRow?.ip_kept_until) === joinedMs + REMOVED_NEWCOMER_KEEP_MS,
        `a moderator removes Jo minutes after joining: the row keeps the café's hash until 7 days from the join (${joRow?.ip_kept_until})`);
    const afterRemoval = await askWork('words', CAFE);
    const signInAfterRemoval = await askWork('sign-in', CAFE);
    assert(afterRemoval.level === 4 && signInAfterRemoval.status === 200 && signInAfterRemoval.body?.work === null,
        `a 12-words join from the café is asked level 4 meanwhile (got ${afterRemoval.level}); a sign-in join no more than before (${JSON.stringify(signInAfterRemoval.body?.work)})`);
    const dayOn = joinedMs + 25 * 3600_000;
    forgetOldJoinAddresses(dayOn);
    assert(joinRow(jo.id.pk)?.ip_hash === cafe && doorLevel('words', cafe, dayOn).level === 4,
        'the sweep a day on keeps it, and the café is still asked level 4');
    const weekOn = joinedMs + REMOVED_NEWCOMER_KEEP_MS + 60_000;
    forgetOldJoinAddresses(weekOn);
    assert(joinRow(jo.id.pk)?.ip_hash === null && joinRow(jo.id.pk)?.ip_kept_until === null && doorLevel('words', cafe, weekOn).level === 0,
        'a week on, the sweep clears it, and the café is back to level 0');
    const PUB = '203.0.113.17';
    const kay = await joinByWords(PUB, 'Kay');
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey = ?').run(new Date(Date.now() - 25 * 3600_000).toISOString(), kay.id.pk);
    adminPruneUser(kay.id.pk, 'owner:password');
    const lou = await joinByWords(PUB, 'Lou');
    const louPurge = await call('POST', lou.id, '/api/member/purge', PUB, {});
    assert(kay.res.status === 200 && !joinRow(kay.id.pk)?.ip_kept_until && lou.res.status === 200 && louPurge.status === 200 && !joinRow(lou.id.pk)?.ip_kept_until
        && (await askWork('words', PUB)).level === 0,
        'removed more than a day after joining (Kay), or deleted by their own hand (Lou): nothing is kept, and the network is asked no more');
    // Max, removed fresh from a third network, to look for in the copies.
    const BAR = '203.0.113.18';
    const max = await joinByWords(BAR, 'Max');
    adminPruneUser(max.id.pk, 'owner:password');
    const maxRow = joinRow(max.id.pk);
    const payload = await exportSyncState('test');
    const exported = (payload.openJoins ?? []).find((j: any) => j.memberPubkey === max.id.pk);
    const bundled = readOpenJoinRecord().joins.find((j) => j.memberPubkey === max.id.pk);
    const payloadText = JSON.stringify(payload);
    assert(typeof maxRow?.ip_kept_until === 'string' && !!exported && !!bundled
        && JSON.stringify(Object.keys(exported).sort()) === JSON.stringify(['joinCohort', 'joinHash', 'joinedAt', 'memberPubkey', 'provider', 'updatedAt'])
        && JSON.stringify(Object.keys(bundled).sort()) === JSON.stringify(['joinCohort', 'joinHash', 'joinedAt', 'memberPubkey', 'provider', 'updatedAt'])
        && !payloadText.includes(maxRow.ip_hash) && !payloadText.includes(maxRow.ip_kept_until),
        'a copy for a standby and the take-over record carry Max\'s row (with its join_cohort label, report rings #1416), but neither the hash nor how long it is kept');

    // ── 7. overrides ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. overrides in node_config ──');
    const SHOP = '203.0.113.19';
    setConfig('doorNumbers.wordsPerHour', '3');
    addJoins(SHOP, 3, new Date(), 'words');
    const lowCeiling = await askWork('words', SHOP);
    setConfig('doorNumbers.wordsPerHour', null);
    assert(lowCeiling.status === 429 && lowCeiling.body?.code === 'network_busy', `doorNumbers.wordsPerHour=3: the 4th 12-words join from an address is refused (${show(lowCeiling)})`);
    setConfig('doorNumbers.networkSteps', '2,4,6,8');
    const steeper = await askWork('words', SHOP);
    setConfig('doorNumbers.networkSteps', null);
    assert(steeper.level === 2, `doorNumbers.networkSteps=2,4,6,8: the 4th join from an address has passed two steps, level 2 (got ${steeper.level})`);
    for (const [key, bad] of [['doorNumbers.wordsPerHour', 'lots'], ['doorNumbers.networkSteps', '30,10,100,200'], ['doorNumbers.networkSteps', '1,2,3'], ['doorNumbers.nope', '5']]) {
        setConfig(key, bad);
    }
    const kept = doorNumbers();
    for (const key of ['doorNumbers.wordsPerHour', 'doorNumbers.networkSteps', 'doorNumbers.nope']) setConfig(key, null);
    assert(kept.wordsPerHour === N.wordsPerHour && JSON.stringify(kept.networkSteps) === JSON.stringify(N.networkSteps),
        `values that aren't numbers, steps that fall or are too few, and a name that isn't one: ignored, the defaults kept (${JSON.stringify({ wordsPerHour: kept.wordsPerHour, networkSteps: kept.networkSteps })})`);

    // ── 8. local profile ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. local profile ──');
    delete process.env.NODE_PROFILE;
    const LOCAL = '203.0.113.20';
    const someone = newId();
    const routes = await Promise.all([
        call('POST', someone, '/api/join/work', LOCAL, { door: 'words' }),
        call('POST', someone, '/api/join', LOCAL, { door: 'words', callsign: 'Someone', work: { challenge: 'x', counters: [] } }),
        call('POST', someone, '/api/join/sso-nonce', LOCAL, {}),
        call('POST', someone, '/api/join/link/sso-nonce', LOCAL, {}),
        call('POST', someone, '/api/join/link', LOCAL, { provider: 'google', idToken: 'x', nonce: 'y' }),
    ]);
    assert(routes.every(r => r.status === 404 && r.body?.code === 'invite_only'), `every door route → 404 invite_only (${routes.map(r => r.status).join(', ')})`);
    pruneAuthAttempts(Date.now() + 120_000);
    holdLimiters = true;
    let refused = 0;
    for (let i = 0; i < 16; i++) if ((await call('GET', someone, `/api/members/callsign-available/Local${i}`, LOCAL)).status === 429) refused++;
    holdLimiters = false;
    assert(refused === 1, `the name check, signed by a key that is no member, keeps the auth limiter's 15 a minute here (${refused} of 16 refused)`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The door\'s signal: seconds of work for a busy network instead of a refusal, and ceilings no honest network reaches.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
