/**
 * The S3/R2 image store (`IMAGE_STORE=s3`): the same {@link ImageStore} contract as the disk store, with the
 * objects in a bucket on any S3-compatible endpoint. Cloudflare R2 is the one it is built for — the global
 * node keeps its photos there from day one (storage design §7, Marty 2026-09-24) — while local nodes keep the
 * disk store, which is the default and needs nothing signed up for.
 *
 * ## Configuration, and what is refused
 *
 * `IMAGE_S3_ENDPOINT`, `IMAGE_S3_BUCKET`, `IMAGE_S3_REGION` (`auto` on R2), `IMAGE_S3_ACCESS_KEY_ID`,
 * `IMAGE_S3_SECRET_ACCESS_KEY` — from the environment only, never node_config, never a backup. Any one of them
 * missing or malformed is a boot failure that names every setting at fault (by NAME: a value is never
 * printed), and so is a bucket the credentials cannot reach — or can reach but not write to, read back from and
 * delete from, which boot proves with a test object of its own ({@link S3ImageStore.checkBucket}). Never a
 * silent fall back to disk: a node that believes its photos are in a bucket must not quietly fill a local disk
 * nobody is watching.
 *
 * The endpoint must be `https:`. Plain `http:` is accepted for a loopback host only, which is what the tests'
 * in-process stand-in is; anything else would send every photo and every attachment's ciphertext across the
 * network in the clear, and let whoever sits in the path hand back different bytes.
 *
 * Requests are path-style (`<endpoint>/<bucket>/<key>`), which R2, MinIO and AWS all accept, so the bucket
 * name never has to be a valid DNS label.
 *
 * ## Two ways in: blocking and not
 *
 * The {@link ImageStore} methods are synchronous by contract, so here they go through {@link BlockingFetcher}:
 * the node's event loop is held for the round trip. That is the price of the contract until the async port
 * (storage design §2), and it is paid only where the contract demands it — writing a new post's photos, an
 * attachment, a post-commit delete, the evacuation job. Everything that is already async — serving a photo, the
 * sync export, taking a backup, measuring a restore, the orphan sweep and the admin Clean — uses the async
 * methods ({@link S3ImageStore.getAsync}, {@link S3ImageStore.openRead}, {@link S3ImageStore.scanAsync},
 * {@link S3ImageStore.deleteAsync}), which never hold the loop, and serving streams the object rather than
 * buffering it.
 *
 * ## A write and a delete of the same key never overlap
 *
 * The sweep's deletes are async, so other code runs while one is on its way to the bucket — and a write of the
 * SAME key could land first and be deleted by it: a photo whose row then points at nothing. The store keeps
 * the two apart for the keys it is in the middle of. While {@link S3ImageStore.deleteAsync} has a key, a
 * non-blocking write of it waits for the delete to finish and lands after it, and a blocking one is refused at
 * once as an {@link ImageStoreUnavailableError} (it cannot wait: it holds the loop the delete needs) — which
 * every blocking writer already answers by keeping the photo in its row for the evacuation job. And while a
 * non-blocking write of a key is in flight, a delete of it is not attempted at all.
 *
 * The blocking path is kept short on purpose. Each attempt has its own timeout, there are at most
 * {@link S3Tuning.syncAttempts} of them, and after the bucket fails a blocking call the store stops making
 * blocking calls for {@link S3Tuning.breakerMs}: a write in that window fails at once, which the callers
 * already handle by keeping the photo in its row for the evacuation job to move later. Without that, an R2
 * outage would hold the node for the whole retry budget on every photo of every post, and the host watchdog
 * (which restarts a node that has not answered for ~60 s) would restart it in a loop.
 *
 * ## Retries
 *
 * Only on a 5xx or on no answer at all (connection refused, reset, DNS, the timeout). A 4xx is the bucket
 * telling us something true — no such key, access denied, a bad signature — and asking again changes nothing.
 * Every request is re-signed per attempt. PUT and DELETE are safe to repeat: keys are content-addressed, and
 * deleting a deleted key is a no-op.
 */

import util from 'node:util';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
    ImageStoreError, ImageStoreUnavailableError, MAX_OBJECT_BYTES, assertSafeKey, assertSafePrefix, sha256Hex,
    type ImageStore, type ObjectInfo, type PutOptions, type StoredObject,
} from './image-store.js';
import { EMPTY_PAYLOAD_SHA256, signRequest, uriEncode, type SigV4Credentials } from './s3-sigv4.js';
import { BlockingFetcher, BlockingFetchError, sleepSync, type BlockingResponse } from './blocking-fetch.js';

