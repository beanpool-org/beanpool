/**
 * The signed requests' nonce store is split in two regions, members' and strangers', each with a share per owner, and
 * says "busy" past a share (NB1 of #2038's deciding review; re-decided by Fable 2026-10-22 after #2359's deciding review:
 * scratch/fable-design/DESIGN-nonce-store-2-fable.md).
 *
 * Before the split one cap held every signer's nonces together, refused by count alone, so about 15 addresses minting
 * fresh keys kept it full and every member's signed request and /ws was refused 503 (measured on 235d707f). Now a key
 * that acts here (isNodeMember or isLiveVisitor) spends from the members' region, 3,000 live nonces a key and 250,000
 * together; any other verified key from the strangers', 3,000 an address (IPv6 by its /64) and 100,000 together. A
 * replay of a live nonce is still 403, and no live nonce is ever forgotten to make room.
 *
 *  1. The store (limits members 4, strangers 3, key 2, address 2): each owner held to its share, each region to its
 *     ceiling, the counts exact through expiry and re-spends; the default limits; each refusal in pressure().
 *  2. The verifier, with stores of its own: the three sentences, Retry-After 60, the refusal's scope and signer; a
 *     replay 403 and a forgery 403 with every region full; a route that spends no nonce never refused; a caller with no
 *     client held to one address's share; a member's key never charged to its address. The security line, at most one
 *     an hour per scope.
 *  3. Over HTTPS, the real node and the gateway limiter on at its defaults, attackers sent as X-Forwarded-For from
 *     loopback: 15 addresses with fresh keys fill the strangers' region, and a member on its own address still writes,
 *     reads, reads publicly and opens /ws; a stranger's public read answers as unsigned and its /ws opens as unsigned.
 *  4. One member key held to its own share while another member on the same address goes on; its refusals are charged
 *     to its own bucket, never the address's.
 *  5. The members' region full: a member is refused "very busy", its public read answered as unsigned; strangers go on.
 *  6. The alert (requests.flood): raised once with counts only, raised again when members are affected, cleared after
 *     the 15-minute hold; one address held to its own share raises nothing.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-nonce-store-cap
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode
// The community's one name, so a format-2 request signed for it is this community's whatever the switch date.
const HOST = 'nonce-cap.test';
process.env.BEANPOOL_ADDRESSES = HOST;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { SIGNED_FOR_HEADER, signedRequestBytes, signedRequestText } from '@beanpool/core';
import { db } from './db/db.js';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { checkServerAlerts, resetAlertsForTests, serverAlertsBanner, setAlertsClockForTests, type AlertEvent } from './services/alerts.js';
// A namespace, not named imports: so this suite runs, and counts its failures, against a verifier without some of them.
import * as sig from './engine/member-signature.js';
import type { NonceLimits, NonceSpender, NonceStore as Store, SignedRequestParts } from './engine/member-signature.js';

const { NonceStore, requestNonces, SIGNATURE_FRESHNESS_MS, verifyMemberSignature } = sig;

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

const W = SIGNATURE_FRESHNESS_MS;
const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const SMALL: NonceLimits = { membersMax: 4, strangersMax: 3, keyMax: 2, addressMax: 2 };
const KEY_SHARE_ERROR = 'Your app has sent more requests than this community holds at once. Please wait a minute and try again.';
const MEMBERS_FULL_ERROR = 'This community is very busy right now. Please try again in a minute.';
const STRANGERS_FULL_ERROR = 'This community is busy with new visitors right now. Please try again in a minute.';

interface Id { pubKeyHex: string; privateKey: crypto.KeyObject }

function newKey(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

let members = 0;
/** A member of this node, as test-gateway-real-client makes one: a members row and an account. */
function makeMember(): Id {
    const id = newKey();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, `nonce-cap-${++members}`);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
    return id;
}

const freshNonce = () => crypto.randomBytes(16).toString('hex');

function sign(id: Id, method: string, path: string, ts: number, nonce: string, body: string): string {
    const text = signedRequestText({ host: HOST, method, path, timestamp: String(ts), nonce, body });
    return crypto.sign(null, Buffer.from(signedRequestBytes(text)), id.privateKey).toString('base64');
}

