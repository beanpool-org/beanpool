/**
 * What the plain listener (http-server.ts, port 80 / 8080) may answer, and to whom (design
 * scratch/global-node/DESIGN-https-anywhere-fable.md D9, §6 and §7 S6).
 *
 * A node with no certificate of its own (a LAN or development node, a node reached only through a tunnel) answers on
 * port 80 exactly as it always has. Once this server holds a CA certificate for one of its addresses
 * (tls.ts holdsOwnCertificate), a request that did not come through a tunnel gets only the ACME challenge route (mounted
 * before this gate) and a 301 to https: never a page of the app, an API answer, a cookie or a live-updates socket in
 * cleartext. The redirect goes to the same host when it is one of this community's addresses, else to its main one.
 *
 * Which requests came through a tunnel is read from the socket, never from a header anyone can send (cf-connecting-ip was
 * only ever cosmetic):
 *   - loopback (127.0.0.0/8, ::1, ::ffff:127.x): cloudflared run by this server as its child, in the same container,
 *     dials LOOPBACK_ORIGIN (tunnel-connector.ts); so do the registrar's name watch and anything else inside the container.
 *     A connection from outside the container never has a loopback source: the container has its own network namespace.
 *   - a host-level tunnel: our fleet's hosts run cloudflared on the host, not in the container (docs/secrets-rotation-runbook.md;
 *     every ingress is localhost:<published port>). Docker's port proxy hands those connections on from the bridge
 *     gateway (172.16.0.0/12 and the like), never from loopback, so the loopback rule alone would send that tunnel's
 *     requests round a 301 loop on a fleet node that gained a certificate. Its requests name a beanpool.org host, which
 *     a browser only ever reaches through Cloudflare, where TLS for that name ends; so a request from a private-range
 *     source that names a beanpool.org host is let through as well.
 *   - a web server or proxy of the operator's own in front (the operator manual, "Behind a web server or proxy of your
 *     own"), on the host or on a Docker network, that holds the certificate and passes requests on to this port: it too
 *     arrives from a private range, naming the community's own domain. Where it says the visitor's request came over
 *     https (X-Forwarded-Proto: https, or Forwarded: proto=https: Caddy and Traefik send it by themselves, nginx when told
 *     to), it is let through, else it would be sent round the same loop once this server got a certificate of its own.
 * A private-range source that names any other host and says nothing of https (a LAN member, another stack on
 * beanpool-shared, an IPv6 visitor that Docker's proxy hands on from the gateway) is redirected. A public source is always
 * redirected, whatever host or header it sends: what lets a private-range source through is a claim about the leg before
 * it, which only a machine of the operator's own makes.
 */

import type Koa from 'koa';
import net from 'node:net';
import { configuredAddresses, isBeanPoolName, isLocalNetworkHost, normalizeAddress, primaryAddress } from './engine/own-addresses.js';
import { holdsOwnCertificate, servedHosts, servesCaCertificateFor } from './services/tls.js';

/** A socket's remote address as Node gives it, IPv4-mapped IPv6 unwrapped; '' for none. */
function plainAddress(remoteAddress: string | undefined): string {
    const a = (remoteAddress ?? '').trim().toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    return mapped ? mapped[1] : a;
}

/** A connection from this machine's own loopback: inside the container, cloudflared run by this server among them. */
export function isLoopbackSource(remoteAddress: string | undefined): boolean {
    const a = plainAddress(remoteAddress);
    if (net.isIPv4(a)) return a.startsWith('127.');
    return a === '::1';
}

/** A connection from a private range (RFC 1918, link-local, IPv6 unique-local and link-local) or loopback. */
export function isPrivateSource(remoteAddress: string | undefined): boolean {
    const a = plainAddress(remoteAddress);
    if (net.isIPv4(a)) return isLocalNetworkHost(a);
    if (net.isIPv6(a)) return a === '::1' || isLocalNetworkHost(`[${a}]`);
    return false;
}

