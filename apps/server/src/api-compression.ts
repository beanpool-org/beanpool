/**
 * gzip for the node's /api answers.
 *
 * The global load test (scratch/global-node/geosync-load, REPORT-geosync-load-A, 10 Oct) found the node sent every /api
 * answer raw: no Content-Encoding, even to a reader that sent `Accept-Encoding: gzip`. A first sync at 20,000 listings
 * was 26.6 MB on the wire, against 4.2 MB gzipped, on the prepaid data our members pay for. Only an edge in front of the
 * node (Cloudflare, by default) compressed it, and a self-hoster's node has none (no-domain-lock-in: nothing may need ours).
 *
 * So an /api answer is gzipped here when the reader asks for gzip and the answer is worth it:
 *   - text: JSON, text/* (not an event stream), JavaScript or XML, held whole as an object, a string or a Buffer. A
 *     stream (an event stream, a backup's .tar.gz, a .bpsealed, a photo's file) goes out as it is: it was never held
 *     whole, and most of them are compressed already. So does an image, whatever its body.
 *   - at least MIN_BYTES: under that, gzip's header and a round of zlib cost more than they save.
 *   - not already encoded: the shared directory and roster snapshots carry their own gzip copy, made once and sent to
 *     every reader (members-snapshot.ts). Compressing it again would cost a copy per reader and save nothing.
 *   - not a heavy read (heavy-reads.ts): the cap learns each answer's weight from its Content-Length as it goes out.
 *     Compressed here, it would learn the gzip size and let in answers whose raw build is many times that. So those keep
 *     their bytes, and their accounting, exactly as before; the directory's and a roster's shared snapshots are gzipped
 *     there already.
 *   - not a HEAD, a 204, a 304, a range (206, or a request with Range), or a body-less answer.
 * Any answer that could have been gzipped says `Vary: Accept-Encoding`, whether it was or not, so no cache in between
 * hands one reader's encoding to another.
 *
 * ETags. Every route compares If-None-Match with its tag the weak way (it strips `W/`), and nearly all its tags are weak
 * already. A strong tag on an answer that is gzipped here is made weak (`"x"` → `W/"x"`), as nginx does: a strong tag
 * promises the same bytes, and the gzip bytes aren't. A reader that holds either form gets its 304, plain or gzipped.
 *
 * Level GZIP_LEVEL, chosen by measurement (bench-api-compression.ts, sync-page-shaped JSON, an M4 Pro, 11 Oct): per MB of
 * JSON, level 1 took 4.1 ms to 3.29×, level 4 8.5 ms to 3.65×, level 6 13.6 ms to 3.80×, level 9 18.5 ms to 3.84×. Level
 * 4 is the knee: 11% fewer bytes than level 1, while level 6 saves 4% more for 60% more CPU. A sync page (200 listings,
 * ~263 KB) is then about 2 ms of CPU here, 5 on the global droplet. The compression runs on libuv's pool (zlib's async
 * gzip), not on the event loop.
 *
 * The operator's switch, API_GZIP in .env (apiGzipFromEnv). Empty = on. `off` = this middleware isn't registered at all:
 * every /api answer goes out as the route made it, with no Vary of ours. For a node behind an edge that compresses for
 * the phones already: global, test and mullum sit behind Cloudflare, which answered phones with `Content-Encoding: br`
 * (the director, 11 Oct). There this saves only the node→edge bytes and costs the node's CPU, which on one vCPU shares
 * its core with the event loop (the #1764 review, F2). The directory's and rosters' snapshots keep their own gzip copy
 * either way: made once, for every reader.
 */
import { promisify } from 'node:util';
import { gzip as gzipCallback, constants as zlibConstants } from 'node:zlib';
import { Stream } from 'node:stream';
import type Koa from 'koa';
import { isHeavyRead } from './heavy-reads.js';

const gzipAsync = promisify(gzipCallback);

