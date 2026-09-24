/**
 * Automated Test Suite: ssrfSafeFetch's timeoutMs bounds the WHOLE call.
 *
 * The failure this pins down, from PR #1085's CI run 35927145011: the federation suite hit
 * TIMEOUT after 15m33s with `--- 9. Nudges Endpoint ---` as its last output. That step probes an
 * Instagram channel through ssrfSafeFetch with timeoutMs: 8000, so an 8-second limit had let a
 * 15-minute stall through. Measured against local servers, three phases escaped the timer:
 *
 *   - the SSRF DNS pre-flight, awaited entirely outside it — a resolver that never answers hung
 *     the call forever;
 *   - body streaming, where the timer did fire and abort the socket, but .pipe() does not forward
 *     errors, so the tail of the byte-limit chain never ended and the body read waited forever;
 *   - redirects, where each hop armed a fresh full timeoutMs, so 5 hops could legitimately spend
 *     6 x the budget.
 *
 * Only response-header arrival was ever covered.
 *
 * Covers:
 * 1. A server that accepts the connection and never answers fails by timeoutMs (already worked).
 * 2. A server that sends headers then trickles the body forever fails by timeoutMs.
 * 3. A DNS pre-flight that never returns fails by timeoutMs.
 * 4. A redirect chain cannot buy a fresh budget per hop; the whole call ends by timeoutMs.
 * 5. A fast, well-behaved response still succeeds, and a redirect chain inside the budget is
 *    still followed to the end.
 * 6. The timeout does not take the process down when the caller never reads the body.
 * 7. The test hook is inert unless BEANPOOL_SSRF_TEST_HOOK=1, and ssrfSafeFetch itself still
 *    refuses loopback, so nothing here has loosened the guard.
 *
 * No network: every target is a server this file starts on 127.0.0.1, reached through the
 * resolver test hook. Nothing here contacts Instagram or any other external host.
 *
 * Run: BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-ssrf-fetch-timeout.ts
 */

process.env.BEANPOOL_SSRF_TEST_HOOK = '1';

import http from 'node:http';
import net from 'node:net';
import {
    ssrfSafeFetch,
    __ssrfSafeFetchWithResolverForTests,
    RequestTimeoutError,
} from './engine/pulse-resolver.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const TIMEOUT = 1500;
// Generous enough that a slow CI box does not fail it, tight enough that a call which ignores the
// budget (the pre-fix behaviour hung indefinitely) cannot pass.
const CEILING = TIMEOUT * 4;

const toLoopback = async (_host: string) => ({ pinnedIp: '127.0.0.1', family: 4 });
const neverResolves = () => new Promise<never>(() => {});

interface Outcome { ms: number; error: Error | null; value: unknown }

/** Run fn, but never wait longer than capMs — a hang must fail the suite, not stall CI again. */
async function outcomeOf(fn: () => Promise<unknown>, capMs = CEILING * 3): Promise<Outcome> {
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
        const value = await Promise.race([
            fn(),
            new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error(`HUNG: still running after ${capMs}ms`)), capMs);
            }),
        ]);
        return { ms: Date.now() - t0, error: null, value };
    } catch (e: any) {
        return { ms: Date.now() - t0, error: e, value: undefined };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function timedOutInBudget(o: Outcome, label: string): void {
    const isTimeout = o.error instanceof RequestTimeoutError;
    assert(isTimeout && o.ms < CEILING,
        `${label} — gave up after ${o.ms}ms with ${o.error?.name ?? 'no error'} (budget ${TIMEOUT}ms)`);
}

function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port);
    }));
}

