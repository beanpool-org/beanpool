/**
 * GitHub sign-in run by the NODE (sign-in hardening S2), over REAL HTTPS through the real signature middleware.
 *
 * No GitHub is contacted. `fetch` is stubbed for the whole run: requests to this test's own server go through,
 * `github.com` and `api.github.com` are answered by a fake GitHub below that plays the device flow, `exp.host`
 * (push) is recorded, and anything else is recorded and refused. The node's clock for GitHub sessions is moved
 * by the test instead of waiting out GitHub's interval.
 *
 *   1. start and poll need a signed active member (401 otherwise); start asks GitHub with our client id
 *   2. a poll inside the interval answers pending with no GitHub request
 *   3. GitHub's answers mapped: authorization_pending, slow_down (the interval grows), access_denied,
 *      expired_token, GitHub down (start 503, a poll stays pending), GitHub rate-limiting a poll (429, or its
 *      rate-limit 403: pending, the session survives); starting again replaces the old session; /user failing
 *      after the token is issued → 400 start again, never a 503 try-again for a session that is gone
 *   4. success keeps only { sub, email }: the access token is not reachable from the session object, not in
 *      any answer, not in the logs, not in the database
 *   5. another key cannot poll or spend a session, and does not consume it; a session is spent once; an
 *      unspent result expires after NONCE_TTL_MS
 *   6. a GitHub token handed in (an OAuth token, a PAT, either as idToken or as the session id) → 400, no request
 *   7. the recovering device: its sessions bind to its ephemeral key; a member's session cannot be spent there
 *   8. round trip: deposit with GitHub, recover with GitHub, the blob opens with the sub the node returned
 *   9. the release alert: fires once when a sign-in releases the fragment, never on a failed attempt
 *  10. every sign-in nonce answer carries githubFlow: 'node'
 *  11. the global door: GitHub start and poll 404 on a local node, work on the global one, and join; a door
 *      session cannot be spent on the recovery routes
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-github-device.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GITHUB_CLIENT_IDS;
delete process.env.GITHUB_CLIENT_ID;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { NONCE_TTL_MS, verifySignIn } from './sso.js';
import {
    _setGithubDeviceClockForTests,
    _clearGithubSessionsForTests,
    _githubSessionForTests,
} from './engine/github-device.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { sealSeedToSso, openShareFromSso } from '@beanpool/core';

const PORT = 8733;
const BASE = `https://localhost:${PORT}`;
const OUR_CLIENT_ID = 'Ov23li8mmDfBr7GyJVRU';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── everything this process writes, so the logs can be searched for the token ─────────────────────
let written = '';
for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]) => {
        written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        return original(chunk, ...rest);
    };
}

// ── a fake GitHub ────────────────────────────────────────────────────────────────────────────────
interface GhUser { id: number; login: string; email: string | null; privateEmail?: string }
interface GhDevice {
    deviceCode: string;
    userCode: string;
    clientId: string;
    scope: string;
    /** What the next access_token polls answer, in order; empty means authorization_pending. */
    queue: Array<'token' | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'down' | 'rate_limited' | 'rate_limited_403'>;
    user?: GhUser;
    token?: string;
}
const gh = {
    byDeviceCode: new Map<string, GhDevice>(),
    byUserCode: new Map<string, GhDevice>(),
    tokens: new Map<string, GhUser>(),
    /** The device-code endpoint answering 503. */
    down: false,
    /** When set, /user answers with this HTTP status instead of the user. */
    userStatus: 0,
    calls: { deviceCode: 0, accessToken: 0, user: 0, emails: 0 },
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeGithub(url: string, init: any): Response {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === 'https://github.com/login/device/code') {
        gh.calls.deviceCode++;
        if (gh.down) return new Response('unavailable', { status: 503 });
        const device: GhDevice = {
            deviceCode: crypto.randomBytes(20).toString('hex'),
            userCode: `${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`.toUpperCase(),
            clientId: body.client_id,
            scope: body.scope,
            queue: [],
        };
        gh.byDeviceCode.set(device.deviceCode, device);
        gh.byUserCode.set(device.userCode, device);
        return json({ device_code: device.deviceCode, user_code: device.userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
        gh.calls.accessToken++;
        const device = gh.byDeviceCode.get(body.device_code);
        if (!device || body.client_id !== device.clientId || body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
            return json({ error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.' });
        }
        const next = device.queue.shift() ?? 'authorization_pending';
        if (next === 'down') return new Response('unavailable', { status: 502 });
        // GitHub's rate limits: JSON with a `message` and no OAuth `error`, as a 429 or as a 403 with the headers.
        if (next === 'rate_limited') return json({ message: 'API rate limit exceeded for 203.0.113.9.' }, 429);
        if (next === 'rate_limited_403') {
            return new Response(JSON.stringify({ message: 'API rate limit exceeded for 203.0.113.9.' }),
                { status: 403, headers: { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0' } });
        }
        if (next === 'token') {
            device.token = `gho_${crypto.randomBytes(18).toString('hex')}`;
            gh.tokens.set(device.token, device.user!);
            return json({ access_token: device.token, token_type: 'bearer', scope: 'read:user,user:email' });
        }
        // slow_down with no interval, so the +5 s the node adds is the only thing that can move it.
        return json({ error: next });
    }
    const bearer = String(init?.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const user = gh.tokens.get(bearer);
    if (url === 'https://api.github.com/user') {
        gh.calls.user++;
        if (gh.userStatus === 429) return json({ message: 'API rate limit exceeded for user ID 1.' }, 429);
        if (gh.userStatus) return new Response('unavailable', { status: gh.userStatus });
        return user ? json({ id: user.id, login: user.login, email: user.email }) : json({ message: 'Bad credentials' }, 401);
    }
    if (url === 'https://api.github.com/user/emails') {
        gh.calls.emails++;
        return user ? json([{ email: user.privateEmail, primary: true, verified: true }]) : json({ message: 'Bad credentials' }, 401);
    }
    return json({ message: 'Not Found' }, 404);
}

const realFetch = globalThis.fetch;
/** Every request that left for somewhere other than this test's own server. */
let outbound: string[] = [];
let pushes: any[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    outbound.push(url);
    if (url.startsWith('https://exp.host/')) {
        pushes.push(...JSON.parse(String(init?.body ?? '[]')));
        return json({ data: [] });
    }
    if (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')) return fakeGithub(url, init);
    return new Response('stubbed: test-github-device contacts nobody', { status: 503 });
}) as typeof fetch;

const providerRequests = () => outbound.filter(u => !u.startsWith('https://exp.host/')).length;

// ── the node's GitHub clock ──────────────────────────────────────────────────────────────────────
let offset = 0;
_setGithubDeviceClockForTests(() => Date.now() + offset);
const advance = (ms: number) => { offset += ms; };

// ── callers ──────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Uint8Array }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seed = new Uint8Array((privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32));
    return { pk, priv: privateKey, seed };
}

let seq = 0;
function newMember(): Id & { callsign: string } {
    const id = newId();
    const callsign = `ghd${++seq}-${id.pk.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pk, callsign);
    return { ...id, callsign };
}

async function call(id: Id | null, path: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, raw: text };
}

let nextGithubId = 5_000_000;
function ghUser(email: string | null = null, privateEmail?: string): GhUser {
    const id = nextGithubId++;
    return { id, login: `user${id}`, email, privateEmail };
}

/** Drive a start/poll pair to `ok` as `user`. */
async function signInWithGithub(
    id: Id, prefix: string, extra: Record<string, unknown>, user: GhUser,
): Promise<{ sessionId: string; sub: string; email?: string; token: string; start: any; poll: any }> {
    const start = await call(id, `${prefix}/start`, extra);
    if (start.status !== 200) throw new Error(`${prefix}/start: ${start.status} ${start.raw}`);
    const device = gh.byUserCode.get(start.body.userCode)!;
    device.user = user;
    device.queue.push('token');
    advance(start.body.intervalSeconds * 1000);
    const poll = await call(id, `${prefix}/poll`, { ...extra, sessionId: start.body.sessionId });
    if (poll.status !== 200 || poll.body?.status !== 'ok') throw new Error(`${prefix}/poll: ${poll.status} ${poll.raw}`);
    return { sessionId: start.body.sessionId, sub: poll.body.sub, email: poll.body.email, token: device.token!, start, poll };
}

const MEMBER = '/api/recovery/sso/github';
const COLLECT = '/api/recovery/collect/github';
const DOOR = '/api/join/github';

/** Every string reachable from `value`, own properties enumerable or not. */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    const out: string[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
        out.push(key, ...reachableStrings((value as any)[key], seen));
    }
    return out;
}

async function main(): Promise<void> {
    console.log('\n=== GitHub sign-in run by the node, over real HTTPS ===\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);
    _clearGithubSessionsForTests();

    // ── 1. who may start ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. start and poll need a signed active member ──');
    const ada = newMember();
    const stranger = newId();
    const unsigned = await call(null, `${MEMBER}/start`, {});
    assert(unsigned.status === 401 && /signature/i.test(String(unsigned.body?.error)),
        `unsigned start → 401 from the signature middleware (got ${unsigned.status} ${unsigned.raw})`);
    const notMember = await call(stranger, `${MEMBER}/start`, {});
    assert(notMember.status === 401 && /active member/.test(String(notMember.body?.error)),
        `a signed key that is not a member → 401 (got ${notMember.status} ${notMember.raw})`);
    assert((await call(null, `${MEMBER}/poll`, { sessionId: 'x' })).status === 401, 'unsigned poll → 401');
    assert((await call(stranger, `${MEMBER}/poll`, { sessionId: 'x' })).status === 401, 'a non-member poll → 401');
    assert(gh.calls.deviceCode === 0, '...and none of them reached GitHub');

    outbound = [];
    const started = await call(ada, `${MEMBER}/start`, {});
    assert(started.status === 200 && typeof started.body?.sessionId === 'string' && started.body.sessionId.length >= 40
        && typeof started.body.userCode === 'string' && started.body.verificationUri === 'https://github.com/login/device'
        && started.body.expiresInSeconds === 900 && started.body.intervalSeconds === 5,
        `a signed active member starts: sessionId, userCode, verificationUri, expiresInSeconds, intervalSeconds (got ${started.raw})`);
    const adaDevice = gh.byUserCode.get(started.body.userCode)!;
    assert(adaDevice?.clientId === OUR_CLIENT_ID && adaDevice.scope === 'read:user user:email',
        `the node asked GitHub for a device code with our client id and read:user user:email (got ${adaDevice?.clientId}, ${adaDevice?.scope})`);
    assert(!started.raw.includes(adaDevice.deviceCode), 'the device code stays on the node: it is not in the answer');
    assert(outbound.length === 1 && outbound[0] === 'https://github.com/login/device/code', `exactly one request, to GitHub's device-code endpoint (got ${JSON.stringify(outbound)})`);

    // ── 2. inside the interval ───────────────────────────────────────────────────────────────────
    console.log('\n── 2. a poll inside the interval never asks GitHub ──');
    const sid = started.body.sessionId as string;
    const before = gh.calls.accessToken;
    const early: any[] = [];
    for (let i = 0; i < 4; i++) { early.push((await call(ada, `${MEMBER}/poll`, { sessionId: sid })).body); advance(1000); }
    assert(early.every(b => b?.status === 'pending' && b.intervalSeconds === 5), `four polls a second apart all answer pending (got ${JSON.stringify(early)})`);
    assert(gh.calls.accessToken === before, `...and none of them asked GitHub (${gh.calls.accessToken - before} requests)`);

    // ── 3. GitHub's answers ──────────────────────────────────────────────────────────────────────
    console.log('\n── 3. each of GitHub\'s answers ──');
    advance(1000);
    const pending = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(pending.status === 200 && pending.body?.status === 'pending' && gh.calls.accessToken === before + 1,
        `once the interval has passed the node asks GitHub, once; authorization_pending → pending (got ${pending.raw})`);

    adaDevice.queue.push('slow_down');
    advance(5000);
    const slowed = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(slowed.body?.status === 'pending' && slowed.body.intervalSeconds === 10 && gh.calls.accessToken === before + 2,
        `slow_down → pending, and the interval grows to 10 s (got ${slowed.raw})`);
    advance(5000);
    const stillSlow = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(stillSlow.body?.status === 'pending' && gh.calls.accessToken === before + 2,
        `5 s later, the old interval, the node does not ask GitHub (${gh.calls.accessToken - before - 2} extra requests)`);
    advance(5000);
    await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(gh.calls.accessToken === before + 3, 'at 10 s it asks again');

    adaDevice.queue.push('down');
    advance(10_000);
    const dropped = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(dropped.status === 200 && dropped.body?.status === 'pending',
        `GitHub failing mid-poll is a dropped poll, not a failed sign-in: pending (got ${dropped.status} ${dropped.raw})`);

    adaDevice.queue.push('rate_limited');
    advance(10_000);
    const throttled = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(throttled.status === 200 && throttled.body?.status === 'pending',
        `GitHub rate-limiting a poll (429) is a dropped poll too: pending (got ${throttled.status} ${throttled.raw})`);
    adaDevice.queue.push('rate_limited_403');
    advance(10_000);
    const throttled403 = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(throttled403.status === 200 && throttled403.body?.status === 'pending',
        `...and so is its rate-limit 403 (got ${throttled403.status} ${throttled403.raw})`);
    assert(!!_githubSessionForTests(sid), '...and the session survives both, for the member still typing the code');

    adaDevice.queue.push('access_denied');
    advance(10_000);
    const denied = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(denied.status === 200 && denied.body?.status === 'denied', `access_denied → denied (got ${denied.raw})`);
    const afterDenied = await call(ada, `${MEMBER}/poll`, { sessionId: sid });
    assert(afterDenied.status === 400, `...and the session is gone (got ${afterDenied.status})`);

    const second = await call(ada, `${MEMBER}/start`, {});
    gh.byUserCode.get(second.body.userCode)!.queue.push('expired_token');
    advance(5000);
    const expiredToken = await call(ada, `${MEMBER}/poll`, { sessionId: second.body.sessionId });
    assert(expiredToken.body?.status === 'expired', `expired_token → expired (got ${expiredToken.raw})`);

    const third = await call(ada, `${MEMBER}/start`, {});
    advance(901_000);
    const requestsBefore = gh.calls.accessToken;
    const codeExpired = await call(ada, `${MEMBER}/poll`, { sessionId: third.body.sessionId });
    assert(codeExpired.body?.status === 'expired' && gh.calls.accessToken === requestsBefore,
        `a device code past its expiry → expired, without asking GitHub (got ${codeExpired.raw})`);

    const first = await call(ada, `${MEMBER}/start`, {});
    const replacement = await call(ada, `${MEMBER}/start`, {});
    const replaced = await call(ada, `${MEMBER}/poll`, { sessionId: first.body.sessionId });
    assert(replacement.status === 200 && replaced.status === 400, `starting again replaces the member's earlier session (got ${replaced.status})`);

    gh.down = true;
    const down = await call(ada, `${MEMBER}/start`, {});
    gh.down = false;
    assert(down.status === 503 && /GitHub/.test(String(down.body?.error)), `GitHub down at start → 503, try again (got ${down.status} ${down.raw})`);

    // GitHub issued the token, then would not say whose it is. The device code is spent and the token is
    // dropped, so the session is gone: the answer must say start again, never "try again in a minute".
    for (const [label, status] of [['down (502)', 502], ['rate-limiting (429)', 429]] as const) {
        const cut = await call(ada, `${MEMBER}/start`, {});
        const cutDevice = gh.byUserCode.get(cut.body.userCode)!;
        cutDevice.user = ghUser('cut@example.com');
        cutDevice.queue.push('token');
        gh.userStatus = status;
        advance(5000);
        const lost = await call(ada, `${MEMBER}/poll`, { sessionId: cut.body.sessionId });
        gh.userStatus = 0;
        assert(lost.status === 400 && /start .*again/i.test(String(lost.body?.error)),
            `/user ${label} after GitHub issued the token → 400 start again, not a 503 try-again (got ${lost.status} ${lost.raw})`);
        const afterLost = await call(ada, `${MEMBER}/poll`, { sessionId: cut.body.sessionId });
        assert(afterLost.status === 400, `...and the session is gone, as that answer said (got ${afterLost.status})`);
    }

    // ── 4. what is kept ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. success keeps { sub, email } and nothing else ──');
    written = '';
    const bea = newMember();
    const beaUser = ghUser(null, 'bea@users.example');
    const beaSignIn = await signInWithGithub(bea, MEMBER, {}, beaUser);
    assert(beaSignIn.sub === String(beaUser.id) && beaSignIn.email === 'bea@users.example',
        `the poll answers ok with GitHub's numeric user id as sub, and the primary address from /user/emails (got ${beaSignIn.poll.raw})`);
    assert(gh.calls.user >= 1 && gh.calls.emails >= 1, 'the node read /user, then /user/emails for a profile with no public address');
    const session = _githubSessionForTests(beaSignIn.sessionId) as any;
    const strings = reachableStrings(session);
    assert(!!session && !strings.some(s => s.includes(beaSignIn.token)),
        'the access token is not reachable from the session object');
    assert(JSON.stringify(Object.keys(session.result).sort()) === '["email","sub"]', `the result holds sub and email only (got ${JSON.stringify(session.result)})`);
    assert(session.deviceCode === '', 'the device code is dropped once the flow is finished');
    assert(!beaSignIn.poll.raw.includes(beaSignIn.token) && !beaSignIn.start.raw.includes(beaSignIn.token), 'the token is in no answer');
    const again = await call(bea, `${MEMBER}/poll`, { sessionId: beaSignIn.sessionId });
    assert(again.body?.status === 'ok' && again.body.sub === beaSignIn.sub, 'polling a finished session again answers the same ok, for a phone that lost the first');

    // ── 5. bound, single use, expiring ───────────────────────────────────────────────────────────
    console.log('\n── 5. bound to the member, spent once, expiring ──');
    const beaSealed = await sealSeedToSso(bea.seed, 'github', beaSignIn.sub);
    const deposit = (id: Id, body: Record<string, unknown>) =>
        call(id, '/api/recovery/shares/sso', { shares: [{ holderType: 'sso', holderRef: 'github', shareIndex: 1, ...beaSealed }], ...body });
    const cal = newMember();
    const calPoll = await call(cal, `${MEMBER}/poll`, { sessionId: beaSignIn.sessionId });
    assert(calPoll.status === 400, `another member cannot poll Bea's session (got ${calPoll.status})`);
    const calSpend = await deposit(cal, { provider: 'github', proof: { sessionId: beaSignIn.sessionId } });
    assert(calSpend.status === 400, `...or spend it on their own deposit (got ${calSpend.status} ${calSpend.raw})`);
    assert(!!_githubSessionForTests(beaSignIn.sessionId), '...and neither consumed it');
    const beaDeposit = await deposit(bea, { provider: 'github', proof: { sessionId: beaSignIn.sessionId } });
    assert(beaDeposit.status === 200 && beaDeposit.body?.provider === 'github' && JSON.stringify(beaDeposit.body.enrolledSso) === '["github"]',
        `Bea deposits with it: the keeper is filed under github (got ${beaDeposit.status} ${beaDeposit.raw})`);
    const reuse = await deposit(bea, { provider: 'github', proof: { sessionId: beaSignIn.sessionId } });
    assert(reuse.status === 400, `a spent session cannot be spent again (got ${reuse.status})`);

    const expiring = await signInWithGithub(bea, MEMBER, {}, beaUser);
    advance(NONCE_TTL_MS + 1000);
    const late = await deposit(bea, { provider: 'github', proof: { sessionId: expiring.sessionId } });
    assert(late.status === 400 && /expired|no GitHub sign-in/i.test(String(late.body?.error)),
        `a finished sign-in left unspent past NONCE_TTL_MS is refused (got ${late.status} ${late.raw})`);
    assert(!written.includes(beaSignIn.token) && !written.includes(expiring.token), 'no access token appears anywhere in the logs');
    const image = db.serialize();
    assert(!image.includes(Buffer.from(beaSignIn.token)) && !image.includes(Buffer.from(expiring.token)), 'nor anywhere in the database');

    // ── 6. a token handed in ─────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a GitHub token handed in is refused before any request ──');
    const nonce = (await call(bea, '/api/recovery/sso-nonce', {})).body.nonce;
    const pat = `ghp_${crypto.randomBytes(18).toString('hex').slice(0, 36)}`;
    const handedIn: Array<[string, Record<string, unknown>]> = [
        ['an OAuth access token as idToken', { provider: 'github', idToken: `gho_${crypto.randomBytes(18).toString('hex')}`, nonce }],
        ['a PAT as idToken', { provider: 'github', idToken: pat, nonce }],
        ['a fine-grained PAT as idToken', { provider: 'github', idToken: `github_pat_${crypto.randomBytes(30).toString('hex')}`, nonce }],
        ['a PAT as the session id', { provider: 'github', proof: { sessionId: pat } }],
        ['nothing at all', { provider: 'github', nonce }],
    ];
    for (const [label, body] of handedIn) {
        outbound = [];
        const r = await deposit(bea, body);
        assert(r.status === 400 && providerRequests() === 0, `${label} → 400 with no request anywhere (got ${r.status}, ${providerRequests()} requests: ${r.raw})`);
    }
    outbound = [];
    const oldApp = await deposit(bea, { provider: 'github', idToken: pat, nonce });
    assert(/^Update BeanPool to connect GitHub/.test(String(oldApp.body?.error)), `a token is answered with the update message (got ${oldApp.raw})`);
    const withBoth = await signInWithGithub(bea, MEMBER, {}, beaUser);
    outbound = [];
    const both = await deposit(bea, { provider: 'github', idToken: pat, proof: { sessionId: withBoth.sessionId } });
    assert(both.status === 400 && /^Update BeanPool/.test(String(both.body?.error)) && providerRequests() === 0,
        `a token alongside a real session is still refused (got ${both.status} ${both.raw})`);
    assert(!!_githubSessionForTests(withBoth.sessionId), '...before the session is touched: it is still there');
    let direct: unknown;
    try { await verifySignIn('github', { idToken: pat }, [OUR_CLIENT_ID], 'n', bea.pk); } catch (e) { direct = e; }
    assert(/^Update BeanPool/.test(String((direct as Error)?.message)) && providerRequests() === 0, 'verifySignIn refuses it directly too, with no request');

    // ── 7 + 8. the recovering device, and the round trip ────────────────────────────────────────
    console.log('\n── 7. the recovering device\'s sessions are bound to its ephemeral key ──');
    const pushToken = `ExponentPushToken[${crypto.randomBytes(8).toString('hex')}]`;
    db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`).run(bea.pk, pushToken);
    const released = () => pushes.filter(p => p?.data?.kind === 'recovery_released');
    pushes = [];

    const device = newId();
    const thief = newId();
    const opened = await call(device, '/api/recovery/collect', { callsign: bea.callsign });
    const thiefOpened = await call(thief, '/api/recovery/collect', { callsign: bea.callsign });
    assert(opened.status === 200 && thiefOpened.status === 200, `two devices open collections for Bea (got ${opened.status}, ${thiefOpened.status})`);
    const cid = opened.body.collectionId as string;
    const thiefCid = thiefOpened.body.collectionId as string;

    const collectNonce = await call(device, '/api/recovery/collect/sso-nonce', { collectionId: cid });
    assert(collectNonce.body?.githubFlow === 'node', `the recovering device's nonce answer carries githubFlow: 'node' (got ${collectNonce.raw})`);
    assert((await call(thief, `${COLLECT}/start`, { collectionId: cid })).status === 404, 'a device cannot start a GitHub sign-in on a collection it did not open');

    const recovering = await signInWithGithub(device, COLLECT, { collectionId: cid }, beaUser);
    assert(recovering.sub === beaSignIn.sub, 'the recovering device learns the same sub: GitHub\'s user id, whichever device asks');
    const thiefPoll = await call(thief, `${COLLECT}/poll`, { collectionId: thiefCid, sessionId: recovering.sessionId });
    assert(thiefPoll.status === 400, `another ephemeral key cannot poll that session through its own collection (got ${thiefPoll.status})`);
    const thiefSpend = await call(thief, '/api/recovery/collect/sso', { collectionId: thiefCid, provider: 'github', proof: { sessionId: recovering.sessionId } });
    assert(thiefSpend.status === 400 && released().length === 0, `...nor spend it (got ${thiefSpend.status}), and nothing was released`);
    assert(!!_githubSessionForTests(recovering.sessionId), '...and did not consume it');
    const memberSession = await signInWithGithub(bea, MEMBER, {}, beaUser);
    const crossRoute = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', proof: { sessionId: memberSession.sessionId } });
    assert(crossRoute.status === 400, `a member's session cannot be spent by the recovering device (got ${crossRoute.status})`);

    outbound = [];
    const oldAppRecovery = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', idToken: pat, nonce: collectNonce.body.nonce });
    assert(oldAppRecovery.status === 400 && /^Update BeanPool/.test(String(oldAppRecovery.body?.error)) && providerRequests() === 0,
        `an old app recovering with a GitHub token → 400 update message, no request (got ${oldAppRecovery.raw})`);

    console.log('\n── 8 + 9. the round trip, and the alert when it releases ──');
    const mallory = await signInWithGithub(device, COLLECT, { collectionId: cid }, ghUser('mallory@example.com'));
    const wrongAccount = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', proof: { sessionId: mallory.sessionId } });
    assert(wrongAccount.status === 400 && /not the keeper/.test(String(wrongAccount.body?.error)),
        `a GitHub account that is not Bea's keeper releases nothing (got ${wrongAccount.status} ${wrongAccount.raw})`);
    assert(released().length === 0, 'no release alert for any failed attempt');
    const replacedByMallory = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', proof: { sessionId: recovering.sessionId } });
    assert(replacedByMallory.status === 400 && released().length === 0,
        `the device's earlier session was replaced when it started Mallory's, so it releases nothing (got ${replacedByMallory.status})`);

    const beaRecovering = await signInWithGithub(device, COLLECT, { collectionId: cid }, beaUser);
    const recovered = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', proof: { sessionId: beaRecovering.sessionId } });
    assert(recovered.status === 200 && recovered.body?.enough === true, `Bea's own GitHub releases the fragment (got ${recovered.status} ${recovered.raw})`);
    const fragments = await call(device, '/api/recovery/collect/fragments', { collectionId: cid });
    const blob = fragments.body?.fragments?.find((f: any) => f.holderType === 'sso');
    const reopened = await openShareFromSso(
        { encryptedShare: blob.payload, shareIv: blob.payloadIv, shareTag: blob.payloadTag, kdfParams: blob.kdfParams },
        'github', beaRecovering.sub,
    );
    assert(Buffer.from(reopened).equals(Buffer.from(bea.seed)), 'the released blob opens with the sub the node returned, to Bea\'s own seed');

    const alerts = released();
    assert(alerts.length === 1 && alerts[0].to === pushToken, `one release alert, to Bea (got ${alerts.length})`);
    assert(alerts[0]?.body === 'Your account was just restored with GitHub on another device. If that wasn\'t you, contact your community\'s admin now to move your account to a new key, and secure your GitHub account.',
        `in plain words (got ${JSON.stringify(alerts[0]?.body)})`);
    const alertText = JSON.stringify(alerts[0]);
    assert(!alertText.includes(blob.payload) && !alertText.includes(beaRecovering.sub), 'with nothing of the fragment or the sub in it');

    const retry = await signInWithGithub(device, COLLECT, { collectionId: cid }, beaUser);
    const again2 = await call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'github', proof: { sessionId: retry.sessionId } });
    assert(again2.status === 200 && released().length === 1, `a second sign-in on the same collection releases nothing new, so no second alert (${released().length} alerts)`);

    // ── 10. discovery ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. nonce answers tell the app the node runs GitHub ──');
    const memberNonce = await call(bea, '/api/recovery/sso-nonce', {});
    assert(memberNonce.body?.githubFlow === 'node' && memberNonce.body.providers.includes('github'),
        `/api/recovery/sso-nonce carries githubFlow: 'node' (got ${memberNonce.raw})`);

    // ── 11. the door ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. the global door ──');
    const joiner = newId();
    for (const path of [`${DOOR}/start`, `${DOOR}/poll`]) {
        const r = await call(joiner, path, { sessionId: 'x' });
        assert(r.status === 404 && r.body?.code === 'invite_only', `local: ${path} → 404 invite-only (got ${r.status} ${r.raw})`);
    }
    process.env.NODE_PROFILE = 'global';
    const doorNonce = await call(joiner, '/api/join/sso-nonce', {});
    assert(doorNonce.body?.githubFlow === 'node', `global: /api/join/sso-nonce carries githubFlow: 'node' (got ${doorNonce.raw})`);
    assert((await call(null, `${DOOR}/start`, {})).status === 401, 'global: an unsigned door start → 401');
    const joinerUser = ghUser('joiner@example.com');
    const doorSignIn = await signInWithGithub(joiner, DOOR, {}, joinerUser);
    assert(doorSignIn.sub === String(joinerUser.id), `global: the door runs GitHub for a key that is no member yet (got ${doorSignIn.poll.raw})`);
    const doorCross = await call(bea, '/api/recovery/shares/sso', {
        provider: 'github', proof: { sessionId: doorSignIn.sessionId },
        shares: [{ holderType: 'sso', holderRef: 'github', shareIndex: 1, ...beaSealed }],
    });
    assert(doorCross.status === 400, `a door session cannot be spent on the recovery deposit route (got ${doorCross.status})`);
    outbound = [];
    const doorToken = await call(joiner, '/api/join', { callsign: 'Joiner', provider: 'github', idToken: pat });
    assert(doorToken.status === 401 && /^Update BeanPool/.test(String(doorToken.body?.error)) && providerRequests() === 0,
        `global: a join with a GitHub token → refused with the update message, no request (got ${doorToken.status} ${doorToken.raw})`);
    const noProof = await call(joiner, '/api/join', { callsign: 'Joiner', provider: 'github' });
    assert(noProof.status === 400, `global: a GitHub join with no proof → 400 (got ${noProof.status})`);
    const joined = await call(joiner, '/api/join', { callsign: 'Joiner', provider: 'github', proof: { sessionId: doorSignIn.sessionId } });
    assert(joined.status === 200 && joined.body?.provider === 'github', `global: the join spends the door session (got ${joined.status} ${joined.raw})`);
    const row = db.prepare('SELECT invited_by FROM members WHERE public_key = ?').get(joiner.pk) as any;
    assert(row?.invited_by === 'open:github', `...and the joiner is invited_by open:github (got ${row?.invited_by})`);
    const member2 = await call(joiner, `${DOOR}/start`, {});
    assert(member2.status === 409 && member2.body?.code === 'already_member', `a member at the door's GitHub start → 409 already_member (got ${member2.status})`);
    delete process.env.NODE_PROFILE;

    const issued = [...gh.tokens.keys()];
    const finalImage = db.serialize();
    assert(issued.length >= 8 && issued.every(t => !written.includes(t) && !finalImage.includes(Buffer.from(t))),
        `none of the ${issued.length} access tokens GitHub issued in this run is in the logs or the database`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ GitHub run by the node: bound, spent once, no token kept, no token accepted.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
