/**
 * A large answer goes to a TLS connection a window at a time, so an idle connection doesn't keep the answer's size in
 * memory after it has gone (#1746).
 *
 * Koa writes a body it holds whole (a Buffer, a string, an object's JSON) to the socket in one write. On a TLS socket,
 * Node's TLS layer then sizes its outgoing buffer for the whole encrypted answer, and keeps that buffer with the
 * connection until the connection closes, not just until the answer has gone. A phone that reads a 1.5 MB answer and
 * keeps its connection for the next request therefore held 1.6 MB of the server's memory per connection; at the 4,096
 * connections a listener allows (server-limits.ts) that is gigabytes, far past a 1 GB droplet.
 *
 * Written 64 KB at a time, the same connection holds about 0.20 MB, and 0.11 MB after a 1 KB answer: that last is Node's
 * and OpenSSL's own state for an open TLS connection, ours or not. Measured with Node 26 on a Mac, live malloc after 512,
 * 2,048 and 4,096 idle keep-alive connections had each read their whole answer (the PR for #1746 has the table). Plain
 * HTTP (the listener the Cloudflare tunnel reaches, http-server.ts) holds about 0.01 MB either way, so it is left alone.
 *
 * Bodies already streamed (a file, the members directory's shared windows: members-snapshot.ts) are left as they are,
 * as are HEAD and bodiless answers. The Content-Type and Content-Length stay what they were: the reader sees the same
 * bytes and headers, sent in pieces.
 */
import { Readable, Stream } from 'node:stream';
import type Koa from 'koa';

/** The most one write hands the TLS layer, and the largest body sent whole. */
export const TLS_SEND_WINDOW_BYTES = 64 * 1024;

const NO_BODY = new Set([204, 205, 304]);

function* windows(bytes: Buffer, size: number): Generator<Buffer> {
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/**
 * The middleware. Register it before every other that sets or changes a body (api-compression.ts included), so its work,
 * after `next()`, sees the final body.
 */
export function tlsSendWindows(size: number = TLS_SEND_WINDOW_BYTES): Koa.Middleware {
    return async function tlsSendWindowsMiddleware(ctx, next) {
        await next();
        if (ctx.respond === false || ctx.method === 'HEAD' || ctx.status < 200 || NO_BODY.has(ctx.status)) return;
        if (!(ctx.req.socket as { encrypted?: boolean } | null)?.encrypted) return;
        const body: unknown = ctx.body;
        if (body == null || body instanceof Stream || (typeof body !== 'string' && typeof body !== 'object')) return;
        // An object is made its JSON here, as Koa's respond would make it (api-compression.ts does the same).
        const made = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        const length = typeof made === 'string' ? Buffer.byteLength(made) : made.length;
        if (length <= size) {
            // Made here, it goes to Koa as made, not made again; the Content-Type the route set stays.
            if (made !== body) ctx.body = made;
            return;
        }
        const bytes = typeof made === 'string' ? Buffer.from(made) : made;
        // Koa drops the Content-Length when a body becomes a stream; the same bytes go, so it is set again.
        ctx.body = Readable.from(windows(bytes, size), { objectMode: false });
        ctx.length = bytes.length;
    };
}