export interface S3Config {
    /** The bare endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    endpoint: string;
    bucket: string;
    /** `auto` for R2. */
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export interface S3Tuning {
    /** Per-attempt timeout on the blocking path. */
    syncAttemptTimeoutMs: number;
    syncAttempts: number;
    /** Per-attempt timeout on the async path. A streamed GET's whole body must arrive within it. */
    asyncAttemptTimeoutMs: number;
    asyncAttempts: number;
    /** First backoff between attempts; doubles each time. */
    backoffMs: number;
    /** After a blocking call fails on the bucket, blocking calls fail at once for this long. */
    breakerMs: number;
}

/**
 * The defaults keep one blocking call's worst case — every attempt timing out, plus the backoff — near 8.5 s,
 * well inside the watchdog's ~60 s, and the breaker makes that a once-per-30-seconds cost during an outage
 * rather than a per-photo one.
 */
export const DEFAULT_S3_TUNING: S3Tuning = {
    syncAttemptTimeoutMs: 4_000,
    syncAttempts: 2,
    asyncAttemptTimeoutMs: 20_000,
    asyncAttempts: 3,
    backoffMs: 250,
    breakerMs: 30_000,
};

/** The most one ListObjectsV2 page may be. A thousand keys of ours is ~300 KB of XML. */
const MAX_LIST_PAGE_BYTES = 8 * 1024 * 1024;
/** A bucket of a hundred million objects is not ours; a listing that long is a loop. */
const MAX_LIST_PAGES = 100_000;

/**
 * Where the boot check writes its test object. Outside every namespace of ours (image-store.ts
 * `STORE_NAMESPACES`), so no sweep, backup or restore ever lists it or takes it for a photo; and one object per
 * boot, uniquely named, deleted again before the node starts.
 */
export const WRITE_CHECK_PREFIX = 'beanpool-write-check';

export const S3_ENV = {
    endpoint: 'IMAGE_S3_ENDPOINT',
    bucket: 'IMAGE_S3_BUCKET',
    region: 'IMAGE_S3_REGION',
    accessKeyId: 'IMAGE_S3_ACCESS_KEY_ID',
    secretAccessKey: 'IMAGE_S3_SECRET_ACCESS_KEY',
} as const;

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Read and check the five settings. Throws one {@link ImageStoreError} naming EVERY setting that is missing or
 * unusable — by name, never by value, so the message is safe in any log — or returns the config.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
    const read = (name: string): string => String(env[name] ?? '').trim();
    const endpointRaw = read(S3_ENV.endpoint);
    const bucket = read(S3_ENV.bucket);
    const region = read(S3_ENV.region);
    const accessKeyId = read(S3_ENV.accessKeyId);
    const secretAccessKey = String(env[S3_ENV.secretAccessKey] ?? '');

    const missing: string[] = [];
    const bad: string[] = [];
    if (!endpointRaw) missing.push(S3_ENV.endpoint);
    if (!bucket) missing.push(S3_ENV.bucket);
    if (!region) missing.push(S3_ENV.region);
    if (!accessKeyId) missing.push(S3_ENV.accessKeyId);
    if (!secretAccessKey.trim()) missing.push(S3_ENV.secretAccessKey);

    let endpoint = '';
    if (endpointRaw) {
        let url: URL | null = null;
        try { url = new URL(endpointRaw); } catch { /* reported below */ }
        if (!url) {
            bad.push(`${S3_ENV.endpoint} is not a URL`);
        } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
            bad.push(`${S3_ENV.endpoint} must be https:// (plain http is allowed only for a loopback test endpoint)`);
        } else if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password) {
            bad.push(`${S3_ENV.endpoint} must be the bare endpoint, e.g. https://<account>.r2.cloudflarestorage.com — `
                + `no path (the bucket goes in ${S3_ENV.bucket}), no query, no credentials`);
        } else {
            endpoint = url.origin;
        }
    }
    if (bucket && !BUCKET_NAME.test(bucket)) {
        bad.push(`${S3_ENV.bucket} is not a bucket name (3-63 characters: lowercase letters, digits, dots, hyphens)`);
    }
    if (region && !REGION_NAME.test(region)) {
        bad.push(`${S3_ENV.region} is not a region name (use "auto" for Cloudflare R2)`);
    }
    if (accessKeyId && /\s/.test(accessKeyId)) bad.push(`${S3_ENV.accessKeyId} contains whitespace`);
    if (secretAccessKey.trim() && secretAccessKey !== secretAccessKey.trim()) {
        bad.push(`${S3_ENV.secretAccessKey} has leading or trailing whitespace`);
    }

    if (missing.length || bad.length) {
        const parts: string[] = [];
        if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
        if (bad.length) parts.push(bad.join('; '));
        throw new ImageStoreError(
            `IMAGE_STORE=s3 is set but the S3 settings are not usable (${parts.join('; ')}). `
            + 'Photos will not be written anywhere until this is fixed; unset IMAGE_STORE to keep them on this '
            + 'node\'s disk instead.',
        );
    }
    return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

