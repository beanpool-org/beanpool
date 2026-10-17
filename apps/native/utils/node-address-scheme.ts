import { isPrivateHost } from '@beanpool/core';

/** A real scheme, in any letter case (node-url.ts SCHEME: `startsWith('http')` also said yes to `httppool`). */
const SCHEME = /^https?:\/\//i;

/** Localhost exactly, optionally with a port: `startsWith('localhost')` also matched `localhost.attacker.com`. */
const LOCALHOST = /^localhost(:\d+)?$/i;

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/;

/**
 * A node address someone typed or a link carried, with its scheme: Settings' "Add & Connect", the address typed beside
 * an invite on People, a deep link's `server=` (utils/invite-parser.ts).
 *
 * http:// only for localhost and a private/LAN IPv4 address (core isPrivateHost, the cleartext rule's own reading).
 * https:// for everything else: a public IPv4 address, a bracketed IPv6 literal, a host name. The same rule
 * normalizeNodeUrl (utils/node-url.ts) follows, without its community-name expansion: these three never expanded a bare
 * word, and a guessed `<word>.beanpool.org` they didn't show the member could be somebody else's node.
 *
 * Each of them used to pick http:// for every bare IPv4 address, and for anything starting `localhost`. The cleartext
 * rule (shouldBlockCleartextNodeUrl) refuses http:// to a public host, so a node on a public IP was saved under an
 * address every request to it then failed on (utils/node-request-signing.ts), and `localhost.attacker.com` was given
 * cleartext by a test that read it as this phone.
 *
 * An address with a scheme keeps it: a typed http:// stays http://, and the cleartext rule still decides. Only its
 * letter case changes (`HTTP://` → `http://`), because the readers after this one (ws-client's `/^http/`) expect lower
 * case. Returns '' for blank input.
 */
export function withNodeScheme(raw: string): string {
    const u = raw.trim();
    if (!u) return '';
    if (SCHEME.test(u)) return u.replace(SCHEME, (s) => s.toLowerCase());
    if (LOCALHOST.test(u) || (IPV4.test(u) && isPrivateHost(u))) return 'http://' + u;
    return 'https://' + u;
}