function parts(id: Id, nonce: string, ts: number, forged = false): SignedRequestParts {
    const body = '{"x":1}';
    return {
        pubKeyHex: id.pubKeyHex, nonce, timestamp: String(ts), method: 'POST', path: '/api/messages/mark-read', body, signedFor: HOST,
        signature: sign(id, 'POST', '/api/messages/mark-read', ts, nonce, forged ? '{"x":2}' : body),
    };
}

const heapLength = (s: Store): number => (s as unknown as { heapExp: number[] }).heapExp.length;
const ownersHeld = (s: Store): number => (s as unknown as { owners: Map<string, unknown> }).owners.size;
const storeWith = (limits: Partial<NonceLimits>): Store => new NonceStore(W, limits);

/** The security lines about a full share, by scope: a stranger's line says "not members here", a member's does not. */
const securityLines = (scope: 'member' | 'stranger'): number => (db.prepare(
    `SELECT COUNT(*) AS n FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%store_full%' AND message ${scope === 'stranger' ? '' : 'NOT '}LIKE '%not members here%'`,
).get() as { n: number }).n;

/** The verifier's answer, reduced to what these checks read. */
function verify(store: Store, p: SignedRequestParts, now: number, opts: { client?: string; consumeNonce?: boolean } = {}) {
    const v = verifyMemberSignature(p, { consumeNonce: opts.consumeNonce ?? true, nonces: store, now, client: opts.client });
    return v.ok
        ? { ok: true as const, status: 200, code: undefined, retryAfterSec: undefined, error: '', scope: undefined, signer: undefined }
        : { ok: false as const, status: v.status, code: v.code, retryAfterSec: v.retryAfterSec, error: v.error, scope: v.scope, signer: v.signer };
}

// ─── 1. The store ───────────────────────────────────────────────────────────────────────────

