/**
 * This machine's IPv4 default gateways, from /proc/net/route (Linux; none elsewhere). In a Docker container that is the
 * bridge gateway: the address Docker's port proxy hands a connection on from, whether it came from a program on the host
 * (a host-level cloudflared or web server dialling localhost:<published port>) or from anyone who reached a published
 * port over IPv6. So it is never trusted on its own: direct-lan.ts leaves it out of the local network, and client-ip.ts
 * trusts it only when the operator says the ports are published on the host's loopback (TRUSTED_PROXIES=docker-host).
 */
import fs from 'node:fs';

let gatewaysForTests: string[] | null = null;
/** Tests only: this machine's default gateways (null: read them from /proc/net/route again). */
export function _setDefaultGatewaysForTests(list: string[] | null): void { gatewaysForTests = list; cached = null; }

let cached: { at: number; list: Set<string> } | null = null;
/** The IPv4 default gateways of this machine's routes, re-read every 5 minutes. */
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
    } catch { /* not Linux, or no routes to read: no gateway */ }
    cached = { at: now, list };
    return list;
}
