/**
 * The GitHub sign-in POLL routes have their own per-address bucket (github-poll-rate-limit.ts), apart from the
 * shared auth limiter, over REAL HTTPS through the real signature middleware and the REAL limiters: the auth
 * limiter, the poll bucket and the gateway throttle are never reset or pruned by this test. Time moves by faking
 * Date.now for the whole process (every limiter, the signature check and the GitHub sessions read it), never by
 * touching a limiter.
 *
 * No GitHub is contacted: `fetch` is stubbed, and a fake GitHub answers the device flow. Requests arrive from
 * loopback, a trusted proxy, with CF-Connecting-IP naming the address the limiters count.
 *
 *   1. two phones on one address each poll at GitHub's 5 s interval for 15 minutes: no poll is refused, and from
 *      that address a callsign check and a recovery lookup every minute, and a recovering device's whole release
 *      sequence in the first minute (lookup, collect, nonce, start, eleven polls, the release), all succeed; each
 *      session still reached GitHub at most once an interval; five phones on another address (the size the
 *      bucket is chosen for) each poll at the interval for 3 minutes and none is refused
 *   2. a poll flood from one address, across the three poll routes, is refused 429 past the bucket and asked
 *      GitHub nothing; a callsign check, a recovery lookup and a start from that address still succeed right
 *      after; the same member still polls from another address; the next window polls again
 *   3. polls naming an unknown session, somebody else's session or an unknown collection, and a non-member's poll,
 *      count against the bucket like any other poll: they fill it, and the caller's own poll is then refused
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-github-poll-limit.ts
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
import { GITHUB_POLLS_PER_MINUTE } from './github-poll-rate-limit.js';
import { sealSeedToSso, openShareFromSso } from '@beanpool/core';

const PORT = 8737;
const BASE = `https://localhost:${PORT}`;

/** One address shared by several phones: a household, a hall's wifi, a carrier NAT. */
const HALL = '203.0.113.7';
const HOUSE = '203.0.113.8';
const SETUP = '198.51.100.20';
const FLOOD = '192.0.2.50';
const ELSEWHERE = '192.0.2.60';
const STRANGER = '192.0.2.77';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the clock ────────────────────────────────────────────────────────────────────────────────────
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms: number) => { offset += ms; };