function storeChecks(T0: number): void {
    const s = storeWith(SMALL);
    const a = (n: number): NonceSpender => ({ scope: 'stranger', owner: `a:${n}` });
    const k = (n: number): NonceSpender => ({ scope: 'member', owner: `k:${n}` });
    /** One spend: null when it was stored, else why there was no room (and then nothing is stored). */
    const spend = (sp: NonceSpender, nonce = freshNonce(), at = T0): string | null => {
        const why = s.room(sp, at);
        if (why) return why;
        return s.consume(nonce, at, at, sp) ? null : 'replay';
    };

    assert(spend(a(1)) === null && spend(a(1)) === null, 'a:1 spends its share of 2');
    const before = s.size;
    assert(spend(a(1)) === 'owner' && s.size === before, `its third has no room (its own share) and stores nothing (size ${s.size})`);
    assert(spend(a(2)) === null, 'a:2 spends 1: the strangers\' region holds its 3');
    assert(spend(a(3)) === 'region', 'a:3 has no room: the region is full though a:3 has spent nothing');
    assert(spend(k(1)) === null && spend(k(1)) === null, 'k:1 spends 2 with the strangers\' region full: members spend from their own');
    assert(spend(k(1)) === 'owner', 'k:1\'s third has no room (its own share)');
    assert(spend(k(2)) === null && spend(k(2)) === null, 'k:2 spends 2: the members\' region holds its 4');
    assert(spend(k(3)) === 'region', 'k:3 has no room: the members\' region is full');
    const c = s.counts();
    assert(c.member.live === 4 && c.member.owners === 2 && c.stranger.live === 3 && c.stranger.owners === 2,
        `counts: members 4 from 2 keys, strangers 3 from 2 addresses (${JSON.stringify(c)})`);
    assert(s.size === 7 && heapLength(s) === 7, `the map and the heap hold one entry each per live nonce (map ${s.size}, heap ${heapLength(s)})`);

    const p = s.pressure();
    assert(p.stranger.ownerAt === T0 && p.stranger.ownerRefusals === 1 && p.stranger.regionAt === T0 && p.stranger.regionRefusals === 1,
        `pressure(): the strangers' refusals, one for an owner and one for the region, at their time (${JSON.stringify(p.stranger)})`);
    assert(p.member.ownerAt === T0 && p.member.ownerRefusals === 1 && p.member.regionAt === T0 && p.member.regionRefusals === 1,
        `pressure(): the members' refusals likewise (${JSON.stringify(p.member)})`);
    assert(p.member.live === 4 && p.member.owners === 2 && p.stranger.live === 3 && p.stranger.owners === 2,
        'pressure(): each region\'s count and owners at its last refusal');

    // A nonce string re-spent after its expiry, by another owner, before any sweep popped it.
    const t = T0 + W + 2;
    const x = new NonceStore(W);
    x.consume('same', T0, T0, a(1));
    assert(x.consume('same', t, t, a(2)), 'a nonce re-spent after its expiry by another owner is accepted');
    const xc = x.counts();
    assert(xc.stranger.live === 1 && xc.stranger.owners === 1 && heapLength(x) === 1 && x.size === 1,
        `it moved the counts to its new owner and left one heap pair (${JSON.stringify(xc)}, heap ${heapLength(x)})`);

    s.prune(t);
    const z = s.counts();
    assert(z.member.live === 0 && z.member.owners === 0 && z.stranger.live === 0 && z.stranger.owners === 0,
        `past the window every count is 0 (${JSON.stringify(z)})`);
    assert(ownersHeld(s) === 0 && heapLength(s) === 0 && s.size === 0, `the owners, the heap and the map are empty (${ownersHeld(s)}, ${heapLength(s)}, ${s.size})`);
    assert(spend(a(3), freshNonce(), t) === null && spend(k(3), freshNonce(), t) === null, 'and both regions have room again');

    const limits = new NonceStore(W).limits;
    assert(limits?.membersMax === 250_000 && limits.strangersMax === 100_000 && limits.keyMax === 3_000 && limits.addressMax === 3_000,
        `the default limits: members 250,000, strangers 100,000, a key 3,000, an address 3,000 (${JSON.stringify(limits)})`);
    const share = sig.nonceKeyShare;
    assert(share?.(120) === 3_000 && share(600) === 15_000, `a key's share is 25 × the gateway's minute allowance, at least 3,000 (${share?.(120)}, ${share?.(600)})`);

    // The default regions at their real size: strangers from 34 addresses fill 100,000; a member still has room.
    const big = new NonceStore(W);
    for (let i = 0; i < 100_000; i++) big.consume(`s-${i}`, T0, T0, a(Math.floor(i / 3_000)));
    assert(big.room(a(0), T0) === 'owner', 'by default an address holds 3,000');
    assert(big.room(a(99), T0) === 'region', 'and the strangers\' region 100,000 (34 addresses)');
    assert(big.room(k(1), T0) === null, 'while a member still has room');
    for (let i = 0; i < 250_000; i++) big.consume(`m-${i}`, T0, T0, k(Math.floor(i / 3_000)));
    assert(big.room(k(0), T0) === 'owner', 'by default a key holds 3,000');
    assert(big.room(k(999), T0) === 'region', 'and the members\' region 250,000 (84 keys)');
    assert(big.room(k(999), T0 + W + 2) === null && big.room(a(99), T0 + W + 2) === null, 'until they expire');
}

// ─── 2. The verifier ────────────────────────────────────────────────────────────────────────

