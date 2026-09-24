/**
 * An S3-compatible endpoint for tests: PUT / GET / HEAD / DELETE an object, HEAD a bucket, ListObjectsV2 —
 * path-style, in memory, and on loopback only. No real bucket is ever contacted by a suite.
 *
 * ## Why a worker thread
 *
 * The S3 store's synchronous methods block the calling thread until the request is answered
 * (storage/blocking-fetch.ts). A stand-in served from that same thread could never answer, so this one runs in
 * its own worker thread with its own event loop, and a suite talks to it over a message port.
 *
 * ## It checks the signature, independently
 *
 * Every request must carry a SigV4 `Authorization` header of the right shape, for the right access key, region
 * and service, signing at least `host`, `x-amz-date` and `x-amz-content-sha256`, with a payload hash that
 * matches the body actually sent — and the signature itself is recomputed HERE, by a second implementation
 * written from the specification, over the request exactly as it arrived. A request that fails any of that is a
 * 403 `SignatureDoesNotMatch`, as a real bucket would answer. So a store that signs the wrong thing fails the
 * suite, not the global node's first upload.
 *
 * ## Faults on demand
 *
 * {@link FakeS3.fault} makes the next N matching requests answer a status (a 503, a 403), drop the connection
 * (no answer at all), or wait before answering — which is how the retry, timeout and circuit-breaker paths
 * are proved without a network.
 */

import { Worker } from 'node:worker_threads';
import type { S3Config } from './storage/s3-image-store.js';

