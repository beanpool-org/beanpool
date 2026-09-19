/**
 * The admin-password brake must not let a stranger lock the real owner out.
 *
 * #937's brake counted wrong passwords for the whole node: eleven from anyone closed password checking for everyone,
 * for up to ten minutes, and the right password got 429 too. Found live on test 2026-09-19. On a node with no key
 * owner yet the password is the only way in, so anyone on the internet could keep the owner out for good.
 *
 * password-brake.ts is now per source (IPv4 address, IPv6 /64) with a node-wide cap on checks from sources that
 * failed in the last day. This suite shows:
 *   - a flood of wrong passwords from A does not stop the right password from B;
 *   - A itself backs off exponentially, capped;
 *   - a flood spread over many sources is still capped node-wide, favouring sources with fewer failures, and a source
 *     with no failure on record is always checked;
 *   - fresh /64s inside one /48 do not each count as clean;
 *   - key sign-in and break-glass codes are unaffected;
 *   - /ws/logs?auth= follows the same rules;
 *   - the guesses an attacker gets per hour (the maths in docs/admin-surface.md §2.6), by simulation.
 *
 * The HTTP parts drive the real servers on the tunnel-origin port: the test client connects from loopback (a trusted
 * local proxy), so CF-Connecting-IP names the client, as cloudflared does.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-password-brake-no-lockout.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, setNodeRoleBreakGlassHash } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateGatewayConfig, updateLocalConfig, hashPassword, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { setTrustConfigForTests } from './client-ip.js';
import { generateBreakGlassCode, hashBreakGlassCode } from './admin-key-auth.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import {
    SOURCE_FREE_FAILURES, MAX_DELAY_MS, FORGET_MS, NODE_CHECKS_PER_MIN, NODE_BACKOFF_CHECKS_PER_MIN, PREFIX_CLEAN_FAILURES,
    tryAdmit, settlePasswordAttempt, notePasswordFailure, prefixOf, resetPasswordBrake,
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

const viaTunnel = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });
let BASE = '';
let WS_BASE = '';

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

/** Attempt a WebSocket upgrade; the HTTP status it was refused with, or 101. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers });
        let settled = false;
        const done = (n: number) => { if (!settled) { settled = true; resolve(n); } };
        ws.on('open', () => { done(101); ws.terminate(); });
        ws.on('unexpected-response', (_req, res) => { done(res.statusCode || 0); res.resume(); ws.terminate(); });
        ws.on('error', () => done(0));
        setTimeout(() => done(-1), 5000);
    });
}

/** One whole attempt on the injected clock: admitted → checked (always wrong here) → settled. */
function guess(key: string, now: number): 'checked' | 'source' | 'node' | 'wait' {
    const a = tryAdmit(key, now);
    if (a === 'wait') return 'wait';
    if (!a.admitted) return a.reason;
    settlePasswordAttempt(key, false, true, now);
    return 'checked';
}

