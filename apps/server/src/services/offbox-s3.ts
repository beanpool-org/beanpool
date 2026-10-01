/**
 * The S3 client for off-box backups (services/offbox-backups.ts): PUT a sealed backup file, LIST what a destination
 * holds, GET one back as a stream, DELETE one past its retention. Any S3-compatible store an operator chooses —
 * Cloudflare R2, Backblaze B2, Wasabi, AWS, a MinIO or Garage of their own. None is built in, and none is ours.
 *
 * ## Why not the image store's client
 *
 * `storage/s3-image-store.ts` holds a photo in memory (objects of a few MB at most) and only takes keys inside the
 * image store's own namespaces. A backup is the whole community, hundreds of MB on a large one, so this client streams
 * the file from disk with its length and hash known up front, and takes the operator's prefix as it is. The signing is
 * the same {@link signRequest}, already checked against AWS's published examples (test-s3-image-store.ts).
 *
 * ## Requests
 *
 * Path-style (`<endpoint>/<bucket>/<key>`), which R2, B2, MinIO and AWS all accept. `https:` only; plain `http:` for a
 * loopback host alone (the tests' stand-in), as the image store allows. Redirects are never followed: a store that
 * answers 3xx is answering something else. The payload's SHA-256 is signed (`x-amz-content-sha256`), so the store
 * refuses a body altered on the way, and it travels as `x-amz-meta-sha256` too, so a download can be checked.
 *
 * ## Retries
 *
 * Each request is tried {@link OffboxTuning.attempts} times, re-signed each time, waiting {@link OffboxTuning.backoffMs}
 * and then double that between tries — on a 5xx or no answer at all. A 4xx is the store saying something true (no such
 * bucket, access denied) and asking again changes nothing. A request has no overall deadline, because a large backup on
 * a slow uplink can take a long time; it is ended when nothing moves for {@link OffboxTuning.idleMs}.
 *
 * ## What never leaves this file
 *
 * The secret access key. It lives in a WeakMap off the instance, so neither logging nor serialising a client prints it,
 * and every error names the store and the S3 error code, never a request or an answer's body.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import util from 'node:util';
import type { Readable } from 'node:stream';
import { EMPTY_PAYLOAD_SHA256, signRequest, uriEncode, type SigV4Credentials } from '../storage/s3-sigv4.js';

export interface OffboxS3Config {
    /** The bare endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export interface OffboxTuning {
    attempts: number;
    /** First wait between attempts; doubles each time. */
    backoffMs: number;
    /** A request with nothing sent or received for this long is ended (and retried). */
    idleMs: number;
}

export const DEFAULT_OFFBOX_TUNING: OffboxTuning = { attempts: 3, backoffMs: 2_000, idleMs: 120_000 };

/**
 * The largest file one PUT may carry. S3 and R2 take up to 5 GiB in a single PUT; past that needs a multipart upload,
 * which this client does not do. A backup that big is refused in words before a byte is sent.
 */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

/** The most one ListObjectsV2 page or error body is read: a thousand keys of ours is well under 1 MB of XML. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 10_000;

/** What went wrong, in words safe for a log and a screen: the store and the S3 code, never a credential or a body. */
export class OffboxS3Error extends Error {
    constructor(message: string, readonly status: number | null = null, readonly code: string | null = null) {
        super(message);
        this.name = 'OffboxS3Error';
    }
}

export interface OffboxObject {
    key: string;
    bytes: number;
    mtimeMs: number;
}

/** The S3 error code in an answer's body (`<Code>AccessDenied</Code>`), never the body itself. */
function s3ErrorCode(text: string): string | null {
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

/** One page of a ListObjectsV2 answer, every key as the store spelled it. */
export function parseListObjects(xml: string): { objects: OffboxObject[]; nextToken: string | null } {
    const objects: OffboxObject[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(m[1], 'Key');
        if (!key) continue;
        const bytes = Number(tag(m[1], 'Size'));
        const mtimeMs = Date.parse(tag(m[1], 'LastModified') || '');
        objects.push({ key, bytes: Number.isFinite(bytes) ? bytes : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 });
    }
    const truncated = (tag(xml, 'IsTruncated') || '').trim() === 'true';
    return { objects, nextToken: truncated ? tag(xml, 'NextContinuationToken') : null };
}

/** Where the credentials live: off the instance, so logging or serialising a client cannot print them. */
const secrets = new WeakMap<OffboxBucket, SigV4Credentials>();

interface Answer {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** The body unread. The caller reads it ({@link readText}) or streams it, and must do one of the two. */
    res: http.IncomingMessage;
}

async function readText(res: http.IncomingMessage, max = MAX_TEXT_BYTES): Promise<string> {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of res) {
        total += (chunk as Buffer).length;
        if (total > max) {
            res.destroy();
            throw new OffboxS3Error(`the answer was over ${max} bytes`);
        }
        parts.push(chunk as Buffer);
    }
    return Buffer.concat(parts).toString('utf8');
}

