/**
 * Shared helpers for community-node addresses, used by onboarding (welcome) and the
 * wrong-node recovery screen so they normalise and validate identically.
 */

/**
 * The domain community names expand under.
 *
 * Every node that claims a name through the registrar gets `<name>.beanpool.org`, so the expansion
 * is deterministic rather than a guess. A node on its own domain is unaffected — it is typed in
 * full and passes through untouched.
 */
const COMMUNITY_DOMAIN = 'beanpool.org';

/**
 * Accept a community name OR a node address, and return a URL.
 *
 * A bare word becomes `<name>.beanpool.org`. Anything with a dot, a scheme, a port, an IP or
 * localhost is treated as an address and only gains a scheme.
 *
 * The reason is recovery. A member restoring an account has lost their phone, and asking them to
 * reproduce `mullum.beanpool.org` exactly is a poor thing to ask at that moment — where "which
 * community are you part of?" is something they simply know. Bare names were previously rejected
 * outright by `looksLikeNodeAddress`, which requires a dotted host.
 *
 * http:// for raw IPs and localhost, https:// for everything else. Returns '' for blank input.
 * Idempotent for full URLs.
 */
export function normalizeNodeUrl(raw: string): string {
    let u = raw.trim();
    if (!u) return '';
    if (u.startsWith('http')) return u;

    const isIpOrLocal = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(u) || u.startsWith('localhost');
    if (isIpOrLocal) return 'http://' + u;

    // A bare community name: no dot, no port, no path. Anything else is already an address.
    if (/^[a-z0-9][a-z0-9-]*$/i.test(u)) {
        return `https://${u.toLowerCase()}.${COMMUNITY_DOMAIN}`;
    }
    return 'https://' + u;
}

/**
 * Offline sanity check that a node address is well-formed (scheme + host.tld, an IP,
 * or localhost) — enough to catch a blank or a single-word typo. Deliberately NOT a
 * reachability check: that needs the network and would wrongly reject a valid address
 * on a flaky connection.
 */
export function looksLikeNodeAddress(url: string): boolean {
    return /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(url)
        || /^https?:\/\/localhost(:\d+)?(\/|$)/i.test(url);
}

/**
 * NAT-4: is `host` a private/LAN address where cleartext (http/ws) is acceptable?
 * Covers RFC-1918 + loopback + link-local IPv4, localhost, mDNS (.local/.lan), and
 * bare single-label hostnames. Deliberately biased to return TRUE on anything
 * ambiguous — a false negative here would block legitimate LAN sync (the exact
 * regression reverted in #125/#127), whereas the only cost of a false positive is
 * permitting cleartext to an unusual private setup.
 */
export function isPrivateHost(host: string): boolean {
    const h = host.toLowerCase().trim().replace(/:\d+$/, ''); // strip :port
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.internal')) return true;
    if (h.startsWith('[')) return true; // IPv6 literal (ULA/link-local commonly used on LAN) — don't block
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        if (a === 10) return true;                       // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;          // 192.168.0.0/16
        if (a === 127) return true;                       // loopback
        if (a === 169 && b === 254) return true;          // link-local
        return false;                                     // public IPv4
    }
    if (!h.includes('.')) return true; // bare hostname → LAN mDNS/NetBIOS style
    return false; // public domain (has a dot, not a private IP)
}

/**
 * NAT-4: should a connection to `url` be refused because it sends cleartext
 * (http/ws) to a *public* host (MITM-exposed)? https/wss and private/LAN hosts are
 * always allowed. Keeps `usesCleartextTraffic` enabled (LAN sync still works) while
 * preventing plaintext traffic to the public internet.
 */
export function shouldBlockCleartextNodeUrl(url: string): boolean {
    const lower = (url || '').toLowerCase();
    const isCleartext = lower.startsWith('http://') || lower.startsWith('ws://');
    if (!isCleartext) return false;
    const hostPort = url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || '';
    return !isPrivateHost(hostPort);
}
