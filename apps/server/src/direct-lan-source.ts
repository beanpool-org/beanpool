/**
 * Whether a request reached this server straight from a machine on its own local network: a phone on the hall Wi-Fi, the
 * laptop's own browser. One test, for every route that serves the hall and nothing else (lights-out: the plain port's
 * exemption and GET /hall, services/lights-out.ts; the APK on the node, H3, is meant to use this same helper).
 *
 * A private or loopback source is NOT enough. Cloudflare's tunnel reaches this server from cloudflared on the same machine:
 * inside the container from loopback (tunnel-connector.ts LOOPBACK_ORIGIN), on our fleet's hosts from Docker's bridge
 * gateway (a private range). So does a web server or proxy of the operator's own in front. Each of those is the Internet
 * arriving from a private address. They are told apart by what they add, and by the name they were asked for:
 *   - any tunnel or proxy header (CF-Connecting-IP, Cf-Ray, Cf-Visitor, Cdn-Loop, X-Forwarded-For, X-Forwarded-Host,
 *     X-Forwarded-Proto, X-Real-IP, Forwarded, Via): refused, whatever it says. A phone on the hall Wi-Fi sends none;
 *   - a Host that names anything but a local-network address (a private or link-local number, loopback, a `.local` or
 *     `.lan` name): refused. A browser that came through the tunnel asked for the community's public name.
 * Fail closed: a source Node can't read, or a Host that can't be parsed, is not the LAN.
 */

import net from 'node:net';
import { isLocalNetworkHost, normalizeAddress } from './engine/own-addresses.js';

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

/** Headers a tunnel or proxy adds and a phone on a Wi-Fi never sends. Lower case, as Node gives them. */
export const TUNNEL_OR_PROXY_HEADERS = [
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop', 'cf-warp-tag-id',
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded', 'via',
    'true-client-ip',
] as const;

export interface LanRequestFacts {
    /** req.socket.remoteAddress. */
    remoteAddress: string | undefined;
    /** The request's headers, as Node gives them (lower-case names). */
    headers: Record<string, string | string[] | undefined>;
}

/** A Host header that names an address on this local network: a private or loopback number, `.local` or `.lan`. */
export function isLocalNetworkHostHeader(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const host = normalizeAddress(hostHeader);
    if (!host) return false;
    return isLocalNetworkHost(host) || host.endsWith('.lan');
}

/** True only for a request straight from this server's own local network (see above). */
export function isDirectLanRequest(req: LanRequestFacts): boolean {
    if (!isPrivateSource(req.remoteAddress)) return false;
    for (const h of TUNNEL_OR_PROXY_HEADERS) {
        const v = req.headers[h];
        if (v !== undefined && (Array.isArray(v) ? v.length > 0 : true)) return false;
    }
    const host = req.headers.host;
    return isLocalNetworkHostHeader(Array.isArray(host) ? host[0] : host);
}

/** The same, from a Koa context. */
export function isDirectLanContext(ctx: { req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> } }): boolean {
    return isDirectLanRequest({ remoteAddress: ctx.req.socket.remoteAddress, headers: ctx.req.headers });
}