/** Smaller answers go out plain: gzip's 18-byte frame and a round of zlib cost more than they save. */
export const MIN_BYTES = 1024;
/** zlib's level, chosen by measurement (see above). */
export const GZIP_LEVEL = 4;
/** The .env line that turns the /api gzip off. */
export const API_GZIP_ENV = 'API_GZIP';

/**
 * Is the /api gzip on? `off` (or 0, false, no; any case) turns it off. Empty, or on/1/true/yes, leave it on. Anything
 * else leaves it on too, with a warning in the log: on is what a node without an edge in front needs.
 */
export function apiGzipFromEnv(raw: string | undefined = process.env[API_GZIP_ENV]): boolean {
    const value = (raw ?? '').trim().toLowerCase();
    if (['off', '0', 'false', 'no'].includes(value)) return false;
    if (['', 'on', '1', 'true', 'yes'].includes(value)) return true;
    console.warn(`⚠️  ${API_GZIP_ENV}=${JSON.stringify(raw)} is neither on nor off, so this node gzips /api answers for readers that ask. Set ${API_GZIP_ENV}=off to stop it.`);
    return true;
}

/** A content type worth compressing: text of every kind but an event stream (SSE goes out a frame at a time). */
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-ndjson|[\w.+-]+\+(?:json|xml))\b)/i;

/** Statuses that carry no body to compress. */
const NO_BODY = new Set([204, 205, 206, 304]);

/** Is this an /api path (/api itself, or anything under it)? */
function isApiPath(path: string): boolean {
    return path === '/api' || path.startsWith('/api/');
}

/** Is the body one held whole (an object, a string or a Buffer), not a stream or nothing? */
function heldWhole(body: unknown): body is object | string {
    return typeof body === 'string' || (body != null && typeof body === 'object' && !(body instanceof Stream));
}

/** A body held whole as the bytes Koa would send: an object becomes its JSON, as Koa's respond makes it. */
function asSent(body: object | string): Buffer | string {
    return typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
}

/** `"x"` → `W/"x"`; a weak tag, or none, as it is. */
export function weakEtag(tag: string): string {
    return tag.startsWith('W/') ? tag : `W/${tag}`;
}

/**
 * The middleware. Register it first among those that set or change a body, so every body is final by the time it
 * runs (its work is after `next()`).
 */
export function apiCompression(): Koa.Middleware {
    return async (ctx, next) => {
        await next();
        if (!isApiPath(ctx.path) || ctx.method === 'HEAD') return;
        const status = ctx.status;
        if (status < 200 || NO_BODY.has(status)) return;
        if (ctx.response.get('Content-Encoding') || ctx.response.get('Content-Range') || ctx.get('Range')) return;
        if (!COMPRESSIBLE.test(ctx.response.get('Content-Type'))) return;
        if (!heldWhole(ctx.body) || isHeavyRead(ctx)) return;

        ctx.vary('Accept-Encoding');
        // An object is made its JSON only for a reader that asks: for any other, Koa makes it as it sends, once.
        if (ctx.acceptsEncodings('gzip', 'identity') !== 'gzip') return;
        const body = asSent(ctx.body);
        const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
        if (size < MIN_BYTES) {
            // Made here, it goes to Koa as made, not made again. The Content-Type the route set stays (Koa sets one only
            // where none was).
            if (body !== ctx.body) ctx.body = body;
            return;
        }

        const gzipped = await gzipAsync(body, { level: GZIP_LEVEL, memLevel: zlibConstants.Z_DEFAULT_MEMLEVEL });
        // The reader may have gone while it was compressed: Koa then writes nothing, as it would have.
        const etag = ctx.response.get('ETag');
        if (etag) ctx.set('ETag', weakEtag(etag));
        ctx.set('Content-Encoding', 'gzip');
        // A Buffer keeps the Content-Type the route set (Koa sets one only where none was), and gets its own length.
        ctx.body = gzipped;
    };
}
