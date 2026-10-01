import crypto from 'node:crypto';
import type { FetchLike } from '@beanpool/signin';
import { BACKUP_NAME_RE, compareBackupNames } from '../shared/backup-format.js';
import { virtualHostUrl, type OffsiteS3 } from '../shared/settings.js';
import type { BackupStore } from './backup-store.js';

/**
 * The off-box backup store (key vault design §4): any S3-compatible object store, over its REST API with AWS Signature
 * Version 4, signed here with node:crypto (no SDK, nothing native). Four calls: PutObject, GetObject,
 * ListObjectsV2 and DeleteObject, on the objects under one prefix of one bucket.
 *
 * The store is trusted with nothing but keeping the bytes. What goes up is the backup file exactly as the keyholder
 * sealed and signed it (shared/backup-format.ts): the database and the deletion records under keys only `M` opens,
 * a plain header (the vault's id, the time, the generation, the custodians' public keys and the keyholder's state,
 * itself sealed under `M`), and a signature. The object's name is the backup's name (`bv-<time>.bin`) under the
 * prefix; it carries no metadata of its own. The payload's SHA-256 is signed with the request, so the store refuses
 * bytes changed on the way; a file changed in the store fails the keyholder's signature check when it is opened.
 *
 * An error says what failed in a few words (`HTTP 403 AccessDenied`, `unreachable`, `timed out`): never a body, a
 * key or a URL, since it goes into the public report and the alerts.
 */