/**
 * The part of a failed answer worth logging: the S3 error code, never the body (which can echo the request).
 *
 * Also how a missing OBJECT is told from a missing BUCKET: both are a 404, and only the first is "not there" —
 * the second is a misconfigured node, and reading it as an absent photo would hide that.
 */
function s3ErrorCode(body: Buffer | string | null | undefined): string | null {
    if (!body) return null;
    const text = typeof body === 'string' ? body : body.subarray(0, 4096).toString('utf8');
    const m = text.match(/<Code>([A-Za-z0-9.]{1,64})<\/Code>/);
    return m ? m[1] : null;
}

function xmlUnescape(s: string): string {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | null {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? xmlUnescape(m[1]) : null;
}

/** One page of a ListObjectsV2 answer. Keys that could not be ours (unsafe as a key) are dropped here. */
export function parseListPage(xml: string): { objects: ObjectInfo[]; nextToken: string | null } {
    const objects: ObjectInfo[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(m[1], 'Key');
        if (!key) continue;
        try { assertSafeKey(key); } catch { continue; }
        const bytes = Number(tag(m[1], 'Size'));
        const mtimeMs = Date.parse(tag(m[1], 'LastModified') || '');
        objects.push({ key, bytes: Number.isFinite(bytes) ? bytes : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 });
    }
    const truncated = (tag(xml, 'IsTruncated') || '').trim() === 'true';
    const nextToken = truncated ? tag(xml, 'NextContinuationToken') : null;
    return { objects, nextToken };
}

interface BuiltRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
}

/** Retry-worthy: a 5xx, or no answer at all. */
function retryableStatus(status: number): boolean {
    return status >= 500 && status <= 599;
}

/**
 * An answer about the bucket or this node's access to it, not about the object: throttled, credentials
 * refused, no such bucket. Not retried on the spot, but the same request can succeed later, once the
 * provider or the operator has fixed it — so it is an {@link ImageStoreUnavailableError}.
 */
function storeWideRefusal(status: number, code: string | null): boolean {
    return status === 429 || status === 401 || status === 403 || code === 'NoSuchBucket';
}

/** Where the credentials live: off the instance, so logging or serialising a store cannot print them. */
const secrets = new WeakMap<S3ImageStore, SigV4Credentials>();

export class S3ImageStore implements ImageStore {
    readonly kind = 's3';
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    private readonly tuning: S3Tuning;
    private readonly fetcher = new BlockingFetcher();
    private breakerUntil = 0;
    private breakerReason = '';
    /** Keys {@link deleteAsync} is deleting, each with what settles when it is done. */
    private readonly deleting = new Map<string, Promise<void>>();
    /** Keys {@link putAsync} is writing, with how many writes of each are in flight. */
    private readonly writing = new Map<string, number>();