function part1Unit() {
    const T0 = 1_000_000_000_000;

    console.log('— one source backs off exponentially (clock injected) —');
    resetPasswordBrake();
    {
        const A = '203.0.113.10';
        const first: string[] = [];
        for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) first.push(guess(A, T0 + i));
        assert(first.every(r => r === 'checked'), `the first ${SOURCE_FREE_FAILURES + 1} wrong passwords from A are all checked (${first.join(',')})`);
        const waits: number[] = [];
        const reopened: string[] = [];
        let t = T0 + SOURCE_FREE_FAILURES;
        for (let i = 0; i < 6; i++) {
            const r = tryAdmit(A, t + 1);
            if (r === 'wait' || r.admitted) break;
            waits.push(r.retryAfter);
            // Wait out A's backoff, and at least a minute, so the node-wide allowance (which A's own checks also
            // use) is not what refuses it.
            t += Math.max(r.retryAfter * 1000, 60_000);
            reopened.push(guess(A, t));
        }
        assert(reopened.length === 6 && reopened.every(r => r === 'checked'), `A is checked again each time its wait is over (${reopened.join(',')})`);
        assert(waits.join(',') === '2,4,8,16,32,64', `each further failure doubles A's wait (s: ${waits.join(',')})`);
        for (let i = 0; i < 40; i++) { t += MAX_DELAY_MS; guess(A, t); }
        const capped = tryAdmit(A, t + 1);
        assert(capped !== 'wait' && !capped.admitted && capped.retryAfter === MAX_DELAY_MS / 1000,
            `A's wait is capped at ${MAX_DELAY_MS / 60_000} min: never a permanent lockout (got ${capped !== 'wait' && !capped.admitted ? capped.retryAfter : '?'}s)`);

        const B = '198.51.100.20';
        const b = tryAdmit(B, t + 1);
        assert(b !== 'wait' && b.admitted, 'while A is closed, another source B is admitted straight away');
        settlePasswordAttempt(B, true, true, t + 1);

        const later = t + MAX_DELAY_MS + FORGET_MS + 1;
        const r = tryAdmit(A, later);
        assert(r !== 'wait' && r.admitted, 'a day with no failure from A forgets it');
        settlePasswordAttempt(A, false, true, later);
        const again = [guess(A, later + 1), guess(A, later + 2), guess(A, later + 3), guess(A, later + 4)];
        assert(again.every(x => x === 'checked'), `and its free failures start again (${again.join(',')})`);
    }

    console.log('\n— a right password from A clears only A —');
    resetPasswordBrake();
    {
        const A = '203.0.113.11', C = '203.0.113.99';
        for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) guess(C, T0 + i);
        for (let i = 0; i < SOURCE_FREE_FAILURES; i++) guess(A, T0 + i);
        const a = tryAdmit(A, T0 + 100);
        assert(a !== 'wait' && a.admitted, 'A is admitted');
        settlePasswordAttempt(A, true, true, T0 + 100);
        const c = tryAdmit(C, T0 + 101);
        assert(c !== 'wait' && !c.admitted && c.reason === 'source', `C, still guessing, stays closed after A's success (#937 cleared everyone)`);
    }

    console.log('\n— many sources: capped node-wide, fewer failures first —');
    resetPasswordBrake();
    {
        // 100 addresses, each in its own /24, each fails once (all clean, all checked).
        const keys = Array.from({ length: 100 }, (_, i) => `198.18.${i}.1`);
        const firsts = keys.map(k => guess(k, T0));
        assert(firsts.every(r => r === 'checked'), `100 clean sources: every first guess is checked (${firsts.filter(r => r === 'checked').length}/100)`);
        const seconds = keys.map(k => guess(k, T0 + 1000));
        const nChecked = seconds.filter(r => r === 'checked').length;
        assert(nChecked === NODE_CHECKS_PER_MIN && seconds.filter(r => r === 'node').length === 100 - NODE_CHECKS_PER_MIN,
            `their second guesses in the same minute: only ${NODE_CHECKS_PER_MIN} checked node-wide, the rest refused (checked ${nChecked})`);
        const refused = tryAdmit(keys[99], T0 + 2000);
        assert(refused !== 'wait' && !refused.admitted && refused.reason === 'node' && refused.retryAfter <= 60,
            `a refusal says when the allowance frees, within the minute (${refused !== 'wait' && !refused.admitted ? refused.retryAfter : '?'}s)`);
        const owner = tryAdmit('192.0.2.50', T0 + 2000);
        assert(owner !== 'wait' && owner.admitted, 'meanwhile a source with no failure (the owner) is always checked');
        settlePasswordAttempt('192.0.2.50', true, true, T0 + 2000);
        const nextMinute = keys.slice(20).map(k => guess(k, T0 + 61_000)).filter(r => r === 'checked').length;
        assert(nextMinute === NODE_CHECKS_PER_MIN, `the next minute checks another ${NODE_CHECKS_PER_MIN} (got ${nextMinute})`);
    }
    resetPasswordBrake();
    {
        // Twenty sources already in backoff, and one that mistyped once.
        let t = T0;
        const backed = Array.from({ length: 20 }, (_, i) => `198.19.${i}.1`);
        for (const k of backed) for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) notePasswordFailure(k, t);
        const typo = '192.0.2.77';
        notePasswordFailure(typo, t);
        t += 10 * 60_000; // past their waits, still within the hour
        const r = backed.map(k => guess(k, t)).filter(x => x === 'checked').length;
        assert(r === NODE_BACKOFF_CHECKS_PER_MIN, `sources in backoff share only ${NODE_BACKOFF_CHECKS_PER_MIN} checks a minute (got ${r})`);
        const typoAdmit = tryAdmit(typo, t);
        assert(typoAdmit !== 'wait' && typoAdmit.admitted, 'an owner who mistyped once is still checked: the rest of the allowance is kept for few-failure sources');
    }

    console.log('\n— fresh /64s inside one /48 are not each clean —');
    resetPasswordBrake();
    {
        const in48 = (i: number) => `2001:db8:77:${i.toString(16)}::/64`;
        assert(prefixOf(in48(1)) === '2001:db8:77::/48' && prefixOf('203.0.113.5') === '203.0.113.0/24', 'prefixes: IPv6 /48, IPv4 /24');
        const results = Array.from({ length: 40 }, (_, i) => guess(in48(i), T0));
        const cleanChecked = results.slice(0, PREFIX_CLEAN_FAILURES).every(r => r === 'checked');
        const after = results.slice(PREFIX_CLEAN_FAILURES).filter(r => r === 'checked').length;
        assert(cleanChecked && after === NODE_CHECKS_PER_MIN,
            `40 fresh /64s in one /48: the first ${PREFIX_CLEAN_FAILURES} are clean, after that they share the node allowance (${after} of 20 checked)`);
        const elsewhere = tryAdmit('2001:db8:88:1::/64', T0);
        assert(elsewhere !== 'wait' && elsewhere.admitted, 'a /64 in another /48 is still clean and checked');
    }
    resetPasswordBrake();
}

