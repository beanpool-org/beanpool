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
 * printed), and so is a bucket the credentials cannot reach. Never a silent fall back to disk: a node that
 * believes its photos are in a bucket must not quietly fill a local disk nobody is watching.
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
 * attachment, a post-commit delete, the evacuation job, the daily orphan sweep. Everything that is already
 * async — serving a photo, the sync export, taking a backup, measuring a restore — uses the async methods
 * ({@link S3ImageStore.getAsync}, {@link S3ImageStore.openRead}, {@link S3ImageStore.scanAsync}), which never
 * hold the loop, and serving streams the object rather than buffering it.
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
import { Readable } from 'node:stream';
import {
    ImageStoreError, MAX_OBJECT_BYTES, assertSafeKey, assertSafePrefix, sha256Hex,
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
        const { host: _host, ...headers } = signed.headers;
        return { url: url.toString(), method, headers, body: opts.body };
    }

    // ── The blocking path ──────────────────────────────────────────────────────────────────────

    /** Throw at once while the breaker is open, rather than holding the node on a bucket that just failed. */
    private checkBreaker(what: string): void {
        const now = Date.now();
        if (now < this.breakerUntil) {
            throw new ImageStoreError(
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
        throw new ImageStoreError(`S3 ${what} failed after ${this.tuning.syncAttempts} attempt(s): ${last}`);
    }

    private fail(what: string, res: { status: number; body?: Buffer | string | null }): never {
        const code = s3ErrorCode(res.body ?? null);
        throw new ImageStoreError(`S3 ${what} answered HTTP ${res.status}${code ? ` (${code})` : ''}`);
    }

    put(key: string, bytes: Buffer, options: PutOptions): StoredObject {
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
        const res = this.syncCall(`PUT ${key}`, () => this.build('PUT', url, {
            body: bytes,
            bodySha256: digest,
            headers: { 'content-type': options.mime || 'application/octet-stream', 'x-amz-meta-sha256': digest },
        }), 64 * 1024);
        if (res.status !== 200) this.fail(`PUT ${key}`, res);
        return { key, bytes: bytes.length, sha256: digest, mime: options.mime };
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
     */
    private async asyncCall(what: string, make: () => BuiltRequest): Promise<Response> {
        let last = '';
        for (let attempt = 0; attempt < this.tuning.asyncAttempts; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, this.tuning.backoffMs * 2 ** (attempt - 1)));
            const req = make();
            let res: Response;
            try {
                res = await fetch(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body ? new Uint8Array(req.body) : undefined,
                    signal: AbortSignal.timeout(this.tuning.asyncAttemptTimeoutMs),
                    redirect: 'manual',
                });
            } catch (e: any) {
                const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
                last = timedOut ? `no answer within ${this.tuning.asyncAttemptTimeoutMs} ms` : String(e?.cause?.code || e?.message || e);
                continue;
            }
            if (retryableStatus(res.status)) {
                const text = await res.text().catch(() => '');
                last = `HTTP ${res.status}${s3ErrorCode(text) ? ' ' + s3ErrorCode(text) : ''}`;
                continue;
            }
            // A good answer from the bucket closes the breaker for the blocking path as well.
            this.breakerUntil = 0;
            return res;
        }
        throw new ImageStoreError(`S3 ${what} failed after ${this.tuning.asyncAttempts} attempt(s): ${last}`);
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
     * when the object is not there. The whole body must arrive within the per-attempt timeout.
     */
    async openRead(key: string): Promise<{ stream: Readable; bytes: number | null } | null> {
        let url: URL;
        try { url = this.objectUrl(key); } catch { return null; }
        const res = await this.asyncCall(`GET ${key}`, () => this.build('GET', url));
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
     * The boot check: can these credentials reach this bucket? Throws an {@link ImageStoreError} that says
     * which of the likely causes it is, in words, and never prints a credential.
     */
    async checkBucket(): Promise<void> {
        let res: Response;
        try {
            res = await this.asyncCall(`HEAD bucket ${this.bucket}`, () => this.build('HEAD', this.bucketUrl()));
        } catch (e: any) {
            throw new ImageStoreError(`Could not reach the S3 endpoint for ${this.describe()}: ${e?.message || e}`);
        }
        if (res.status === 200) return;
        if (res.status === 404) {
            throw new ImageStoreError(`${this.describe()}: no such bucket (HTTP 404). Create it, or fix ${S3_ENV.bucket}.`);
        }
        if (res.status === 401 || res.status === 403) {
            throw new ImageStoreError(
                `${this.describe()} refused these credentials (HTTP ${res.status}). Check ${S3_ENV.accessKeyId} and `
                + `${S3_ENV.secretAccessKey}, and that the token may read and write this bucket.`,
            );
        }
        throw new ImageStoreError(`${this.describe()} answered HTTP ${res.status} to a bucket check.`);
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
        const { value, done } = await reader.read();
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
