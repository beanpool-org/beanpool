/**
 * A community's address as the phone will use it (utils/community-directory.ts reads every directory row through it):
 * kept here, importing nothing that needs a device, so Home's pure rules (utils/home-cards.ts, "Ask a community to let
 * you in") check an address exactly as Communities near you and the find card do (#1517).
 */

import { isPublicIpv4 } from '@beanpool/core';
import { GLOBAL_NODE_URL } from './global-node-url';

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
 * Anything else (http, a path-only string, a private, loopback, link-local, carrier-NAT or benchmarking IPv4 address, an
 * IPv6 literal, a login in the URL) is no address. The global node itself is never a community's address here: nobody knocks on the lobby, and
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
    // All digits and dots: a server's public number as the server itself reads one (core isPublicIpv4: never a private,
    // carrier-NAT or benchmarking number, which no server has a certificate for), or nothing (`1.2.3`, `999.1.1.1`,
    // `10.0.0.5`, `100.64.0.1`). Else a host name with at least one dot, made of labels.
    if (/^[\d.]+$/.test(name) ? !isPublicIpv4(name) : !new RegExp(`^${label}(?:\\.${label})+$`).test(name)) return null;
    if (h === host(GLOBAL_NODE_URL)) return null;
    return `https://${h}`;
}