const SERVICE = 's3';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
/** Up to the whole local budget (1 GiB) goes up in one request; a slow link gets this long. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

export class OffsiteError extends Error {
    constructor(readonly short: string) {
        super(short);
        this.name = 'OffsiteError';
    }
}

export class OffsiteNotFound extends OffsiteError {
    constructor() {
        super('not found');
    }
}

// ─── Signature Version 4 ─────────────────────────────────────────────────────────────────────

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~ (and '/' in a path, when kept). */
export function uriEncode(s: string, keepSlash = false): string {
    let out = '';
    for (const byte of Buffer.from(s, 'utf8')) {
        const c = String.fromCharCode(byte);
        if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
        else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
}

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');

export interface SignV4Input {
    method: string;
    /** The path as sent (already encoded), e.g. `/bucket/vault/bv-…bin`. */
    path: string;
    /** Query parameters, not yet encoded. */
    query?: Record<string, string>;
    /** Every header to sign, `host` included; names any case. */
    headers: Record<string, string>;
    payloadSha256: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service?: string;
    /** `YYYYMMDDTHHMMSSZ`. */
    amzDate: string;
}

/** The Authorization header for a request (AWS SigV4, single chunk). */
export function signV4(r: SignV4Input): { authorization: string; canonicalRequest: string; stringToSign: string } {
    const service = r.service ?? SERVICE;
    const query = Object.entries(r.query ?? {})
        .map(([k, v]) => [uriEncode(k), uriEncode(v)])
        .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`).join('&');
    const headers = Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join('');
    const signedHeaders = headers.map(([k]) => k).join(';');
    const canonicalRequest = [r.method, r.path, query, canonicalHeaders, signedHeaders, r.payloadSha256].join('\n');
    const date = r.amzDate.slice(0, 8);
    const scope = `${date}/${r.region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', r.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${r.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, r.region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    return {
        authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        canonicalRequest,
        stringToSign,
    };
}

export function amzDateOf(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// ─── The store ───────────────────────────────────────────────────────────────────────────────

function xmlText(s: string): string {
    return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
        if (e === 'lt') return '<';
        if (e === 'gt') return '>';
        if (e === 'quot') return '"';
        if (e === 'apos') return '\'';
        if (e === 'amp') return '&';
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
}

/** The S3 error code in a response body (`<Code>AccessDenied</Code>`), if it is a plain word. */
function errorCode(body: string): string {
    const m = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body);
    return m ? ` ${m[1]}` : '';
}

export class S3Store implements BackupStore {
    private readonly fetch: FetchLike;
    private readonly clock: () => number;
    private readonly base: URL;

    constructor(private readonly s: OffsiteS3, opts: { fetch?: FetchLike; clock?: () => number } = {}) {
        this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.clock = opts.clock ?? (() => Date.now());
        this.base = new URL(s.pathStyle ? s.endpoint : virtualHostUrl(s));
    }

    /** The encoded path of an object (or of the bucket, for `key` ''). */
    private pathOf(key: string): string {
        const bucketPart = this.s.pathStyle ? `/${uriEncode(this.s.bucket)}` : '';
        return key ? `${bucketPart}/${uriEncode(key, true)}` : (bucketPart || '/');
    }

    private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, opts: { query?: Record<string, string>; body?: Uint8Array; timeoutMs?: number } = {}): Promise<{ status: number; body: Buffer }> {
        const path = this.pathOf(key);
        const payloadSha256 = opts.body ? sha256Hex(opts.body) : EMPTY_SHA256;
        const amzDate = amzDateOf(this.clock());
        const headers: Record<string, string> = { host: this.base.host, 'x-amz-content-sha256': payloadSha256, 'x-amz-date': amzDate };
        const { authorization } = signV4({
            method, path, query: opts.query, headers, payloadSha256, accessKeyId: this.s.accessKeyId, secretAccessKey: this.s.secretAccessKey,
            region: this.s.region, amzDate,
        });
        const qs = Object.entries(opts.query ?? {}).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
        const url = `${this.base.origin}${path}${qs ? `?${qs}` : ''}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CALL_TIMEOUT_MS);
        try {
            const sendHeaders: Record<string, string> = { 'x-amz-content-sha256': payloadSha256, 'x-amz-date': amzDate, Authorization: authorization };
            if (opts.body) sendHeaders['Content-Type'] = 'application/octet-stream';
            const res = await this.fetch(url, { method, headers: sendHeaders, body: opts.body, signal: controller.signal });
            return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
        } catch (e) {
            if (e instanceof OffsiteError) throw e;
            throw new OffsiteError(controller.signal.aborted ? 'timed out' : 'unreachable');
        } finally {
            clearTimeout(timer);
        }
    }

    private failed(status: number, body: Buffer): never {
        throw new OffsiteError(`HTTP ${status}${errorCode(body.toString('utf8').slice(0, 4096))}`);
    }

    private keyOf(name: string): string {
        if (!BACKUP_NAME_RE.test(name)) throw new OffsiteError('not a backup name');
        return `${this.s.prefix}${name}`;
    }

    async put(name: string, bytes: Uint8Array): Promise<void> {
        const r = await this.request('PUT', this.keyOf(name), { body: bytes, timeoutMs: TRANSFER_TIMEOUT_MS });
        if (r.status !== 200) this.failed(r.status, r.body);
    }

    async get(name: string): Promise<Buffer> {
        const r = await this.request('GET', this.keyOf(name), { timeoutMs: TRANSFER_TIMEOUT_MS });
        if (r.status === 404) throw new OffsiteNotFound();
        if (r.status !== 200) this.failed(r.status, r.body);
        return r.body;
    }

    /** Every backup name under the prefix, oldest first. Anything else there is not the vault's and is left alone. */
    async list(): Promise<string[]> {
        const names: string[] = [];
        let token: string | null = null;
        for (let page = 0; page < 1000; page++) {
            const query: Record<string, string> = { 'list-type': '2', prefix: this.s.prefix };
            if (token) query['continuation-token'] = token;
            const r = await this.request('GET', '', { query });
            if (r.status !== 200) this.failed(r.status, r.body);
            const xml = r.body.toString('utf8');
            for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
                const key = xmlText(m[1]);
                if (!key.startsWith(this.s.prefix)) continue;
                const name = key.slice(this.s.prefix.length);
                if (BACKUP_NAME_RE.test(name)) names.push(name);
            }
            const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
            const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
            if (!truncated) return names.sort(compareBackupNames);
            if (!next) throw new OffsiteError('listing cut short');
            token = xmlText(next[1]);
        }
        throw new OffsiteError('listing too long');
    }

    async delete(name: string): Promise<void> {
        const r = await this.request('DELETE', this.keyOf(name));
        if (r.status !== 204 && r.status !== 200 && r.status !== 404) this.failed(r.status, r.body);
    }
}
