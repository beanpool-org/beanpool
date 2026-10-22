/**
 * The signed requests' nonce store has a ceiling, and says "busy" when it is full (NB1 of #2038's deciding review,
 * settled by Fable 2026-10-22: scratch/fable-redo/verdict-identity-auth.md, "## 2. Auth hardening").
 *
 * Before it the store had no count bound: one address is held to ~18,000 live nonces by the gateway limiter, but a flood
 * rotating IPv6 /64s, one request each with a fresh keypair, spent ~5,200 nonces a second on a Mac, ~3 M held over the
 * 10-minute hold: past the 512 MB heap. Now a request that needs a new entry is refused 503 store_full with Retry-After
 * while the store is full, and no live nonce is ever forgotten to make room (that would let its request be replayed).
 *
 *  1. The verifier, with a store of its own capped at 3 (through the constructor; the production cap is not touched):
 *     three new nonces are spent; the fourth is refused 503 store_full, 60 seconds, and stores nothing; neither does a
 *     flood of new ones; a replay of a live one is still 403, not busy; a forged request keeps its own 403; a route that
 *     spends no nonce is not refused; once the three have expired, the next request's sweep makes room. The default
 *     store holds 250,000.
 *  2. The security line: one on the first refusal, then at most one an hour however many are refused.
 *  3. Over HTTPS, the real middleware and the process's own store (its cap lowered with setMaxForTests, put back after):
 *     503 with Retry-After: 60 and code store_full; a replay of a live nonce still 403; a /ws connect token with a new
 *     nonce is turned away 503 (not 401, not opened); with room again, the refused request is accepted.
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
import {
    NonceStore, requestNonces, SIGNATURE_FRESHNESS_MS, verifyMemberSignature, type SignedRequestParts,
} from './engine/member-signature.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

const W = SIGNATURE_FRESHNESS_MS;
const HOUR = 60 * 60_000;

// A key that is a member of nothing: the middleware lets its signed POST through to the route, which answers 404.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const freshNonce = () => crypto.randomBytes(16).toString('hex');

function sign(method: string, path: string, ts: number, nonce: string, body: string): string {
    const text = signedRequestText({ host: HOST, method, path, timestamp: String(ts), nonce, body });
    return crypto.sign(null, Buffer.from(signedRequestBytes(text)), privateKey).toString('base64');
}

function parts(nonce: string, ts: number, forged = false): SignedRequestParts {
    const body = '{"x":1}';
    return {
        pubKeyHex, nonce, timestamp: String(ts), method: 'POST', path: '/api/messages/mark-read', body, signedFor: HOST,
        signature: sign('POST', '/api/messages/mark-read', ts, nonce, forged ? '{"x":2}' : body),
    };
}

const securityLines = (): number => (db.prepare(
    `SELECT COUNT(*) AS n FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%store_full%'`,
).get() as { n: number }).n;

const heapLength = (s: NonceStore): number => (s as unknown as { heapExp: number[] }).heapExp.length;

/** The verifier's answer, reduced to what these checks read. */
function verify(store: NonceStore, p: SignedRequestParts, now: number, consumeNonce = true) {
    const v = verifyMemberSignature(p, { consumeNonce, nonces: store, now });
    return v.ok
        ? { ok: true as const, status: 200, code: undefined, retryAfterSec: undefined, error: '' }
        : { ok: false as const, status: v.status, code: v.code, retryAfterSec: (v as { retryAfterSec?: number }).retryAfterSec, error: v.error };
}

function verifierChecks(T0: number): void {
    console.log('\n1. the verifier, with a store capped at 3');
    const store = new NonceStore(W, 3);
    const spent = [freshNonce(), freshNonce(), freshNonce()];
    for (const [i, n] of spent.entries()) {
        const v = verify(store, parts(n, T0), T0);
        assert(v.ok, `new nonce ${i + 1} of 3 is spent (got ${v.status} ${v.error})`);
    }
    assert(store.size === 3, `the store holds 3 (${store.size})`);

    const t = T0 + 1000;
    const fourth = freshNonce();
    const busy = verify(store, parts(fourth, t), t);
    assert(!busy.ok && busy.status === 503 && busy.code === 'store_full',
        `a fourth new nonce is refused 503 store_full (got ${busy.status} ${busy.code ?? ''} ${busy.error})`);
    assert(busy.retryAfterSec === 60, `with a 60-second wait (got ${busy.retryAfterSec})`);
    assert(/busy/i.test(busy.error), `in words that say the community is busy ("${busy.error}")`);
    assert(store.size === 3 && heapLength(store) === 3 && !store.isSpent(fourth, t),
        `the refused nonce is not stored (map ${store.size}, heap ${heapLength(store)})`);

    let refused = 0;
    for (let i = 0; i < 200; i++) if (verify(store, parts(freshNonce(), t), t).status === 503) refused++;
    assert(refused === 200 && store.size === 3 && heapLength(store) === 3,
        `a flood of 200 more new nonces: all refused, nothing stored (${refused} refused, map ${store.size}, heap ${heapLength(store)})`);

    const replay = verify(store, parts(spent[0], t), t);
    assert(!replay.ok && replay.status === 403 && /replay/i.test(replay.error),
        `a replay of a live nonce is still 403 replay, not busy (got ${replay.status} ${replay.error})`);
    assert(spent.every((n) => store.isSpent(n, t)), 'every live nonce is still spent: none was forgotten to make room');

    const forged = verify(store, parts(freshNonce(), t, true), t);
    assert(!forged.ok && forged.status === 403 && /signature/i.test(forged.error),
        `a forged request keeps its own answer (got ${forged.status} ${forged.error})`);

    const unspent = verify(store, parts(freshNonce(), t), t, false);
    assert(unspent.ok, `a route that spends no nonce (the redeem routes) is not refused (got ${unspent.status} ${unspent.error})`);

    const later = T0 + W + 2; // past the three nonces' expiry (T0 + W + 1)
    const v = verify(store, parts(fourth, later), later);
    assert(v.ok, `once the three have expired, a new request is accepted (got ${v.status} ${v.error})`);
    assert(store.size === 1 && store.isSpent(fourth, later), `the sweep freed the three expired ones (map ${store.size})`);

    const big = new NonceStore(W);
    for (let i = 0; i < 249_999; i++) big.consume(`d-${i}`, T0);
    assert(!big.full(T0), 'the default store is not full at 249,999');
    big.consume('d-last', T0);
    assert(big.full(T0), 'and is full at 250,000');
    assert(!big.full(T0 + W + 2), 'until they expire');
}

