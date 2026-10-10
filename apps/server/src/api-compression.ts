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
 * Level GZIP_LEVEL, chosen by measurement on a 200-listing sync page and a 26 MB answer (PR #—, the lane gzip's
 * bench-api-compression.ts): level 1 was barely faster than 6 at a noticeably larger answer, and 9 cost several times
 * the CPU for under a percent more. The compression runs off the main thread (zlib's async gzip, on libuv's pool), so a
 * big answer doesn't stall the event loop.
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
export const GZIP_LEVEL = 6;

/** A content type worth compressing: text of every kind but an event stream (SSE goes out a frame at a time). */
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-ndjson|[\w.+-]+\+(?:json|xml))\b)/i;

/** Statuses that carry no body to compress. */
const NO_BODY = new Set([204, 205, 206, 304]);

/** Is this an /api path (/api itself, or anything under it)? */
function isApiPath(path: string): boolean {
    return path === '/api' || path.startsWith('/api/');
}

/** The body as the bytes Koa would send, or null when it isn't one held whole (a stream, nothing). */
function wholeBody(body: unknown): Buffer | string | null {
    if (body == null) return null;
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return body;
    if (body instanceof Stream) return null;
    if (typeof body === 'object') return JSON.stringify(body);
    return null;
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
        const body = wholeBody(ctx.body);
        if (body === null) return;
        if (isHeavyRead(ctx)) return;

        ctx.vary('Accept-Encoding');
        const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
        if (size < MIN_BYTES) return;
        if (ctx.acceptsEncodings('gzip', 'identity') !== 'gzip') return;

        const gzipped = await gzipAsync(body, { level: GZIP_LEVEL, memLevel: zlibConstants.Z_DEFAULT_MEMLEVEL });
        // The reader may have gone while it was compressed: Koa then writes nothing, as it would have.
        const etag = ctx.response.get('ETag');
        if (etag) ctx.set('ETag', weakEtag(etag));
        ctx.set('Content-Encoding', 'gzip');
        // A Buffer keeps the Content-Type the route set (Koa sets one only where none was), and gets its own length.
        ctx.body = gzipped;
    };
}
