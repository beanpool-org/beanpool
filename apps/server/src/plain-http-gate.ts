/**
 * What the plain listener (http-server.ts, port 80 / 8080) may answer, and to whom (design
 * scratch/global-node/DESIGN-https-anywhere-fable.md D9, §6 and §7 S6).
 *
 * A node with no certificate of its own (a LAN or development node, a node reached only through a tunnel) answers on
 * port 80 exactly as it always has. Once this server holds a CA certificate for one of its addresses (tls.ts
 * holdsOwnCertificate; one that lapsed counts, from the first request after a restart too), a request that did not come
 * through a tunnel gets only the ACME challenge route (mounted before this gate) and a 301 to https: never a page of the
 * app, an API answer, a cookie or a live-updates socket in cleartext. The redirect goes to the same host when it is one
 * of this community's addresses, else to its main one.
 *
 * Which requests came through a tunnel is read from the socket first. A header counts only from a proxy this server trusts
 * (client-ip.ts isTrustedProxy, the one rule the client's address is read by too), never from any other source, private
 * or public: Docker's port proxy hands an IPv6 visitor from the internet on from the bridge gateway, and a neighbour on
 * beanpool-shared is on a private range (security inventory 17 Nov 2026, risk 5).
 *   - loopback (127.0.0.0/8, ::1, ::ffff:127.x): cloudflared run by this server as its child, in the same container,
 *     dials LOOPBACK_ORIGIN (tunnel-connector.ts); so do the registrar's name watch and anything else inside the container.
 *     A connection from outside the container never has a loopback source: the container has its own network namespace.
 *   - a host-level tunnel: cloudflared on the host dials localhost:<published port>, and Docker's port proxy hands that on
 *     from the bridge gateway, never from loopback. With the ports published on 127.0.0.1 and TRUSTED_PROXIES=docker-host
 *     the gateway is trusted, and its requests that name a beanpool.org host (which a browser only ever reaches through
 *     Cloudflare, where TLS for that name ends) are let through; else that tunnel is sent round a 301 loop on a node that
 *     holds a certificate of its own.
 *   - a web server or proxy of the operator's own in front (the operator manual, "Behind a web server or proxy of your
 *     own"), listed in TRUSTED_PROXIES (or docker-host, on the same machine), that holds the certificate and passes
 *     requests on to this port. Where it says the visitor's request came over https (X-Forwarded-Proto: https, or
 *     Forwarded: proto=https: Caddy and Traefik send it by themselves, nginx when told to), it is let through, else it
 *     would be sent round the same loop once this server got a certificate of its own.
 * Any other source is redirected, whatever host or header it sends (the hall's own exemption apart, which takes no
 * header at all: hallMayReach): what lets a request through is a claim about the leg before it, which only a proxy the
 * operator named makes.
 */

import type Koa from 'koa';
import { configuredAddresses, isBeanPoolName, isLoopbackHost, normalizeAddress, primaryAddress } from './engine/own-addresses.js';
import { isDirectLanRequest, isLoopbackSource } from './direct-lan.js';
import { isTrustedProxy } from './client-ip.js';
import { lightsOutOn } from './services/lights-out.js';
import { holdsOwnCertificate, servedHosts, servesCaCertificateFor } from './services/tls.js';
import { acmeTargets } from './services/acme/schedule.js';

/** The addresses this server certifies now, as its renewal tick orders them (schedule.ts acmeTargets; status.ts reads the
 *  same): what tls.ts holdsOwnCertificate reads state.json for, from the first request after a start. */
const certifiedHosts = () => acmeTargets().map((t) => t.host);

// The source tests live in direct-lan.ts (the one direct-LAN rule, the hall's and the APK's); here as they always were.
export { isLoopbackSource, isPrivateSource } from './direct-lan.js';

export interface PlainRequest {
    /** The socket's remote address, as req.socket.remoteAddress gives it. */
    remoteAddress: string | undefined;
    /** The Host header as sent (with or without a port), or undefined. */
    host: string | undefined;
    /** The X-Forwarded-Proto header, or undefined. */
    forwardedProto?: string | undefined;
    /** The Forwarded header (RFC 7239), or undefined. */
    forwarded?: string | undefined;
    /** Every header, as Node gives them, and the path: what the hall's exemption reads (direct-lan.ts). */
    headers?: Record<string, string | string[] | undefined>;
    path?: string;
}

