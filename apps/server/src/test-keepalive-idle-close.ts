/**
 * A kept-alive connection's idle close never resets a request that has already reached the server (server-limits.ts
 * closeIdleWithoutReset), on both listeners: the HTTPS one, and the plain HTTP one the Cloudflare tunnel reaches.
 *
 * Why: server suites on CI failed with "TypeError: fetch failed" / read ECONNRESET from their own call() helper, in suites
 * a PR never touched, and passed on a re-run (test-group-guests-home 15 Nov; test-address-spelling and test-bills-invite
 * in the same minute 16 Nov; test-invite-adds-voucher on main 16 Nov, run 43929263354). Node closes a connection idle for
 * its keep-alive from a timer, and the event loop runs timers BEFORE it reads the sockets: when the loop was held across
 * that moment, a request that arrived meanwhile was still unread, Node destroyed the socket, and the kernel answered the
 * request with a reset. A suite holds its own loop (its server runs in its process) for its synchronous stretches; a live
 * node holds it for another request's synchronous work, and a phone's request that reaches it then is reset the same way.
 *
 * The table, each row on each listener, at the real limits (keep-alive 5 s):
 *   A. fetch, the loop held well inside the keep-alive: answered (the control).
 *   B. fetch, the loop held past the close, as a suite's synchronous stretch on CI holds it: answered on the same socket.
 *      Before: ECONNRESET with Node 22's fetch (CI's and the node image's Node); Node 26's fetch opens a new socket instead,
 *      so there the row is only reported, and C carries the server's side.
 *   C. a client in another process that keeps its socket past the server's Keep-Alive hint, as a phone, a browser or
 *      cloudflared does, whose request reaches the server while its loop is busy across the close: answered on the same
 *      socket. Before: ECONNRESET on Node 22 and on Node 26.
 *   D. a connection that stays idle is still closed by the server, no sooner than its keep-alive and soon after it (DoS
 *      review F3: no idle socket is held longer than before).
 *
 * The loop is held with Atomics.wait: it stops the loop and burns no CPU.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import http from 'node:http';
import https from 'node:https';
import dc from 'node:diagnostics_channel';
import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startHttpServer } from './http-server.js';
import { DEFAULT_SERVER_LIMITS } from './server-limits.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const KA = DEFAULT_SERVER_LIMITS.keepAliveTimeoutMs;
const PATH = '/api/version';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Holds this process's event loop (the server's and the client's) for `ms`, burning no CPU. */
const hold = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Node 22's fetch (undici 6) reuses a socket its loop was held over; undici 7 and later open a new one (measured). */
const FETCH_REUSES_HELD_SOCKET = Number(process.versions.undici?.split('.')[0]) < 7;

let fetchConnects = 0;
dc.subscribe('undici:client:connected', () => { fetchConnects++; });

interface Outcome { status: number | null; err: string | null; reused: boolean | null; ms?: number }
const show = (o: Outcome) => (o.err ? `${o.err}${o.reused === null ? '' : `, reused ${o.reused}`}` : `${o.status}${o.reused === null ? '' : `, reused ${o.reused}`}`);

/** A, B: fetch from this process, its loop held `holdMs` after an answer. */
async function fetchAfterHold(base: string, holdMs: number): Promise<Outcome> {
    await (await fetch(`${base}${PATH}`)).text();
    await sleep(20); // a turn: fetch frees the socket for the next call, as a suite's own awaits let it
    const before = fetchConnects;
    hold(holdMs);
    try {
        const res = await fetch(`${base}${PATH}`);
        const text = await res.text();
        return { status: res.status, err: res.status === 200 ? null : `${res.status} ${text.slice(0, 160)}`, reused: fetchConnects === before };
    } catch (e: any) {
        return { status: null, err: `${e.message} (${e.cause?.code ?? e.cause?.message ?? '?'})`, reused: fetchConnects === before };
    }
}

/**
 * C: a client in its own process, with a keep-alive agent (it keeps the socket and never reads the Keep-Alive hint):
 * an answer, then KA - 500 ms idle, then its next request on the same socket. KA - 1000 ms after its answer it tells
 * this process, which holds its loop 2,500 ms from there, as another request's synchronous work would: across the
 * close (Node's timer is due about KA + 1000 ms after the answer), with the client's request arriving inside it. The
 * hold runs in the message's callback, an I/O callback as a request's work is; held inside a timer's callback instead,
 * the loop's clock would still read the start of the hold and the close would wait for the next turn.
 */