function drain(res: http.IncomingMessage): void {
    res.resume();
    res.on('error', () => { /* nothing more is wanted from it */ });
}

export class OffboxBucket {
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    private readonly tuning: OffboxTuning;

    constructor(config: OffboxS3Config, tuning: Partial<OffboxTuning> = {}) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.bucket = config.bucket;
        this.region = config.region;
        this.tuning = { ...DEFAULT_OFFBOX_TUNING, ...tuning };
        secrets.set(this, { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
    }

    /** What an operator may see: where the copies are, never how to get at them. */
    describe(): string {
        return `bucket "${this.bucket}" at ${new URL(this.endpoint).host}`;
    }

    toJSON(): Record<string, string> {
        return { endpoint: this.endpoint, bucket: this.bucket, region: this.region };
    }

    [util.inspect.custom](): string {
        return `OffboxBucket { ${this.describe()} }`;
    }

    private objectUrl(key: string): URL {
        return new URL(`${this.endpoint}/${uriEncode(this.bucket)}/${key.split('/').map(uriEncode).join('/')}`);
    }

    private bucketUrl(query: Record<string, string> = {}): URL {
        const url = new URL(`${this.endpoint}/${uriEncode(this.bucket)}`);
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        return url;
    }

    /** One attempt: sign, send (the file, when there is one), and resolve with the answer's head. */
    private once(method: string, url: URL, body: { file: string; bytes: number; sha256: string } | null, headers: Record<string, string>): Promise<Answer> {
        const creds = secrets.get(this);
        if (!creds) return Promise.reject(new OffboxS3Error(`${this.describe()}: no credentials`));
        const signed = signRequest({
            method, url, headers, payloadSha256: body ? body.sha256 : EMPTY_PAYLOAD_SHA256, region: this.region,
        }, creds);
        const sendHeaders: Record<string, string> = { ...signed.headers };
        if (body) sendHeaders['content-length'] = String(body.bytes);
        const lib = url.protocol === 'https:' ? https : http;
        return new Promise<Answer>((resolve, reject) => {
            let settled = false;
            const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } };
            const req = lib.request(url, { method, headers: sendHeaders }, (res) => {
                if (settled) { drain(res); return; }
                settled = true;
                // The idle deadline keeps running while the caller reads the body.
                res.setTimeout(this.tuning.idleMs, () => res.destroy(new Error(`nothing arrived for ${this.tuning.idleMs} ms`)));
                resolve({ status: res.statusCode ?? 0, headers: res.headers, res });
            });
            req.setTimeout(this.tuning.idleMs, () => req.destroy(new Error(`nothing moved for ${this.tuning.idleMs} ms`)));
            req.on('error', (e: NodeJS.ErrnoException) => fail(new Error(e?.code || e?.message || String(e))));
            if (!body) { req.end(); return; }
            const source: Readable = fs.createReadStream(body.file);
            source.on('error', (e) => { req.destroy(e); fail(new OffboxS3Error(`could not read the backup file: ${e.message}`)); });
            source.pipe(req);
        });
    }

    /** {@link once} with retries on a 5xx or no answer. Resolves with any other answer; rejects when the tries run out. */
    private async call(what: string, method: string, url: URL, body: { file: string; bytes: number; sha256: string } | null = null,
        headers: Record<string, string> = {}): Promise<Answer> {
        let last = '';
        for (let attempt = 0; attempt < this.tuning.attempts; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, this.tuning.backoffMs * 2 ** (attempt - 1)));
            let answer: Answer;
            try {
                answer = await this.once(method, url, body, headers);
            } catch (e: any) {
                if (e instanceof OffboxS3Error) throw e;
                last = `no answer (${e?.message || e})`;
                continue;
            }
            if (answer.status >= 500 && answer.status <= 599) {
                const code = s3ErrorCode(await readText(answer.res).catch(() => ''));
                last = `HTTP ${answer.status}${code ? ` ${code}` : ''}`;
                continue;
            }
            return answer;
        }
        throw new OffboxS3Error(`${this.describe()}: ${what} failed after ${this.tuning.attempts} tries: ${last}`);
    }

    /** Turn an answer that is not what was wanted into an error that says what the store said. */
    private async refuse(what: string, answer: Answer): Promise<never> {
        const code = s3ErrorCode(await readText(answer.res).catch(() => ''));
        const hint = answer.status === 401 || answer.status === 403
            ? ' The store refused these credentials: check the key and that it may read, write and delete in this bucket.'
            : code === 'NoSuchBucket' ? ' No such bucket: create it, or fix the bucket name.' : '';
        throw new OffboxS3Error(`${this.describe()}: ${what} answered HTTP ${answer.status}${code ? ` (${code})` : ''}.${hint}`, answer.status, code);
    }

    /**
     * Upload a file as `key`, streamed from disk. `sha256` is the file's, worked out by the caller before this is called,
     * and signed: the store refuses the upload if the body that arrives is not that file. Then the object's size is read
     * back from the store, so an upload that a proxy cut short is never counted as made.
     */
    async putFile(key: string, file: string, sha256: string): Promise<{ bytes: number }> {
        const bytes = fs.statSync(file).size;
        if (bytes > MAX_SINGLE_PUT_BYTES) {
            throw new OffboxS3Error(`${this.describe()}: the backup is ${bytes} bytes, more than one upload can carry `
                + `(${MAX_SINGLE_PUT_BYTES}); off-box backups of a community this large are not supported yet`);
        }
        const url = this.objectUrl(key);
        const answer = await this.call(`PUT ${key}`, 'PUT', url, { file, bytes, sha256 }, {
            'content-type': 'application/octet-stream',
            'x-amz-meta-sha256': sha256,
        });
        if (answer.status !== 200) return this.refuse(`PUT ${key}`, answer);
        drain(answer.res);
        const head = await this.head(key);
        if (!head) throw new OffboxS3Error(`${this.describe()}: PUT ${key} was answered, but the store does not have it`);
        if (head.bytes !== bytes) {
            throw new OffboxS3Error(`${this.describe()}: PUT ${key} was answered, but the store holds ${head.bytes} of its ${bytes} bytes`);
        }
        return { bytes };
    }

    /** An object's size, time and the hash it was uploaded with; null when it is not there. */
    async head(key: string): Promise<(OffboxObject & { sha256: string | null }) | null> {
        const answer = await this.call(`HEAD ${key}`, 'HEAD', this.objectUrl(key));
        drain(answer.res);
        if (answer.status === 404) return null;
        if (answer.status !== 200) return this.refuse(`HEAD ${key}`, answer);
        const bytes = Number(answer.headers['content-length']);
        const mtimeMs = Date.parse(String(answer.headers['last-modified'] || ''));
        const meta = String(answer.headers['x-amz-meta-sha256'] || '').toLowerCase();
        return {
            key, bytes: Number.isFinite(bytes) ? bytes : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
            sha256: /^[0-9a-f]{64}$/.test(meta) ? meta : null,
        };
    }

    /** Every object under `prefix` (as the store spells it), with its size and time: one request per thousand. */
    async list(prefix: string): Promise<OffboxObject[]> {
        const out: OffboxObject[] = [];
        const seen = new Set<string>();
        let token: string | null = null;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
            if (prefix) query.prefix = prefix;
            if (token) query['continuation-token'] = token;
            const answer = await this.call(`LIST ${prefix || '(all)'}`, 'GET', this.bucketUrl(query));
            if (answer.status !== 200) return this.refuse(`LIST ${prefix || '(all)'}`, answer);
            const parsed = parseListObjects(await readText(answer.res));
            out.push(...parsed.objects.filter((o) => o.key.startsWith(prefix)));
            if (!parsed.nextToken) return out;
            if (seen.has(parsed.nextToken)) throw new OffboxS3Error(`${this.describe()}: the listing gave the same page twice`);
            seen.add(parsed.nextToken);
            token = parsed.nextToken;
        }
        throw new OffboxS3Error(`${this.describe()}: the listing did not end within ${MAX_LIST_PAGES} pages`);
    }

    /** An object as a stream, with its length and upload hash; null when it is not there. */
    async openRead(key: string): Promise<{ stream: http.IncomingMessage; bytes: number | null; sha256: string | null } | null> {
        const answer = await this.call(`GET ${key}`, 'GET', this.objectUrl(key));
        if (answer.status === 404) {
            const code = s3ErrorCode(await readText(answer.res).catch(() => ''));
            if (code === 'NoSuchBucket') throw new OffboxS3Error(`${this.describe()}: no such bucket`, 404, code);
            return null;
        }
        if (answer.status !== 200) return this.refuse(`GET ${key}`, answer);
        const bytes = Number(answer.headers['content-length']);
        const meta = String(answer.headers['x-amz-meta-sha256'] || '').toLowerCase();
        return { stream: answer.res, bytes: Number.isFinite(bytes) ? bytes : null, sha256: /^[0-9a-f]{64}$/.test(meta) ? meta : null };
    }

    /** Remove an object. S3 answers 204 whether or not it was there. */
    async delete(key: string): Promise<void> {
        const answer = await this.call(`DELETE ${key}`, 'DELETE', this.objectUrl(key));
        if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) return this.refuse(`DELETE ${key}`, answer);
        drain(answer.res);
    }
}
