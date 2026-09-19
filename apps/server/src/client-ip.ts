/**
 * The address of the person on the other end of a request — what every IP-keyed limiter must key on.
 *
 * A node sees requests arrive three ways:
 *   - Tunnel mode: cloudflared (a sidecar container on the compose network) opens every connection, so the
 *     socket peer is the cloudflared container for the whole community. The member's address is in
 *     CF-Connecting-IP, which Cloudflare's edge sets and overwrites (a client cannot choose it).
 *   - Direct mode behind Cloudflare's proxy (the registrar creates proxied A records): the socket peer is a
 *     Cloudflare edge address, shared by everyone near the same data centre. Again CF-Connecting-IP names the member.
 *   - Truly direct (LAN node, or someone reaching the origin IP): the socket peer IS the client.
 *
 * Forwarding headers are believed ONLY from a peer that is known to set them honestly. From anyone else they
 * are the client's own words: honouring them would let one client present a fresh address per request and
 * never be throttled. Koa's `ctx.ip` under `app.proxy = true` is the leftmost X-Forwarded-For from ANY peer,
 * so it must never feed a limiter.
 *
 * Trusted peers:
 *   - loopback;
 *   - the subnets this machine's own private interfaces are on. In a container these are the docker networks
 *     (the compose network cloudflared lives on, and its gateway, where a host-level cloudflared arrives from);
 *     on a bare LAN host it is the LAN;
 *   - TRUSTED_PROXIES: extra IPs or CIDRs, comma-separated (e.g. a reverse proxy on another host);
 *   - Cloudflare's published edge ranges — trusted for CF-Connecting-IP only, never for X-Forwarded-For, which
 *     Cloudflare passes through with the client's own entries still in it.
 */
import net from 'node:net';
import os from 'node:os';
import type Koa from 'koa';

// https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-09-19.
const CLOUDFLARE_V4 = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflareEdge = new net.BlockList();
for (const c of CLOUDFLARE_V4) addCidr(cloudflareEdge, c);
for (const c of CLOUDFLARE_V6) addCidr(cloudflareEdge, c);

function addCidr(list: net.BlockList, entry: string): boolean {
    const [addr, bits] = entry.trim().split('/');
    const a = normalizeIp(addr);
    const family = net.isIP(a);
    if (!family) return false;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
        list.addAddress(a, type);
        return true;
    }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) return false;
    list.addSubnet(a, prefix, type);
    return true;
}

/** Strip the IPv4-mapped IPv6 prefix and any zone id, so one address has one spelling. */
export function normalizeIp(addr: string | undefined | null): string {
    if (!addr) return '';
    let a = String(addr).trim();
    if (a.toLowerCase().startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
    const zone = a.indexOf('%');
    if (zone !== -1) a = a.slice(0, zone);
    return a;
}

function inList(list: net.BlockList, ip: string): boolean {
    const family = net.isIP(ip);
    if (!family) return false;
    return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

export interface TrustConfig {
    loopback: boolean;
    localSubnets: boolean;
    cloudflare: boolean;
    extra: string[];
}

function defaultTrustConfig(): TrustConfig {
    const extra = (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
    return { loopback: true, localSubnets: true, cloudflare: true, extra };
}

let trustConfig: TrustConfig = defaultTrustConfig();
let localProxies: net.BlockList | null = null;
let localProxiesBuiltAt = 0;
const LOCAL_REFRESH_MS = 5 * 60_000; // docker networks can be attached after start

function isPrivate(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [o1, o2] = ip.split('.').map(Number);
        return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168);
    }
    return /^f[cd][0-9a-f]{2}:/i.test(ip); // unique-local; link-local is never a proxy hop here
}

function buildLocalProxies(): net.BlockList {
    const list = new net.BlockList();
    if (trustConfig.loopback) {
        list.addSubnet('127.0.0.0', 8, 'ipv4');
        list.addAddress('::1', 'ipv6');
    }
    if (trustConfig.localSubnets) {
        for (const addrs of Object.values(os.networkInterfaces())) {
            for (const i of addrs || []) {
                // A public interface's subnet is the internet's neighbourhood, not our proxy.
                if (i.internal || !i.cidr || !isPrivate(normalizeIp(i.address))) continue;
                addCidr(list, i.cidr);
            }
        }
    }
    for (const e of trustConfig.extra) {
        if (!addCidr(list, e)) console.warn(`[client-ip] ignoring TRUSTED_PROXIES entry "${e}" (not an IP or CIDR)`);
    }
    return list;
}

function localProxyList(): net.BlockList {
    const now = Date.now();
    if (!localProxies || now - localProxiesBuiltAt > LOCAL_REFRESH_MS) {
        localProxies = buildLocalProxies();
        localProxiesBuiltAt = now;
    }
    return localProxies;
}

/** A peer whose CF-Connecting-IP and X-Forwarded-For are believed. */
export function isTrustedProxy(peer: string | undefined): boolean {
    const ip = normalizeIp(peer);
    return !!ip && inList(localProxyList(), ip);
}

function isCloudflareEdge(ip: string): boolean {
    return trustConfig.cloudflare && inList(cloudflareEdge, ip);
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
    const v = headers[name];
    return Array.isArray(v) ? v[0] || '' : v || '';
}

/**
 * The client's address for a request whose socket peer is `peer`.
 *
 * X-Forwarded-For is read right to left: each trusted proxy APPENDS the address it received from, so the
 * rightmost entry that is not itself one of our proxies is the first hop we can vouch for. Entries to the
 * left of it were written by the client and prove nothing.
 */
export function resolveClientIp(peer: string | undefined, headers: Record<string, string | string[] | undefined>): string {
    const socketIp = normalizeIp(peer) || 'unknown';
    const fromLocalProxy = isTrustedProxy(socketIp);
    if (!fromLocalProxy && !isCloudflareEdge(socketIp)) return socketIp;

    const cf = normalizeIp(header(headers, 'cf-connecting-ip'));
    if (net.isIP(cf)) return cf;
    if (!fromLocalProxy) return socketIp; // Cloudflare's own X-Forwarded-For carries the client's entries

    const hops = header(headers, 'x-forwarded-for').split(',').map(normalizeIp).filter(h => net.isIP(h));
    for (let i = hops.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(hops[i])) return hops[i];
    }
    return hops[0] || socketIp;
}

/** The real client address of a Koa request, computed once per request. */
export function clientIp(ctx: Koa.Context): string {
    const state = ctx.state || (ctx.state = {});
    if (!state.clientIp) {
        // A context without a socket is a handler-level test's stand-in; its `ip` is what it means.
        state.clientIp = ctx.req?.socket
            ? resolveClientIp(ctx.req.socket.remoteAddress, ctx.req.headers || {})
            : ((ctx as any).ip || 'unknown');
    }
    return state.clientIp;
}

/** Tests only: replace the trust set (and rebuild it). `undefined` restores the default. */
export function setTrustConfigForTests(cfg: Partial<TrustConfig> | undefined): void {
    trustConfig = cfg ? { ...defaultTrustConfig(), ...cfg } : defaultTrustConfig();
    localProxies = null;
}