const CLIENT = `
const mod = await import(process.env.KA_SCHEME === 'https' ? 'node:https' : 'node:http');
const agent = new mod.Agent({ keepAlive: true });
const call = () => new Promise((resolve) => {
    const req = mod.request(process.env.KA_URL, { agent, rejectUnauthorized: false }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, err: null, reused: req.reusedSocket }));
    });
    req.on('error', (e) => resolve({ status: null, err: e.code || e.message, reused: req.reusedSocket }));
    req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call();
await sleep(Number(process.env.KA_IDLE) - 500);
process.send('busy now');
await sleep(500);
process.send(await call());
process.disconnect();
`;
async function keptSocketDuringBusyServer(url: string): Promise<Outcome> {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CLIENT], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, NODE_NO_WARNINGS: '1', KA_URL: url, KA_SCHEME: url.startsWith('https') ? 'https' : 'http', KA_IDLE: String(KA - 500) },
    });
    return new Promise<Outcome>((resolve, reject) => {
        const giveUp = setTimeout(() => { child.kill(); reject(new Error('the client never answered')); }, KA + 20_000);
        child.on('message', (m: any) => {
            if (m === 'busy now') { hold(2_500); return; }
            clearTimeout(giveUp);
            resolve(m as Outcome);
        });
        child.on('error', reject);
    });
}

/** D: one answer on a keep-alive agent's socket, then nothing: how long until the server closes it. */
async function idleCloseAfter(mod: typeof http | typeof https, url: string): Promise<Outcome> {
    const agent = new mod.Agent({ keepAlive: true });
    let socket: Socket | null = null;
    const status = await new Promise<number | null>((resolve) => {
        const req = mod.request(url, { agent, rejectUnauthorized: false } as https.RequestOptions, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? null));
        });
        req.on('socket', (s) => { socket = s as Socket; });
        req.on('error', () => resolve(null));
        req.end();
    });
    const answeredAt = performance.now();
    const closedAt = await new Promise<number | null>((resolve) => {
        const giveUp = setTimeout(() => resolve(null), KA + 8_000);
        socket!.once('close', () => { clearTimeout(giveUp); resolve(performance.now()); });
    });
    agent.destroy();
    return { status, err: closedAt === null ? 'still open' : null, reused: null, ms: closedAt === null ? undefined : Math.round(closedAt - answeredAt) };
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const httpPort = await startHttpServer(0);
    const httpsPort = await startHttpsServer(0);
    console.log(`Node ${process.version}, fetch is undici ${process.versions.undici}; the listeners' keep-alive is ${KA} ms`);

    const listeners = [
        { name: 'HTTPS', mod: https, base: `https://localhost:${httpsPort}` },
        { name: 'plain HTTP (the tunnel origin)', mod: http, base: `http://127.0.0.1:${httpPort}` },
    ] as const;
    for (const l of listeners) {
        console.log(`\n── ${l.name} ──`);
        const a = await fetchAfterHold(l.base, KA / 10);
        assert(a.status === 200 && fetchConnects > 0, `${l.name} A. fetch, the loop held ${KA / 10} ms: answered (${show(a)}; ${fetchConnects} fetch connections seen)`);

        const b = await fetchAfterHold(l.base, KA + 2_000);
        if (FETCH_REUSES_HELD_SOCKET) {
            assert(b.status === 200 && b.reused === true, `${l.name} B. fetch, the loop held ${KA + 2_000} ms, past the close: answered on the same socket (${show(b)})`);
        } else {
            assert(b.status === 200, `${l.name} B. fetch, the loop held ${KA + 2_000} ms: answered (${show(b)}; this fetch, undici ${process.versions.undici}, ${b.reused ? 'reused' : 'opened a new socket instead of'} the held one)`);
        }

        const c = await keptSocketDuringBusyServer(`${l.base}${PATH}`);
        assert(c.status === 200 && c.reused === true,
            `${l.name} C. a client in another process keeping its socket, its request reaching the server while its loop is busy across the close: answered on the same socket (${show(c)})`);

        const d = await idleCloseAfter(l.mod, `${l.base}${PATH}`);
        assert(d.status === 200 && d.ms !== undefined && d.ms >= KA - 100 && d.ms <= KA + 4_000,
            `${l.name} D. a connection left idle is closed by the server between ${KA - 100} and ${KA + 4_000} ms after its answer (${d.err ?? `${d.ms} ms`})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
