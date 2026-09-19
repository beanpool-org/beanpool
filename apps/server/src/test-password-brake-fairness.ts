/**
 * The admin-password brake (#944), three follow-ups from Fable's review:
 *
 *   1. An attacker with one IPv6 /48 who rotates fresh /64s (six guesses each) took every freed check in the
 *      "few failures" tier, so an owner who had mistyped once was never checked again from that network: 0 of 1078
 *      retries over 6 h. A source with at most TYPO_FAILURES failures outside a dirty prefix now has the next free
 *      check held for it, so it is checked on its first retry after one frees (a minute at most).
 *   2. Behind a reverse proxy the node does not trust, every member is one source, and #944's hour-long wait fell on
 *      everyone. client-ip.ts now notices such a proxy (forwarding headers from an untrusted peer), and its wait is
 *      capped at SHARED_SOURCE_MAX_DELAY_MS (ten minutes, as before #944), with a log line naming TRUSTED_PROXIES.
 *   3. With the source map full, every new source rescanned all 100,000. Adding one is now O(1) on average, and the
 *      prefix map is bounded too.
 *
 * All on an injected clock, like test-password-brake-no-lockout.ts (which must still pass unchanged).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-password-brake-fairness.ts
 */
import { resolveClientIp, limiterKeyForIp, isSharedSourceKey, resetUntrustedForwardersForTests, setTrustConfigForTests } from './client-ip.js';
import {
    SOURCE_FREE_FAILURES, MAX_DELAY_MS, FORGET_MS, NODE_CHECKS_PER_MIN, TYPO_FAILURES, PENDING_HOLD_MS,
    SHARED_SOURCE_MAX_DELAY_MS, MAX_SOURCES, MAX_PREFIXES,
    tryAdmit, settlePasswordAttempt, notePasswordFailure, resetPasswordBrake, passwordBrakeSizes,
} from './password-brake.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const T0 = 1_000_000_000_000;

/**
 * Fable's attack: one /48, fresh /64s, each guessing until the brake closes it (six guesses), polling every
 * second. Runs until `until`; `onTick` is called every second after the attacker has had its go, and returns
 * true to stop.
 */
function attack48(from: number, until: number, onTick: (t: number) => boolean): number {
    let next = 0;
    const fresh = () => `2001:db8:66:${(next++).toString(16)}::/64`;
    let live = Array.from({ length: 50 }, fresh);
    for (let t = from; t < until; t += 1000) {
        live = live.map(k => {
            const a = tryAdmit(k, t);
            if (a === 'wait') return k;
            if (a.admitted) { settlePasswordAttempt(k, false, true, t); return k; }
            return a.reason === 'source' ? fresh() : k; // braked: move on to a fresh /64
        });
        if (onTick(t)) return t;
    }
    return -1;
}