const SERVER_SOURCE = `
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { bucket, accessKeyId, secretAccessKey, region, maxKeys } = workerData;

const objects = new Map(); // key -> { bytes: Buffer, mime, mtimeMs, meta }
const log = [];
const faults = []; // { method, status, network, delayMs, count, prefix }

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function hmac(k, d) { return crypto.createHmac('sha256', k).update(d, 'utf8').digest(); }
function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function errorXml(code, message) {
    return '<?xml version="1.0" encoding="UTF-8"?><Error><Code>' + code + '</Code><Message>' + xml(message) + '</Message></Error>';
}

function verify(req, body) {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\\/(\\d{8})\\/([^/]+)\\/([^/]+)\\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/);
    if (!m) return 'the Authorization header is not SigV4-shaped';
    const [, akid, date, reg, service, signedHeaders, signature] = m;
    if (akid !== accessKeyId) return 'unknown access key';
    if (reg !== region) return 'wrong region';
    if (service !== 's3') return 'wrong service';
    const names = signedHeaders.split(';');
    for (const need of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!names.includes(need)) return need + ' is not signed';
    const amzDate = req.headers['x-amz-date'] || '';
    if (amzDate.slice(0, 8) !== date) return 'x-amz-date does not match the credential scope';
    const payloadHash = req.headers['x-amz-content-sha256'] || '';
    if (payloadHash !== sha256(body)) return 'x-amz-content-sha256 does not match the body';
    const q = req.url.indexOf('?');
    const rawPath = q < 0 ? req.url : req.url.slice(0, q);
    const rawQuery = q < 0 ? '' : req.url.slice(q + 1);
    const canonicalUri = rawPath.split('/').map(s => enc(decodeURIComponent(s))).join('/');
    const pairs = rawQuery ? rawQuery.split('&').map(p => {
        const i = p.indexOf('=');
        const k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\\+/g, ' '));
        const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1).replace(/\\+/g, ' '));
        return [enc(k), enc(v)];
    }) : [];
    pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    const canonicalQuery = pairs.map(([k, v]) => k + '=' + v).join('&');
    const canonicalHeaders = names.map(n => {
        const v = req.headers[n];
        if (v === undefined) return null;
        return n + ':' + String(v).trim().replace(/\\s+/g, ' ') + '\\n';
    });
    if (canonicalHeaders.includes(null)) return 'a signed header was not sent';
    const canonicalRequest = [req.method, canonicalUri, canonicalQuery, canonicalHeaders.join(''), signedHeaders, payloadHash].join('\\n');
    const scope = date + '/' + reg + '/s3/aws4_request';
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), reg), 's3'), 'aws4_request');
    const expected = crypto.createHmac('sha256', key).update(sts, 'utf8').digest('hex');
    if (expected !== signature) return 'signature does not match';
    return null;
}

function takeFault(method, path) {
    for (const f of faults) {
        if (f.count <= 0) continue;
        if (f.method && f.method !== method) continue;
        if (f.prefix && !path.startsWith(f.prefix)) continue;
        f.count--;
        return f;
    }
    return null;
}

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
});

function handle(req, res, body) {
    const u = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: u.pathname, query: u.search, authOk: false, status: 0, error: null };
    log.push(entry);
    const answer = (status, headers, payload) => {
        entry.status = status;
        res.writeHead(status, headers || {});
        if (fault && fault.slowBodyMs && req.method !== 'HEAD') {
            // The headers now, the body later: a bucket that answers at once and then trickles.
            res.flushHeaders();
            setTimeout(() => res.end(payload), fault.slowBodyMs);
            return;
        }
        res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const fault = takeFault(req.method, u.pathname);
    const go = () => {
        if (fault && fault.network) { entry.status = -1; req.socket.destroy(); return; }
        if (fault && fault.status) { return answer(fault.status, { 'content-type': 'application/xml' }, errorXml(fault.code || 'InternalError', 'injected by the test')); }
        const bad = verify(req, body);
        if (bad) { entry.error = bad; return answer(403, { 'content-type': 'application/xml' }, errorXml('SignatureDoesNotMatch', bad)); }
        entry.authOk = true;
        const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
        if (parts[0] !== bucket) return answer(404, { 'content-type': 'application/xml' }, errorXml('NoSuchBucket', 'no such bucket'));
        const key = parts.slice(1).join('/');
        if (!key) {
            if (req.method === 'HEAD') return answer(200, {});
            if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
                const prefix = u.searchParams.get('prefix') || '';
                const limit = Math.min(Number(u.searchParams.get('max-keys') || 1000), maxKeys || 1000);
                const after = u.searchParams.get('continuation-token');
                const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
                const start = after ? keys.findIndex(k => k > Buffer.from(after, 'base64url').toString('utf8')) : 0;
                const page = start < 0 ? [] : keys.slice(start, start + limit);
                const truncated = start >= 0 && start + limit < keys.length;
                let out = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>' + xml(bucket) + '</Name><Prefix>' + xml(prefix) + '</Prefix><KeyCount>' + page.length + '</KeyCount><MaxKeys>' + limit + '</MaxKeys><IsTruncated>' + truncated + '</IsTruncated>';
                for (const k of page) {
                    const o = objects.get(k);
                    out += '<Contents><Key>' + xml(k) + '</Key><LastModified>' + new Date(o.mtimeMs).toISOString() + '</LastModified><ETag>&quot;' + sha256(o.bytes).slice(0, 32) + '&quot;</ETag><Size>' + o.bytes.length + '</Size><StorageClass>STANDARD</StorageClass></Contents>';
                }
                if (truncated) out += '<NextContinuationToken>' + Buffer.from(page[page.length - 1], 'utf8').toString('base64url') + '</NextContinuationToken>';
                out += '</ListBucketResult>';
                return answer(200, { 'content-type': 'application/xml' }, out);
            }
            return answer(400, { 'content-type': 'application/xml' }, errorXml('InvalidRequest', 'unsupported bucket request'));
        }
        const o = objects.get(key);
        if (req.method === 'PUT') {
            objects.set(key, { bytes: body, mime: req.headers['content-type'] || 'application/octet-stream', mtimeMs: Date.now(), meta: req.headers['x-amz-meta-sha256'] || null });
            return answer(200, { etag: '"' + sha256(body).slice(0, 32) + '"' });
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            if (!o) return answer(404, { 'content-type': 'application/xml' }, errorXml('NoSuchKey', 'no such key'));
            return answer(200, { 'content-type': o.mime, 'content-length': String(o.bytes.length), 'last-modified': new Date(o.mtimeMs).toUTCString() }, o.bytes);
        }
        if (req.method === 'DELETE') {
            objects.delete(key);
            return answer(204, {});
        }
        return answer(405, {}, '');
    };
    if (fault && fault.delayMs) setTimeout(go, fault.delayMs); else go();
}

parentPort.on('message', (msg) => {
    const reply = (value) => parentPort.postMessage({ id: msg.id, value });
    switch (msg.type) {
        case 'fault': faults.push({ ...msg.fault }); return reply(true);
        case 'clearFaults': faults.length = 0; return reply(true);
        case 'objects': return reply([...objects.entries()].map(([k, o]) => [k, { bytes: new Uint8Array(o.bytes), mime: o.mime, mtimeMs: o.mtimeMs, meta: o.meta }]));
        case 'log': return reply(log.slice());
        case 'clearLog': log.length = 0; return reply(true);
        case 'setMtime': { const o = objects.get(msg.key); if (o) o.mtimeMs = msg.mtimeMs; return reply(!!o); }
        case 'seed': objects.set(msg.key, { bytes: Buffer.from(msg.bytes), mime: msg.mime || 'application/octet-stream', mtimeMs: msg.mtimeMs || Date.now(), meta: null }); return reply(true);
        case 'remove': return reply(objects.delete(msg.key));
        case 'close': server.close(); server.closeAllConnections && server.closeAllConnections(); return reply(true);
    }
});

server.listen(0, '127.0.0.1', () => parentPort.postMessage({ ready: server.address().port }));
`;

export interface FakeS3Object {
    bytes: Buffer;
    mime: string;
    mtimeMs: number;
    /** The `x-amz-meta-sha256` the uploader sent, if any. */
    meta: string | null;
}

