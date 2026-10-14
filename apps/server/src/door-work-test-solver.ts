/**
 * Door work solved OFF the test's event loop, for suites that run the HTTPS server in their own process
 * (test-door-work, test-door-signal).
 *
 * WHY. A solve is CPU work with no await in it. Run on the suite's own thread it holds the server's event loop too, and
 * the server's keep-alive is 5 s (server-limits.ts). Hold the loop past that and the next `fetch` reuses a pooled
 * socket the server is closing at that moment: `fetch failed` / `read ECONNRESET`. CI run 36876951525 died exactly so
 * (test-door-work section 6: about 16 s of solves on CI's machine, 2 s on an M4), and on Node 22, CI's version, it
 * happens about half the time. Here every solve runs in one worker thread, so the loop stays free to answer and to
 * close idle sockets on time, and the client never picks one up mid-close.
 *
 * The worker runs plain JavaScript: @beanpool/core's built solver and node:crypto's SHA-256, the same digest the
 * server checks with (services/door-work.ts nodeSha256). It is unref'd: it never keeps a suite alive.
 *
 * `loopWatch()` measures how long the suite's loop was held, so a suite can assert that nothing held it near the
 * keep-alive.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
import(workerData.coreUrl).then(({ solveDoorWorkSync }) => {
    parentPort.on('message', ({ id, challenge }) => {
        const t0 = performance.now();
        try {
            const counters = solveDoorWorkSync(challenge, sha256);
            parentPort.postMessage({ id, counters, ms: performance.now() - t0 });
        } catch (e) {
            parentPort.postMessage({ id, error: String((e && e.message) || e) });
        }
    });
    parentPort.postMessage({ ready: true });
}, (e) => parentPort.postMessage({ failed: String((e && e.message) || e) }));
`;

interface Pending { resolve: (r: { counters: number[]; ms: number }) => void; reject: (e: Error) => void }

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function start(): Promise<void> {
    if (ready) return ready;
    const coreUrl = pathToFileURL(createRequire(import.meta.url).resolve('@beanpool/core')).href;
    // No execArgv: the worker needs no TypeScript loader, only the built package.
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { coreUrl }, execArgv: [] });
    worker = w;
    ready = new Promise<void>((resolve, reject) => {
        w.on('message', (m: any) => {
            if (m?.ready) { resolve(); return; }
            if (m?.failed) { reject(new Error(`door-work solver: ${m.failed}`)); return; }
            const p = pending.get(m?.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.error) p.reject(new Error(`door-work solver: ${m.error}`));
            else p.resolve({ counters: m.counters, ms: m.ms });
        });
        w.on('error', (e) => {
            reject(e);
            for (const p of pending.values()) p.reject(e);
            pending.clear();
        });
    });
    w.unref();
    return ready;
}

/** Solve a door-work challenge in the worker thread: the counters, and how long the solve itself took there. */
export async function solveOffLoopTimed(challenge: string): Promise<{ counters: number[]; ms: number }> {
    await start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, challenge });
    });
}

/** Solve a door-work challenge in the worker thread. */
export async function solveOffLoop(challenge: string): Promise<number[]> {
    return (await solveOffLoopTimed(challenge)).counters;
}

/**
 * Start measuring how long this thread's event loop is held: a 20 ms tick, and how late each one ran. `maxMs()` is the
 * longest hold since the start (or the last `reset()`), to about 20 ms. A hold shows once the loop runs again, so read
 * it after a turn of the loop. (perf_hooks' monitorEventLoopDelay misses a single long hold on Node 26: measured.)
 */
export function loopWatch(): { maxMs: () => number; reset: () => void; stop: () => void } {
    const TICK_MS = 20;
    let last = performance.now();
    let max = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last - TICK_MS);
        last = now;
    }, TICK_MS);
    timer.unref();
    return {
        maxMs: () => max,
        reset: () => { max = 0; },
        stop: () => clearInterval(timer),
    };
}