// ── a fake GitHub ────────────────────────────────────────────────────────────────────────────────
interface GhUser { id: number; login: string; email: string }
interface GhDevice { deviceCode: string; userCode: string; typed?: GhUser; tokenIssued?: boolean; asked: number }
const gh = {
    byDeviceCode: new Map<string, GhDevice>(),
    byUserCode: new Map<string, GhDevice>(),
    tokens: new Map<string, GhUser>(),
    calls: { deviceCode: 0, accessToken: 0 },
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeGithub(url: string, init: any): Response {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === 'https://github.com/login/device/code') {
        gh.calls.deviceCode++;
        const device: GhDevice = {
            deviceCode: crypto.randomBytes(20).toString('hex'),
            userCode: `${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`.toUpperCase(),
            asked: 0,
        };
        gh.byDeviceCode.set(device.deviceCode, device);
        gh.byUserCode.set(device.userCode, device);
        return json({ device_code: device.deviceCode, user_code: device.userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
        gh.calls.accessToken++;
        const device = gh.byDeviceCode.get(body.device_code);
        if (!device) return json({ error: 'incorrect_device_code' });
        device.asked++;
        if (!device.typed) return json({ error: 'authorization_pending' });
        if (device.tokenIssued) return json({ error: 'incorrect_device_code' });
        device.tokenIssued = true;
        const token = `gho_${crypto.randomBytes(18).toString('hex')}`;
        gh.tokens.set(token, device.typed);
        return json({ access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    const user = gh.tokens.get(String(init?.headers?.Authorization ?? '').replace(/^Bearer /, ''));
    if (url === 'https://api.github.com/user') {
        return user ? json({ id: user.id, login: user.login, email: user.email }) : json({ message: 'Bad credentials' }, 401);
    }
    return json({ message: 'Not Found' }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    if (url.startsWith('https://exp.host/')) return json({ data: [] });
    if (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')) return fakeGithub(url, init);
    return new Response('stubbed: test-github-poll-limit contacts nobody', { status: 503 });
}) as typeof fetch;

let nextGithubId = 7_000_000;
function ghUser(): GhUser {
    const id = nextGithubId++;
    return { id, login: `user${id}`, email: `user${id}@example.com` };
}
/** The member types the code at GitHub: the node's next poll past the interval collects the token. */
function typeCode(userCode: string, user: GhUser): void {
    gh.byUserCode.get(userCode)!.typed = user;
}

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
    const callsign = `ghp${++seq}-${id.pk.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pk, callsign);
    return { ...id, callsign };
}

interface Answer { status: number; body: any; raw: string; retryAfter: string | null }

/** Every answer this test got, by the address it was sent from. */
const answers = new Map<string, Array<{ path: string; status: number }>>();

async function send(id: Id | null, method: 'GET' | 'POST', path: string, from: string, body?: unknown): Promise<Answer> {
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const headers: Record<string, string> = { 'CF-Connecting-IP': from };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!answers.has(from)) answers.set(from, []);
    answers.get(from)!.push({ path, status: res.status });
    return { status: res.status, body: parsed, raw: text, retryAfter: res.headers.get('retry-after') };
}
const post = (id: Id, path: string, from: string, body: unknown = {}) => send(id, 'POST', path, from, body);
const get = (path: string, from: string) => send(null, 'GET', path, from);
const refusedAt = (from: string) => (answers.get(from) ?? []).filter(a => a.status === 429);

const MEMBER = '/api/recovery/sso/github';
const COLLECT = '/api/recovery/collect/github';
const DOOR = '/api/join/github';

async function main(): Promise<void> {
    console.log('\n=== GitHub sign-in polls: their own bucket, apart from the auth limiter ===\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);
    console.log(`(poll bucket: ${GITHUB_POLLS_PER_MINUTE} a minute per address)\n`);

    // ── setup, from an address no scenario uses: Cal has a GitHub keeper ─────────────────────────
    const cal = newMember();
    const calUser = ghUser();
    const calStart = await post(cal, `${MEMBER}/start`, SETUP);
    typeCode(calStart.body.userCode, calUser);
    advance(5000);
    const calPoll = await post(cal, `${MEMBER}/poll`, SETUP, { sessionId: calStart.body.sessionId });
    const calSealed = await sealSeedToSso(cal.seed, 'github', calPoll.body?.sub);
    const calDeposit = await post(cal, '/api/recovery/shares/sso', SETUP, {
        provider: 'github', proof: { sessionId: calStart.body.sessionId },
        shares: [{ holderType: 'sso', holderRef: 'github', shareIndex: 1, ...calSealed }],
    });
    if (calDeposit.status !== 200) throw new Error(`setup: Cal's GitHub keeper deposit failed: ${calDeposit.status} ${calDeposit.raw}`);
    advance(60_000);

    // ── 1. two phones on one address for 15 minutes ──────────────────────────────────────────────
    console.log('── 1. two phones on one address poll at the interval for 15 minutes ──');
    const ada = newMember();
    const bea = newMember();
    const adaUser = ghUser();
    const device = newId(); // Cal's new phone, recovering the account
    const adaStart = await post(ada, `${MEMBER}/start`, HALL);
    const beaStart = await post(bea, `${MEMBER}/start`, HALL);
    assert(adaStart.status === 200 && beaStart.status === 200 && adaStart.body.intervalSeconds === 5,
        `Ada and Bea start a GitHub enrolment from the hall (got ${adaStart.status}, ${beaStart.status})`);

    const lookup = await get(`/api/recovery/lookup/${cal.callsign}`, HALL);
    const opened = await post(device, '/api/recovery/collect', HALL, { callsign: cal.callsign });
    const collectionId = opened.body?.collectionId as string;
    const collectNonce = await post(device, '/api/recovery/collect/sso-nonce', HALL, { collectionId });
    const deviceStart = await post(device, `${COLLECT}/start`, HALL, { collectionId });

    const adaPolls: string[] = [];
    const beaPolls: string[] = [];
    const devicePolls: string[] = [];
    let adaDone = false;
    let deviceDone = false;
    let release: Answer | null = null;
    let fragments: Answer | null = null;
    const checks: Answer[] = [];
    const lookups: Answer[] = [];
    for (let tick = 1; tick <= 180; tick++) {
        advance(5000);
        const t = tick * 5;
        if (tick === 179) typeCode(adaStart.body.userCode, adaUser); // Ada finds the code at 14:55
        if (!adaDone) {
            const r = await post(ada, `${MEMBER}/poll`, HALL, { sessionId: adaStart.body.sessionId });
            adaPolls.push(r.status === 200 ? r.body?.status : String(r.status));
            adaDone = r.body?.status === 'ok';
        }
        const b = await post(bea, `${MEMBER}/poll`, HALL, { sessionId: beaStart.body.sessionId });
        beaPolls.push(b.status === 200 ? b.body?.status : String(b.status));

        // Cal takes most of the first minute to type the code on the new phone.
        if (!deviceDone && deviceStart.status === 200) {
            if (tick === 11) typeCode(deviceStart.body.userCode, calUser);
            const d = await post(device, `${COLLECT}/poll`, HALL, { collectionId, sessionId: deviceStart.body.sessionId });
            devicePolls.push(d.status === 200 ? d.body?.status : String(d.status));
            if (d.body?.status === 'ok' || tick === 12) {
                deviceDone = true;
                release = await post(device, '/api/recovery/collect/sso', HALL, { collectionId, provider: 'github', proof: { sessionId: deviceStart.body.sessionId } });
                fragments = await post(device, '/api/recovery/collect/fragments', HALL, { collectionId });
            }
        }
        if (t % 60 === 30) {
            checks.push(await get(`/api/members/callsign-available/newcomer${tick}`, HALL));
            lookups.push(await get(`/api/recovery/lookup/${cal.callsign}`, HALL));
        }
    }

    assert(refusedAt(HALL).length === 0,
        `nothing anybody at the hall asked in those 15 minutes was refused 429 (got ${refusedAt(HALL).length}: ${JSON.stringify(refusedAt(HALL).slice(0, 6))}…)`);
    assert(adaPolls.length === 179 && adaPolls.slice(0, 178).every(s => s === 'pending') && adaPolls[178] === 'ok',
        `Ada's phone polled every 5 s: 178 pending, then ok when she typed the code at 14:55 (got ${adaPolls.length} polls, ${JSON.stringify([...new Set(adaPolls)])}, last ${adaPolls[adaPolls.length - 1]})`);
    assert(beaPolls.length === 180 && beaPolls.slice(0, 179).every(s => s === 'pending') && beaPolls[179] === 'expired',
        `Bea's phone polled every 5 s for the code's whole 15 minutes: 179 pending, then expired (got ${JSON.stringify([...new Set(beaPolls)])}, last ${beaPolls[beaPolls.length - 1]})`);
    const beaDevice = gh.byUserCode.get(beaStart.body.userCode)!;
    assert(beaDevice.asked <= 180,
        `...and the node asked GitHub about Bea's code at most once an interval: ${beaDevice.asked} times in 180 intervals`);
    assert(checks.length === 15 && checks.every(c => c.status === 200 && typeof c.body?.available === 'boolean'),
        `a callsign check from the hall every minute for those 15 minutes: all answered (got ${JSON.stringify(checks.map(c => c.status))})`);
    assert(lookup.status === 200 && lookups.length === 15 && lookups.every(l => l.status === 200),
        `a recovery lookup from the hall, at the start and every minute: all answered (got ${lookup.status}, ${JSON.stringify(lookups.map(l => l.status))})`);
    assert(opened.status === 200 && collectNonce.status === 200 && deviceStart.status === 200,
        `the recovering device, in the first minute: collect, sso-nonce and GitHub start all answered (got ${opened.status}, ${collectNonce.status}, ${deviceStart.status})`);
    assert(devicePolls.length === 11 && devicePolls.slice(0, 10).every(s => s === 'pending') && devicePolls[10] === 'ok',
        `...ten polls pending while Cal finds the code, the eleventh ok (got ${JSON.stringify(devicePolls)})`);
    assert(release?.status === 200 && release.body?.enough === true,
        `...and the request that releases the fragment, 55 s in, is answered (got ${release?.status} ${release?.raw})`);
    const blob = fragments?.body?.fragments?.find((f: any) => f.holderType === 'sso');
    const reopened = blob
        ? await openShareFromSso({ encryptedShare: blob.payload, shareIv: blob.payloadIv, shareTag: blob.payloadTag, kdfParams: blob.kdfParams }, 'github', calPoll.body.sub).catch(() => null)
        : null;
    assert(!!reopened && Buffer.from(reopened).equals(Buffer.from(cal.seed)), 'the released blob opens to Cal\'s own seed');

    // The size the bucket is chosen for: five phones at the interval fill a window exactly and are never refused.
    const phones = Array.from({ length: GITHUB_POLLS_PER_MINUTE / 12 }, () => newMember());
    const phoneStarts = await Promise.all(phones.map(p => post(p, `${MEMBER}/start`, HOUSE)));
    const phonePolls: number[] = [];
    for (let tick = 1; tick <= 36; tick++) {
        advance(5000);
        for (let i = 0; i < phones.length; i++) {
            phonePolls.push((await post(phones[i], `${MEMBER}/poll`, HOUSE, { sessionId: phoneStarts[i].body.sessionId })).status);
        }
    }
    assert(phones.length === 5 && phoneStarts.every(s => s.status === 200) && phonePolls.length === 180 && phonePolls.every(s => s === 200),
        `${phones.length} phones on one address each poll every 5 s for 3 minutes: all ${phonePolls.length} polls answered (got ${JSON.stringify([...new Set(phonePolls)])})`);

    // ── 2. a flood from one address ──────────────────────────────────────────────────────────────
    console.log('\n── 2. a poll flood from one address is refused past the bucket, and nothing else is ──');
    const dee = newMember();
    const deeStart = await post(dee, `${MEMBER}/start`, FLOOD);
    const device2 = newId();
    const opened2 = await post(device2, '/api/recovery/collect', FLOOD, { callsign: cal.callsign });
    const device2Start = await post(device2, `${COLLECT}/start`, FLOOD, { collectionId: opened2.body?.collectionId });
    process.env.NODE_PROFILE = 'global';
    const joiner = newId();
    const joinStart = await post(joiner, `${DOOR}/start`, FLOOD);
    assert(deeStart.status === 200 && device2Start.status === 200 && joinStart.status === 200,
        `a member, a recovering device and a joiner at the door each start a GitHub sign-in from one address (got ${deeStart.status}, ${device2Start.status}, ${joinStart.status})`);

    const floodPoll = (i: number) => [
        () => post(dee, `${MEMBER}/poll`, FLOOD, { sessionId: deeStart.body.sessionId }),
        () => post(device2, `${COLLECT}/poll`, FLOOD, { collectionId: opened2.body.collectionId, sessionId: device2Start.body.sessionId }),
        () => post(joiner, `${DOOR}/poll`, FLOOD, { sessionId: joinStart.body.sessionId }),
    ][i % 3]();
    const githubBefore = gh.calls.accessToken;
    const admitted: Answer[] = [];
    for (let i = 0; i < GITHUB_POLLS_PER_MINUTE; i++) admitted.push(await floodPoll(i));
    assert(admitted.every(a => a.status === 200 && a.body?.status === 'pending'),
        `${GITHUB_POLLS_PER_MINUTE} polls in one instant, across the member, recovery and door routes, all answered pending (got ${JSON.stringify([...new Set(admitted.map(a => a.status))])})`);
    const over = [await floodPoll(0), await floodPoll(1), await floodPoll(2)];
    assert(over.every(a => a.status === 429 && Number(a.retryAfter) >= 1),
        `the next poll on each of the three routes → 429 with Retry-After: one bucket for the address (got ${JSON.stringify(over.map(a => [a.status, a.retryAfter]))})`);
    assert(gh.calls.accessToken === githubBefore, `...and the node asked GitHub nothing for the flood (${gh.calls.accessToken - githubBefore} requests)`);

    const floodCheck = await get('/api/members/callsign-available/afterflood', FLOOD);
    assert(floodCheck.status === 200 && typeof floodCheck.body?.available === 'boolean',
        `a callsign check from that address right after is answered (got ${floodCheck.status} ${floodCheck.raw})`);
    const floodLookup = await get(`/api/recovery/lookup/${cal.callsign}`, FLOOD);
    assert(floodLookup.status === 200, `...and a recovery lookup (got ${floodLookup.status})`);
    const other = newMember();
    const otherStart = await post(other, `${MEMBER}/start`, FLOOD);
    assert(otherStart.status === 200, `...and another member's GitHub start, on the auth limiter (got ${otherStart.status} ${otherStart.raw})`);
    const deeElsewhere = await post(dee, `${MEMBER}/poll`, ELSEWHERE, { sessionId: deeStart.body.sessionId });
    assert(deeElsewhere.status === 200 && deeElsewhere.body?.status === 'pending',
        `Dee polling from another address is answered: the bucket is the address's, not the member's (got ${deeElsewhere.status})`);
    advance(60_000);
    const nextWindow = await floodPoll(2);
    assert(nextWindow.status === 200 && nextWindow.body?.status === 'pending', `a minute later the address polls again (got ${nextWindow.status} ${nextWindow.raw})`);
    delete process.env.NODE_PROFILE;

    // ── 3. unknown and somebody else's sessions count ────────────────────────────────────────────
    console.log('\n── 3. a poll for an unknown or somebody else\'s session counts like any other ──');
    const eve = newMember();
    const eveStart = await post(eve, `${MEMBER}/start`, STRANGER);
    const frank = newMember();
    const frankStart = await post(frank, `${MEMBER}/start`, SETUP);
    const device3 = newId();
    const opened3 = await post(device3, '/api/recovery/collect', STRANGER, { callsign: cal.callsign });
    const outsider = newId();
    const joiner3 = newId();
    assert(eveStart.status === 200 && frankStart.status === 200 && opened3.status === 200,
        `Eve starts from the stranger's address, Frank from another, and a device opens a collection (got ${eveStart.status}, ${frankStart.status}, ${opened3.status})`);

    const unknownId = crypto.randomBytes(32).toString('base64url');
    const bogus: Array<[string, () => Promise<Answer>]> = [
        ['an unknown session', () => post(eve, `${MEMBER}/poll`, STRANGER, { sessionId: unknownId })],
        ['Frank\'s session', () => post(eve, `${MEMBER}/poll`, STRANGER, { sessionId: frankStart.body.sessionId })],
        ['an unknown collection', () => post(device3, `${COLLECT}/poll`, STRANGER, { collectionId: 'no-such-collection', sessionId: unknownId })],
        ['Frank\'s session through its own collection', () => post(device3, `${COLLECT}/poll`, STRANGER, { collectionId: opened3.body.collectionId, sessionId: frankStart.body.sessionId })],
        ['a non-member on the member route', () => post(outsider, `${MEMBER}/poll`, STRANGER, { sessionId: unknownId })],
        ['an unknown session at the door', () => post(joiner3, `${DOOR}/poll`, STRANGER, { sessionId: unknownId })],
    ];
    process.env.NODE_PROFILE = 'global';
    const bogusAnswers: Array<[string, number]> = [];
    for (let i = 0; i < GITHUB_POLLS_PER_MINUTE; i++) {
        const [label, poll] = bogus[i % bogus.length];
        bogusAnswers.push([label, (await poll()).status]);
    }
    delete process.env.NODE_PROFILE;
    const byLabel = Object.fromEntries(bogus.map(([label]) => [label, [...new Set(bogusAnswers.filter(b => b[0] === label).map(b => b[1]))]]));
    assert(bogusAnswers.every(([, s]) => s === 400 || s === 404 || s === 401),
        `${GITHUB_POLLS_PER_MINUTE} such polls are each refused for what they name, never 429 (got ${JSON.stringify(byLabel)})`);
    const evesOwn = await post(eve, `${MEMBER}/poll`, STRANGER, { sessionId: eveStart.body.sessionId });
    assert(evesOwn.status === 429,
        `...and they counted: Eve's poll for her own session is then refused 429 (got ${evesOwn.status} ${evesOwn.raw})`);
    const frankOwn = await post(frank, `${MEMBER}/poll`, SETUP, { sessionId: frankStart.body.sessionId });
    assert(frankOwn.status === 200 && frankOwn.body?.status === 'pending', `Frank's session was not consumed by any of it (got ${frankOwn.status} ${frankOwn.raw})`);
    const strangerCheck = await get('/api/members/callsign-available/afterbogus', STRANGER);
    assert(strangerCheck.status === 200, `a callsign check from the stranger's address is still answered (got ${strangerCheck.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ GitHub sign-in polls have their own bucket: phones sharing an address never lock out the auth routes.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
