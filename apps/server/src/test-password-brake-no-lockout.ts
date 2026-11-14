/**
 * The brake must not let a stranger lock the real owner out.
 *
 * #937's brake counted wrong passwords for the whole node: eleven from anyone closed password checking for everyone,
 * for up to ten minutes, and the right password got 429 too. Found live on test 2026-09-19. On a node with no key
 * owner yet the password was the only way in, so anyone on the internet could keep the owner out for good.
 *
 * password-brake.ts is now per source (IPv4 address, IPv6 /64) with a node-wide cap on checks from sources that
 * failed in the last day. The node has no admin password since 11 Nov 2026: what the brake guards now is an owner's
 * break-glass code on the two enrol routes (admin-auth.ts), so the HTTP parts guess there. This suite shows:
 *   - a flood of wrong guesses from A does not stop the right code from B;
 *   - A itself backs off exponentially, capped, and a code from A is still checked once every few seconds;
 *   - a flood spread over many sources is still capped node-wide, favouring sources with fewer failures, and a source
 *     with no failure on record is always checked;
 *   - fresh /64s inside one /48 do not each count as clean;
 *   - key sign-in is unaffected, and the code is read on the enrol routes only;
 *   - /ws/logs?auth= is no door at all (Fable's web review, L5): its query is never checked, so it opens nothing and
 *     costs the brake nothing;
 *   - the guesses an attacker gets per hour (the maths in docs/admin-surface.md §2.6), by simulation.
 *
 * The HTTP parts drive the real servers on the tunnel-origin port: the test client connects from loopback (a trusted
 * local proxy), so CF-Connecting-IP names the client, as cloudflared does.
 * They run on the brake's own clock, stopped (setPasswordBrakeClockForTests) and moved only by the test: on the real
 * clock a source's 2 s wait could run out between two requests on a slow runner (CI run 43516030134).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-password-brake-no-lockout.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, setNodeRoleBreakGlassHash } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { setTrustConfigForTests } from './client-ip.js';
import { generateBreakGlassCode, hashBreakGlassCode } from './admin-key-auth.js';
import { resetAdminAuthTarpit, BREAK_GLASS_WHILE_BRAKED_MS } from './admin-auth.js';
import {
    SOURCE_FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, FORGET_MS, NODE_CHECKS_PER_MIN, NODE_BACKOFF_CHECKS_PER_MIN, PREFIX_CLEAN_FAILURES,
    tryAdmit, settlePasswordAttempt, notePasswordFailure, prefixOf, resetPasswordBrake, setPasswordBrakeClockForTests,
} from './password-brake.js';
import { adminSigninFields } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
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
    return { pub, priv };
}

async function part3Http() {
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    // The owner whose break-glass code is the one secret the brake guards now (the node has no admin password).
    const owner = keyPair();
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, 'BrakeOwner2', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(owner.pub);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(owner.pub);
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    const CODE = generateBreakGlassCode();
    setNodeRoleBreakGlassHash(owner.pub, hashBreakGlassCode(CODE));
    let helpers = 0;
    /** A member for a code to enrol as an admin (each right code here enrols a new one). */
    const newHelper = () => {
        const h = keyPair();
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(h.pub, `BrakeHelper${++helpers}`);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(h.pub);
        return h.pub;
    };
    /** A value on the enrol route (POST /auth/enrol, X-Break-Glass-Code) from `ip`, enrolling `memberPubkey` as an admin. */
    const enrol = (value: string, ip: string, memberPubkey = newHelper(), route = '/api/local/admin/auth/enrol') =>
        req(route, { method: 'POST', body: { memberPubkey, role: 'admin' }, headers: { 'x-break-glass-code': value, ...viaTunnel(ip) } });
    /** A wrong value that is no code at all: checked against nothing, but counted, as any guess is. */
    const junk = (i: number | string) => `wrong-${i}`;
    /**
     * The brake's clock stands still through these parts and moves only here, to `ms` after the start. On the real clock
     * a source's first wait is BASE_DELAY_MS (2 s), the tarpit alone holds the sixth wrong value's answer for 1.5 s of it,
     * and the requests after it had the rest: a slow runner could outlast it, and then the brake rightly checked the
     * source again before the test looked. The tarpit itself still sleeps on the real clock.
     */
    const brakeStart = Date.now();
    let brakeAt = brakeStart;
    const moveBrakeClock = (ms: number) => { brakeAt = brakeStart + ms; };
    setPasswordBrakeClockForTests(() => brakeAt);

    console.log('\n— HTTP: a flood from A does not stop the right code from B —');
    // The brake, the tarpit and the held sources' code checks, all at once (resetAdminAuthTarpit resets the brake too).
    resetAdminAuthTarpit();
    const A = '203.0.113.66';
    {
        const s: number[] = [];
        for (let i = 0; i < 30; i++) s.push((await enrol(junk(i), A)).status);
        const checked = s.filter(x => x === 401).length;
        assert(checked === SOURCE_FREE_FAILURES + 1 && s.slice(checked).every(x => x === 429),
            `30 wrong values from A on the enrol route: ${SOURCE_FREE_FAILURES + 1} checked, then A is refused (${checked}×401, ${s.length - checked}×429)`);
        // A held source still has one code checked every BREAK_GLASS_WHILE_BRAKED_MS (an owner who lost their phone, beside
        // a guesser on the same network): a wrong one takes that check, and A then waits for the next, the right code too.
        const wrongCode = await enrol(generateBreakGlassCode(), A);
        const aRight = await enrol(CODE, A);
        assert(wrongCode.status === 429 && aRight.status === 429 && aRight.json?.passwordBackoff === true
            && Number(aRight.headers.get('retry-after')) === BREAK_GLASS_WHILE_BRAKED_MS / 1000,
            `A itself waits: a code from it is checked at most once in ${BREAK_GLASS_WHILE_BRAKED_MS / 1000} s, the right one too (got ${wrongCode.status}, ${aRight.status}, Retry-After ${aRight.headers.get('retry-after')})`);
        assert(/another network/.test(aRight.json?.error || ''), `and is told another network, or a key, still works ("${aRight.json?.error}")`);
        const b = await enrol(CODE, '198.51.100.7');
        assert(b.status === 200, `the right code from B gets in (got ${b.status}; #937 answered 429)`);
        const bOther = await enrol(CODE, '198.51.100.8', newHelper(), '/api/local/admin/auth/break-glass/enrol');
        assert(bOther.status === 200, `and on the other enrol route from another address (got ${bOther.status})`);

        // The held check only covers a source the brake holds. A's own wait after its sixth failure is BASE_DELAY_MS; until
        // then its next code still waits for the held check, and from then on the brake checks A itself, once. On the
        // real clock that wait ran out between the two codes above on a slow runner (CI run 43516030134: 429, then 200):
        // the brake's schedule, not a second held check.
        moveBrakeClock(BASE_DELAY_MS - 1);
        const stillHeld = await enrol(CODE, A);
        assert(stillHeld.status === 429 && Number(stillHeld.headers.get('retry-after')) === Math.ceil((BREAK_GLASS_WHILE_BRAKED_MS - BASE_DELAY_MS + 1) / 1000),
            `${(BASE_DELAY_MS - 1) / 1000} s on, inside A's own wait, its right code still waits for the held check (got ${stillHeld.status}, Retry-After ${stillHeld.headers.get('retry-after')})`);
        moveBrakeClock(BASE_DELAY_MS);
        const ownWaitOver = await enrol(CODE, A);
        assert(ownWaitOver.status === 200, `once A's own ${BASE_DELAY_MS / 1000} s wait is over the brake checks it, and the right code gets in (got ${ownWaitOver.status})`);
    }

    console.log('\n— HTTP: parallel guesses from one source —');
    resetAdminAuthTarpit();
    {
        const P = '203.0.113.67';
        const all = await Promise.all(Array.from({ length: 30 }, (_, i) => enrol(junk(`parallel-${i}`), P)));
        const n401 = all.filter(r => r.status === 401).length, n429 = all.filter(r => r.status === 429).length;
        assert(n401 === SOURCE_FREE_FAILURES + 1 && n429 === 30 - n401,
            `30 wrong values at once from one address: only ${SOURCE_FREE_FAILURES + 1} are checked (401: ${n401}, 429: ${n429})`);
    }

    console.log('\n— HTTP: a flood from many sources is capped node-wide —');
    resetAdminAuthTarpit();
    {
        const srcs = Array.from({ length: 40 }, (_, i) => `198.18.${i}.9`);
        const first = await Promise.all(srcs.map(ip => enrol(junk('spread'), ip)));
        assert(first.every(r => r.status === 401), `40 addresses, one wrong value each: all checked (${first.filter(r => r.status === 401).length}/40)`);
        const second = await Promise.all(srcs.map(ip => enrol(junk('spread-2'), ip)));
        const n401 = second.filter(r => r.status === 401).length;
        assert(n401 === NODE_CHECKS_PER_MIN && second.filter(r => r.status === 429).length === 40 - NODE_CHECKS_PER_MIN,
            `their second round: only ${NODE_CHECKS_PER_MIN} checked this minute, the rest 429 (checked ${n401})`);
        const ownerIn = await enrol(CODE, '192.0.2.10');
        assert(ownerIn.status === 200, `the owner's right code from a clean address still gets in (got ${ownerIn.status})`);
    }

    console.log('\n— key sign-in is unaffected, and the code is read on the enrol routes only —');
    resetAdminAuthTarpit();
    {
        // Close K for a few minutes (the steps below take longer than a 2 s wait).
        const K = '203.0.113.70';
        for (let i = 0; i < SOURCE_FREE_FAILURES + 8; i++) notePasswordFailure(K);
        const closed = await enrol(junk('closed'), K);
        assert(closed.status === 429, `K is closed (got ${closed.status})`);

        const chal = await req('/api/local/admin/auth/challenge', { method: 'POST', headers: viaTunnel(K) });
        const solved = await req('/api/local/admin/auth/verify-challenge', {
            method: 'POST', headers: viaTunnel(K), body: { challengeId: chal.json?.challengeId, memberPubkey: owner.pub, ...adminSigninFields(owner.priv, chal.json?.challengeId || '') },
        });
        const exchanged = await req('/api/local/admin/auth/exchange', { method: 'POST', headers: viaTunnel(K), body: { token: solved.json?.handshakeToken } });
        // The exchange answers the session in its httpOnly cookie only, never in the body (Fable's web review, L3).
        const exchangedId = (exchanged.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/)?.[1] || '';
        const session = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-session': exchangedId, ...viaTunnel(K) } });
        assert(chal.status === 200 && solved.status === 200 && exchanged.status === 200 && session.status === 200,
            `key sign-in from the braked address works: challenge ${chal.status}, signed ${solved.status}, session ${exchanged.status}, admin route ${session.status}`);

        // A break-glass code only enrols a key (docs/admin-surface.md §2.2). Until 2026-10-01 this checked it on
        // /diagnostics, where it opened an owner's session; there it is not read at all now: no credential, nothing braked.
        const bgElsewhere = await req('/api/local/admin/diagnostics', { headers: { 'x-break-glass-code': CODE, ...viaTunnel(K) } });
        assert(bgElsewhere.status === 401 && bgElsewhere.json?.notSignedIn === true,
            `the code from the braked address on any other route is not read: 401, no credential (got ${bgElsewhere.status})`);
        const bg = await enrol(CODE, K);
        assert(bg.status === 200, `a break-glass code from the braked address is still checked on the enrol route (got ${bg.status})`);
        const bgWrong = await enrol('not-the-code', K);
        assert(bgWrong.status === 429, `a wrong value from it gets the brake's 429 (got ${bgWrong.status})`);
    }

    // Until 2026-10-01 ?auth=<password> opened the socket with 2FA off, under this brake; that door is gone. These
    // asserted it was braked (429) and that the right password opened it (101). The node has no password now; the query
    // is never read, whatever it holds.
    console.log('\n— /ws/logs?auth= is no door: never checked, never braked —');
    resetAdminAuthTarpit();
    {
        const W = '203.0.113.80';
        const logs = (value: string, ip: string) => upgradeStatus(`${WS_BASE}/ws/logs?auth=${encodeURIComponent(value)}`, viaTunnel(ip));
        const s: number[] = [];
        for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) s.push(await logs('ws-wrong-' + i, W));
        assert(s.every(x => x === 401), `${SOURCE_FREE_FAILURES + 1} wrong ?auth= from W are refused (${s.join(',')})`);
        const wRight = await logs(CODE, W);
        assert(wRight === 401, `the owner's right code in the query is refused too: the socket takes a ticket only (got ${wRight})`);
        const x = await logs(CODE, '198.51.100.81');
        assert(x === 401, `from any address (got ${x})`);
        const viaHttp = await enrol(CODE, W);
        assert(viaHttp.status === 200, `and none of them was a check: W's brake is untouched, its right code enrols on the enrol route (got ${viaHttp.status})`);
    }
    resetPasswordBrake();
    resetAdminAuthTarpit();
    setPasswordBrakeClockForTests(null);
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
}

async function main() {
    console.log('Running password-brake no-lockout tests...\n');
    part1Unit();
    part2Maths();
    await initTls();
    initStateEngine();
    setTrustConfigForTests(undefined);
    // Bind once and read the port back (two probes in a row could be handed the same port).
    const httpPort = await startHttpServer(0);
    const httpsPort = await startHttpsServer(0);
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
