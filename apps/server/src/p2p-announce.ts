/**
 * The addresses a node announces to its federation peers, from PUBLIC_IP.
 *
 * PUBLIC_IP comes from the host (deploy.sh asks ifconfig.me), and a host with IPv6 can answer with an IPv6 address.
 * This used to be written into `/ip4/…` whatever it was, and libp2p refused the node at start: "Invalid IPv4
 * address", a restart loop (the global node's first deploy, 2026-09-25). A self-hoster's server that prefers IPv6
 * would do the same. So the protocol follows the address, and anything that isn't an address (an empty answer, an
 * error page) announces nothing rather than stopping the node: without an announce address libp2p announces what
 * it listens on, which is how every node without PUBLIC_IP already runs.
 */
import { isIPv4, isIPv6 } from 'node:net';

export function announceAddrsFor(publicIp: string | undefined, tcpPort: number, wsPort: number): string[] | undefined {
    const ip = (publicIp ?? '').trim();
    if (!ip) return undefined;
    const proto = isIPv4(ip) ? 'ip4' : isIPv6(ip) ? 'ip6' : null;
    if (!proto) {
        console.warn(`[P2P] PUBLIC_IP "${ip.slice(0, 60)}" is not an IP address; announcing the listen addresses instead.`);
        return undefined;
    }
    return [`/${proto}/${ip}/tcp/${tcpPort}`, `/${proto}/${ip}/tcp/${wsPort}/ws`];
}
