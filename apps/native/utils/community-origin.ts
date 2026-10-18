/**
 * A community's address as the phone will use it (utils/community-directory.ts reads every directory row through it):
 * kept here, importing nothing that needs a device, so Home's pure rules (utils/home-cards.ts, "Ask a community to let
 * you in") check an address exactly as Communities near you and the find card do (#1517).
 */

import { isPrivateHost } from '@beanpool/core';
import { GLOBAL_NODE_URL } from './global-node-url';

/** A dotted quad, each part 0 to 255 written without leading zeros (`010.1.1.1` reads as octal to some parsers). */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * An IPv4 address a community's server can be reached at from the Internet: public by the cleartext rule's own reading
 * (core isPrivateHost, which normalizeNodeUrl and withNodeScheme read too), and not one that no server is at: 0.0.0.0/8,
 * which some systems connect to as this phone itself, nor multicast and above (224.0.0.0/3).
 */
function isServerIpv4(ip: string): boolean {
    if (!IPV4.test(ip) || isPrivateHost(ip)) return false;
    const first = Number(ip.split('.')[0]);
    return first !== 0 && first < 224;
}

function host(url: string): string | null {
    // The host must run to the end or to a path, query or fragment: a login (`user.name:1234@real-host`) would
    // otherwise read as the host `user.name:1234`, so anything with an `@` before the path is no host at all.
    const m = /^https:\/\/([^/?#@\s]+)(?=[/?#]|$)/i.exec(url);
    return m ? m[1].toLowerCase().replace(/:443$/, '') : null;
}

/**
 * A community's address as the phone will use it: an https origin with a host name or a public IPv4 address, no path,
 * no credentials. A server's number reaches it as well as a name does once the server has its own certificate
 * (scratch/global-node/DESIGN-https-anywhere-fable.md §3, D3), though only a name survives a change of server.
 * Anything else (http, a path-only string, a private, loopback or link-local IPv4 address, an IPv6 literal, a login in
 * the URL) is no address. The global node itself is never a community's address here: nobody knocks on the lobby, and
 * a stale or hostile directory row pointing at it must not become a signed request to it.
 */
export function communityOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^https:\/\//i.test(trimmed) || trimmed.length > 300) return null;
    const h = host(trimmed);
    if (!h) return null;
    const name = h.replace(/:\d{1,5}$/, '');
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    // All digits and dots: a public IPv4 address, or nothing (`1.2.3`, `999.1.1.1`, `10.0.0.5`). Else a host name with
    // at least one dot, made of labels.
    if (/^[\d.]+$/.test(name) ? !isServerIpv4(name) : !new RegExp(`^${label}(?:\\.${label})+$`).test(name)) return null;
    if (h === host(GLOBAL_NODE_URL)) return null;
    return `https://${h}`;
}
