/**
 * A synchronous HTTP request, for the one place that needs one: the S3 image store's synchronous methods.
 *
 * ## Why this exists
 *
 * {@link ImageStore} is synchronous (image-store.ts, "Synchronous, on purpose"): `put` is reached from code
 * that runs around better-sqlite3 transactions, where an `await` would commit at the first suspension point.
 * Until the async port lands (storage design §2) a network-backed store has to answer those calls
 * synchronously too. Node has no synchronous `fetch`, so this is the standard way to build one: a single
 * worker thread performs the request with the ordinary async `fetch`, and the calling thread blocks on
 * `Atomics.wait` until the worker says it has answered, then takes the answer off a `MessagePort` with
 * `receiveMessageOnPort` — no event-loop turn needed.
 *
 * ## What it costs, and how that is bounded
 *
 * The calling thread is the node's only event loop, so for the length of a request the node serves nothing.
 * That is acceptable for the paths that use it — creating or editing a post (up to five photos), sending an
 * attachment, a post-commit delete — and it is why every path that CAN await (serving a photo, the sync
 * export, backups, restore) uses the store's async methods instead and never comes through here.
 *
 * It is bounded twice: the worker aborts its `fetch` at the request's own timeout, and the caller stops
 * waiting at `budgetMs` whatever the worker is doing. The host watchdog (ops/watchdog) restarts a node that
 * has not answered for ~60 s; the S3 store keeps its whole synchronous budget, retries included, far below
 * that, and stops calling here at all for a while after the bucket fails (its circuit breaker).
 *
 * ## What crosses the thread boundary
 *
 * A URL, headers that are already signed, and the body. Never a secret: SigV4 signing happens on the calling
 * thread (s3-sigv4.ts), so the worker only ever holds a signature.
 *
 * The worker's source is a plain-JavaScript string run with `eval: true`, so the same code runs under `tsx`
 * (tests, `pnpm start`) and from `dist/` (production, `node dist/index.js`) with no loader involved.
 */

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

export interface BlockingRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    /** The worker aborts the request after this long. */
    timeoutMs: number;
    /** The most response body bytes accepted; a longer body is an error, not a truncation. */
    maxBytes: number;
}

export interface BlockingResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

/**
 * The request produced no answer to return. `network` and `timeout` are the bucket not answering (DNS, refused
 * connection, TLS, reset, the clock); `too-large` is an answer bigger than the caller agreed to hold.
 */
export class BlockingFetchError extends Error {
    constructor(message: string, readonly kind: 'network' | 'timeout' | 'too-large') {
        super(message);
        this.name = 'BlockingFetchError';
    }
    get timedOut(): boolean { return this.kind === 'timeout'; }
}

const WORKER_SOURCE = `
'use strict';
const { workerData } = require('node:worker_threads');
const { port, signal } = workerData;
function done(msg, transfer) {
    try { port.postMessage(msg, transfer || []); }
    catch (e) { port.postMessage({ id: msg.id, ok: false, kind: 'network', error: 'could not return the answer: ' + (e && e.message) }); }
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
}
port.on('message', async (req) => {
    try {
        const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body ? Buffer.from(req.body) : undefined,
            signal: AbortSignal.timeout(req.timeoutMs),
            redirect: 'manual',
        });
        // A HEAD's content-length is the object's size, not a body that is coming.
        const declared = req.method === 'HEAD' ? NaN : Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > req.maxBytes) {
            try { await res.body?.cancel(); } catch {}
            done({ id: req.id, ok: false, kind: 'too-large', error: 'response body of ' + declared + ' bytes is over the ' + req.maxBytes + '-byte limit' });
            return;
        }
        const chunks = [];
        let total = 0;
        if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
                const { value, done: finished } = await reader.read();
                if (finished) break;
                total += value.byteLength;
                if (total > req.maxBytes) {
                    try { await reader.cancel(); } catch {}
                    done({ id: req.id, ok: false, kind: 'too-large', error: 'response body is over the ' + req.maxBytes + '-byte limit' });
                    return;
                }
                chunks.push(value);
            }
        }
        const body = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) { body.set(c, at); at += c.byteLength; }
        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        done({ id: req.id, ok: true, status: res.status, headers, body: body.buffer }, [body.buffer]);
    } catch (e) {
        const timedOut = !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        const cause = e && e.cause && (e.cause.code || e.cause.message);
        done({ id: req.id, ok: false, kind: timedOut ? 'timeout' : 'network', error: String((e && e.message) || e) + (cause ? ' (' + cause + ')' : '') });
    }
});
`;