/**
 * What a phone or browser straight from the hall Wi-Fi may reach while lights-out is OFF, on a server that holds a
 * certificate of its own (design §4.1, §4.3): Settings and its files, the sign-in routes, the switch itself (Settings' and
 * the phone's), the hall page (it says the hall is closed), and the four public reads the phone's hall door checks the laptop
 * with before it signs anything (H2: the health, the community's info, the identity statement, the nonce attestation).
 * Everything else, /api/ledger/transfer among it, keeps the redirect until the switch is on.
 */
const HALL_PATHS_WHILE_OFF_EXACT = new Set([
    '/settings', '/hall', '/api/local/admin/lights-out', '/api/node/owner/lights-out', '/api/local/admin/csrf-token',
    '/api/community/health', '/api/community/info', '/api/local/community-info', '/api/node/identity-epoch', '/api/attest',
]);
const HALL_PATH_PREFIXES_WHILE_OFF = ['/settings/', '/api/local/admin/auth/'];

/** Whether this path is one the hall reaches while the switch is off (above). Dot segments and doubled slashes never count. */
export function hallPathWhileOff(rawPath: string | undefined): boolean {
    if (!rawPath) return false;
    const p = rawPath.split('?')[0];
    if (/\/\.{1,2}(\/|$)|\/\/|%2e|%2f|\\/i.test(p)) return false;
    const path = p.length > 1 ? p.replace(/\/$/, '') : p;
    return HALL_PATHS_WHILE_OFF_EXACT.has(path) || HALL_PATH_PREFIXES_WHILE_OFF.some((x) => path.startsWith(x));
}

/**
 * Lights-out's exemption (services/lights-out.ts, design §2.1 item 1, §4.1): a request straight from the hall Wi-Fi (a
 * private or loopback source that is not a default gateway, with no tunnel or proxy header, naming a local-network host:
 * direct-lan.ts, the same rule /android uses) is answered while the switch is on, and reaches the sign-in and switch
 * paths while it is off. Never a public source, never anything that came through a tunnel or proxy.
 */
export function hallMayReach(req: PlainRequest): boolean {
    if (!req.headers) return false;
    if (!isDirectLanRequest({ remoteAddress: req.remoteAddress, headers: req.headers })) return false;
    return lightsOutOn() || hallPathWhileOff(req.path);
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
 * CF_RECORD_NAME redirect): on a node with no certificate of its own; from loopback; from a proxy this server trusts
 * (isTrustedProxy) naming a beanpool.org host (a host-level tunnel) or saying the request came over https before it (a
 * proxy of the operator's own); from the hall Wi-Fi as lights-out allows (hallMayReach). Everything else gets the redirect.
 */
export function plainHttpAnswersAsBefore(req: PlainRequest): boolean {
    if (isLoopbackSource(req.remoteAddress)) return true;
    if (!holdsOwnCertificate(certifiedHosts)) return true;
    if (hallMayReach(req)) return true;
    if (!isTrustedProxy(req.remoteAddress)) return false;
    const host = req.host ? normalizeAddress(req.host) : null;
    return (!!host && isBeanPoolName(host)) || saysHttpsBefore(req);
}

/**
 * Where the redirect goes: https://<the same host><path> when that host is one of this community's addresses (any but a
 * lost one or a loopback name an operator listed for an SSH tunnel, which names whichever machine a visitor is on), else its main address (primaryAddress), else an address it holds a valid certificate for. Null when it has
 * none of those, which a server holding a certificate does not reach.
 */
export function httpsRedirectTarget(host: string | undefined, url: string): string | null {
    const named = host ? normalizeAddress(host) : null;
    const own = named && !isLoopbackHost(named) && configuredAddresses().some((a) => a.address === named && !a.lost) ? named : null;
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
            headers: ctx.req.headers, path: ctx.path,
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
        headers: req.headers, path: (req.url ?? '/').split('?')[0],
    })) return true;
    const location = httpsRedirectTarget(host, req.url ?? '/');
    const head = location
        ? `HTTP/1.1 301 Moved Permanently\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
        : 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
    try { socket.write(head); } catch { /* the socket is closed below either way */ }
    socket.destroy();
    return false;
}