/** An attacker who guesses from every source as fast as the brake allows. Returns checks per hour. */
function simulate(keys: string[], hours: number): number[] {
    resetPasswordBrake();
    const T0 = 2_000_000_000_000;
    const perHour = Array(hours).fill(0);
    const nextTry = new Map<string, number>(keys.map(k => [k, T0]));
    for (let t = T0; t < T0 + hours * 3_600_000; t += 1000) {
        for (const k of keys) {
            if (nextTry.get(k)! > t) continue;
            const a = tryAdmit(k, t);
            if (a === 'wait') continue;
            if (a.admitted) {
                settlePasswordAttempt(k, false, true, t);
                perHour[Math.floor((t - T0) / 3_600_000)]++;
            } else {
                nextTry.set(k, t + a.retryAfter * 1000);
            }
        }
    }
    resetPasswordBrake();
    return perHour;
}

function part2Maths() {
    console.log('\n— guesses an attacker gets per hour (simulated, 1 s steps) —');
    const one = simulate(['203.0.113.200'], 3);
    console.log(`  1 address:                 ${one.join(', ')} checks in hours 1–3`);
    assert(one[0] <= 20 && one[2] <= 2, `one address: ${one[0]} in the first hour, then about one an hour (${one[2]} in hour 3)`);
    const many = simulate(Array.from({ length: 300 }, (_, i) => `198.${18 + (i >> 8)}.${i & 255}.1`), 3);
    console.log(`  300 addresses (300 /24s):  ${many.join(', ')} checks in hours 1–3`);
    assert(many[0] <= 300 + NODE_CHECKS_PER_MIN * 60 && many.slice(1).every(h => h <= NODE_CHECKS_PER_MIN * 60),
        `300 addresses: at most N + ${NODE_CHECKS_PER_MIN * 60} in the first hour, then at most ${NODE_CHECKS_PER_MIN * 60} an hour whatever N is (${many.join(', ')})`);
    const v6 = simulate(Array.from({ length: 1000 }, (_, i) => `2001:db8:99:${i.toString(16)}::/64`), 3);
    console.log(`  1000 /64s in one /48:      ${v6.join(', ')} checks in hours 1–3`);
    assert(v6.every(h => h <= PREFIX_CLEAN_FAILURES + NODE_CHECKS_PER_MIN * 60), `a /48's worth of /64s is capped like one prefix: at most ${PREFIX_CLEAN_FAILURES} + ${NODE_CHECKS_PER_MIN * 60} an hour (${v6.join(', ')})`);
}

