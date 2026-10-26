/**
 * The nonce store on the GLOBAL profile, where anyone can open an account through the 12-words door in seconds
 * (scratch/fable-design/DESIGN-nonce-store-3-fable.md §9). The deciding review of #2359's fix round 1 (49aa3028)
 * measured 84 such accounts, made in 6.1 s, filling the members' region of the nonce store, and every established
 * member, the owner included, answered 503 on signed writes, /api/members and /ws. Now an account spends from the rows'
 * region as a newcomer until it is established (engine/probation.ts isEstablishedMember: a node role, or 72 hours a
 * member; here also off probation and joined with a sign-in, or a 12-words member who has added one), held to a
 * newcomer's share and refused at the line, which leaves established members a reserve no newcomer can take.
 *
 * Over REAL HTTPS through the real signature middleware and the gateway limiter on at its defaults, the joins real
 * (POST /api/join/work, solved off the loop, then POST /api/join, as test-door-signal's joinByWords), attackers sent as
 * X-Forwarded-For from loopback. Sign-ins are a test key primed into sso.ts's cache: no provider is contacted. The store's
 * limits are scaled (rows 2,000 / reserve 400 / key 100 / newer key 20) and put back in `finally`.
 *
 *  1. "84 open-door accounts flooding: a member off probation still writes": 84 real 12-words joins, 9 from each address
 *     so every one is at work level 0; each sends 25 signed writes: 80 store their 20 (1,600, the line) and the 21st of
 *     each is 503 "Your app"; the last 4 are 503 "busy with new members" from their first. The alert tells priority 4,
 *     "1,600 in flight from 80 apps", naming nothing. The owner (a role, joined today) and an established member (a
 *     sign-in join 4 days old with 3 kept posts) write, make a gated read (/api/community/me: the global node lists
 *     nobody whole) and open /ws; a 12-words member 10 days old with 3 kept posts (off probation, words only) and a
 *     sign-in member 4 days old with no kept post (on probation) are "busy with new members"; a stranger still writes, in
 *     its own region.
 *  2. The same 12-words member adds a sign-in (POST /api/join/link) once the flood's numbers expire, and under the same
 *     flood again writes.
 *
 * Fail-first: run against 49aa3028 (round 1, with its one members' ceiling set to the rows' 2,000), the owner and the
 * established member are refused 503 "very busy".
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-nonce-store-global
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';
// The community's one name, so a format-2 request signed for it is this community's whatever the switch date.
const HOST = 'nonce-global.test';
process.env.BEANPOOL_ADDRESSES = HOST;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { SIGNED_FOR_HEADER, signedRequestBytes, signedRequestText } from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from './db/db.js';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import { initStateEngine, seedGenesisMember, createPost: rawCreatePost } from './state-engine.js';
const createPost = wrapCreatePost(rawCreatePost);
import { startHttpsServer } from './https-server.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { _resetWordsJoinsForTests } from './engine/door-signal.js';
import { checkServerAlerts, resetAlertsForTests, type AlertEvent } from './services/alerts.js';
import { solveOffLoop } from './door-work-test-solver.js';
import { requestNonces } from './engine/member-signature.js';
import type { NonceLimits } from './engine/member-signature.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

/** A check that throws counts as one failure, and the next one still runs. */
async function section(title: string, body: () => void | Promise<void>): Promise<void> {
    console.log(`\n${title}`);
    try {
        await body();
    } catch (e) {
        assert(false, `ran to the end (threw: ${e instanceof Error ? e.message : String(e)})`);
    }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KEY_SHARE_ERROR = 'Your app has sent more requests than this community holds at once. Please wait a minute and try again.';
const NEWCOMERS_FULL_ERROR = 'This community is busy with new members right now. Please try again in a minute.';
/** Round 1's one members' ceiling (`membersMax`) set to the rows' too, so the fail-first run measures 49aa3028 at this size. */
const LIMITS = { rowsMax: 2_000, membersReserve: 400, keyMax: 100, newKeyMax: 20, strangersMax: 100_000, addressMax: 3_000, membersMax: 2_000 } as Partial<NonceLimits>;

const GOOGLE_KID = 'test-nonce-store-global-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pubKeyHex: string; privateKey: crypto.KeyObject }
function newKey(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
const freshNonce = () => crypto.randomBytes(16).toString('hex');
function sign(id: Id, method: string, path: string, ts: number, nonce: string, body: string): string {
    const text = signedRequestText({ host: HOST, method, path, timestamp: String(ts), nonce, body });
    return crypto.sign(null, Buffer.from(signedRequestBytes(text)), id.privateKey).toString('base64');
}

let BASE = '';
interface Answer { status: number; retryAfter: string | null; error?: string; code?: string; body: any }

/** A request from `ip` (X-Forwarded-For from loopback, which the node trusts), signed by `id` when given. */
async function request(id: Id | null, method: 'GET' | 'POST', path: string, ip: string, body?: unknown): Promise<Answer> {
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const headers: Record<string, string> = { 'X-Forwarded-For': ip };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now(), nonce = freshNonce();
        Object.assign(headers, {
            'X-Public-Key': id.pubKeyHex, 'X-Timestamp': String(ts), 'X-Nonce': nonce, [SIGNED_FOR_HEADER]: HOST,
            'X-Signature': sign(id, method, path.split('?')[0], ts, nonce, raw),
        });
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? raw : undefined });
    let json: any = {};
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), error: json?.error, code: json?.code, body: json };
}
const write = (id: Id, ip: string) => request(id, 'POST', '/api/notices/seen', ip, { ids: ['nonce-global'] });

