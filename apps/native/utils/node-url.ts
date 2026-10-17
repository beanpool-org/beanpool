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
 * A real scheme, not merely a string starting with "http".
 *
 * `startsWith('http')` said yes to the community name `httppool`, which then never expanded, and
 * said no to `HTTP://node.example.com`, which then got a second scheme bolted on the front.
 */
const SCHEME = /^https?:\/\//i;

/**
 * Localhost EXACTLY, optionally with a port.
 *
 * `startsWith('localhost')` also matched `localhost.attacker.com`, and the consequence was not
 * cosmetic: that branch chooses http://, so a public attacker-controlled domain was being
 * downgraded to cleartext.
 */
const LOCALHOST = /^localhost(:\d+)?$/i;

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/;

/** A hostname label: alphanumeric ends, hyphens only inside. `mullum-` is not a valid label. */
const BARE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

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
/**
 * True when `raw` is a bare community name that `normalizeNodeUrl` will expand.
 *
 * Exposed so a screen can SHOW the member what it resolved to. The expansion is a guess, and a
 * wrong guess is dangerous: a community hosted on its own domain — `beans.mycommunity.nz` — has a
 * name that expands to a `beanpool.org` address which is either nothing, or somebody else's node.
 * Silently sending a member there while they are recovering is worse than asking them to type more.
 */
export function isBareCommunityName(raw: string): boolean {
    const u = raw.trim();
    if (!u || SCHEME.test(u) || IPV4.test(u) || LOCALHOST.test(u)) return false;
    return BARE_NAME.test(u);
}

export function normalizeNodeUrl(raw: string): string {
    const u = raw.trim();
    if (!u) return '';
    if (SCHEME.test(u)) return u;
    if (IPV4.test(u) || LOCALHOST.test(u)) return 'http://' + u;
    if (BARE_NAME.test(u)) return `https://${u.toLowerCase()}.${COMMUNITY_DOMAIN}`;
    return 'https://' + u;
}

/**
 * Offline sanity check that a node address is well-formed (scheme + host.tld, an IP,
 * or localhost) — enough to catch a blank or a single-word typo. Deliberately NOT a
 * reachability check: that needs the network and would wrongly reject a valid address
 * on a flaky connection.
 */
export function looksLikeNodeAddress(url: string): boolean {
    return (/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(url)
        || /^https?:\/\/localhost(:\d+)?(\/|$)/i.test(url))
        && isPlainNodeAddress(url);
}

/**
 * Request binding: an address the app will connect to, sign for, or keep as a community's, names exactly one host.
 *
 * Every signature the app makes is bound to the host @beanpool/core's `audienceOf` reads from the URL, and that has
 * to be the host the phone then connects to. Parsers agree on that only for a plain authority. Core, browsers and
 * Android's OkHttp end the host at `\`; iOS's NSURL (React Native's fetch and WebSocket) percent-encodes the `\`
 * and reads everything before the last `@` as a login. So `https://127.0.0.1\@evil.test/` would be signed for
 * 127.0.0.1 and sent to evil.test.
 *
 * So the authority must be exactly `host[:port]`: a host name or IPv4 address made of letters, digits, hyphens and
 * dots, or a bracketed IPv6 address with at least two colons inside (iOS drops the brackets and connects to what's
 * inside, so `[deadbeef.de]` would be signed for one host and reach another), then at most a 5-digit port. No login
 * (`@`), no `\`, no whitespace, no control or percent-encoded character. Then comes a `/` or the end. A `?` or `#`
 * straight after the host isn't allowed: older parsers (RFC 1808) read the authority up to the first `/`, so
 * `https://a.test?x@evil.test/` could name evil.test to one of them. After that first `/`, every parser reads path,
 * so an `@` in the path is fine.
 */
const PLAIN_ADDRESS = /^(?:https?|wss?):\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[(?=(?:[0-9a-f.]*:){2})[0-9a-f:.]+\])(?::\d{1,5})?(?:\/|$)/i;

export function isPlainNodeAddress(url: unknown): url is string {
    return typeof url === 'string' && PLAIN_ADDRESS.test(url);
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', ws: '80', https: '443', wss: '443' };

/**
 * The origin a plain address names, in one spelling: `scheme://host[:port]`, scheme and host in lower case, the port
 * without leading zeros and left out when it is the scheme's default (80, 443). Null for an address that isn't plain
 * ({@link isPlainNodeAddress}). A plain string reading, like core's `audienceOf`, so Hermes and Node agree.
 *
 * Two addresses are the same community's when their origins are equal: not when one string starts with the other
 * (`https://a.org` is a prefix of `https://a.org.evil.example`), and not when the two read the same once every
 * character but a letter or digit is blotted out (`mullum.beanpool.org` and `mullum-beanpool.org`).
 */
export function plainOriginOf(url: unknown): string | null {
    if (!isPlainNodeAddress(url)) return null;
    const m = /^([a-z]+):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(url);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const port = m[3] === undefined ? '' : String(Number(m[3]));
    return `${scheme}://${m[2].toLowerCase()}${port && port !== DEFAULT_PORTS[scheme] ? `:${port}` : ''}`;
}

/** Why an address was refused. Shown as is. */
export const UNSAFE_NODE_ADDRESS_MESSAGE =
    "That community address isn't a plain web address (it has something like @ or \\ in it), so BeanPool won't " +
    'connect to it or sign anything for it. Check the address with whoever gave it to you.';

export class UnsafeNodeAddressError extends Error {
    constructor() {
        super(UNSAFE_NODE_ADDRESS_MESSAGE);
        this.name = 'UnsafeNodeAddressError';
    }
}

/**
 * Throws {@link UnsafeNodeAddressError} unless {@link isPlainNodeAddress}. Every builder that signs for a host calls
 * this first, before core reads the URL or anything is signed. So does every path that stores a community's
 * address.
 */
export function assertPlainNodeAddress(url: unknown): asserts url is string {
    if (!isPlainNodeAddress(url)) throw new UnsafeNodeAddressError();
}

/**
 * NAT-4: the phone's cleartext rule, kept in @beanpool/core so `beanpool claim` warns by exactly the rule this app refuses
 * by (packages/beanpool-core/src/cleartext-address.ts). Re-exported here so every caller keeps importing it from node-url.
 */
export { isPrivateHost, shouldBlockCleartextNodeUrl } from '@beanpool/core';