function part1Fairness() {
    console.log('— an attacker rotating /64s in one /48 cannot shut out an owner who mistyped —');
    for (const typos of [1, TYPO_FAILURES]) {
        resetPasswordBrake();
        const owner = '192.0.2.44';
        const attackStart = T0, ownerStart = T0 + 10 * 60_000;
        let ownerNext = ownerStart, mistakes = 0, firstRightTry = 0, retries = 0;
        const admittedAt = attack48(attackStart, attackStart + 6 * 3_600_000, t => {
            if (t < ownerNext) return false;
            const a = tryAdmit(owner, t);
            if (a === 'wait') return false;
            if (mistakes < typos) {
                // The mistypes: the first is from a clean source (always checked), a second waits its turn too.
                if (a.admitted) { settlePasswordAttempt(owner, false, true, t); mistakes++; if (mistakes === typos) firstRightTry = t + 1000; ownerNext = t + 1000; }
                else ownerNext = t + a.retryAfter * 1000;
                return false;
            }
            if (a.admitted) { settlePasswordAttempt(owner, true, true, t); return true; }
            retries++;
            ownerNext = t + a.retryAfter * 1000; // an owner (or the dashboard) that honours Retry-After
            return false;
        });
        const waited = admittedAt < 0 ? Infinity : (admittedAt - firstRightTry) / 1000;
        console.log(`  ${typos} mistype(s): the right password got in after ${waited} s and ${retries} refusal(s)`);
        assert(admittedAt > 0 && waited <= 61,
            `an owner who mistyped ${typos}× during the /48 attack gets in within a minute of trying the right password, honouring Retry-After (${waited} s; before this fix: never, over 6 h)`);
    }

    resetPasswordBrake();
    {
        // A person rather than a client: comes back when they get round to it, but within PENDING_HOLD_MS.
        const owner = '192.0.2.45';
        let phase = 0, lateAt = 0, result = '';
        attack48(T0, T0 + 3_600_000, t => {
            if (phase === 0 && t >= T0 + 10 * 60_000) {
                const a = tryAdmit(owner, t);
                if (a !== 'wait' && a.admitted) { settlePasswordAttempt(owner, false, true, t); phase = 1; }
                return false;
            }
            if (phase === 1) {
                const a = tryAdmit(owner, t);
                if (a === 'wait') return false;
                if (a.admitted) { result = 'admitted at once'; return true; }
                phase = 2; lateAt = t + PENDING_HOLD_MS - 10_000;
                return false;
            }
            if (phase === 2 && t >= lateAt) {
                const a = tryAdmit(owner, t);
                result = a !== 'wait' && a.admitted ? 'admitted' : 'refused';
                if (a !== 'wait' && a.admitted) settlePasswordAttempt(owner, true, true, t);
                return true;
            }
            return false;
        });
        assert(result === 'admitted', `an owner refused once who comes back ${(PENDING_HOLD_MS - 10_000) / 1000} s later (ignoring Retry-After) finds a check held for them (${result})`);
    }

    resetPasswordBrake();
    {
        // The hold is only for low-failure sources outside dirty prefixes: an attacker's fresh /64s in its dirty /48
        // never get one, and its backed-off sources are held to their own smaller share as before.
        let t = T0;
        for (let i = 0; i < 40; i++) notePasswordFailure(`2001:db8:66:${i.toString(16)}::/64`, t);
        const inDirty = '2001:db8:66:ffff::/64';
        notePasswordFailure(inDirty, t);
        t += 61_000;
        // The attacker fills the minute's allowance, one check a millisecond, so they free one at a time.
        for (let i = 0; i < NODE_CHECKS_PER_MIN; i++) {
            const k = `2001:db8:66:${(0x1000 + i).toString(16)}::/64`;
            const a = tryAdmit(k, t + i);
            if (a !== 'wait' && a.admitted) settlePasswordAttempt(k, false, true, t + i);
        }
        const full = t + NODE_CHECKS_PER_MIN;
        tryAdmit(inDirty, full); // refused, and with a dirty prefix it holds nothing
        assert(passwordBrakeSizes().pending === 0, 'a source in a dirty prefix is never held for, even with one failure');
        const typo = '192.0.2.46';
        notePasswordFailure(typo, T0);
        tryAdmit(typo, full);
        assert(passwordBrakeSizes().pending === 1, 'a refused once-mistyped source outside it is');
        const oneFree = t + 60_000; // the attacker's first check has left the minute
        const attacker = tryAdmit('2001:db8:66:2000::/64', oneFree);
        assert(attacker !== 'wait' && !attacker.admitted && attacker.reason === 'node' && attacker.retryAfter <= 60,
            `when one check frees, the attacker's next /64 is refused: it is held for the waiting owner (retry in ${attacker !== 'wait' && !attacker.admitted ? attacker.retryAfter : '?'} s)`);
        const o = tryAdmit(typo, oneFree);
        assert(o !== 'wait' && o.admitted, 'and the owner takes it');
        if (o !== 'wait' && o.admitted) settlePasswordAttempt(typo, true, true, oneFree);
        assert(passwordBrakeSizes().pending === 0, 'the claim is spent');
        const unheld = tryAdmit('2001:db8:66:2001::/64', oneFree + 1);
        assert(unheld !== 'wait' && unheld.admitted, 'with nobody waiting, the next free check goes to whoever asks, as before');
    }

    resetPasswordBrake();
    {
        // A claim nobody comes back for lapses, and holds nothing after.
        const typo = '192.0.2.47';
        let t = T0;
        for (let i = 0; i < NODE_CHECKS_PER_MIN; i++) { notePasswordFailure(`198.18.${i}.1`, t); }
        notePasswordFailure(typo, t);
        for (let i = 0; i < NODE_CHECKS_PER_MIN; i++) { const k = `198.18.${i}.1`; const a = tryAdmit(k, t); if (a !== 'wait' && a.admitted) settlePasswordAttempt(k, false, true, t); }
        tryAdmit(typo, t);
        assert(passwordBrakeSizes().pending === 1, 'a refused once-mistyped source holds a claim');
        t += PENDING_HOLD_MS + 1;
        // Eleven checks in use, and a source of the 'few' rank (three failures) asks for the twelfth.
        const few = (i: number) => `2001:db8:55:${i}::/64`;
        for (let i = 0; i < NODE_CHECKS_PER_MIN; i++) for (let j = 0; j <= TYPO_FAILURES; j++) notePasswordFailure(few(i), T0);
        for (let i = 0; i < NODE_CHECKS_PER_MIN - 1; i++) { const a = tryAdmit(few(i), t); if (a !== 'wait' && a.admitted) settlePasswordAttempt(few(i), false, true, t); }
        const a = tryAdmit(few(NODE_CHECKS_PER_MIN - 1), t);
        assert(a !== 'wait' && a.admitted && passwordBrakeSizes().pending === 0, `after ${PENDING_HOLD_MS / 60_000} min unclaimed, the claim lapses and holds nothing`);
    }
}

