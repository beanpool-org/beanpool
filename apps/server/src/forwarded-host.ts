/**
 * The host and the scheme a request reached, for every Koa app this server makes (security inventory 17 Nov 2026, risk 5,
 * split off from #3293: forwarded host and protocol).
 *
 * Koa's `app.proxy = true` believed X-Forwarded-Host and X-Forwarded-Proto from ANY peer: ctx.host, ctx.hostname, ctx.origin,
 * ctx.href and ctx.URL took the host a client named, and ctx.protocol, ctx.secure (and so each cookie's Secure flag) the scheme
 * it named. useOwnHostAndScheme turns that off and puts one rule in its place:
 *
 *   - The scheme: https when the socket is TLS. On the plain port, https only when a proxy this server trusts (client-ip.ts
 *     isTrustedProxy: loopback, TRUSTED_PROXIES, docker-host, the one rule a client's address is read by) says the leg before
 *     it was https: X-Forwarded-Proto's first hop, or Forwarded: proto= (saysHttpsBefore, the plain port's gate reads the same).
 *     Cloudflare overwrites X-Forwarded-Proto with the scheme the visitor used, so the tunnel's is the visitor's real one; Caddy
 *     and Traefik set it themselves, nginx when told to. From anyone else: http, whatever they say.
 *   - The host: the Host header the request carried (HTTP/2's :authority), from everyone. X-Forwarded-Host is believed from no
 *     one, a trusted proxy included: Cloudflare "passes all HTTP request headers to your origin web server" and adds only its
 *     own, X-Forwarded-Host not among them (developers.cloudflare.com/fundamentals/reference/http-headers, read 18 Nov 2026), so
 *     through our tunnel it is the visitor's own words, under the Host that Cloudflare routed by. cloudflared keeps that Host,
 *     and so do Caddy and Traefik; nginx needs `proxy_set_header Host $host;` (the operator manual, Address and peers).
 *
 * A reader that needs the host or scheme reads ctx.host / ctx.hostname / ctx.protocol / ctx.secure / ctx.origin, never the
 * X-Forwarded-* headers themselves (test-forwarded-host.ts holds the list of readers and fails on a new one).
 */
import type { IncomingMessage } from 'node:http';
import type Koa from 'koa';
import { isTrustedProxy } from './client-ip.js';

/** Whether a proxy's headers say the request before it came over https: the first hop's X-Forwarded-Proto or proto=. */
export function saysHttpsBefore(req: { forwardedProto?: string | undefined; forwarded?: string | undefined }): boolean {
    const xfp = (req.forwardedProto ?? '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https') return true;
    const first = (req.forwarded ?? '').split(',')[0];
    return /(?:^|;)\s*proto\s*=\s*"?https"?\s*(?:;|$)/i.test(first);
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(',') : v);

/** The scheme this request reached (above): the socket's own, or https from a trusted proxy that says so. */
export function reachedScheme(req: Pick<IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string; encrypted?: boolean } | null }): 'https' | 'http' {
    const socket = req.socket;
    if (socket?.encrypted) return 'https';
    if (!socket || !isTrustedProxy(socket.remoteAddress)) return 'http';
    return saysHttpsBefore({ forwardedProto: one(req.headers['x-forwarded-proto']), forwarded: one(req.headers.forwarded) }) ? 'https' : 'http';
}

/**
 * Koa's host and scheme by the rule above, for every request `app` answers: proxy off (ctx.host is the Host header, ctx.ips
 * is empty; ctx.ip is set to clientIp() by https-server.ts first), and ctx.protocol from reachedScheme, which ctx.secure,
 * ctx.origin, ctx.href, ctx.URL and the cookies' Secure flag read. Defined on this app's own request prototype only.
 */
export function useOwnHostAndScheme(app: Koa): void {
    app.proxy = false;
    Object.defineProperty(app.request, 'protocol', {
        configurable: true,
        enumerable: true,
        get(this: Koa.Request) { return reachedScheme(this.req); },
    });
}
