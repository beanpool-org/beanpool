/**
 * Whether a request came straight off this server's local network: a phone on the hall Wi-Fi, a browser on the same LAN.
 * The ONE rule for everything served only to the people in the room, never to the internet:
 *   - lights-out (H1): the plain port's hall exemption (plain-http-gate.ts hallMayReach) and the hall page GET /hall
 *     (http-server.ts, routes/lights-out.ts);
 *   - the Android APK (H3): /android, its file and /android/link (routes/android.ts), and the "Get the Android app" link on
 *     the trust page and the hall page. Marty, 4 Nov 2026: "we dont really want to have it visible on the front door
 *     otherwise or spammers might find the node on the cloud and download the apk with no intent to use it. over and over
 *     again costing the node operator data".
 *
 * A private source alone proves nothing here: Cloudflare's tunnel reaches the node from cloudflared in the same container
 * (loopback, tunnel-connector.ts) or on the host (Docker's bridge gateway) or as a compose sidecar (a Docker network
 * address), an operator's own proxy from a private range, and Docker's port proxy hands an IPv6 visitor from the internet
 * on from the gateway. So all of these must hold:
 *   - the socket's source is private, link-local or loopback (isPrivateSource);
 *   - it is not one of this container's default gateways (Docker's port proxy and a host-level tunnel arrive from there,
 *     never a phone on the LAN, whose own address Docker's NAT keeps on Linux);
 *   - the request carries none of the headers a tunnel, CDN or proxy adds on its way (PROXY_HEADERS: Cloudflare's
 *     CF-Connecting-IP and Cf-Ray among them, X-Forwarded-For, Forwarded, Via…), whatever they say;
 *   - its Host names this machine or the local network: a private or link-local IP literal, a `.local` name or localhost
 *     (host-kinds.ts isLocalNetworkHost). Never a beanpool.org name or any public one, which only the internet's way in
 *     sends, and never a router's `.lan` name either (a name is not a number; the hall's poster gives the number).
 * Fail closed: a source Node can't read, a Host that is missing, repeated or can't be parsed, is not the LAN. Anything else
 * is "not here": each caller answers as it does for a request that isn't from the room.
 */
import fs from 'node:fs';
import net from 'node:net';
import { isBeanPoolName, isLocalNetworkHost, normalizeAddress } from './engine/own-addresses.js';

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

/** Headers a tunnel, CDN or proxy adds on its way, lower case as Node gives them. Any one of them, with any value: the
 *  request did not come straight off the LAN. */
export const PROXY_HEADERS = [
    'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-warp-tag-id', 'cdn-loop', 'true-client-ip',
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'x-real-ip',
    'x-client-ip', 'x-original-forwarded-for', 'forwarded', 'via',
] as const;

let gatewaysForTests: string[] | null = null;
/** Tests only: this machine's default gateways (null: read them from /proc/net/route again). */
export function _setDefaultGatewaysForTests(list: string[] | null): void { gatewaysForTests = list; cached = null; }

let cached: { at: number; list: Set<string> } | null = null;
/** The IPv4 default gateways of this machine's routes (/proc/net/route, Linux; none elsewhere), re-read every 5 minutes. */
export function defaultGateways(now = Date.now()): Set<string> {
    if (gatewaysForTests) return new Set(gatewaysForTests);
    if (cached && now - cached.at < 5 * 60_000) return cached.list;
    const list = new Set<string>();
    try {
        for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
            const [, destination, gateway] = line.trim().split(/\s+/);
            if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway) || gateway === '00000000') continue;
            const n = parseInt(gateway, 16); // little-endian
            list.add([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.'));
        }
    } catch { /* not Linux, or no routes to read: no gateway to leave out */ }
    cached = { at: now, list };
    return list;
}

export interface LanRequest {
    /** req.socket.remoteAddress. */
    remoteAddress: string | undefined;
    /** The request's headers, as Node gives them (lower-case names). */
    headers: Record<string, string | string[] | undefined>;
}

/** Whether `req` came straight off the local network (above). */
export function isDirectLanRequest(req: LanRequest): boolean {
    if (!isPrivateSource(req.remoteAddress)) return false;
    const source = plainAddress(req.remoteAddress);
    if (net.isIPv4(source) && defaultGateways().has(source)) return false;
    if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
    const rawHost = req.headers.host;
    const host = typeof rawHost === 'string' ? normalizeAddress(rawHost) : null;
    return !!host && !isBeanPoolName(host) && isLocalNetworkHost(host);
}

/** The same for a Koa request. */
export function isDirectLanContext(ctx: { req: { socket: { remoteAddress?: string }; headers: LanRequest['headers'] } }): boolean {
    return isDirectLanRequest({ remoteAddress: ctx.req.socket.remoteAddress, headers: ctx.req.headers });
}