async function main(): Promise<void> {
    const servers: net.Server[] = [];
    const timers: NodeJS.Timeout[] = [];

    // ── 1. Headers never arrive ──────────────────────────────────────────────────────────────
    console.log('\n--- 1. Response headers never arrive ---');
    const silent = net.createServer((sock) => { sock.on('error', () => {}); });
    servers.push(silent);
    const silentPort = await listen(silent);
    timedOutInBudget(
        await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
            `http://probe.test:${silentPort}/`, { timeoutMs: TIMEOUT }, toLoopback)),
        'a server that accepts the connection and never answers');

    // ── 2. Body trickles forever ─────────────────────────────────────────────────────────────
    console.log('\n--- 2. The body never ends ---');
    const trickle = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html>');
        const t = setInterval(() => { try { res.write('.'); } catch { /* socket gone */ } }, 100);
        timers.push(t);
    });
    servers.push(trickle);
    const tricklePort = await listen(trickle);
    timedOutInBudget(
        await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
            `http://probe.test:${tricklePort}/`, { timeoutMs: TIMEOUT }, toLoopback).then(r => r.text())),
        'a body that trickles forever after the headers');

    // ── 3. The SSRF DNS pre-flight never returns ─────────────────────────────────────────────
    console.log('\n--- 3. The DNS pre-flight never returns ---');
    timedOutInBudget(
        await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
            'http://probe.test/', { timeoutMs: TIMEOUT }, neverResolves as any)),
        'a host resolution that never answers');

    // ── 4. Redirects share one budget ────────────────────────────────────────────────────────
    console.log('\n--- 4. Redirects spend one budget, not one each ---');
    let redirPort = 0;
    let hop = 0;
    const redirector = http.createServer((_req, res) => {
        hop++;
        const t = setTimeout(() => {
            if (hop <= 5) {
                res.writeHead(302, { Location: `http://probe.test:${redirPort}/hop${hop}` });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html>arrived</html>');
            }
        }, TIMEOUT * 0.8);
        timers.push(t);
    });
    servers.push(redirector);
    redirPort = await listen(redirector);
    const chained = await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
        `http://probe.test:${redirPort}/`, { timeoutMs: TIMEOUT }, toLoopback).then(r => r.text()));
    timedOutInBudget(chained, 'five redirect hops of 0.8 x the budget each');
    assert(chained.ms < TIMEOUT * 5,
        `and it did not spend a fresh timeout per hop — ${chained.ms}ms, not the ~${TIMEOUT * 5}ms of six full budgets`);

    // ── 5. A well-behaved response is unaffected ─────────────────────────────────────────────
    console.log('\n--- 5. A normal response still works ---');
    const body = '<html>' + 'x'.repeat(5000) + '</html>';
    const good = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(body);
    });
    servers.push(good);
    const goodPort = await listen(good);
    const ok = await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
        `http://probe.test:${goodPort}/`, { timeoutMs: TIMEOUT }, toLoopback).then(r => r.text()));
    assert(ok.error === null && ok.value === body, 'a fast response is returned whole and unchanged');
    assert(ok.ms < TIMEOUT, `and it returns well inside the budget (${ok.ms}ms)`);

    // A redirect chain that fits the budget must still be followed to the end.
    let shortHop = 0;
    let shortPort = 0;
    const shortChain = http.createServer((_req, res) => {
        shortHop++;
        if (shortHop <= 2) {
            res.writeHead(302, { Location: `http://probe.test:${shortPort}/h${shortHop}` });
            res.end();
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html>followed</html>');
        }
    });
    servers.push(shortChain);
    shortPort = await listen(shortChain);
    const followed = await outcomeOf(() => __ssrfSafeFetchWithResolverForTests(
        `http://probe.test:${shortPort}/`, { timeoutMs: TIMEOUT }, toLoopback).then(r => r.text()));
    assert(followed.error === null && followed.value === '<html>followed</html>',
        'a redirect chain that fits the budget is still followed to the end');

    // ── 6. An unread body cannot crash the process ───────────────────────────────────────────
    console.log('\n--- 6. An unread body that times out is not an unhandled error ---');
    const abandoned = await outcomeOf(async () => {
        const res = await __ssrfSafeFetchWithResolverForTests(
            `http://probe.test:${tricklePort}/`, { timeoutMs: TIMEOUT }, toLoopback);
        // Never read it. The deadline fires on a stream with no consumer; if that emitted an
        // unhandled 'error' the process would die here rather than reach the assertion below.
        await new Promise((r) => setTimeout(r, TIMEOUT * 2));
        return res.status;
    });
    assert(abandoned.error === null && abandoned.value === 200,
        'the deadline firing on a body nobody reads does not take the process down');

    // ── 7. The guard is exactly as strong as before ──────────────────────────────────────────
    console.log('\n--- 7. Nothing here loosened the guard ---');
    let blocked = '';
    try {
        await ssrfSafeFetch(`http://127.0.0.1:${goodPort}/`, { timeoutMs: TIMEOUT });
    } catch (e: any) { blocked = e?.message ?? ''; }
    assert(blocked.includes('SSRF_BLOCKED'),
        'ssrfSafeFetch still refuses 127.0.0.1 — the hook is not a hole in the real entry point');

    const saved = process.env.BEANPOOL_SSRF_TEST_HOOK;
    delete process.env.BEANPOOL_SSRF_TEST_HOOK;
    let hookRefused = '';
    try {
        await __ssrfSafeFetchWithResolverForTests(
            `http://probe.test:${goodPort}/`, { timeoutMs: TIMEOUT }, toLoopback);
    } catch (e: any) { hookRefused = e?.message ?? ''; }
    process.env.BEANPOOL_SSRF_TEST_HOOK = saved;
    assert(hookRefused.includes('SSRF_BLOCKED') && hookRefused.includes('test hook is disabled'),
        'and the test hook itself refuses to run without BEANPOOL_SSRF_TEST_HOOK=1');

    for (const t of timers) clearInterval(t as any);
    for (const s of servers) s.close();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
