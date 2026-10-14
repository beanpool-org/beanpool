/**
 * The 12-words door and its door work (the two-doors design §2, §3: scratch/global-node/DESIGN-global-two-doors-fable.md),
 * over REAL HTTPS through the real signature middleware. No provider is contacted: the Google JWKS is a test key primed
 * into sso.ts's cache, as in test-open-join.
 *
 *   1. local profile: POST /api/join/work and a 12-words join answer 404 invite_only, and features.wordsDoor is false
 *   2. global profile: features.wordsDoor true; the work answer: a challenge for this key at the 12-words door, level 0,
 *      8 parts of 7 bits over 64 KB, ten minutes; the sign-in door at ordinary rates asks none (`work: null`)
 *   3. a 12-words join with good work: a member, `invited_by` open:words, no invite code, an `open_joins` row of provider
 *      `words` with a random `words:` hash and this network's hash; the funnel counts the attempt as `words`; its own
 *      /api/community/me says its probation runs on the 12-words rules
 *   4. refused as the sign-in door refuses: unsigned (401), a body naming another key (403), an upper-case spelling of a
 *      member's key (409 already_member), a key a re-key replaced (403 key_invalidated), a closed account's key (403
 *      account_closed); a 12-words body that carries a sign-in (400); a name under 2 characters (400)
 *   5. the work's refusals, each with its code and nothing written: none sent (work_required); counters that don't solve
 *      it, a challenge for another key, for the other door, with its level changed, or made with another work key (a
 *      restart) (work_invalid); past its ten minutes (work_expired); used twice (work_spent). At the sign-in door, a work
 *      refusal leaves the nonce unspent, and the same nonce joins with good work
 *   6. what it costs (measured, printed): checking a good solution takes under 2 ms (median of 40; about 0.2 ms on an idle
 *      machine, the bound is wide for a busy parallel pool); a bad one stops at its first part, one hash; issuing is one
 *      HMAC; and one solve per level 0 to 5 on this machine
 *   7. the switch: nodeProfile.ssoRequiredForJoin=true shuts the 12-words door (403 sign_in_required on the work and the
 *      join, features.wordsDoor false) and leaves the sign-in door as it was
 *   8. a 12-words join needs no door key: with data/open-join.key moved away, a sign-in is 503 door_key_missing and a
 *      12-words join is 200
 *   9. a member of another community (federation's visitor row for that key) joins by 12 words with the same key: its
 *      row becomes a member's here, no longer a visitor's
 *  10. the door's own limiter: 20 a minute per key, then 429 with Retry-After; 600 a minute per address; a name check a
 *      joining key signs counts there, not against the auth limiter's 15, which still holds for an unsigned one
 *
 * Every solve runs in a worker thread (door-work-test-solver.ts), never on the server's event loop: a solve held there
 * past the 5 s keep-alive made the next request reset (CI run 36876951525). At the end the suite asserts that no section
 * held the loop for 1.5 s or more.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-door-work.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;

import crypto from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
    DOOR_WORK_MAX_LEVEL,
    DOOR_WORK_PAD_BYTES,
    DOOR_WORK_PARTS,
    checkDoorWorkSolution,
    makeDoorWorkChallenge,
} from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, registerVisitor } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { DOOR_RATE_LIMIT, pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getFunnel } from './engine/funnel.js';
import { openJoinAddressHash } from './engine/open-join.js';
import { DOOR_NUMBERS } from './engine/door-signal.js';
import { checkDoorWork, issueDoorWork, nodeSha256 } from './services/door-work.js';
import { openJoinKeyPath } from './services/open-join-key.js';
import { limiterKeyForIp } from './client-ip.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { loopWatch, solveOffLoop, solveOffLoopTimed } from './door-work-test-solver.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the provider fixture (test-open-join's) ─────────────────────────────────────────────────────
const GOOGLE_KID = 'test-door-work-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
}
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

// ── joiners and requests ────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/** Every request comes from this address unless a call names another (the tunnel's header; loopback is a trusted proxy). */
const HOME_IP = '198.51.100.10';
/** Whether the door's limiter windows are kept between calls (only section 10 keeps them). */
let holdDoorLimiter = false;