function securityLineChecks(first: number, before: number): void {
    console.log('\n2. the security line: at most one an hour');
    assert(securityLines() === before + 1, `the first refusal wrote one line (${securityLines() - before})`);
    /** One refusal at `at`, from a store of one. */
    const trip = (at: number): number => {
        const s = new NonceStore(W, 1);
        verify(s, parts(freshNonce(), at), at);
        return verify(s, parts(freshNonce(), at), at).status;
    };
    const statuses = [first + 60_000, first + 30 * 60_000, first + HOUR - 1].map(trip);
    assert(statuses.every((s) => s === 503), `refused within the hour (${statuses.join(', ')})`);
    assert(securityLines() === before + 1, `no second line within the hour (${securityLines() - before})`);
    trip(first + HOUR);
    assert(securityLines() === before + 2, `a second line an hour after the first (${securityLines() - before})`);
    for (let i = 1; i <= 50; i++) trip(first + HOUR + i * 1000);
    assert(securityLines() === before + 2, `50 more refusals in that hour write none (${securityLines() - before})`);
}

async function httpChecks(base: string): Promise<void> {
    console.log('\n3. over HTTPS: the real middleware and the process\'s store');
    const path = '/api/messages/mark-read';
    const post = async (nonce: string) => {
        const ts = Date.now();
        const body = JSON.stringify({ pubkey: pubKeyHex, conversationId: 'test-conv' });
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'X-Public-Key': pubKeyHex, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
                [SIGNED_FOR_HEADER]: HOST, 'X-Signature': sign('POST', path, ts, nonce, body),
            },
            body,
        });
        let json: { error?: string; code?: string } = {};
        try { json = await res.json(); } catch { /* no json */ }
        return { status: res.status, retryAfter: res.headers.get('retry-after'), ...json };
    };
    const socket = (nonce: string) => new Promise<{ opened: boolean; status: number }>((resolve) => {
        const ts = Date.now();
        const sig = sign('WS', '/ws', ts, nonce, '');
        const ws = new WebSocket(`${base.replace('https', 'wss')}/ws?pubkey=${pubKeyHex}&ts=${ts}&nonce=${nonce}`
            + `&sig=${encodeURIComponent(sig)}&for=${HOST}&v=2`, { rejectUnauthorized: false });
        ws.on('open', () => { ws.close(); resolve({ opened: true, status: 101 }); });
        ws.on('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode ?? 0 }); res.resume(); });
        ws.on('error', () => resolve({ opened: false, status: 0 }));
    });

    const first = await post(freshNonce());
    assert(first.status === 404, `a signed request reaches the route (got ${first.status} ${first.error ?? ''})`);

    const lines = securityLines();
    requestNonces.setMaxForTests(requestNonces.size + 2);
    try {
        const a = freshNonce();
        const ra = await post(a);
        const rb = await post(freshNonce());
        assert(ra.status === 404 && rb.status === 404, `two more fill the store (got ${ra.status}, ${rb.status})`);
        const held = requestNonces.size;

        const c = freshNonce();
        const rc = await post(c);
        assert(rc.status === 503 && rc.code === 'store_full', `a new nonce is refused 503 store_full (got ${rc.status} ${rc.code ?? ''} ${rc.error ?? ''})`);
        assert(rc.retryAfter === '60', `with Retry-After: 60 (got ${rc.retryAfter})`);
        assert(requestNonces.size === held && !requestNonces.isSpent(c), `and is not stored (store ${held} → ${requestNonces.size})`);

        const replay = await post(a);
        assert(replay.status === 403 && /replay/i.test(replay.error ?? ''), `a replay of a live nonce is still 403 (got ${replay.status} ${replay.error ?? ''})`);

        const ws = await socket(freshNonce());
        assert(!ws.opened && ws.status === 503, `a /ws connect token with a new nonce is turned away 503 (opened ${ws.opened}, status ${ws.status})`);
        assert(requestNonces.size === held, `and stores nothing (store ${held} → ${requestNonces.size})`);
        assert(securityLines() === lines + 1, `one security line for all of these (${securityLines() - lines})`);

        requestNonces.setMaxForTests(null);
        const again = await post(c);
        assert(again.status === 404, `with room again, the refused request is accepted (got ${again.status} ${again.error ?? ''})`);
    } finally {
        requestNonces.setMaxForTests(null);
    }
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);

    // The verifier's checks run on a clock 4 hours back, so the hour the security line waits has passed by the time
    // the HTTPS checks trip it on the real clock.
    const T0 = Date.now() - 4 * HOUR;
    const before = securityLines();
    verifierChecks(T0);
    securityLineChecks(T0 + 1000, before); // the first refusal above is at T0 + 1 s
    await httpChecks(`https://localhost:${port}`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