/** A /ws upgrade from `ip`, with a connect token signed by `id`. */
function socket(id: Id, ip: string): Promise<{ opened: boolean; status: number }> {
    return new Promise((resolve) => {
        const ts = Date.now(), nonce = freshNonce();
        const query = `?pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sign(id, 'WS', '/ws', ts, nonce, ''))}&for=${HOST}&v=2`;
        const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws${query}`, { rejectUnauthorized: false, headers: { 'X-Forwarded-For': ip } });
        ws.on('open', () => { ws.close(); resolve({ opened: true, status: 101 }); });
        ws.on('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode ?? 0 }); res.resume(); });
        ws.on('error', () => resolve({ opened: false, status: 0 }));
    });
}

/** A real 12-words join from `ip`: the work asked for, solved off the loop, and the join. Its key and the work's level. */
async function joinByWords(ip: string, callsign: string): Promise<{ id: Id; level: number | null; status: number }> {
    const id = newKey();
    const w = await request(id, 'POST', '/api/join/work', ip, { door: 'words' });
    if (w.status !== 200 || !w.body?.work) return { id, level: null, status: w.status };
    const work = { challenge: w.body.work.challenge, counters: await solveOffLoop(w.body.work.challenge) };
    const j = await request(id, 'POST', '/api/join', ip, { door: 'words', callsign, work });
    return { id, level: w.body.work.level ?? null, status: j.status };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const setJoined = (id: Id, ms: number) => db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(ms), id.pubKeyHex);
/** Kept posts from two days ago, out of every window. */
function keptPosts(id: Id, count: number): void {
    for (let i = 0; i < count; i++) {
        const p = createPost('offer', 'other', `kept ${i}`, 'An old offer', 0, 'fixed', id.pubKeyHex)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    }
}
/** A real sign-in join from `ip` (a Google sign-in, the test key primed into sso.ts), moved `daysAgo` days back. */
async function signInMember(callsign: string, daysAgo: number, ip: string): Promise<Id> {
    const id = newKey();
    const w = await request(id, 'POST', '/api/join/work', ip, { door: 'sign-in' });
    const work = w.body?.work ? { challenge: w.body.work.challenge, counters: await solveOffLoop(w.body.work.challenge) } : undefined;
    const n = await request(id, 'POST', '/api/join/sso-nonce', ip, {});
    const j = await request(id, 'POST', '/api/join', ip, { callsign, provider: 'google', idToken: mint(`sub-${callsign}`, n.body?.nonce), nonce: n.body?.nonce, work });
    if (j.status !== 200) throw new Error(`${callsign} did not join with a sign-in: ${j.status} ${j.error ?? ''}`);
    setJoined(id, daysAgo * DAY);
    return id;
}
const rowsLive = () => (requestNonces.counts() as unknown as Record<string, { live: number }>).rows?.live;
const strangersLive = () => (requestNonces.counts() as unknown as Record<string, { live: number }>).stranger?.live;
const ADDRESS_OR_KEY = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|[0-9a-f]{12}/i;
const flood = (told: AlertEvent[]) => told.filter((e) => e.key === 'requests.flood');

/** Every nonce forgotten (each expires within 10 minutes), the gateway's counts cleared. */
function forgetNonces(): void {
    requestNonces.prune(Date.now() + 11 * MINUTE);
    resetGatewayRateLimit();
}

/** The 84 accounts send 25 signed writes each, one after another: each one's statuses. */
async function floodWith(accounts: { id: Id; ip: string }[]): Promise<Answer[][]> {
    const out: Answer[][] = [];
    for (const a of accounts) {
        const mine: Answer[] = [];
        for (let i = 0; i < 25; i++) mine.push(await write(a.id, a.ip));
        out.push(mine);
    }
    return out;
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://127.0.0.1:${port}`;
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
    _resetWordsJoinsForTests();
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    resetAlertsForTests();
    updateGatewayConfig({ rateLimiting: { ...DEFAULT_GATEWAY_CONFIG.rateLimiting, enabled: true, maxRequestsPerMinute: 120 } });
    const f = (await request(null, 'GET', '/api/community/info', '203.0.113.1')).body?.features ?? {};
    assert(f.probation === true && f.openJoin === true, `setup: the global profile, with probation and the open door (${JSON.stringify({ p: f.probation, d: f.openJoin })})`);

    const owner = newKey();
    seedGenesisMember(owner.pubKeyHex, 'Olive');
    const settled = await signInMember('Sid', 4, '203.0.113.40');
    keptPosts(settled, 3);
    const onProbation = await signInMember('Pip', 4, '203.0.113.41');
    const words = await joinByWords('203.0.113.50', 'Wil');
    setJoined(words.id, 10 * DAY);
    keptPosts(words.id, 3);
    assert(words.status === 200, `setup: the owner (joined today), Sid (a sign-in, 4 days, 3 kept posts), Pip (a sign-in, 4 days, no kept post), Wil (12 words, 10 days, 3 kept posts) (Wil's join ${words.status})`);

    const accounts: { id: Id; ip: string }[] = [];
    try {
        await section('1. 84 open-door accounts flooding: a member off probation still writes', async () => {
            const levels: (number | null)[] = [];
            const statuses: number[] = [];
            for (let i = 0; i < 84; i++) {
                const ip = `198.51.100.${10 + Math.floor(i / 9)}`;
                const j = await joinByWords(ip, `Flood ${i + 1}`);
                levels.push(j.level);
                statuses.push(j.status);
                accounts.push({ id: j.id, ip });
            }
            assert(statuses.every((s) => s === 200) && levels.every((l) => l === 0),
                `84 real 12-words joins, 9 from each address, every one at work level 0 (${statuses.filter((s) => s === 200).length} joined; levels ${[...new Set(levels)].join(',')})`);
            assert(accounts.every((a) => isNodeMember(db, a.id.pubKeyHex)), 'every one is a member here (isNodeMember)');

            forgetNonces();
            requestNonces.setLimitsForTests(LIMITS);
            const answers = await floodWith(accounts);
            const first80 = answers.slice(0, 80).every((a) => a.slice(0, 20).every((r) => r.status === 200)
                && a.slice(20).every((r) => r.status === 503 && r.error === KEY_SHARE_ERROR && r.retryAfter === '60'));
            const last4 = answers.slice(80).every((a) => a.every((r) => r.status === 503 && r.error === NEWCOMERS_FULL_ERROR && r.retryAfter === '60'));
            const show = (a: Answer[]) => a.map((r) => r.status).join(',');
            assert(first80, `accounts 1 to 80 store their 20 each, and from the 21st each is 503 in the words for its own app (account 1: ${show(answers[0])}; account 80: ${show(answers[79])})`);
            assert(last4, `accounts 81 to 84 are 503 "busy with new members" from their first write (account 81: ${show(answers[80])}: "${answers[80][0].error ?? ''}")`);
            assert(rowsLive() === 1_600, `the rows' region holds 1,600, the line, of its 2,000 (${rowsLive()})`);
            // Told now, while the counts are the flood's own (each later refusal brings its region's count up to date).
            const told = flood(await checkServerAlerts());
            const detail = told[0]?.detail ?? '';
            assert(told.length === 1 && told[0].priority === 4 && detail.includes('1,600 in flight from 80 apps') && !ADDRESS_OR_KEY.test(detail),
                `the alert tells priority 4, "1,600 in flight from 80 apps", naming nothing (${JSON.stringify(told.map((e) => [e.kind, e.priority]))} "${detail}")`);

            // A gated read here: the global node lists nobody whole (/api/members is 403 there), so a member's own record.
            for (const [who, id, ip] of [['the owner', owner, '203.0.113.20'], ['Sid, a sign-in member off probation', settled, '203.0.113.21']] as const) {
                const w = await write(id, ip);
                const g = await request(id, 'GET', '/api/community/me', ip);
                const ws = await socket(id, ip);
                assert(w.status === 200 && g.status === 200 && ws.opened,
                    `${who}: the write is 200, the gated read /api/community/me 200, /ws opens (${w.status} ${w.error ?? ''}, ${g.status} ${g.error ?? ''}, ${ws.status})`);
            }
            const wil = await write(words.id, '203.0.113.22');
            assert(wil.status === 503 && wil.error === NEWCOMERS_FULL_ERROR,
                `Wil, 12 words with no sign-in, 10 days and 3 kept posts, is 503 "busy with new members" (${wil.status} "${wil.error ?? ''}")`);
            const pip = await write(onProbation, '203.0.113.23');
            assert(pip.status === 503 && pip.error === NEWCOMERS_FULL_ERROR,
                `Pip, a sign-in member 4 days old with no kept post (still on probation), is 503 "busy with new members" (${pip.status} "${pip.error ?? ''}")`);
            const before = strangersLive();
            const stranger = await write(newKey(), '203.0.113.24');
            assert(stranger.status !== 503 && strangersLive() === before + 1, `a stranger's write still stores, in its own region (${stranger.status}, ${before} → ${strangersLive()})`);
        });

        await section('2. the same 12-words member adds a sign-in, and under the same flood again writes', async () => {
            // While the line is full a newcomer's signed request is refused, adding a sign-in included (residual 4 of the
            // design): it is added once the flood's numbers expire.
            const during = await request(words.id, 'POST', '/api/join/link/sso-nonce', '203.0.113.22', {});
            console.log(`  (while the flood holds the line, Wil's POST /api/join/link/sso-nonce is ${during.status} "${during.error ?? ''}")`);
            forgetNonces();
            const n = await request(words.id, 'POST', '/api/join/link/sso-nonce', '203.0.113.22', {});
            const linked = await request(words.id, 'POST', '/api/join/link', '203.0.113.22', { provider: 'google', idToken: mint('wil-google-sub', n.body?.nonce), nonce: n.body?.nonce });
            assert(n.status === 200 && linked.status === 200, `Wil adds a Google sign-in (POST /api/join/link: ${n.status}, ${linked.status} ${linked.error ?? ''})`);
            forgetNonces();
            const again = await floodWith(accounts);
            const refusedAgain = again.slice(80).every((a) => a.every((r) => r.status === 503 && r.error === NEWCOMERS_FULL_ERROR));
            assert(rowsLive() === 1_600 && refusedAgain, `the 84 flood again: the line full, the last 4 refused (${rowsLive()})`);
            const wil = await write(words.id, '203.0.113.22');
            assert(wil.status === 200, `Wil's write is 200: off probation with a sign-in, established (${wil.status} ${wil.error ?? ''})`);
        });
    } finally {
        try { requestNonces.setLimitsForTests(null); } catch { /* a store without limits to put back */ }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
