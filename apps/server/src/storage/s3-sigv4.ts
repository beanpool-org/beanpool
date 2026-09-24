/**
 * AWS Signature Version 4 for S3-compatible object stores (Cloudflare R2 first), on `node:crypto` alone.
 *
 * ## Why not a library
 *
 * `@aws-sdk/client-s3` adds tens of megabytes to the image every self-hoster pulls, to run on 1 GB servers,
 * for the five requests the image store makes. `aws4fetch` — the client Cloudflare documents for R2 — is small
 * and dependency-free, but it signs through WebCrypto, which is asynchronous: `crypto.subtle.sign` returns a
 * promise. The image store's interface is synchronous (see image-store.ts: `put` is reached from code that
 * runs around `db.transaction` bodies), so the synchronous path has to be able to sign without awaiting. HMAC
 * and SHA-256 are synchronous in `node:crypto`, and the whole algorithm is the ~100 lines below.
 *
 * Checked against the worked examples in the S3 SigV4 documentation (test-s3-image-store.ts), so a mistake
 * here is a failing assertion, not a 403 discovered on the global node.
 *
 * ## What never leaves this file
 *
 * The secret access key. It is an input to {@link signingKey} and nothing else; the output is the signature,
 * which is safe to send, log and hand to the worker thread that performs the request.
 */

import crypto from 'node:crypto';

export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
    accessKeyId: string;
    secretAccessKey: string;
}

export interface SigV4Request {
    method: string;
    url: URL;
    /** Headers to send and sign. `host`, `x-amz-date` and `x-amz-content-sha256` are added for you. */
    headers?: Record<string, string>;
    /** Lowercase hex SHA-256 of the body; {@link EMPTY_PAYLOAD_SHA256} for none. */
    payloadSha256: string;
    region: string;
    service?: string;
    /** The signing time. Tests pin it; everything else takes now. */
    now?: Date;
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC 3986 encoding as SigV4 wants it: everything but `A-Z a-z 0-9 - _ . ~` is %XX, uppercase hex. */
export function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The path, each segment encoded once (S3 is the one service that does not double-encode). */
function canonicalUri(url: URL): string {
    const raw = url.pathname || '/';
    return raw.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/');
}

function canonicalQuery(url: URL): string {
    const pairs: [string, string][] = [];
    for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** `20130524T000000Z` */
export function amzDate(now: Date): string {
    return now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secretAccessKey}`, date);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

export interface SignedRequest {
    /** Every header to send, including `authorization`. Lowercase names. */
    headers: Record<string, string>;
    /** For tests: the intermediate strings the documentation publishes. */
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
}

/**
 * Sign a request. Returns the headers to send — the caller's, plus `host`, `x-amz-date`,
 * `x-amz-content-sha256` and `authorization`.
 */
export function signRequest(req: SigV4Request, creds: SigV4Credentials): SignedRequest {
    const service = req.service ?? 's3';
    const stamp = amzDate(req.now ?? new Date());
    const date = stamp.slice(0, 8);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = String(v);
    headers['host'] = req.url.host;
    headers['x-amz-date'] = stamp;
    headers['x-amz-content-sha256'] = req.payloadSha256;

    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
        req.method.toUpperCase(),
        canonicalUri(req.url),
        canonicalQuery(req.url),
        canonicalHeaders,
        signedHeaders,
        req.payloadSha256,
    ].join('\n');

    const scope = `${date}/${req.region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = crypto
        .createHmac('sha256', signingKey(creds.secretAccessKey, date, req.region, service))
        .update(stringToSign, 'utf8')
        .digest('hex');

    headers['authorization'] =
        `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { headers, canonicalRequest, stringToSign, signature };
}