interface Res { status: number; body: any; headers: Headers }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown, opts: { ip?: string; spellAs?: string } = {}): Promise<Res> {
    resetGatewayRateLimit();
    if (!holdDoorLimiter) pruneAuthAttempts(Date.now() + 120_000);
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? HOME_IP };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.spellAs ?? id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, headers: res.headers };
}
const post = (id: Id | null, path: string, body?: unknown, opts?: { ip?: string; spellAs?: string }) => call('POST', id, path, body, opts);
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)}`;

/** The work the 12-words door hands this key now, solved here. */
async function wordsWork(id: Id, ip?: string): Promise<{ challenge: string; counters: number[]; level: number }> {
    const w = await post(id, '/api/join/work', { door: 'words' }, { ip });
    if (w.status !== 200 || !w.body?.work) throw new Error(`no work: ${show(w)}`);
    return { challenge: w.body.work.challenge, counters: await solveOffLoop(w.body.work.challenge), level: w.body.work.level };
}
const wordsJoin = (id: Id, callsign: string, work: unknown, ip?: string) => post(id, '/api/join', { door: 'words', callsign, work }, { ip });

const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
const countMembers = () => (db.prepare('SELECT COUNT(*) AS n FROM members').get() as any).n as number;
const countJoins = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as any).n as number;
function funnelCount(event: string, variant: string): number {
    return getFunnel(1).filter(r => r.event === event && r.variant === variant).reduce((n, r) => n + r.count, 0);
}
async function features(): Promise<any> {
    return ((await (await fetch(`${BASE}/api/community/info`)).json()) as any).features;
}
const setOverride = (name: string, value: string | null) => {
    if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(`nodeProfile.${name}`);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`nodeProfile.${name}`, value);
};
/**
 * How long the server's event loop is held, section by section (door-work-test-solver.ts). A hold near the server's 5 s
 * keep-alive makes the next request reuse a socket the server is closing (ECONNRESET: CI run 36876951525). Solves run
 * in a worker for that reason; this keeps it so.
 */
const LOOP_HOLD_LIMIT_MS = 1500;
let loop: ReturnType<typeof loopWatch>;
let loopSection = 'setup';
let loopWorst = 0;
const loopHolds: string[] = [];
async function loopMark(next: string): Promise<void> {
    // A hold is recorded only once the loop runs again, so give it a turn before reading.
    await new Promise((r) => setTimeout(r, 50));
    const held = loop.maxMs();
    loopWorst = Math.max(loopWorst, held);
    loopHolds.push(`${loopSection} ${Math.round(held)} ms`);
    loop.reset();
    loopSection = `§${next}`;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];

async function main(): Promise<void> {
    console.log('\n=== The 12-words door and its door work, over real HTTPS ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    loop = loopWatch();
    primeJwks();
    _clearNoncesForTests();

    // ── 1. local profile ─────────────────────────────────────────────────────────────────────────
    await loopMark('1');
    console.log('── 1. local profile: no door ──');
    const shut = newId();
    const shutWork = await post(shut, '/api/join/work', { door: 'words' });
    assert(shutWork.status === 404 && shutWork.body?.code === 'invite_only', `local: POST /api/join/work → 404 invite_only (${show(shutWork)})`);
    const shutJoin = await wordsJoin(shut, 'Shut', { challenge: 'x', counters: [] });
    assert(shutJoin.status === 404 && shutJoin.body?.code === 'invite_only' && !memberRow(shut.pk), `local: a 12-words join → 404, nobody joined (${show(shutJoin)})`);
    assert((await features())?.wordsDoor === false, 'local: features.wordsDoor false');

    // ── 2. global profile: the work answer ───────────────────────────────────────────────────────
    await loopMark('2');
    console.log('\n── 2. global profile: the work answer ──');
    process.env.NODE_PROFILE = 'global';
    const f = await features();
    assert(f?.openJoin === true && f?.wordsDoor === true, `global: features.openJoin and features.wordsDoor true (${JSON.stringify({ openJoin: f?.openJoin, wordsDoor: f?.wordsDoor })})`);
    const ada = newId();
    const work = await post(ada, '/api/join/work', { door: 'words' });
    const w = work.body?.work;
    assert(work.status === 200 && w?.level === 0 && w?.parts === DOOR_WORK_PARTS && w?.bits === 7 && w?.size === DOOR_WORK_PAD_BYTES
        && w?.expiresInSeconds === 600 && /^v1\.0\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(w?.challenge) && work.body?.turnstile === null,
        `the 12-words door hands a quiet network level 0: 8 parts of 7 bits over 64 KB, ten minutes (${show(work)})`);
    const signInWork = await post(ada, '/api/join/work', { door: 'sign-in' });
    assert(signInWork.status === 200 && signInWork.body?.work === null, `the sign-in door at ordinary rates asks none (${show(signInWork)})`);
    const noDoor = await post(ada, '/api/join/work', { door: 'sso' });
    assert(noDoor.status === 400, `a door that isn't one → 400 (${show(noDoor)})`);
    const unsignedWork = await post(null, '/api/join/work', { door: 'words' });
    assert(unsignedWork.status === 401, `an unsigned work request is refused by the middleware (${unsignedWork.status})`);

    // ── 3. a 12-words join ───────────────────────────────────────────────────────────────────────
    await loopMark('3');
    console.log('\n── 3. a 12-words join ──');
    const attemptsBefore = funnelCount('open_join_attempt', 'words');
    const adaJoin = await wordsJoin(ada, '  Ada Words  ', { challenge: w.challenge, counters: await solveOffLoop(w.challenge) });
    const adaRow = memberRow(ada.pk);
    const adaDoor = joinRow(ada.pk);
    assert(adaJoin.status === 200 && adaJoin.body?.success === true && adaJoin.body?.door === 'words' && adaJoin.body?.member?.publicKey === ada.pk,
        `a 12-words join with good work → 200, the member (${show(adaJoin)})`);
    assert(adaRow?.invited_by === 'open:words' && !adaRow?.invite_code && adaRow?.callsign === 'Ada Words' && adaRow?.is_visitor === 0,
        `invited_by open:words, no invite code, the name trimmed (${JSON.stringify({ by: adaRow?.invited_by, code: adaRow?.invite_code, name: adaRow?.callsign })})`);
    assert(adaDoor?.provider === 'words' && /^words:[0-9a-f]{32}$/.test(adaDoor?.join_hash) && adaDoor?.ip_hash === openJoinAddressHash(limiterKeyForIp(HOME_IP)),
        `an open_joins row of provider words, a random words: hash, and this network's keyed hash (${JSON.stringify({ provider: adaDoor?.provider, hash: adaDoor?.join_hash })})`);
    assert(funnelCount('open_join_attempt', 'words') === attemptsBefore + 1, 'the funnel counts the attempt as words');
    const me = await call('GET', ada, '/api/community/me');
    assert(me.status === 200 && me.body?.probation?.onProbation === true && me.body?.probation?.rules === 'words'
        && me.body?.probation?.limits?.posts?.limit === 2 && me.body?.probation?.endsWhen?.hours === 168,
        `its /api/community/me: on probation under the 12-words rules, 2 posts a day, 7 days (${JSON.stringify(me.body?.probation)})`);
    const again = await wordsJoin(ada, 'Ada', { challenge: w.challenge, counters: await solveOffLoop(w.challenge) });
    assert(again.status === 409 && again.body?.code === 'already_member', `the same key again → 409 already_member (${show(again)})`);

    // ── 4. refused as the sign-in door refuses ───────────────────────────────────────────────────
    await loopMark('4');
    console.log('\n── 4. refused as the sign-in door refuses ──');
    const unsignedJoin = await post(null, '/api/join', { door: 'words', callsign: 'Nobody' });
    assert(unsignedJoin.status === 401, `unsigned → 401 (${unsignedJoin.status})`);
    const bea = newId();
    const beaWork = await wordsWork(bea);
    const spoof = await post(bea, '/api/join', { door: 'words', callsign: 'Bea', work: beaWork, publicKey: ada.pk });
    assert(spoof.status === 403 && !memberRow(bea.pk), `a body publicKey naming another key → 403 from the middleware (${spoof.status})`);
    const upper = await wordsJoin(ada, 'Ada Upper', beaWork);
    const upperSpelled = await post(ada, '/api/join', { door: 'words', callsign: 'Ada Upper', work: beaWork }, { spellAs: ada.pk.toUpperCase() });
    assert(upper.status === 409 && upperSpelled.status === 409 && upperSpelled.body?.code === 'already_member',
        `a member's key in upper case is that member: 409 already_member (${show(upperSpelled)})`);
    const kit = newId(), kit2 = newId();
    const kitJoin = await wordsJoin(kit, 'Kit', await wordsWork(kit));
    completeRekey(kit.pk, kit2.pk, issueRekeyCode(kit.pk, 'owner:password').code, 'owner:password');
    const replaced = await post(kit, '/api/join/work', { door: 'words' });
    assert(kitJoin.status === 200 && replaced.status === 403 && replaced.body?.code === 'key_invalidated',
        `a key a re-key replaced → 403 key_invalidated (${show(replaced)})`);
    const cal = newId();
    const calJoin = await wordsJoin(cal, 'Cal', await wordsWork(cal));
    const calPurge = await post(cal, '/api/member/purge', {});
    const closed = await post(cal, '/api/join/work', { door: 'words' });
    assert(calJoin.status === 200 && calPurge.status === 200 && closed.status === 403 && closed.body?.code === 'account_closed',
        `a closed account's key (deleted by its owner) → 403 account_closed (${show(closed)})`);
    const withSignIn = await post(bea, '/api/join', { door: 'words', callsign: 'Bea', work: beaWork, provider: 'google', idToken: 'x', nonce: 'y' });
    assert(withSignIn.status === 400 && /carries no sign-in/.test(withSignIn.body?.error) && !memberRow(bea.pk),
        `a 12-words body that carries a sign-in → 400, one request one path (${show(withSignIn)})`);
    const shortName = await wordsJoin(bea, ' B ', beaWork);
    assert(shortName.status === 400 && !memberRow(bea.pk), `a name under 2 characters → 400 (${show(shortName)})`);

    // ── 5. the work's refusals ───────────────────────────────────────────────────────────────────
    await loopMark('5');
    console.log('\n── 5. the work\'s refusals ──');
    const membersBefore = countMembers();
    const joinsBefore = countJoins();
    const refused = async (label: string, work: unknown, code: string) => {
        const r = await wordsJoin(bea, 'Bea', work);
        assert(r.status === 400 && r.body?.code === code && !memberRow(bea.pk), `${label} → 400 ${code}, nothing written (${show(r)})`);
    };
    await refused('no work', undefined, 'work_required');
    await refused('work that is not an object', 'v1.0.1.x.y', 'work_required');
    const badCounters = [...beaWork.counters];
    badCounters[0] = 0;
    // The smallest counter that works is the solver's, so 0 below it does not, unless it is 0 itself.
    if (beaWork.counters[0] === 0) badCounters[0] = 1;
    const bad = checkDoorWorkSolution(beaWork.challenge, badCounters, nodeSha256);
    await refused('counters that don\'t solve it', { challenge: beaWork.challenge, counters: badCounters }, bad.ok ? 'never' : 'work_invalid');
    const forAda = issueDoorWork(ada.pk, 'words', 0).challenge;
    await refused('a challenge issued to another key', { challenge: forAda, counters: await solveOffLoop(forAda) }, 'work_invalid');
    const forSignIn = issueDoorWork(bea.pk, 'sign-in', 0).challenge;
    await refused('a challenge for the other door', { challenge: forSignIn, counters: await solveOffLoop(forSignIn) }, 'work_invalid');
    const relevelled = beaWork.challenge.replace(/^v1\.0\./, 'v1.1.');
    await refused('its level changed', { challenge: relevelled, counters: await solveOffLoop(relevelled) }, 'work_invalid');
    const beforeRestart = makeDoorWorkChallenge({ workKey: new Uint8Array(crypto.randomBytes(32)), level: 0, key: bea.pk, door: 'words' });
    await refused('one made with another work key (before a restart)', { challenge: beforeRestart, counters: await solveOffLoop(beforeRestart) }, 'work_invalid');
    const stale = issueDoorWork(bea.pk, 'words', 0, Date.now() - 11 * 60_000).challenge;
    await refused('one past its ten minutes', { challenge: stale, counters: await solveOffLoop(stale) }, 'work_expired');
    assert(countMembers() === membersBefore && countJoins() === joinsBefore, 'none of them wrote a member or a join');
    const beaJoins = await wordsJoin(bea, 'Bea', beaWork);
    assert(beaJoins.status === 200 && joinRow(bea.pk)?.provider === 'words', `and Bea's own good work, refused nowhere above, joins (${show(beaJoins)})`);

    // Spent twice, and a refusal never spends a nonce: the sign-in door, on a network busy enough that it asks for work.
    const BUSY_IP = '198.51.100.30';
    const busyHash = openJoinAddressHash(limiterKeyForIp(BUSY_IP));
    const insertRow = db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
        for (let i = 0; i < DOOR_NUMBERS.global.signInWorkFrom; i++) {
            insertRow.run(crypto.randomBytes(32).toString('hex'), 'google', crypto.randomBytes(32).toString('base64url'), new Date().toISOString(), busyHash);
        }
    })();
    const dot = newId();
    const dotWorkAnswer = await post(dot, '/api/join/work', { door: 'sign-in' }, { ip: BUSY_IP });
    const dotChallenge = dotWorkAnswer.body?.work?.challenge as string;
    assert(dotWorkAnswer.status === 200 && dotWorkAnswer.body?.work?.level === 0, `a busy network: the sign-in door asks work (${show(dotWorkAnswer)})`);
    const dotNonce = (await post(dot, '/api/join/sso-nonce', {}, { ip: BUSY_IP })).body?.nonce as string;
    const dotToken = mint('dot-google-sub', dotNonce);
    const dotBadWork = await post(dot, '/api/join', { callsign: 'Dot', provider: 'google', idToken: dotToken, nonce: dotNonce, work: { challenge: dotChallenge, counters: [0, 0, 0, 0, 0, 0, 0, 0] } }, { ip: BUSY_IP });
    const dotWork = { challenge: dotChallenge, counters: await solveOffLoop(dotChallenge) };
    const dotJoins = await post(dot, '/api/join', { callsign: 'Dot', provider: 'google', idToken: dotToken, nonce: dotNonce, work: dotWork }, { ip: BUSY_IP });
    assert(dotBadWork.status === 400 && dotBadWork.body?.code === 'work_invalid' && dotJoins.status === 200 && memberRow(dot.pk)?.invited_by === 'open:google',
        `bad work at the sign-in door → 400 before the sign-in is checked, and the same nonce then joins with good work (${dotBadWork.status} ${dotBadWork.body?.code}, ${dotJoins.status})`);
    const eli = newId();
    const eliChallenge = (await post(eli, '/api/join/work', { door: 'sign-in' }, { ip: BUSY_IP })).body?.work?.challenge as string;
    const eliWork = { challenge: eliChallenge, counters: await solveOffLoop(eliChallenge) };
    const eliNonce1 = (await post(eli, '/api/join/sso-nonce', {}, { ip: BUSY_IP })).body?.nonce as string;
    const eliWrongToken = await post(eli, '/api/join', { callsign: 'Eli', provider: 'google', idToken: mint('eli-google-sub', 'not-the-nonce'), nonce: eliNonce1, work: eliWork }, { ip: BUSY_IP });
    const eliNonce2 = (await post(eli, '/api/join/sso-nonce', {}, { ip: BUSY_IP })).body?.nonce as string;
    const eliSpent = await post(eli, '/api/join', { callsign: 'Eli', provider: 'google', idToken: mint('eli-google-sub', eliNonce2), nonce: eliNonce2, work: eliWork }, { ip: BUSY_IP });
    assert(eliWrongToken.status === 401 && eliSpent.status === 400 && eliSpent.body?.code === 'work_spent' && !memberRow(eli.pk),
        `work that checked is spent: used again after a failed sign-in → 400 work_spent (${eliWrongToken.status}, ${show(eliSpent)})`);

    // ── 6. what it costs ─────────────────────────────────────────────────────────────────────────
    await loopMark('6');
    console.log('\n── 6. what it costs (measured on this machine) ──');
    const costKey = newId().pk;
    // Solved in the worker (door-work-test-solver.ts): only the checks below run on the server's loop.
    const solved = await Promise.all(Array.from({ length: 40 }, async () => {
        const challenge = issueDoorWork(costKey, 'words', 0).challenge;
        return { challenge, counters: await solveOffLoop(challenge) };
    }));
    const checkMs: number[] = [];
    for (const s of solved) {
        const t0 = performance.now();
        const ok = checkDoorWork(s, costKey, 'words');
        checkMs.push(performance.now() - t0);
        if (!ok.ok || ok.hashes !== DOOR_WORK_PARTS) throw new Error(`a good solution did not check: ${JSON.stringify(ok)}`);
    }
    const junkMs: number[] = [];
    let junkHashes = 0;
    for (let i = 0; i < 40; i++) {
        const challenge = issueDoorWork(costKey, 'words', 5).challenge;
        const t0 = performance.now();
        const r = checkDoorWork({ challenge, counters: [0, 0, 0, 0, 0, 0, 0, 0] }, costKey, 'words');
        junkMs.push(performance.now() - t0);
        // A level-5 part needs 12 zero bits: counter 0 meets them about once in 4,096, and then the next part fails.
        junkHashes = Math.max(junkHashes, r.hashes);
        if (r.ok) throw new Error('junk checked');
    }
    const issueMs: number[] = [];
    for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        issueDoorWork(costKey, 'words', 3);
        issueMs.push(performance.now() - t0);
    }
    console.log(`   check of one join's work (mac, expiry, 8 hashes of 64 KB): median ${median(checkMs).toFixed(3)} ms, p95 ${quantile(checkMs, 0.95).toFixed(3)} ms (n=40)`);
    console.log(`   junk (a level-5 challenge, counters all 0): median ${median(junkMs).toFixed(3)} ms, at most ${junkHashes} hash(es) (n=40)`);
    console.log(`   issuing a challenge (one HMAC): median ${(median(issueMs) * 1000).toFixed(1)} µs (n=200)`);
    // About 0.2 ms on an idle machine; CI's parallel pool measured a 0.456 ms median. 2 ms leaves that room and still
    // says what matters: a check costs a request next to nothing.
    assert(median(checkMs) < 2, `checking a good solution takes under 2 ms (median ${median(checkMs).toFixed(3)} ms)`);
    const firstPartWrong = checkDoorWork({ challenge: solved[0].challenge.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), counters: solved[0].counters }, costKey, 'words');
    const junkSolution = await (async () => {
        const challenge = issueDoorWork(costKey, 'words', 0).challenge;
        const counters = await solveOffLoop(challenge);
        const wrong = [...counters];
        wrong[0] = counters[0] === 0 ? 1 : 0;
        return checkDoorWork({ challenge, counters: wrong }, costKey, 'words');
    })();
    assert(!firstPartWrong.ok && firstPartWrong.hashes === 0 && !junkSolution.ok && junkSolution.hashes <= 2 && junkHashes <= 2,
        `a forged challenge costs no hash, and a wrong solution stops at its first wrong part (${JSON.stringify({ forged: firstPartWrong.hashes, wrong: junkSolution.hashes, junk: junkHashes })})`);
    const solveLine: string[] = [];
    for (let level = 0; level <= DOOR_WORK_MAX_LEVEL; level++) {
        const challenge = issueDoorWork(costKey, 'words', level).challenge;
        // Timed inside the worker: the solve alone, as an app's would be.
        const { counters, ms } = await solveOffLoopTimed(challenge);
        const tries = counters.reduce((n, c) => n + c + 1, 0);
        solveLine.push(`L${level} ${Math.round(ms)} ms (${tries} tries)`);
    }
    console.log(`   one solve per level, node:crypto on this machine: ${solveLine.join(', ')}`);

    // ── 7. the switch ────────────────────────────────────────────────────────────────────────────
    await loopMark('7');
    console.log('\n── 7. ssoRequiredForJoin shuts the 12-words door, and only it ──');
    setOverride('ssoRequiredForJoin', 'true');
    const fay = newId();
    const fayWork = await post(fay, '/api/join/work', { door: 'words' });
    const fayJoin = await wordsJoin(fay, 'Fay', { challenge: forAda, counters: [] });
    assert(fayWork.status === 403 && fayWork.body?.code === 'sign_in_required' && fayJoin.status === 403 && fayJoin.body?.code === 'sign_in_required'
        && (await features())?.wordsDoor === false,
        `nodeProfile.ssoRequiredForJoin=true: the work and the join → 403 sign_in_required, features.wordsDoor false (${show(fayWork)})`);
    const fayNonce = (await post(fay, '/api/join/sso-nonce', {})).body?.nonce as string;
    const faySignIn = await post(fay, '/api/join', { callsign: 'Fay', provider: 'google', idToken: mint('fay-google-sub', fayNonce), nonce: fayNonce });
    assert(faySignIn.status === 200 && memberRow(fay.pk)?.invited_by === 'open:google', `while the sign-in door is as it was (${show(faySignIn)})`);
    setOverride('ssoRequiredForJoin', null);

    // ── 8. no door key needed ────────────────────────────────────────────────────────────────────
    await loopMark('8');
    console.log('\n── 8. a 12-words join needs no door key ──');
    const keyFile = openJoinKeyPath();
    const keyAside = `${keyFile}.aside`;
    const gus = newId(), hal = newId();
    const gusWork = await wordsWork(gus);
    let gusJoin: Res, halNonce: Res;
    fs.renameSync(keyFile, keyAside);
    try {
        halNonce = await post(hal, '/api/join/sso-nonce', {});
        gusJoin = await wordsJoin(gus, 'Gus', gusWork);
    } finally {
        fs.renameSync(keyAside, keyFile);
    }
    assert(halNonce.status === 503 && halNonce.body?.code === 'door_key_missing', `with data/open-join.key moved away a sign-in is refused, 503 door_key_missing (${show(halNonce)})`);
    assert(gusJoin.status === 200 && joinRow(gus.pk)?.provider === 'words', `and a 12-words join is taken: it compares no sign-in (${show(gusJoin)})`);

    // ── 9. a member of another community ─────────────────────────────────────────────────────────
    await loopMark('9');
    console.log('\n── 9. a member of another community joins by 12 words with the same key ──');
    const ivy = newId();
    registerVisitor(ivy.pk, 'Ivy', 'https://elsewhere.example');
    assert(memberRow(ivy.pk)?.is_visitor === 1, 'setup: federation knows Ivy as another community\'s member (a visitor\'s row)');
    const ivyJoin = await wordsJoin(ivy, 'Ivy', await wordsWork(ivy));
    const ivyRow = memberRow(ivy.pk);
    assert(ivyJoin.status === 200 && ivyRow?.is_visitor === 0 && !ivyRow?.home_node_url && ivyRow?.invited_by === 'open:words' && joinRow(ivy.pk)?.provider === 'words',
        `her row becomes a member's here, by 12 words, with the key she already holds (${show(ivyJoin)})`);

    // ── 10. the door's limiter ───────────────────────────────────────────────────────────────────
    await loopMark('10');
    console.log('\n── 10. the door\'s own limiter ──');
    pruneAuthAttempts(Date.now() + 120_000);
    holdDoorLimiter = true;
    try {
        const LIMIT_IP = '198.51.100.60';
        const one = newId();
        const answers: Res[] = [];
        for (let i = 0; i <= DOOR_RATE_LIMIT.perKey; i++) answers.push(await post(one, '/api/join/work', { door: 'words' }, { ip: LIMIT_IP }));
        const last = answers[answers.length - 1];
        assert(answers.slice(0, -1).every(r => r.status === 200) && last.status === 429 && Number(last.headers.get('retry-after')) > 0,
            `one key: ${DOOR_RATE_LIMIT.perKey} a minute, the next → 429 with Retry-After (${answers.filter(r => r.status === 200).length} answered, then ${last.status} ${last.headers.get('retry-after')})`);
        let answered = DOOR_RATE_LIMIT.perKey;
        while (answered < DOOR_RATE_LIMIT.perAddress) {
            const k = newId();
            for (let i = 0; i < DOOR_RATE_LIMIT.perKey && answered < DOOR_RATE_LIMIT.perAddress; i++) {
                const r = await post(k, '/api/join/work', { door: 'words' }, { ip: LIMIT_IP });
                if (r.status !== 200) throw new Error(`refused before the address's ${DOOR_RATE_LIMIT.perAddress}: ${show(r)} at ${answered}`);
                answered++;
            }
        }
        const overAddress = await post(newId(), '/api/join/work', { door: 'words' }, { ip: LIMIT_IP });
        assert(overAddress.status === 429, `one address: ${DOOR_RATE_LIMIT.perAddress} a minute across its keys, the next key's → 429 (${overAddress.status})`);
        const otherAddress = await post(newId(), '/api/join/work', { door: 'words' }, { ip: '198.51.100.61' });
        assert(otherAddress.status === 200, `another address is not held up by it (${otherAddress.status})`);

        const NAME_IP = '198.51.100.62';
        const namer = newId();
        let namesRefused = 0;
        for (let i = 0; i < 16; i++) if ((await call('GET', namer, `/api/members/callsign-available/Namer${i}`, undefined, { ip: NAME_IP })).status === 429) namesRefused++;
        let unsignedRefused = 0;
        for (let i = 0; i < 16; i++) if ((await call('GET', null, `/api/members/callsign-available/Anon${i}`, undefined, { ip: NAME_IP })).status === 429) unsignedRefused++;
        assert(namesRefused === 0 && unsignedRefused === 1,
            `a name check signed by a joining key counts against the door's limiter (16 answered); an unsigned one from the same address still meets the auth limiter's 15 (${unsignedRefused} of 16 refused)`);
    } finally {
        holdDoorLimiter = false;
    }

    await loopMark('end');
    loop.stop();
    console.log(`   the longest the server's event loop was held, per section: ${loopHolds.join(', ')}`);
    assert(loopWorst < LOOP_HOLD_LIMIT_MS,
        `no section held the server's event loop for ${LOOP_HOLD_LIMIT_MS} ms or more (longest ${Math.round(loopWorst)} ms; its keep-alive is 5 s, and a hold near it resets the next request)`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The 12-words door: signed, its work bound to the key and the door, checked in a fraction of a millisecond, and never a dead end.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