export interface PlainRequest {
    /** The socket's remote address, as req.socket.remoteAddress gives it. */
    remoteAddress: string | undefined;
    /** The Host header as sent (with or without a port), or undefined. */
    host: string | undefined;
    /** The X-Forwarded-Proto header, or undefined. */
    forwardedProto?: string | undefined;
    /** The Forwarded header (RFC 7239), or undefined. */
    forwarded?: string | undefined;
}

/** Whether a proxy's headers say the request before it came over https: the first hop's X-Forwarded-Proto or proto=. */
export function saysHttpsBefore(req: Pick<PlainRequest, 'forwardedProto' | 'forwarded'>): boolean {
    const xfp = (req.forwardedProto ?? '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https') return true;
    const first = (req.forwarded ?? '').split(',')[0];
    return /(?:^|;)\s*proto\s*=\s*"?https"?\s*(?:;|$)/i.test(first);
}

/**
 * Whether the plain listener answers this request as it always has (the tunnel's delegation, the trust page, the
 * CF_RECORD_NAME redirect): on a node with no certificate of its own; from loopback; from a private-range source naming a
 * beanpool.org host (a host-level tunnel) or saying the request came over https before it (a proxy of the operator's own).
 * Everything else gets the redirect.
 */
export function plainHttpAnswersAsBefore(req: PlainRequest): boolean {
    if (isLoopbackSource(req.remoteAddress)) return true;
    if (!holdsOwnCertificate()) return true;
    if (!isPrivateSource(req.remoteAddress)) return false;
    const host = req.host ? normalizeAddress(req.host) : null;
    return (!!host && isBeanPoolName(host)) || saysHttpsBefore(req);
}

/**
 * Where the redirect goes: https://<the same host><path> when that host is one of this community's addresses (any but a
 * lost one), else its main address (primaryAddress), else an address it holds a valid certificate for. Null when it has
 * none of those, which a server holding a certificate does not reach.
 */
export function httpsRedirectTarget(host: string | undefined, url: string): string | null {
    const named = host ? normalizeAddress(host) : null;
    const own = named && configuredAddresses().some((a) => a.address === named && !a.lost) ? named : null;
    const target = own ?? primaryAddress() ?? servedHosts().find((h) => servesCaCertificateFor(h)) ?? null;
    if (!target) return null;
    // Only the path and query of this request, after the host chosen here: `//elsewhere` stays a path on `target`. Anything
    // outside printable ASCII is percent-encoded, so the Location header is always one a client can read.
    const path = (url.startsWith('/') ? url : `/${url}`).replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));
    return `https://${target}${path}`;
}

/** The gate, for the plain listener, right after the ACME challenge route: the redirect, or on to what was there before. */
export function plainHttpGate(): Koa.Middleware {
    return async (ctx, next) => {
        if (plainHttpAnswersAsBefore({
            remoteAddress: ctx.req.socket.remoteAddress, host: ctx.get('host') || undefined,
            forwardedProto: ctx.get('x-forwarded-proto') || undefined, forwarded: ctx.get('forwarded') || undefined,
        })) {
            return next();
        }
        const location = httpsRedirectTarget(ctx.get('host') || undefined, ctx.url);
        ctx.set('Cache-Control', 'no-store');
        if (!location) {
            ctx.status = 404;
            ctx.body = '';
            return;
        }
        ctx.status = 301;
        ctx.set('Location', location);
        ctx.body = '';
    };
}

/**
 * The same gate for a live-updates socket asked of the plain listener: true when the upgrade may go on as before; else
 * the socket is answered with the redirect (no client follows it; nothing of the app is sent) and closed.
 */
export function plainUpgradeAllowed(req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined>; url?: string },
    socket: { write: (s: string) => unknown; destroy: () => unknown }): boolean {
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
    const host = one(req.headers.host);
    if (plainHttpAnswersAsBefore({
        remoteAddress: req.socket.remoteAddress, host,
        forwardedProto: one(req.headers['x-forwarded-proto']), forwarded: one(req.headers.forwarded),
    })) return true;
    const location = httpsRedirectTarget(host, req.url ?? '/');
    const head = location
        ? `HTTP/1.1 301 Moved Permanently\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
        : 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
    try { socket.write(head); } catch { /* the socket is closed below either way */ }
    socket.destroy();
    return false;
}