function part2SharedSource() {
    console.log('\n— one source for everyone (a proxy the node does not trust) waits at most ten minutes —');
    resetPasswordBrake();
    resetUntrustedForwardersForTests();
    setTrustConfigForTests({ loopback: true, localSubnets: false, cloudflare: true, extra: [] });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
        const proxy = '198.51.100.9';
        const ip = resolveClientIp(proxy, { 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '203.0.113.5' });
        const key = limiterKeyForIp(ip);
        assert(ip === proxy, `an untrusted proxy's X-Forwarded-For is still not believed (${ip})`);
        assert(isSharedSourceKey(key), 'but the node notes that this one address stands for others');
        assert(warnings.some(w => w.includes('TRUSTED_PROXIES') && w.includes(proxy)), 'and says so once in the log, naming TRUSTED_PROXIES');
        resolveClientIp(proxy, { 'x-forwarded-for': '203.0.113.6' });
        assert(warnings.filter(w => w.includes('TRUSTED_PROXIES')).length === 1, 'only once, not per request');

        const plain = '198.51.100.10';
        resolveClientIp(plain, {});
        assert(!isSharedSourceKey(limiterKeyForIp(plain)), 'an address that sends no forwarding headers is not a shared source');
        resolveClientIp('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' });
        assert(!isSharedSourceKey('127.0.0.1'), 'nor is a trusted proxy (its headers are believed)');

        let t = T0, longest = 0, checked = 0;
        for (let i = 0; i < 60; i++) {
            const a = tryAdmit(key, t);
            if (a === 'wait') break;
            if (a.admitted) { settlePasswordAttempt(key, false, true, t); checked++; t += 1; continue; }
            longest = Math.max(longest, a.retryAfter);
            t += Math.max(a.retryAfter * 1000, 60_000);
        }
        assert(checked > SOURCE_FREE_FAILURES + 20 && longest === SHARED_SOURCE_MAX_DELAY_MS / 1000,
            `60 attempts from behind it: the longest wait is ${longest} s, capped at ${SHARED_SOURCE_MAX_DELAY_MS / 1000} s (#944: ${MAX_DELAY_MS / 1000} s; before #944: 600 s)`);

        const lone = '203.0.113.200';
        t = T0;
        let loneLongest = 0;
        for (let i = 0; i < 40; i++) {
            const a = tryAdmit(lone, t);
            if (a === 'wait') break;
            if (a.admitted) { settlePasswordAttempt(lone, false, true, t); t += 1; continue; }
            loneLongest = Math.max(loneLongest, a.retryAfter);
            t += Math.max(a.retryAfter * 1000, 60_000);
        }
        assert(loneLongest === MAX_DELAY_MS / 1000, `an ordinary single address still backs off to ${MAX_DELAY_MS / 60_000} min (${loneLongest} s)`);
    } finally {
        console.warn = warn;
        setTrustConfigForTests(undefined);
        resetUntrustedForwardersForTests();
        resetPasswordBrake();
    }
}