/**
 * One worker, created on first use, re-created if it dies. `unref`'d, so it never holds the process open.
 */
export class BlockingFetcher {
    private worker: Worker | null = null;
    private port: MessagePort | null = null;
    private signal: Int32Array | null = null;
    private nextId = 1;

    private ensure(): { port: MessagePort; signal: Int32Array } {
        if (this.worker && this.port && this.signal) return { port: this.port, signal: this.signal };
        const { port1, port2 } = new MessageChannel();
        const signal = new Int32Array(new SharedArrayBuffer(4));
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { port: port2, signal },
            transferList: [port2],
            // Nothing the node's environment holds is the worker's business: it gets a signed request and nothing else.
            env: {},
            // Small: it holds one request at a time, and the node runs on 1 GB hosts.
            resourceLimits: { maxOldGenerationSizeMb: 64 },
        });
        worker.unref();
        port1.unref();
        const forget = () => {
            if (this.worker === worker) { this.worker = null; this.port = null; this.signal = null; }
        };
        worker.on('error', (e) => { console.warn('[ImageStore] The S3 request worker failed; starting a new one on the next request:', e?.message || e); forget(); });
        worker.on('exit', forget);
        this.worker = worker;
        this.port = port1;
        this.signal = signal;
        return { port: port1, signal };
    }

    /**
     * Perform `req` and block until it answers or `budgetMs` passes. Throws {@link BlockingFetchError} when
     * there is no HTTP answer to return; any status, 5xx included, is an answer.
     */
    request(req: BlockingRequest, budgetMs: number): BlockingResponse {
        const { port, signal } = this.ensure();
        const id = this.nextId++;
        let seen = Atomics.load(signal, 0);
        // A fresh copy: the caller keeps its Buffer, and a pooled Buffer's backing store is not ours to send.
        const body = req.body ? new Uint8Array(req.body) : undefined;
        port.postMessage({
            id, url: req.url, method: req.method, headers: req.headers, body,
            timeoutMs: req.timeoutMs, maxBytes: req.maxBytes,
        });
        const deadline = Date.now() + budgetMs;
        for (;;) {
            // Drain first. An answer to an earlier request that gave up waiting can arrive now; it is dropped.
            let m: { message: any } | undefined;
            while ((m = receiveMessageOnPort(port))) {
                const msg = m.message;
                if (!msg || msg.id !== id) continue;
                if (!msg.ok) throw new BlockingFetchError(String(msg.error || 'request failed'), msg.kind === 'timeout' || msg.kind === 'too-large' ? msg.kind : 'network');
                return { status: msg.status, headers: msg.headers || {}, body: Buffer.from(msg.body) };
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                throw new BlockingFetchError(`no answer within ${budgetMs} ms`, 'timeout');
            }
            // Returns at once if the worker has answered anything since `seen` was read, so nothing is missed
            // between the drain above and this wait.
            Atomics.wait(signal, 0, seen, left);
            seen = Atomics.load(signal, 0);
        }
    }

    /** Stop the worker. The next request starts a new one. */
    async close(): Promise<void> {
        const w = this.worker;
        this.worker = null; this.port = null; this.signal = null;
        if (w) await w.terminate();
    }
}

/** Block the calling thread for `ms`, without spinning. Used between retries on the synchronous path. */
export function sleepSync(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