function keyPair() {
    const priv = randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('hex');
    return { pub, sign: (m: string) => Buffer.from(ed25519.sign(Buffer.from(m, 'utf-8'), priv)).toString('hex') };
}

async function part3Http() {
    const PW = 'Brake-Test-Password-1!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    const verify = (pw: string, ip: string) => req('/api/local/verify-password', { method: 'POST', body: { password: pw }, headers: viaTunnel(ip) });

    console.log('\n— HTTP: a flood from A does not stop the right password from B —');
    resetPasswordBrake();
    const A = '203.0.113.66';
    {
        const s: number[] = [];
        for (let i = 0; i < 30; i++) s.push((await verify('wrong-' + i, A)).status);
        const checked = s.filter(x => x === 401).length;
        // After the brake, the existing per-address auth limiter (15/min, auth-rate-limit.ts) also refuses A: both 429.
        assert(checked === SOURCE_FREE_FAILURES + 1 && s.slice(checked).every(x => x === 429),
            `30 wrong passwords from A: ${SOURCE_FREE_FAILURES + 1} checked, then A is refused (${checked}×401, ${s.length - checked}×429)`);
        const aRight = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': PW, ...viaTunnel(A) } });
        assert(aRight.status === 429 && aRight.json?.passwordBackoff === true && Number(aRight.headers.get('retry-after')) >= 1,
            `A itself waits, even with the right password, on admin routes too (got ${aRight.status}, Retry-After ${aRight.headers.get('retry-after')})`);
        assert(/another network/.test(aRight.json?.error || ''), `and is told another network, or a key, still works ("${aRight.json?.error}")`);
        const b = await verify(PW, '198.51.100.7');
        assert(b.status === 200, `the right password from B gets in (got ${b.status}; #937 answered 429)`);
        const bAdmin = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': PW, ...viaTunnel('198.51.100.8') } });
        assert(bAdmin.status === 200, `and so does password auth on admin routes (checkAdminAuth) from another address (got ${bAdmin.status})`);
    }

    console.log('\n— HTTP: parallel guesses from one source —');
    {
        const P = '203.0.113.67';
        const all = await Promise.all(Array.from({ length: 30 }, (_, i) => verify('parallel-wrong-' + i, P)));
        const n401 = all.filter(r => r.status === 401).length, n429 = all.filter(r => r.status === 429).length;
        assert(n401 === SOURCE_FREE_FAILURES + 1 && n429 === 30 - n401,
            `30 wrong passwords at once from one address: only ${SOURCE_FREE_FAILURES + 1} are checked (401: ${n401}, 429: ${n429})`);
        const burst = await Promise.all(Array.from({ length: 20 }, () =>
            req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': PW, ...viaTunnel('203.0.113.68') } })));
        assert(burst.every(r => r.status === 200), `20 right passwords at once from one address (a dashboard's burst) are all admitted (${[...new Set(burst.map(r => r.status))].join(',')})`);
    }

    console.log('\n— HTTP: a flood from many sources is capped node-wide —');
    resetPasswordBrake();
    {
        const srcs = Array.from({ length: 40 }, (_, i) => `198.18.${i}.9`);
        const first = await Promise.all(srcs.map(ip => verify('spread-wrong', ip)));
        assert(first.every(r => r.status === 401), `40 addresses, one wrong password each: all checked (${first.filter(r => r.status === 401).length}/40)`);
        const second = await Promise.all(srcs.map(ip => verify('spread-wrong-2', ip)));
        const n401 = second.filter(r => r.status === 401).length;
        assert(n401 === NODE_CHECKS_PER_MIN && second.filter(r => r.status === 429).length === 40 - NODE_CHECKS_PER_MIN,
            `their second round: only ${NODE_CHECKS_PER_MIN} checked this minute, the rest 429 (checked ${n401})`);
        const owner = await verify(PW, '192.0.2.10');
        assert(owner.status === 200, `the owner's right password from a clean address still gets in (got ${owner.status})`);
    }

    console.log('\n— key sign-in and break-glass are unaffected —');
    {
        const owner = keyPair();
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, 'BrakeOwner2', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(owner.pub);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(owner.pub);
        grantNodeRole(owner.pub, 'owner', 'SYSTEM');
        // Close A for a few minutes (the steps below take longer than a 2 s wait).
        for (let i = 0; i < SOURCE_FREE_FAILURES + 8; i++) notePasswordFailure(A);
        const closed = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': PW, ...viaTunnel(A) } });
        assert(closed.status === 429, `A is closed (got ${closed.status})`);

        const chal = await req('/api/local/admin/auth/challenge', { method: 'POST', headers: viaTunnel(A) });
        const solved = await req('/api/local/admin/auth/verify-challenge', {
            method: 'POST', headers: viaTunnel(A), body: { challengeId: chal.json?.challengeId, memberPubkey: owner.pub, signature: owner.sign(chal.json?.challenge || '') },
        });
        const exchanged = await req('/api/local/admin/auth/exchange', { method: 'POST', headers: viaTunnel(A), body: { token: solved.json?.handshakeToken } });
        const session = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-session': exchanged.json?.sessionId || '', ...viaTunnel(A) } });
        assert(chal.status === 200 && solved.status === 200 && exchanged.status === 200 && session.status === 200,
            `key sign-in from the braked address works: challenge ${chal.status}, signed ${solved.status}, session ${exchanged.status}, admin route ${session.status}`);

        const code = generateBreakGlassCode();
        setNodeRoleBreakGlassHash(owner.pub, hashBreakGlassCode(code));
        const bg = await req('/api/local/admin/diagnostics', { headers: { 'x-break-glass-code': code, ...viaTunnel(A) } });
        assert(bg.status === 200, `a break-glass code from the braked address is still checked (got ${bg.status})`);
        const bgWrong = await req('/api/local/admin/diagnostics', { headers: { 'x-break-glass-code': 'not-the-code', ...viaTunnel(A) } });
        assert(bgWrong.status === 429, `a wrong code from it gets the brake's 429, not a password check (got ${bgWrong.status})`);
    }

    console.log('\n— /ws/logs?auth= follows the same rules —');
    resetPasswordBrake();
    {
        const W = '203.0.113.80';
        const logs = (pw: string, ip: string) => upgradeStatus(`${WS_BASE}/ws/logs?auth=${encodeURIComponent(pw)}`, viaTunnel(ip));
        const s: number[] = [];
        for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) s.push(await logs('ws-wrong-' + i, W));
        assert(s.every(x => x === 401), `${SOURCE_FREE_FAILURES + 1} wrong ?auth= from W are checked and refused (${s.join(',')})`);
        const wRight = await logs(PW, W);
        assert(wRight === 429, `then W is braked, even with the right password (got ${wRight})`);
        const x = await logs(PW, '198.51.100.81');
        assert(x === 101, `the right ?auth= from another address opens (got ${x})`);
        const viaHttp = await verify(PW, W);
        assert(viaHttp.status === 429, `W's brake is the same one HTTP uses (got ${viaHttp.status})`);
    }
    resetPasswordBrake();
    resetAdminAuthTarpit();
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
}

async function main() {
    console.log('Running password-brake no-lockout tests...\n');
    part1Unit();
    part2Maths();
    await initTls();
    initStateEngine();
    setTrustConfigForTests(undefined);
    const httpPort = await freePort();
    const httpsPort = await freePort();
    await startHttpServer(httpPort);
    await startHttpsServer(httpsPort);
    BASE = `http://127.0.0.1:${httpPort}`;
    WS_BASE = `ws://127.0.0.1:${httpPort}`;
    await part3Http();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