function part3Scale() {
    console.log('\n— 100k+ sources: adding one stays cheap, and the prefixes stay bounded —');
    resetPasswordBrake();
    // Every source in its own /48, so the prefix map fills as fast as the source map.
    const key = (i: number) => `2001:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}:1::/64`;
    const add = (from: number, to: number, t: number) => {
        const start = performance.now();
        for (let i = from; i < to; i++) notePasswordFailure(key(i), t);
        return performance.now() - start;
    };
    const batch = 50_000;
    const beforeFull = add(0, batch, T0);
    add(batch, MAX_SOURCES, T0);
    const sizesFull = passwordBrakeSizes();
    const whenFull = add(MAX_SOURCES, MAX_SOURCES + batch, T0 + 1);
    const again = add(MAX_SOURCES + batch, MAX_SOURCES + 3 * batch, T0 + 2);
    const sizes = passwordBrakeSizes();
    console.log(`  ${batch} sources: ${beforeFull.toFixed(0)} ms with room, ${whenFull.toFixed(0)} ms with the map full; ${2 * batch} more: ${again.toFixed(0)} ms`);
    assert(sizesFull.sources === MAX_SOURCES && sizes.sources === MAX_SOURCES, `the source map holds at most ${MAX_SOURCES} (${sizes.sources})`);
    assert(sizes.prefixes <= MAX_PREFIXES, `and the prefix map at most ${MAX_PREFIXES}, after ${MAX_SOURCES + 3 * batch} prefixes (${sizes.prefixes})`);
    assert(whenFull < Math.max(5 * beforeFull, 500) && again < Math.max(10 * beforeFull, 1000),
        `adding a source to a full map costs about what it did with room (${(whenFull * 1000 / batch).toFixed(1)} µs vs ${(beforeFull * 1000 / batch).toFixed(1)} µs each; #944 rescanned all ${MAX_SOURCES})`);

    // The stalest failure goes first; one that keeps failing is remembered.
    resetPasswordBrake();
    const A = '203.0.113.9';
    for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) notePasswordFailure(A, T0);
    for (let i = 0; i < MAX_SOURCES - 1; i++) notePasswordFailure(key(i), T0 + 1);
    notePasswordFailure(A, T0 + 2); // A fails again: now the newest
    for (let i = MAX_SOURCES; i < MAX_SOURCES + 1000; i++) notePasswordFailure(key(i), T0 + 3);
    const a = tryAdmit(A, T0 + 4);
    assert(a !== 'wait' && !a.admitted && a.reason === 'source', 'a source that is still failing is not dropped to make room: it stays braked');
    const dropped = tryAdmit(key(0), T0 + 4);
    assert(dropped !== 'wait' && dropped.admitted, 'the one that failed longest ago is dropped first');
    if (dropped !== 'wait' && dropped.admitted) settlePasswordAttempt(key(0), true, true, T0 + 4);

    // Expired prefix windows leave as new ones arrive, not only when the source map is full.
    resetPasswordBrake();
    for (let i = 0; i < 20_000; i++) notePasswordFailure(key(i), T0);
    const day = T0 + FORGET_MS + 1;
    notePasswordFailure('198.51.100.77', day);
    assert(passwordBrakeSizes().prefixes === 1, `a day later, the next failure clears the 20,000 expired prefixes (${passwordBrakeSizes().prefixes} left)`);
    resetPasswordBrake();
}

function main() {
    part1Fairness();
    part2SharedSource();
    part3Scale();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