function verifierChecks(T0: number, M: Id[]): void {
    const s = storeWith(SMALL);
    const t = T0 + 1000;
    const okStranger = (client: string) => verify(s, parts(newKey(), freshNonce(), t), t, { client });

    const s1 = [okStranger('c1'), okStranger('c1')];
    assert(s1.every((v) => v.ok), `a stranger address spends its share of 2 (${s1.map((v) => v.status)})`);
    const kept = parts(newKey(), freshNonce(), t);
    const keptStatus = verify(s, kept, t, { client: 'c2' }).status;
    const own = okStranger('c1');
    assert(!own.ok && own.status === 503 && own.code === 'store_full' && own.retryAfterSec === 60,
        `its third, with a fresh key, is 503 store_full, 60 s (got ${own.status} ${own.code ?? ''} ${own.retryAfterSec})`);
    assert(own.error === STRANGERS_FULL_ERROR && own.scope === 'stranger', `in the strangers' words, scope stranger ("${own.error}", ${own.scope})`);
    assert(keptStatus === 200, 'another address spends 1: the strangers\' region holds its 3');
    const region = okStranger('c3');
    assert(!region.ok && region.status === 503 && region.error === STRANGERS_FULL_ERROR,
        `a third address is 503 in the same words: the strangers' region is full (got ${region.status} "${region.error}")`);

    const m0 = [0, 1].map(() => verify(s, parts(M[0], freshNonce(), t), t, { client: 'c1' }));
    assert(m0.every((v) => v.ok), `a member on that full address spends its share of 2: its key owns them, not the address (${m0.map((v) => v.status)})`);
    const keyFull = verify(s, parts(M[0], freshNonce(), t), t, { client: 'c9' });
    assert(!keyFull.ok && keyFull.status === 503 && keyFull.error === KEY_SHARE_ERROR && keyFull.retryAfterSec === 60,
        `its third, from another address, is 503 in the words for its own app (got ${keyFull.status} "${keyFull.error}")`);
    assert(keyFull.scope === 'member' && keyFull.signer === M[0].pubKeyHex, `with scope member and the signer (${keyFull.scope}, ${keyFull.signer?.slice(0, 8)})`);
    const m1 = [0, 1].map(() => verify(s, parts(M[1], freshNonce(), t), t, { client: 'c9' }));
    assert(m1.every((v) => v.ok), 'a second member spends 2: the members\' region holds its 4');
    const busy = verify(s, parts(M[2], freshNonce(), t), t, { client: 'c9' });
    assert(!busy.ok && busy.status === 503 && busy.error === MEMBERS_FULL_ERROR && busy.retryAfterSec === 60 && busy.scope === 'member',
        `a third member is 503 "very busy": the members' region is full (got ${busy.status} "${busy.error}" ${busy.scope})`);

    // Every region full now.
    const replay = verify(s, kept, t, { client: 'c2' });
    assert(!replay.ok && replay.status === 403 && /replay/i.test(replay.error), `a replay of a live nonce is still 403 replay, not busy (got ${replay.status} ${replay.error})`);
    const memberNonce = freshNonce();
    const s2 = storeWith(SMALL);
    verify(s2, parts(M[0], memberNonce, t), t);
    verify(s2, parts(M[0], freshNonce(), t), t);
    const memberReplay = verify(s2, parts(M[0], memberNonce, t), t);
    assert(!memberReplay.ok && memberReplay.status === 403, `a member's replay with its own share full is 403 too (got ${memberReplay.status})`);
    const forged = verify(s, parts(newKey(), freshNonce(), t, true), t, { client: 'c4' });
    assert(!forged.ok && forged.status === 403 && /signature/i.test(forged.error), `a forged request keeps its own answer (got ${forged.status} ${forged.error})`);
    const unspent = verify(s, parts(newKey(), freshNonce(), t), t, { client: 'c4', consumeNonce: false });
    assert(unspent.ok, `a route that spends no nonce (the redeem routes) is not refused (got ${unspent.status} ${unspent.error})`);
    assert(s.size === 7, `none of these stored anything (size ${s.size})`);

    const anon = storeWith(SMALL);
    const noClient = [0, 1, 2].map(() => verify(anon, parts(newKey(), freshNonce(), t), t).status);
    assert(noClient[0] === 200 && noClient[1] === 200 && noClient[2] === 503,
        `a caller that passes no client is held to one address's share, every key together (${noClient.join(', ')})`);

    const later = t + W + 2; // past the expiry of every nonce spent at t (t + W + 1)
    const again = verify(s, parts(newKey(), freshNonce(), later), later, { client: 'c3' });
    assert(again.ok, `once the nonces have expired a stranger is accepted again (got ${again.status} ${again.error})`);
}

