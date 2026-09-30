import http from 'node:http';
import type { FetchLike } from '@beanpool/signin';

/**
 * `fetch` over a Unix socket, as Caddy reaches the API on the image: the URL's path and host go in the request (the
 * host is what a request is signed for), the bytes go to `socketPath`. Each call opens its own connection, as Caddy does
 * with keep-alive off.
 */
export function unixFetch(socketPath: string): FetchLike {
    return (input, init) => new Promise<Response>((resolve, reject) => {
        const url = new URL(input);
        const headers: Record<string, string> = { Host: url.host, Connection: 'close' };
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
        const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
        if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
        const req = http.request({ socketPath, path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', headers, agent: false }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: res.headers as Record<string, string> })));
            res.on('error', reject);
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}