    constructor(config: S3Config, tuning: Partial<S3Tuning> = {}) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.bucket = config.bucket;
        this.region = config.region;
        this.tuning = { ...DEFAULT_S3_TUNING, ...tuning };
        secrets.set(this, { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
    }

    /** What an operator may see: where the objects are, never how to get at them. */
    describe(): string {
        return `s3 bucket "${this.bucket}" at ${new URL(this.endpoint).host}`;
    }

    toJSON(): Record<string, string> {
        return { kind: this.kind, endpoint: this.endpoint, bucket: this.bucket, region: this.region };
    }

    [util.inspect.custom](): string {
        return `S3ImageStore { ${this.describe()} }`;
    }

    // ── Building a request ─────────────────────────────────────────────────────────────────────

    private objectUrl(key: string): URL {
        const encoded = assertSafeKey(key).map(uriEncode).join('/');
        return new URL(`${this.endpoint}/${uriEncode(this.bucket)}/${encoded}`);
    }

    private bucketUrl(query?: Record<string, string>): URL {
        const url = new URL(`${this.endpoint}/${uriEncode(this.bucket)}`);
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
        return url;
    }

    private build(method: string, url: URL, opts: { body?: Buffer; bodySha256?: string; headers?: Record<string, string> } = {}): BuiltRequest {
        const creds = secrets.get(this);
        if (!creds) throw new ImageStoreError('S3 image store has no credentials');
        const signed = signRequest({
            method,
            url,
            headers: opts.headers,
            payloadSha256: opts.body ? (opts.bodySha256 ?? sha256Hex(opts.body)) : EMPTY_PAYLOAD_SHA256,
            region: this.region,
        }, creds);
        // `host` is the URL's; fetch sets it and refuses to be handed one.
        const headers = { ...signed.headers };
        delete headers.host;
        return { url: url.toString(), method, headers, body: opts.body };
    }

    // ── The blocking path ──────────────────────────────────────────────────────────────────────

    /** Throw at once while the breaker is open, rather than holding the node on a bucket that just failed. */
    private checkBreaker(what: string): void {
        const now = Date.now();
        if (now < this.breakerUntil) {
            throw new ImageStoreUnavailableError(
                `S3 ${what} not attempted: the bucket failed ${Math.round((now - (this.breakerUntil - this.tuning.breakerMs)) / 1000)} s ago `
                + `(${this.breakerReason}), and the node does not wait on it again until ${new Date(this.breakerUntil).toISOString()}`,
            );
        }
    }

    private syncCall(what: string, make: () => BuiltRequest, maxBytes: number): BlockingResponse {
        this.checkBreaker(what);
        let last = '';
        for (let attempt = 0; attempt < this.tuning.syncAttempts; attempt++) {
            if (attempt > 0) sleepSync(this.tuning.backoffMs * 2 ** (attempt - 1));
            const req = make();
            let res: BlockingResponse;
            try {
                res = this.fetcher.request(
                    { ...req, timeoutMs: this.tuning.syncAttemptTimeoutMs, maxBytes },
                    // The worker aborts at the timeout; the extra is for its answer to come back.
                    this.tuning.syncAttemptTimeoutMs + 1_000,
                );
            } catch (e) {
                if (e instanceof BlockingFetchError && e.kind !== 'too-large') {
                    last = e.timedOut ? `no answer within ${this.tuning.syncAttemptTimeoutMs} ms` : e.message;
                    continue;
                }
                throw new ImageStoreError(`S3 ${what} failed: ${(e as Error)?.message || e}`);
            }
            if (retryableStatus(res.status)) {
                last = `HTTP ${res.status}${s3ErrorCode(res.body) ? ' ' + s3ErrorCode(res.body) : ''}`;
                continue;
            }
            this.breakerUntil = 0;
            return res;
        }
        this.breakerUntil = Date.now() + this.tuning.breakerMs;
        this.breakerReason = last;
        throw new ImageStoreUnavailableError(`S3 ${what} failed after ${this.tuning.syncAttempts} attempt(s): ${last}`);
    }

    private fail(what: string, res: { status: number; body?: Buffer | string | null }): never {
        const code = s3ErrorCode(res.body ?? null);
        const message = `S3 ${what} answered HTTP ${res.status}${code ? ` (${code})` : ''}`;
        throw storeWideRefusal(res.status, code) ? new ImageStoreUnavailableError(message) : new ImageStoreError(message);
    }

    /** The checks every write makes before a byte leaves the node, shared by {@link put} and {@link putAsync}. */
    private preparePut(key: string, bytes: Buffer, options: PutOptions): () => BuiltRequest {
        if (!Buffer.isBuffer(bytes)) throw new ImageStoreError('Image store put needs a Buffer');
        if (bytes.length === 0) throw new ImageStoreError('Refusing to store an empty object');
        if (bytes.length > MAX_OBJECT_BYTES) {
            throw new ImageStoreError(`Object is ${bytes.length} bytes, over the ${MAX_OBJECT_BYTES}-byte limit`);
        }
        const digest = sha256Hex(bytes);
        if (options.sha256 && options.sha256.toLowerCase() !== digest) {
            throw new ImageStoreError('Image store put: the bytes do not match the hash the caller gave');
        }
        const url = this.objectUrl(key);
        // The payload hash is signed (x-amz-content-sha256), so the bucket itself refuses a body that was
        // altered on the way: what lands is exactly these bytes or nothing.
        return () => this.build('PUT', url, {
            body: bytes,
            bodySha256: digest,
            headers: { 'content-type': options.mime || 'application/octet-stream', 'x-amz-meta-sha256': digest },
        });
    }

    put(key: string, bytes: Buffer, options: PutOptions): StoredObject {
        const make = this.preparePut(key, bytes, options);
        if (this.deleting.has(key)) {
            throw new ImageStoreUnavailableError(
                `S3 PUT ${key} not attempted: the orphan sweep is deleting that key this moment, and a blocking write `
                + 'cannot wait for it. The write is retried later.',
            );
        }
        const res = this.syncCall(`PUT ${key}`, make, 64 * 1024);
        if (res.status !== 200) this.fail(`PUT ${key}`, res);
        return { key, bytes: bytes.length, sha256: sha256Hex(bytes), mime: options.mime };
    }

    /** Non-blocking {@link put}: the federation importer writes a peer's photos through this. */
    async putAsync(key: string, bytes: Buffer, options: PutOptions): Promise<StoredObject> {
        const make = this.preparePut(key, bytes, options);
        // After a delete of the same key, never beside it: see "A write and a delete of the same key never overlap".
        for (let gate = this.deleting.get(key); gate; gate = this.deleting.get(key)) await gate;
        this.writing.set(key, (this.writing.get(key) ?? 0) + 1);
        try {
            const res = await this.asyncCall(`PUT ${key}`, make);
            if (res.status !== 200) return await this.failAsync(`PUT ${key}`, res);
            await res.body?.cancel().catch(() => {});
            return { key, bytes: bytes.length, sha256: sha256Hex(bytes), mime: options.mime };
        } finally {
            const left = (this.writing.get(key) ?? 1) - 1;
            if (left > 0) this.writing.set(key, left); else this.writing.delete(key);
        }
    }

    get(key: string): Buffer | null {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = this.syncCall(`GET ${key}`, () => this.build('GET', url), MAX_OBJECT_BYTES);
        if (res.status === 404 && s3ErrorCode(res.body) !== 'NoSuchBucket') return null;
        if (res.status !== 200) this.fail(`GET ${key}`, res);
        return res.body;
    }

    head(key: string): { key: string; bytes: number; mtimeMs: number } | null {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = this.syncCall(`HEAD ${key}`, () => this.build('HEAD', url), 0);
        if (res.status === 404) return null;
        if (res.status !== 200) this.fail(`HEAD ${key}`, res);
        return headInfo(key, res.headers);
    }

    /**
     * S3 answers 204 to a DELETE whether or not the key existed, so "was anything removed" — which the
     * contract promises and the sweep counts — takes a HEAD first. Two round trips, on a path that runs
     * after a commit and in the daily sweep, never while a member waits.
     */
    delete(key: string): boolean {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return false; }
        if (!this.head(key)) return false;
        const res = this.syncCall(`DELETE ${key}`, () => this.build('DELETE', url), 64 * 1024);
        if (res.status === 404) return false;
        if (res.status !== 204 && res.status !== 200) this.fail(`DELETE ${key}`, res);
        return true;
    }