function securityLineChecks(first: number, before: { member: number; stranger: number }): void {
    assert(securityLines('stranger') === before.stranger + 1 && securityLines('member') === before.member + 1,
        `the first refusals wrote one line each for strangers and for members (${securityLines('stranger') - before.stranger}, ${securityLines('member') - before.member})`);
    /** One stranger refusal at `at`, from a store whose address share is 1. */
    const trip = (at: number): number => {
        const s = storeWith({ ...SMALL, addressMax: 1 });
        verify(s, parts(newKey(), freshNonce(), at), at, { client: 'z' });
        return verify(s, parts(newKey(), freshNonce(), at), at, { client: 'z' }).status;
    };
    const statuses = [first + MINUTE, first + 30 * MINUTE, first + HOUR - 1].map(trip);
    assert(statuses.every((st) => st === 503), `refused within the hour (${statuses.join(', ')})`);
    assert(securityLines('stranger') === before.stranger + 1, `no second strangers' line within the hour (${securityLines('stranger') - before.stranger})`);
    trip(first + HOUR);
    assert(securityLines('stranger') === before.stranger + 2, `a second one an hour after the first (${securityLines('stranger') - before.stranger})`);
    for (let i = 1; i <= 50; i++) trip(first + HOUR + i * 1000);
    assert(securityLines('stranger') === before.stranger + 2, `50 more refusals in that hour write none (${securityLines('stranger') - before.stranger})`);
    assert(securityLines('member') === before.member + 1, 'nor do they write a members\' line');
}

// ─── HTTPS ──────────────────────────────────────────────────────────────────────────────────

let BASE = '';
interface Answer { status: number; retryAfter: string | null; error?: string; code?: string }

/** A request from `ip` (X-Forwarded-For from loopback, which the node trusts), signed by `id` when given. */
async function request(id: Id | null, method: 'GET' | 'POST', path: string, ip: string, body = ''): Promise<Answer> {
    const headers: Record<string, string> = { 'X-Forwarded-For': ip };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now(), nonce = freshNonce();
        Object.assign(headers, {
            'X-Public-Key': id.pubKeyHex, 'X-Timestamp': String(ts), 'X-Nonce': nonce, [SIGNED_FOR_HEADER]: HOST,
            'X-Signature': sign(id, method, path, ts, nonce, body),
        });
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? body : undefined });
    let json: { error?: string; code?: string } = {};
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), error: json.error, code: json.code };
}

const WRITE_PATH = '/api/notices/seen';
const WRITE_BODY = JSON.stringify({ ids: ['nonce-cap'] });
const write = (id: Id, ip: string) => request(id, 'POST', WRITE_PATH, ip, WRITE_BODY);

