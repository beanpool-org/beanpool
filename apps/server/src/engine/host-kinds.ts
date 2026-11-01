/**
 * What kind of host an address names: this machine, the local network, a BeanPool registrar name, one a public CA can
 * certify. Pure, with no database or config import, so `beanpool claim` (claim-command.ts, its own process beside the node)
 * reads the same rules as the node (engine/own-addresses.ts re-exports each, and is where they are described in use).
 */

import { audienceOf, isPublicIpv4 } from '@beanpool/core';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** An address as a host in the one form signatures carry (audienceOf), or null for anything that is not one. */
export function normalizeAddress(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const host = audienceOf(input);
    return host && host.length <= 253 ? host : null;
}

/** The zone the BeanPool registrar names communities in: `<name>.beanpool.org` (registrar-names.ts, resolvePublicNodeUrl). */
export const BEANPOOL_ZONE = 'beanpool.org';

/**
 * A name in the registrar's zone: beanpool.org itself or any name under it. One that isn't among this node's
 * configured names (its own registrar name is item 1 or 4) is another community's, or free to be claimed by one.
 */
export function isBeanPoolName(host: string): boolean {
    return host === BEANPOOL_ZONE || host.endsWith(`.${BEANPOOL_ZONE}`);
}

/** A host on this machine: localhost, 127.0.0.0/8, [::1]. */
export function isLoopbackHost(host: string): boolean {
    return LOOPBACK.includes(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A host on this machine or the local network: loopback, private IPv4 ranges, IPv6 unique-local and link-local,
 * `.local`. This community's (own-addresses.ts item 5) only on a node that knows none of its names.
 */
export function isLocalNetworkHost(host: string): boolean {
    if (isLoopbackHost(host) || host.endsWith('.local')) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    return /^\[(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(host);
}

/** An IP literal as signatures carry it: dotted IPv4, or IPv6 in brackets. */
export function isIpLiteral(host: string): boolean {
    return host.startsWith('[') || /^[\d.]+$/.test(host);
}

/** Top-level names no public CA certifies (RFC 6761, RFC 8375 and the usual home and company ones). */
const NON_PUBLIC_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'home', 'corp', 'test', 'invalid', 'example', 'onion', 'arpa']);

/** A bracketed IPv6 literal anyone on the Internet could reach: global unicast (2000::/3) only, never an IPv4-mapped one. */
function isPublicIpv6(host: string): boolean {
    if (!/^\[[0-9a-f:.]+\]$/.test(host)) return false;
    let canonical: string;
    try { canonical = new URL(`http://${host}/`).hostname; } catch { return false; }
    const first = parseInt(canonical.slice(1).split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff;
}

/**
 * Whether a public CA can certify `host` by fetching it from the Internet (services/acme): a public IP literal (an IPv4 one by
 * core's isPublicIpv4, the phone's own reading of a server's public number), or a name of two labels or more, each a-z, 0-9
 * and inner hyphens, under a top-level name that is not numeric and not a home, test or special-use one. Never a
 * beanpool.org name (Cloudflare's edge holds those), never loopback or a local-network host.
 */
export function isCertifiableHost(host: string): boolean {
    if (normalizeAddress(host) !== host || isBeanPoolName(host) || isLocalNetworkHost(host)) return false;
    if (host.startsWith('[')) return isPublicIpv6(host);
    if (/^[\d.]+$/.test(host)) return isPublicIpv4(host);
    const labels = host.split('.');
    if (labels.length < 2) return false;
    if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
    const tld = labels[labels.length - 1];
    return !/^\d+$/.test(tld) && !NON_PUBLIC_TLDS.has(tld);
}

/**
 * The first of `hosts` to send newcomers to: a name before an IP address (a name survives a change of server, a number does
 * not), and only a host the Internet can reach before one on the home network. Null for none.
 */
/** A beanpool.org name, or a public IP or name a public CA can certify (so one in the Internet's DNS): never a home-network one. */
export const reachableFromInternet = (a: string): boolean => isBeanPoolName(a) || isCertifiableHost(a);

export function preferredAddress(hosts: readonly string[]): string | null {
    return hosts.find((a) => !isIpLiteral(a) && reachableFromInternet(a)) ?? hosts.find(reachableFromInternet) ?? hosts[0] ?? null;
}

/** A public IPv4 address as `beanpool claim --ip` and Settings take it: dotted, certifiable (above). */
export function isPublicIpv4Host(host: string): boolean {
    return /^[\d.]+$/.test(host) && isCertifiableHost(host);
}

/**
 * Why `host` (as normalizeAddress gives it, or as typed when it gives none) can't be this server's own address, in words
 * the owner can act on; null when it can. The node (services/public-address-agent.ts storeOwnAddress) and `beanpool claim`
 * say the same.
 */
export function ownAddressProblem(host: string): string | null {
    if (isCertifiableHost(host)) return null;
    if (normalizeAddress(host) !== host) return `"${host}" is not an address: a name like beans.example.org, or this server's public IPv4 address`;
    if (isBeanPoolName(host)) return `${host} is a BeanPool name: ask for it with beanpool claim --name, or in Settings → Public Address`;
    if (isLocalNetworkHost(host)) return `${host} is on a home network or this machine: nothing on the internet can reach it, so no certificate can be issued for it`;
    if (isIpLiteral(host)) return `${host} is not a public IP address: nothing on the internet can reach it, so no certificate can be issued for it`;
    return `${host} is not a name a public certificate authority can check: a name like beans.example.org, under a real top-level domain`;
}