    list(prefix: string): string[] {
        return this.scan(prefix).map((o) => o.key);
    }

    /** Every object under `prefix` with its size and time, from the listing itself: one request per thousand. */
    scan(prefix: string): ObjectInfo[] {
        const listPrefix = normalisePrefix(prefix);
        const out: ObjectInfo[] = [];
        let token: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
            if (listPrefix) query.prefix = listPrefix;
            if (token) query['continuation-token'] = token;
            const url = this.bucketUrl(query);
            const res = this.syncCall(`LIST ${listPrefix || '(all)'}`, () => this.build('GET', url), MAX_LIST_PAGE_BYTES);
            if (res.status !== 200) this.fail(`LIST ${listPrefix || '(all)'}`, res);
            const parsed = parseListPage(res.body.toString('utf8'));
            out.push(...parsed.objects);
            if (!parsed.nextToken) return out;
            if (seen.has(parsed.nextToken)) throw new ImageStoreError('S3 LIST returned the same continuation token twice');
            seen.add(parsed.nextToken);
            token = parsed.nextToken;
        }
        throw new ImageStoreError(`S3 LIST did not finish within ${MAX_LIST_PAGES} pages`);
    }

    totalBytes(): number {
        return this.scan('').reduce((sum, o) => sum + o.bytes, 0);
    }

    // ── The async path ─────────────────────────────────────────────────────────────────────────

    /**
     * One request with retries on 5xx / no answer, never holding the event loop. Returns the response with its
     * body unread, so a caller can stream it.
     *
     * The attempt's timeout covers the whole exchange — except with `streamBody`, where it stops at the headers.
     * A streamed body goes to a phone at the phone's pace, and on a slow connection (this project's audience) a
     * photo can legitimately take longer than any deadline worth setting on the bucket; cutting it off would be
     * a broken photo. A body that genuinely stalls is still ended by undici's own idle timeout between chunks.
     */
    private async asyncCall(what: string, make: () => BuiltRequest, opts: { streamBody?: boolean } = {}): Promise<Response> {
        let last = '';
        for (let attempt = 0; attempt < this.tuning.asyncAttempts; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, this.tuning.backoffMs * 2 ** (attempt - 1)));
            const req = make();
            const abort = new AbortController();
            const timer = setTimeout(
                () => abort.abort(new DOMException(`no answer within ${this.tuning.asyncAttemptTimeoutMs} ms`, 'TimeoutError')),
                this.tuning.asyncAttemptTimeoutMs,
            );
            timer.unref?.();
            let res: Response;
            try {
                res = await fetch(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body ? new Uint8Array(req.body) : undefined,
                    signal: abort.signal,
                    redirect: 'manual',
                });
            } catch (e: any) {
                clearTimeout(timer);
                const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
                last = timedOut ? `no answer within ${this.tuning.asyncAttemptTimeoutMs} ms` : String(e?.cause?.code || e?.message || e);
                continue;
            }
            // Headers are in. A caller that reads the body itself keeps the deadline for it; a streamed body does not.
            if (opts.streamBody) clearTimeout(timer);
            if (retryableStatus(res.status)) {
                const text = await res.text().catch(() => '');
                last = `HTTP ${res.status}${s3ErrorCode(text) ? ' ' + s3ErrorCode(text) : ''}`;
                continue;
            }
            // A good answer from the bucket closes the breaker for the blocking path as well.
            this.breakerUntil = 0;
            return res;
        }
        throw new ImageStoreUnavailableError(`S3 ${what} failed after ${this.tuning.asyncAttempts} attempt(s): ${last}`);
    }

    private async failAsync(what: string, res: Response): Promise<never> {
        const text = await res.text().catch(() => '');
        this.fail(what, { status: res.status, body: text });
    }

    /** The object's bytes without holding the event loop, or null when it is not there. */
    async getAsync(key: string): Promise<Buffer | null> {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = await this.asyncCall(`GET ${key}`, () => this.build('GET', url));
        if (res.status === 404) {
            const text = await res.text().catch(() => '');
            if (s3ErrorCode(text) !== 'NoSuchBucket') return null;
            this.fail(`GET ${key}`, { status: 404, body: text });
        }
        if (res.status !== 200) return this.failAsync(`GET ${key}`, res);
        return readCapped(res, MAX_OBJECT_BYTES, `GET ${key}`);
    }

    async headAsync(key: string): Promise<ObjectInfo | null> {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = await this.asyncCall(`HEAD ${key}`, () => this.build('HEAD', url));
        if (res.status === 404) return null;
        if (res.status !== 200) return this.failAsync(`HEAD ${key}`, res);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return headInfo(key, headers);
    }

    /**
     * The object as a stream, for serving: nothing is buffered beyond what the socket is ready to take. Null
     * when the object is not there. The per-attempt timeout covers the wait for the headers, not the body — see
     * {@link asyncCall}.
     */
    async openRead(key: string): Promise<{ stream: Readable; bytes: number | null } | null> {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = await this.asyncCall(`GET ${key}`, () => this.build('GET', url), { streamBody: true });
        if (res.status === 404) {
            const text = await res.text().catch(() => '');
            if (s3ErrorCode(text) !== 'NoSuchBucket') return null;
            this.fail(`GET ${key}`, { status: 404, body: text });
        }
        if (res.status !== 200) return this.failAsync(`GET ${key}`, res);
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) {
            await res.body?.cancel().catch(() => {});
            throw new ImageStoreError(`S3 GET ${key}: ${declared} bytes is over the ${MAX_OBJECT_BYTES}-byte limit`);
        }
        const stream = res.body ? Readable.fromWeb(res.body as any) : Readable.from([]);
        return { stream, bytes: Number.isFinite(declared) ? declared : null };
    }

    /**
     * Non-blocking {@link delete}, for the orphan sweep and the admin Clean. A HEAD and then the DELETE, like
     * {@link delete}, and `keep` is shown what the HEAD found: the object as the bucket has it now, not as a
     * listing saw it earlier. True when something was removed.
     *
     * Not attempted — false — while a non-blocking write of the key is in flight, or another delete of it is.
     * While this one runs, writes of the key wait or are refused (see "A write and a delete of the same key
     * never overlap"), so what `keep` saw is still true when the DELETE lands.
     */
    async deleteAsync(key: string, keep?: (now: ObjectInfo) => boolean): Promise<boolean> {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return false; }
        if (this.writing.has(key) || this.deleting.has(key)) return false;
        let settle!: () => void;
        this.deleting.set(key, new Promise<void>((resolve) => { settle = resolve; }));
        try {
            const now = await this.headAsync(key);
            if (!now || keep?.(now)) return false;
            const res = await this.asyncCall(`DELETE ${key}`, () => this.build('DELETE', url));
            if (res.status === 404) { await res.body?.cancel().catch(() => {}); return false; }
            if (res.status !== 204 && res.status !== 200) return await this.failAsync(`DELETE ${key}`, res);
            await res.body?.cancel().catch(() => {});
            return true;
        } finally {
            this.deleting.delete(key);
            settle();
        }
    }

    async scanAsync(prefix: string): Promise<ObjectInfo[]> {
        const listPrefix = normalisePrefix(prefix);
        const out: ObjectInfo[] = [];
        let token: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
            if (listPrefix) query.prefix = listPrefix;
            if (token) query['continuation-token'] = token;
            const url = this.bucketUrl(query);
            const res = await this.asyncCall(`LIST ${listPrefix || '(all)'}`, () => this.build('GET', url));
            if (res.status !== 200) return this.failAsync(`LIST ${listPrefix || '(all)'}`, res);
            const parsed = parseListPage((await readCapped(res, MAX_LIST_PAGE_BYTES, 'LIST')).toString('utf8'));
            out.push(...parsed.objects);
            if (!parsed.nextToken) return out;
            if (seen.has(parsed.nextToken)) throw new ImageStoreError('S3 LIST returned the same continuation token twice');
            seen.add(parsed.nextToken);
            token = parsed.nextToken;
        }
        throw new ImageStoreError(`S3 LIST did not finish within ${MAX_LIST_PAGES} pages`);
    }

    /**
     * The boot check: can these credentials use this bucket — reach it, write to it, read back from it and delete
     * from it? Throws an {@link ImageStoreError} that says which of the likely causes it is, in words, and never
     * prints a credential.
     *
     * Reaching it is a HEAD on the bucket. That alone passes an R2 API token scoped "Object Read only" — the
     * likeliest credential mistake beside the right one — and a node booted on it answers 403 to every PUT: each
     * new photo stays in state.db, which is what the bucket is for, and nothing ever refuses. So boot also writes a
     * small object of its own under {@link WRITE_CHECK_PREFIX}, reads it back byte for byte, deletes it and makes
     * sure it is gone, all without holding the event loop. Any step failing is a boot refusal naming the step:
     * refused rather than half-working. A test object it could not delete is named, so it can be removed by hand.
     */
    async checkBucket(): Promise<void> {
        let res: Response;
        try {
            res = await this.asyncCall(`HEAD bucket ${this.bucket}`, () => this.build('HEAD', this.bucketUrl()));
        } catch (e: any) {
            throw new ImageStoreError(`Could not reach the S3 endpoint for ${this.describe()}: ${e?.message || e}`);
        }
        if (res.status === 404) {
            throw new ImageStoreError(`${this.describe()}: no such bucket (HTTP 404). Create it, or fix ${S3_ENV.bucket}.`);
        }
        if (res.status === 401 || res.status === 403) {
            throw new ImageStoreError(
                `${this.describe()} refused these credentials (HTTP ${res.status}). Check ${S3_ENV.accessKeyId} and `
                + `${S3_ENV.secretAccessKey}, and that the token may read and write this bucket.`,
            );
        }
        if (res.status !== 200) throw new ImageStoreError(`${this.describe()} answered HTTP ${res.status} to a bucket check.`);
        await this.checkWriteReadDelete();
    }

    /** The write half of {@link checkBucket}. */
    private async checkWriteReadDelete(): Promise<void> {
        const where = this.describe();
        const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const key = `${WRITE_CHECK_PREFIX}/${stamp}-${crypto.randomBytes(8).toString('hex')}.txt`;
        const url = this.objectUrl(key);
        const body = Buffer.from(`BeanPool boot check: proves this node can write, read back and delete in this bucket. `
            + `Deleted again at once; safe to delete if it is ever left behind. ${key}\n`);
        const needs = 'on Cloudflare R2, an API token with "Object Read & Write" on this bucket';
        const refused = (status: number) => status === 401 || status === 403;
        const answer = async (r: Response) => {
            const code = s3ErrorCode(await r.text().catch(() => ''));
            return `HTTP ${r.status}${code ? ` ${code}` : ''}`;
        };
        const byHand = `remove "${key}" from bucket "${this.bucket}" by hand`;
        // After a failed write or read-back: take the test object away again, and say so if that fails too.
        const tidy = async (): Promise<string> => {
            try {
                const d = await this.asyncCall(`DELETE ${key}`, () => this.build('DELETE', url));
                await d.body?.cancel().catch(() => {});
                if (d.status === 204 || d.status === 200 || d.status === 404) return '';
            } catch { /* reported below */ }
            return ` The test object may still be in the bucket: ${byHand}.`;
        };

        let res: Response;

        // 1. Write.
        try {
            res = await this.asyncCall(`PUT ${key}`, () => this.build('PUT', url, { body, headers: { 'content-type': 'text/plain' } }));
        } catch (e: any) {
            throw new ImageStoreError(`Could not complete a test write to ${where}: ${e?.message || e}.${await tidy()}`);
        }
        if (refused(res.status)) {
            throw new ImageStoreError(
                `${where} let these credentials read the bucket but refused a test write (${await answer(res)}). The node `
                + `writes every new photo and attachment there, so the token needs write access: ${needs}. An R2 token `
                + 'scoped "Object Read only" is refused exactly like this.',
            );
        }
        if (res.status !== 200) {
            throw new ImageStoreError(`${where} did not accept a test write (${await answer(res)}).${await tidy()}`);
        }
        await res.body?.cancel().catch(() => {});

        // 2. Read it back, byte for byte.
        try {
            res = await this.asyncCall(`GET ${key}`, () => this.build('GET', url));
        } catch (e: any) {
            throw new ImageStoreError(`Could not read back a test write from ${where}: ${e?.message || e}.${await tidy()}`);
        }
        if (res.status !== 200) {
            const said = await answer(res);
            const left = await tidy();
            throw new ImageStoreError(refused(res.status)
                ? `${where} accepted a test write but refused to read it back (${said}). The node serves every photo from `
                    + `the bucket, so the token needs read access too: ${needs}.${left}`
                : `${where} did not give back a test write (${said}).${left}`);
        }
        let back: Buffer;
        try {
            back = await readCapped(res, 64 * 1024, `GET ${key}`);
        } catch (e: any) {
            throw new ImageStoreError(`Could not read back a test write from ${where}: ${e?.message || e}.${await tidy()}`);
        }
        if (!back.equals(body)) {
            throw new ImageStoreError(
                `${where} gave back different bytes for a test write than were written: something between this node and `
                + `the bucket is altering objects.${await tidy()}`,
            );
        }

        // 3. Delete it, and make sure it is gone.
        try {
            res = await this.asyncCall(`DELETE ${key}`, () => this.build('DELETE', url));
        } catch (e: any) {
            throw new ImageStoreError(
                `Could not delete the test object from ${where}: ${e?.message || e}. It may still be in the bucket: ${byHand}.`,
            );
        }
        if (res.status !== 204 && res.status !== 200) {
            const said = await answer(res);
            throw new ImageStoreError(refused(res.status)
                ? `${where} refused to delete the test object (${said}). The node deletes a member's photo when its post `
                    + `is removed, and an attachment when its message is, so the token needs delete access: ${needs}. `
                    + `The test object is still in the bucket: ${byHand}.`
                : `${where} did not delete the test object (${said}). It may still be in the bucket: ${byHand}.`);
        }
        await res.body?.cancel().catch(() => {});
        let still: ObjectInfo | null | undefined;
        try { still = await this.headAsync(key); } catch { still = undefined; }
        if (still !== null) {
            throw new ImageStoreError(
                `${where} answered the delete of the test object, but ${still ? 'still has it' : 'could not then say whether it is gone'}. `
                + `It may still be in the bucket: ${byHand}.`,
            );
        }
    }

    /** Stop the blocking path's worker thread (tests, shutdown). */
    async close(): Promise<void> {
        await this.fetcher.close();
    }
}

function headInfo(key: string, headers: Record<string, string>): { key: string; bytes: number; mtimeMs: number } {
    const bytes = Number(headers['content-length']);
    const mtimeMs = Date.parse(headers['last-modified'] || '');
    return { key, bytes: Number.isFinite(bytes) ? bytes : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 };
}

/**
 * A prefix the way the disk store means it: a directory. `posts/abc` lists `posts/abc/…` and not
 * `posts/abcdef/…`, which is what a raw S3 prefix would also match.
 */
function normalisePrefix(prefix: string): string {
    const segments = assertSafePrefix(prefix);
    return segments.length === 0 ? '' : `${segments.join('/')}/`;
}

async function readCapped(res: Response, maxBytes: number, what: string): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new ImageStoreError(`S3 ${what}: ${declared} bytes is over the ${maxBytes}-byte limit`);
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
            chunk = await reader.read();
        } catch (e: any) {
            throw new ImageStoreError(`S3 ${what}: the body did not arrive (${e?.message || e})`);
        }
        const { value, done } = chunk;
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new ImageStoreError(`S3 ${what}: body is over the ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}