export interface FakeS3LogEntry {
    method: string;
    path: string;
    query: string;
    /** The signature checked out (false for a fault or a refused signature). */
    authOk: boolean;
    /** The status answered; -1 when the connection was dropped on purpose. */
    status: number;
    /** Why the signature was refused, when it was. */
    error: string | null;
}

export interface FakeS3Fault {
    /** Only requests with this method. */
    method?: string;
    /** Only requests whose path starts with this. */
    prefix?: string;
    /** Answer this status instead of serving the request. */
    status?: number;
    code?: string;
    /** Drop the connection with no answer at all. */
    network?: boolean;
    /** Wait this long before answering (or before failing, with `status`/`network`). */
    delayMs?: number;
    /** Send the headers at once and the body this much later. */
    slowBodyMs?: number;
    /** How many matching requests this applies to. */
    count: number;
}

export interface FakeS3 {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** The settings a store needs to talk to this endpoint. */
    config(overrides?: Partial<S3Config>): S3Config;
    /** The same, as the environment variables `IMAGE_STORE=s3` reads. */
    env(): Record<string, string>;
    fault(f: FakeS3Fault): Promise<void>;
    clearFaults(): Promise<void>;
    objects(): Promise<Map<string, FakeS3Object>>;
    log(): Promise<FakeS3LogEntry[]>;
    clearLog(): Promise<void>;
    setMtime(key: string, mtimeMs: number): Promise<boolean>;
    seed(key: string, bytes: Buffer, mime?: string, mtimeMs?: number): Promise<void>;
    /** Remove an object behind the store's back — a lost object, as far as the node can tell. */
    remove(key: string): Promise<boolean>;
    stop(): Promise<void>;
}

/**
 * Start a stand-in bucket on a random loopback port. `maxKeys` caps a listing page so a suite can prove
 * pagination with a handful of objects.
 */
export async function startFakeS3(opts: { bucket?: string; region?: string; maxKeys?: number } = {}): Promise<FakeS3> {
    const bucket = opts.bucket ?? 'beanpool-test-photos';
    const region = opts.region ?? 'auto';
    const accessKeyId = 'AKIDFAKES3TEST0000001';
    // Distinctive, so a suite can grep captured logs for it and be sure it never appears.
    const secretAccessKey = 'fake-s3-SECRET-do-not-log-' + Math.random().toString(36).slice(2, 12);
    const worker = new Worker(SERVER_SOURCE, {
        eval: true,
        workerData: { bucket, accessKeyId, secretAccessKey, region, maxKeys: opts.maxKeys ?? 1000 },
    });
    worker.unref();
    let nextId = 1;
    const pending = new Map<number, (v: any) => void>();
    const port: number = await new Promise((resolve, reject) => {
        const onMessage = (msg: any) => {
            if (msg && typeof msg.ready === 'number') { resolve(msg.ready); return; }
            if (msg && pending.has(msg.id)) { pending.get(msg.id)!(msg.value); pending.delete(msg.id); }
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
    });
    const ask = <T>(type: string, extra: Record<string, unknown> = {}): Promise<T> => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        worker.postMessage({ id, type, ...extra });
    });
    const endpoint = `http://127.0.0.1:${port}`;
    return {
        endpoint, bucket, region, accessKeyId, secretAccessKey,
        config: (overrides = {}) => ({ endpoint, bucket, region, accessKeyId, secretAccessKey, ...overrides }),
        env: () => ({
            IMAGE_STORE: 's3',
            IMAGE_S3_ENDPOINT: endpoint,
            IMAGE_S3_BUCKET: bucket,
            IMAGE_S3_REGION: region,
            IMAGE_S3_ACCESS_KEY_ID: accessKeyId,
            IMAGE_S3_SECRET_ACCESS_KEY: secretAccessKey,
        }),
        fault: async (f) => { await ask('fault', { fault: f }); },
        clearFaults: async () => { await ask('clearFaults'); },
        objects: async () => {
            const entries = await ask<[string, { bytes: Uint8Array; mime: string; mtimeMs: number; meta: string | null }][]>('objects');
            return new Map(entries.map(([k, o]) => [k, { bytes: Buffer.from(o.bytes), mime: o.mime, mtimeMs: o.mtimeMs, meta: o.meta }]));
        },
        log: () => ask<FakeS3LogEntry[]>('log'),
        clearLog: async () => { await ask('clearLog'); },
        setMtime: (key, mtimeMs) => ask<boolean>('setMtime', { key, mtimeMs }),
        seed: async (key, bytes, mime, mtimeMs) => { await ask('seed', { key, bytes: new Uint8Array(bytes), mime, mtimeMs }); },
        remove: (key) => ask<boolean>('remove', { key }),
        stop: async () => { await ask('close'); await worker.terminate(); },
    };
}
