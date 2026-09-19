/**
 * Two gaps left after #935.
 *
 * 1. IPv6 rotation. Every per-IP limiter keyed on the full /128, and an IPv6 subscriber owns a whole /64, so a
 *    client could take a fresh address (a fresh, empty bucket) per request. Limiters now key on the /64
 *    (limiterKeyForIp). IPv4 stays per address; IPv4-mapped spellings fold to the IPv4 address.
 * 2. The admin password had only per-address brakes, which any spread of addresses gets round. password-brake.ts
 *    counts failures for the whole node: after FREE_FAILURES, password checks close for a doubling, capped
 *    delay; a success lets go. Key sign-in and break-glass codes still work while it is closed.
 *
 * Part 2 and 3 drive the real servers over HTTP on the tunnel-origin port: the test client connects from
 * loopback (a trusted local proxy), so CF-Connecting-IP names the client, as cloudflared does.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-limiter-ipv6-and-password-brake.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, setNodeRoleBreakGlassHash } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateGatewayConfig, updateLocalConfig, hashPassword, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resolveClientIp, limiterKeyForIp, setTrustConfigForTests } from './client-ip.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { generateBreakGlassCode, hashBreakGlassCode } from './admin-key-auth.js';
import {
    FREE_FAILURES, MAX_DELAY_MS, QUIET_RESET_MS, notePasswordFailure, notePasswordSuccess, passwordBrakeRetryAfter, resetPasswordBrake,
} from './password-brake.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const viaTunnel = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });
let BASE = '';

async function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, json };
}

async function burst(n: number, make: (i: number) => [string, Record<string, string>]): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const [p, h] = make(i);
        out.push((await req(p, { headers: h })).status);
    }
    return out;
}

function part1Keys() {
    console.log('— limiter key (client-ip.ts limiterKeyForIp) —');
    const k = limiterKeyForIp;
    assert(k('2001:db8:1:2::1') === k('2001:db8:1:2:ffff:abcd:1234:5678'), 'two addresses in one /64 share a key');
    assert(k('2001:db8:1:2::1') !== k('2001:db8:1:3::1'), 'addresses in different /64s get different keys');
    assert(k('2001:0DB8:0001:0002:0000:0000:0000:0001') === k('2001:db8:1:2::1'), 'expanded, upper-case and compressed spellings share a key');
    assert(k('fe80::1%eth0') === k('fe80::2'), 'a zone id is stripped');
    assert(k('::ffff:203.0.113.5') === '203.0.113.5', 'IPv4-mapped (dotted) folds to the IPv4 address');
    assert(k('::ffff:cb00:7105') === '203.0.113.5', 'IPv4-mapped (hex) folds to the IPv4 address');
    assert(k('0:0:0:0:0:FFFF:203.0.113.5') === '203.0.113.5', 'IPv4-mapped (expanded) folds to the IPv4 address');
    assert(k('203.0.113.5') === '203.0.113.5' && k('203.0.113.6') === '203.0.113.6', 'IPv4 stays per address');
    assert(k('unknown') === 'unknown' && k('') === 'unknown', 'a non-address passes through');
    // Only the bucket widens: the client's own address, as logged and allowlisted, is the full address.
    setTrustConfigForTests(undefined);
    assert(resolveClientIp('127.0.0.1', viaTunnel('2001:db8:1:2::abcd')) === '2001:db8:1:2::abcd',
        'the resolved client address (logging, allowlist) is still the full /128');
}

async function part2Limiters() {
    const LIMIT = 5;
    const limited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: true, maxRequestsPerMinute: LIMIT } };
    const unlimited = { ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: LIMIT } };
    const PROBE = '/api/gateway-limit-probe';
    const inPrefix = (prefix: string, i: number) => `${prefix}:${(i + 1).toString(16)}:${randomBytes(2).toString('hex')}:0:${(i * 7 + 1).toString(16)}`;

    console.log('\n— gateway limiter over IPv6 —');
    updateGatewayConfig(limited);
    resetGatewayRateLimit();
    {
        const s = await burst(50, i => [PROBE, viaTunnel(inPrefix('2001:db8:1:2', i))]);
        const n429 = s.filter(x => x === 429).length;
        assert(s.slice(0, LIMIT).every(x => x !== 429) && n429 === 50 - LIMIT,
            `50 requests rotating inside one /64 get 429 after ${LIMIT} (429s: ${n429}/50; was 0 before)`);
    }
    resetGatewayRateLimit();
    {
        const s = await burst(2 * LIMIT, i => [PROBE, viaTunnel(inPrefix(i % 2 ? '2001:db8:1:3' : '2001:db8:1:4', i))]);
        assert(!s.includes(429), `two /64s get separate buckets: ${LIMIT} each, no 429 (got ${s.join(',')})`);
    }
    resetGatewayRateLimit();
    {
        const s = await burst(LIMIT + 1, i => [PROBE, viaTunnel(i % 2 ? '::ffff:203.0.113.5' : '203.0.113.5')]);
        assert(s[LIMIT] === 429, `203.0.113.5 and ::ffff:203.0.113.5 share one bucket: 429 on ${LIMIT + 1} (got ${s.join(',')})`);
    }

    console.log('\n— auth-attempt limiter (15/min) over IPv6 —');
    updateGatewayConfig(unlimited);
    {
        const s = await burst(16, i => [`/api/recovery/lookup/nobody${i}`, viaTunnel(inPrefix('2001:db8:2:2', i))]);
        assert(s.slice(0, 15).every(x => x !== 429) && s[15] === 429, `recovery lookups rotating inside one /64: 429 on 16 (got ${s[15]})`);
        const other = await req('/api/recovery/lookup/nobody', { headers: viaTunnel('2001:db8:2:3::1') });
        assert(other.status !== 429, `a neighbouring /64 has its own auth bucket (got ${other.status})`);
    }

    console.log('\n— invite-check limiter (30/min) over IPv6 —');
    {
        const s = await burst(31, i => [`/api/invite/check?code=x${i}`, viaTunnel(inPrefix('2001:db8:3:2', i))]);
        assert(s.slice(0, 30).every(x => x !== 429) && s[30] === 429, `invite checks rotating inside one /64: 429 on 31 (got ${s[30]})`);
    }
}

function keyPair() {
    const priv = randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('hex');
    return { pub, sign: (m: string) => Buffer.from(ed25519.sign(Buffer.from(m, 'utf-8'), priv)).toString('hex') };
}

async function part3Brake() {
    console.log('\n— password brake: growth and reset (clock injected) —');
    resetPasswordBrake();
    const t0 = 1_000_000_000_000;
    for (let i = 1; i <= FREE_FAILURES; i++) notePasswordFailure(t0 + i);
    assert(passwordBrakeRetryAfter(t0 + FREE_FAILURES) === 0, `${FREE_FAILURES} failures cost nothing extra`);
    const waits: number[] = [];
    let t = t0 + FREE_FAILURES;
    for (let i = 1; i <= 5; i++) {
        t += (waits[waits.length - 1] || 0) * 1000 + 1; // each failure just after the previous wait, so it is admitted
        notePasswordFailure(t);
        waits.push(passwordBrakeRetryAfter(t));
    }
    assert(waits.join(',') === '2,4,8,16,32', `each further failure doubles the wait (s: ${waits.join(',')})`);
    for (let i = 0; i < 30; i++) { t += MAX_DELAY_MS; notePasswordFailure(t); }
    assert(passwordBrakeRetryAfter(t) === MAX_DELAY_MS / 1000, `the wait is capped at ${MAX_DELAY_MS / 1000}s: never a permanent lockout`);
    notePasswordSuccess();
    assert(passwordBrakeRetryAfter(t + 1) === 0, 'a success resets the brake');
    for (let i = 0; i <= FREE_FAILURES; i++) notePasswordFailure(t + 2 + i);
    t += 2 + FREE_FAILURES + QUIET_RESET_MS + 1;
    notePasswordFailure(t);
    assert(passwordBrakeRetryAfter(t) === 0, 'half an hour with no failure forgets the count: the next failure is free again');

    // Real servers from here.
    const PW = 'Brake-Test-Password-1!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    const verify = (pw: string, ip: string) => req('/api/local/verify-password', { method: 'POST', body: { password: pw }, headers: viaTunnel(ip) });

    console.log('\n— password brake over HTTP: node-wide, not per address —');
    resetPasswordBrake();
    {
        // Every attempt from a different address: no per-address limiter ever sees more than one.
        const statuses: number[] = [];
        for (let i = 0; i <= FREE_FAILURES; i++) statuses.push((await verify('wrong-' + i, `198.51.100.${i + 1}`)).status);
        assert(statuses.every(s => s === 401), `${FREE_FAILURES + 1} wrong passwords from ${FREE_FAILURES + 1} addresses are each checked and refused (${statuses.join(',')})`);
        const right = await verify(PW, '198.51.100.200');
        assert(right.status === 429, `the next attempt, from yet another address, is not checked at all: 429 even with the right password (got ${right.status})`);
        assert(Number(right.headers.get('retry-after')) >= 1 && right.json?.passwordBackoff === true, `it says when to retry (Retry-After ${right.headers.get('retry-after')})`);
        const viaAdminAuth = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': PW, ...viaTunnel('198.51.100.201') } });
        assert(viaAdminAuth.status === 429, `password auth on admin routes (checkAdminAuth) is under the same brake (got ${viaAdminAuth.status})`);
    }

    console.log('\n— owners still get in while the brake is on —');
    {
        const owner = keyPair();
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, 'BrakeOwner', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(owner.pub);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(owner.pub);
        grantNodeRole(owner.pub, 'owner', 'SYSTEM');
        assert(passwordBrakeRetryAfter() > 0, 'the brake is on');

        const chal = await req('/api/local/admin/auth/challenge', { method: 'POST' });
        const solved = await req('/api/local/admin/auth/verify-challenge', {
            method: 'POST', body: { challengeId: chal.json?.challengeId, memberPubkey: owner.pub, signature: owner.sign(chal.json?.challenge || '') },
        });
        const exchanged = await req('/api/local/admin/auth/exchange', { method: 'POST', body: { token: solved.json?.handshakeToken } });
        const session = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-session': exchanged.json?.sessionId || '' } });
        assert(chal.status === 200 && solved.status === 200 && exchanged.status === 200 && session.status === 200,
            `key sign-in works during a password backoff: challenge ${chal.status}, signed ${solved.status}, session ${exchanged.status}, admin route ${session.status}`);

        const code = generateBreakGlassCode();
        setNodeRoleBreakGlassHash(owner.pub, hashBreakGlassCode(code));
        const bg = await req('/api/local/admin/diagnostics', { headers: { 'x-break-glass-code': code, ...viaTunnel('198.51.100.202') } });
        assert(bg.status === 200, `a break-glass code is still checked during a password backoff (got ${bg.status})`);
        const bgWrong = await req('/api/local/admin/diagnostics', { headers: { 'x-break-glass-code': 'not-the-code', ...viaTunnel('198.51.100.203') } });
        assert(bgWrong.status === 429, `a wrong code during the backoff gets the brake's 429, not a password check (got ${bgWrong.status})`);
    }

    console.log('\n— a success lets go —');
    {
        await sleep(passwordBrakeRetryAfter() * 1000 + 100);
        const right = await verify(PW, '198.51.100.210');
        assert(right.status === 200, `once the wait is over, the right password gets in (got ${right.status})`);
        const wrong = await verify('wrong-again', '198.51.100.211');
        assert(wrong.status === 401 && passwordBrakeRetryAfter() === 0, `and the count starts again: the next wrong password is a plain 401 (got ${wrong.status})`);
    }

    console.log('\n— parallel attempts —');
    resetPasswordBrake();
    {
        const all = await Promise.all(Array.from({ length: 30 }, (_, i) => verify('parallel-wrong-' + i, `198.51.101.${i + 1}`)));
        const n401 = all.filter(r => r.status === 401).length, n429 = all.filter(r => r.status === 429).length;
        assert(n401 === FREE_FAILURES + 1 && n429 === 30 - n401,
            `30 wrong passwords at once: only ${FREE_FAILURES + 1} are checked, the rest refused by the brake (401: ${n401}, 429: ${n429})`);
    }
    resetPasswordBrake();
    {
        const all = await Promise.all(Array.from({ length: 20 }, (_, i) => verify(PW, `198.51.102.${i + 1}`)));
        assert(all.every(r => r.status === 200), `20 right passwords at once (a dashboard's burst) are all admitted (${[...new Set(all.map(r => r.status))].join(',')})`);
    }
    resetPasswordBrake();
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
}

async function main() {
    console.log('Running IPv6 limiter-key and password-brake tests...\n');
    part1Keys();
    await initTls();
    initStateEngine();
    const httpPort = await freePort();
    const httpsPort = await freePort();
    await startHttpServer(httpPort);
    await startHttpsServer(httpsPort);
    BASE = `http://127.0.0.1:${httpPort}`;
    await part2Limiters();
    await part3Brake();
    setTrustConfigForTests(undefined);
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
