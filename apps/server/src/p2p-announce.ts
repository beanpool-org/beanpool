/**
 * The addresses a node announces to its federation peers, from PUBLIC_IP.
 *
 * PUBLIC_IP comes from the host (deploy.sh asks ifconfig.me), and a host with IPv6 can answer with an IPv6 address.
 * This used to be written into `/ip4/…` whatever it was, and libp2p refused the node at start: "Invalid IPv4
 * address", a restart loop (the global node's first deploy, 2026-09-25). A self-hoster's server that prefers IPv6
 * would do the same. So the protocol follows the address, and anything that isn't an address (an empty answer, an
 * error page) announces nothing rather than stopping the node: without an announce address libp2p announces what
 * it listens on, which is how every node without PUBLIC_IP already runs.
 *
 * A self-hoster sets it by hand too (#1135's review, 2026-09-30):
 * - A host name (apps/server/README.md tells them to set one) is announced as `/dns/<name>`. Measured on this libp2p
 *   (3.1, @libp2p/tcp 11): a node announcing `/dns/<name>/tcp/<port>` starts, and a peer dials that address; the name is
 *   looked up when a peer dials, so an address that changes behind the name is followed. It used to announce nothing.
 * - Every address is parsed by the multiaddr library libp2p parses it with before it is announced. An IPv6 address with
 *   a zone (fe80::1%eth0) is an IPv6 address to node:net but not to multiaddr, and libp2p threw at start on it: the same
 *   restart loop. It is refused here, with the reason, and the node announces its listen addresses instead.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { multiaddr } from '@multiformats/multiaddr';

/** One DNS label (RFC 1123): letters, digits and hyphens, 1 to 63 of them, not starting or ending with a hyphen. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/**
 * A host name as DNS has it: labels (LABEL) joined by dots, at most 253 characters, one trailing dot allowed. The last
 * label is never all digits, as no top-level domain is, so a mistyped IPv4 address (999.1.1.1) is not taken for a name.
 * No scheme, no port, no path: `https://bean.example.org` and `bean.example.org:8443` are not host names.
 */
export function isHostName(value: string): boolean {
    const name = value.endsWith('.') ? value.slice(0, -1) : value;
    if (!name || name.length > 253) return false;
    const labels = name.split('.');
    return labels.every(l => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]);
}

const WHAT_TO_SET = 'Set it to this server\'s public address, such as 203.0.113.7 or 2001:db8::7, or its name, such as bean.example.org '
    + '(no https://, no port), or leave it out. This server announces the addresses it listens on instead.';

export function announceAddrsFor(publicIp: string | undefined, tcpPort: number, wsPort: number): string[] | undefined {
    const value = (publicIp ?? '').trim();
    if (!value) return undefined;
    const shown = JSON.stringify(value.slice(0, 60));
    const [proto, host] = isIPv4(value) ? ['ip4', value]
        : isIPv6(value) ? ['ip6', value]
            : isHostName(value) ? ['dns', value.replace(/\.$/, '')]
                : [null, value];
    if (!proto) {
        console.warn(`[P2P] PUBLIC_IP ${shown} is not an IP address or a host name. ${WHAT_TO_SET}`);
        return undefined;
    }
    const addrs = [`/${proto}/${host}/tcp/${tcpPort}`, `/${proto}/${host}/tcp/${wsPort}/ws`];
    try {
        for (const a of addrs) multiaddr(a);
    } catch {
        const zone = proto === 'ip6' ? value.indexOf('%') : -1;
        console.warn(zone !== -1
            ? `[P2P] PUBLIC_IP ${shown} names a network interface (${JSON.stringify(value.slice(zone, zone + 20))}), which peers can't reach. ${WHAT_TO_SET}`
            : `[P2P] PUBLIC_IP ${shown} can't be announced to peers. ${WHAT_TO_SET}`);
        return undefined;
    }
    return addrs;
}