/** A /ws upgrade from `ip`, with a connect token signed by `id` (none when null). */
function socket(id: Id | null, ip: string): Promise<{ opened: boolean; status: number }> {
    return new Promise((resolve) => {
        let query = '';
        if (id) {
            const ts = Date.now(), nonce = freshNonce();
            query = `?pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sign(id, 'WS', '/ws', ts, nonce, ''))}&for=${HOST}&v=2`;
        }
        const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws${query}`, { rejectUnauthorized: false, headers: { 'X-Forwarded-For': ip } });
        ws.on('open', () => { ws.close(); resolve({ opened: true, status: 101 }); });
        ws.on('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode ?? 0 }); res.resume(); });
        ws.on('error', () => resolve({ opened: false, status: 0 }));
    });
}

/** Every nonce forgotten (each expires within 10 minutes), the gateway's counts cleared: a check starts from nothing. */
function freshNode(maxRequestsPerMinute = 120): void {
    requestNonces.prune(Date.now() + 11 * MINUTE);
    resetGatewayRateLimit();
    updateGatewayConfig({ rateLimiting: { ...DEFAULT_GATEWAY_CONFIG.rateLimiting, enabled: true, maxRequestsPerMinute } });
}

const liveCounts = () => requestNonces.counts();
const attacker = (n: number) => `198.51.100.${n}`;

async function fifteenAddressesCheck(): Promise<void> {
    freshNode();
    requestNonces.setLimitsForTests({ membersMax: 200, strangersMax: 300, keyMax: 20, addressMax: 30 });
    const lines = securityLines('stranger');
    const stored: number[] = [];
    let firstRefused = 0, wrongRefusal = 0;
    for (let n = 1; n <= 15; n++) {
        let ok = 0;
        for (let i = 0; i < 40; i++) {
            const r = await write(newKey(), attacker(n));
            if (r.status !== 503) { ok++; continue; }
            if (i === 0) firstRefused++;
            if (r.code !== 'store_full' || r.retryAfter !== '60' || r.error !== STRANGERS_FULL_ERROR) wrongRefusal++;
        }
        stored.push(ok);
    }
    assert(stored.every((n) => n <= 30), `each address stored at most its share of 30 (${stored.join(' ')})`);
    assert(liveCounts().stranger.live === 300, `the strangers' region holds its 300 (${liveCounts().stranger.live})`);
    assert(firstRefused === 5, `addresses 11 to 15 were refused from their first request (${firstRefused})`);
    assert(wrongRefusal === 0, `every refusal was 503 store_full, Retry-After 60, in the strangers' words (${wrongRefusal} not)`);

    const member = makeMember();
    const home = '203.0.113.7';
    const w = await write(member, home);
    assert(w.status === 200, `a member's signed write reaches its route (got ${w.status} ${w.error ?? ''})`);
    const gated = await request(member, 'GET', '/api/members', home);
    assert(gated.status === 200, `its gated read (/api/members) is 200 (got ${gated.status} ${gated.error ?? ''})`);
    const health = await request(member, 'GET', '/api/community/health', home);
    assert(health.status === 200, `its signed public read (/api/community/health) is 200 (got ${health.status})`);
    const memberLive = liveCounts().member.live;
    const ws = await socket(member, home);
    assert(ws.opened, `its /ws opens (status ${ws.status})`);
    assert(liveCounts().member.live === memberLive + 1, 'as a member\'s: its token was spent in the members\' region');

    const sixteenth = attacker(16);
    const strangerLive = liveCounts().stranger.live;
    const pub = await request(newKey(), 'GET', '/api/community/health', sixteenth);
    assert(pub.status === 200, `a stranger's signed public read is answered as unsigned, 200 (got ${pub.status} ${pub.error ?? ''})`);
    const sw = await write(newKey(), sixteenth);
    assert(sw.status === 503 && sw.code === 'store_full', `a stranger's signed write from a 16th address is 503 (got ${sw.status} ${sw.code ?? ''})`);
    const sws = await socket(newKey(), sixteenth);
    assert(sws.opened, `a stranger's /ws token opens as unsigned, not 503, not 401 (status ${sws.status})`);
    assert(liveCounts().stranger.live === strangerLive, `none of the three stored a nonce (${strangerLive} → ${liveCounts().stranger.live})`);

    // M-4 still holds for a public read answered as unsigned: fresh keys buy no more than the address's 120 a minute.
    const reads: number[] = [];
    for (let i = 0; i < 121; i++) reads.push((await request(newKey(), 'GET', '/api/version', attacker(17))).status);
    assert(reads.slice(0, 120).every((st) => st === 200) && reads[120] === 429,
        `a 17th address's 121 signed public reads with fresh keys: 120 answered, the 121st 429 (${reads.filter((st) => st === 200).length} answered, last ${reads[120]})`);

    requestNonces.prune(Date.now() + 11 * MINUTE);
    const after = await write(newKey(), sixteenth);
    assert(after.status !== 503, `once the nonces have expired the 16th address is accepted (got ${after.status})`);
    assert(securityLines('stranger') === lines + 1, `one security line for all of it (${securityLines('stranger') - lines})`);
}

async function oneMemberKeyCheck(): Promise<void> {
    freshNode(30);
    requestNonces.setLimitsForTests({ membersMax: 250_000, strangersMax: 100_000, keyMax: 20, addressMax: 3_000 });
    const lines = securityLines('member');
    const A = makeMember(), B = makeMember();
    const hall = '192.0.2.44';
    const answers: Answer[] = [];
    for (let i = 0; i < 25; i++) answers.push(await write(A, hall));
    const ok = answers.filter((r) => r.status === 200).length;
    const refused = answers.filter((r) => r.status === 503 && r.code === 'store_full' && r.retryAfter === '60' && r.error === KEY_SHARE_ERROR).length;
    assert(ok === 20 && refused === 5, `member A's 25 writes: 20 reach the route, 5 are 503 in the words for its own app (${ok} ok, ${refused} refused; ${answers.map((r) => r.status).join(' ')})`);
    const b = await write(B, hall);
    assert(b.status === 200, `member B on the same address is accepted (got ${b.status} ${b.error ?? ''})`);
    const wsA = await socket(A, hall);
    assert(!wsA.opened && wsA.status === 503, `A's /ws is turned away 503, busy (opened ${wsA.opened}, status ${wsA.status})`);
    const wsB = await socket(B, hall);
    assert(wsB.opened, `B's /ws opens (status ${wsB.status})`);
    const reads: number[] = [];
    for (let i = 0; i < 31; i++) reads.push((await request(null, 'GET', '/api/version', hall)).status);
    assert(reads.slice(0, 30).every((st) => st === 200) && reads[30] === 429,
        `30 unsigned public reads from that address are 200 and the 31st 429: A's refusals were charged to A, not the address (${reads.join(' ')})`);
    assert(securityLines('member') === lines + 1, `one members' security line (${securityLines('member') - lines})`);
    const line = db.prepare(`SELECT message FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%store_full%' ORDER BY rowid DESC LIMIT 1`).get() as { message: string } | undefined;
    assert(!!line && line.message.includes(A.pubKeyHex.slice(0, 12)) && !line.message.includes(A.pubKeyHex.slice(0, 13)),
        'which names the member\'s key by its first 12 characters only');
}

async function membersRegionCheck(): Promise<void> {
    freshNode();
    requestNonces.setLimitsForTests({ membersMax: 40, strangersMax: 100_000, keyMax: 20, addressMax: 3_000 });
    const C = makeMember(), D = makeMember(), E = makeMember();
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await write(C, '192.0.2.61')).status === 200) ok++;
    for (let i = 0; i < 20; i++) if ((await write(D, '192.0.2.62')).status === 200) ok++;
    assert(ok === 40 && liveCounts().member.live === 40, `two members fill the members' region of 40 (${ok} ok, ${liveCounts().member.live} live)`);
    const e = await write(E, '192.0.2.63');
    assert(e.status === 503 && e.error === MEMBERS_FULL_ERROR && e.retryAfter === '60', `a third member's write is 503 "very busy" (got ${e.status} "${e.error ?? ''}")`);
    const pub = await request(E, 'GET', '/api/community/health', '192.0.2.63');
    assert(pub.status === 200 && liveCounts().member.live === 40, `its signed public read is answered as unsigned, 200, nothing stored (got ${pub.status})`);
    const ws = await socket(E, '192.0.2.63');
    assert(!ws.opened && ws.status === 503, `its /ws is 503 (opened ${ws.opened}, status ${ws.status})`);
    const stranger = await write(newKey(), '192.0.2.64');
    assert(stranger.status !== 503, `a stranger is still accepted: its region is its own (got ${stranger.status})`);
}

// ─── 6. The alert ───────────────────────────────────────────────────────────────────────────

const flood = (told: AlertEvent[]) => told.filter((e) => e.key === 'requests.flood');
const ADDRESS_OR_KEY = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|[0-9a-f]{12}/i;

async function alertChecks(): Promise<void> {
    resetAlertsForTests();
    setAlertsClockForTests(0);
    await section('3. HTTPS: 15 addresses with fresh keys fill the strangers\' region; members are not touched', fifteenAddressesCheck);
    await section('6a. the alert, after the strangers\' region filled', async () => {
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'raised' && told[0].priority === 3,
            `requests.flood is raised once, priority 3 (${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        const detail = told[0]?.detail ?? '';
        assert(detail.includes('300') && detail.includes('10 addresses') && detail.includes('not affected'),
            `its words count the region and its addresses and say members are not affected ("${detail}")`);
        assert(!ADDRESS_OR_KEY.test(detail), 'and name no address and no key');
        const banner = serverAlertsBanner().items.find((i) => i.key === 'requests.flood');
        assert(banner?.title === 'signed requests turned away', `it is in the owners' banner (${banner?.title})`);
        assert(flood(await checkServerAlerts()).length === 0, 'a second tick tells nothing');
    });
    await section('4. HTTPS: one member key is held to its own share; the next member goes on', oneMemberKeyCheck);
    await section('6b. the alert, after a member key reached its share', async () => {
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'raised' && told[0].priority === 4,
            `requests.flood is told again at priority 4: members are affected (${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        const detail = told[0]?.detail ?? '';
        assert(/\b1 member's app\b/.test(detail) && !ADDRESS_OR_KEY.test(detail), `its words count 1 member and name no key ("${detail}")`);
    });
    await section('5. HTTPS: the members\' region full refuses members only', membersRegionCheck);
    await section('6c. the alert, after the members\' region filled, and its end', async () => {
        assert(flood(await checkServerAlerts()).length === 0, 'already told at priority 4: nothing more');
        const detail = serverAlertsBanner().items.find((i) => i.key === 'requests.flood')?.detail ?? '';
        assert(/Members' signed requests have filled their share/.test(detail) && /40 in flight from 2 keys/.test(detail),
            `the banner's words now say the members' share is full ("${detail}")`);
        requestNonces.prune(Date.now() + 11 * MINUTE);
        setAlertsClockForTests(3 * MINUTE);
        assert(flood(await checkServerAlerts()).length === 0, 'with nothing refused for 3 minutes, its end waits the 15-minute hold');
        assert(!serverAlertsBanner().items.some((i) => i.key === 'requests.flood'), 'and it leaves the banner');
        setAlertsClockForTests(19 * MINUTE);
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'cleared', `15 minutes later it is told cleared (${JSON.stringify(told.map((e) => e.kind))})`);
        setAlertsClockForTests(0);
    });
    await section('6d. one address held to its own share raises nothing; one member key at its share does', async () => {
        // On a clock 40 minutes on, so every refusal above is long past and only these count.
        const at = Date.now() + 40 * MINUTE;
        setAlertsClockForTests(40 * MINUTE);
        requestNonces.setLimitsForTests({ membersMax: 250_000, strangersMax: 100_000, keyMax: 2, addressMax: 2 });
        const spend = (id: Id, client: string) => verifyMemberSignature(parts(id, freshNonce(), at), { consumeNonce: true, now: at, client }).ok ? 200 : 503;
        const scanner = [0, 1, 2, 3].map(() => spend(newKey(), 'scanner'));
        assert(scanner.join(' ') === '200 200 503 503', `a scanner's address is held to its share of 2 (${scanner.join(' ')})`);
        assert(flood(await checkServerAlerts()).length === 0, 'and that raises nothing: one noisy address harms nobody else');
        const member = makeMember();
        const own = [0, 1, 2].map(() => spend(member, 'hall'));
        const told = flood(await checkServerAlerts());
        assert(own[2] === 503 && told.length === 1 && told[0].priority === 4,
            `a member key at its share does, at priority 4 (${own.join(' ')}; ${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        setAlertsClockForTests(0);
    });
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://127.0.0.1:${port}`;

    // The store's and the verifier's checks run on a clock 4 hours back, so the hour the security lines wait has passed
    // by the time the HTTPS checks trip them on the real clock.
    const T0 = Date.now() - 4 * HOUR;
    const M = [makeMember(), makeMember(), makeMember()];
    await section('1. the store: shares per owner, a ceiling per region', () => storeChecks(T0));
    const before = { member: securityLines('member'), stranger: securityLines('stranger') };
    await section('2. the verifier: the sentences, the scope, replays and forgeries with every region full', () => verifierChecks(T0, M));
    await section('2b. the security line: at most one an hour per scope', () => securityLineChecks(T0 + 1000, before));
    try {
        await alertChecks();
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
