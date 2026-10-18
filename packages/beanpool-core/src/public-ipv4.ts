/**
 * A server's public number, read one way by the server and the phone (review of #2138): the server holds a certificate
 * only for such a number (apps/server/src/engine/host-kinds.ts isCertifiableHost, read by own-addresses.ts tlsIdentifiers
 * and `beanpool claim --ip`), and the phone takes only such a number as a community's address
 * (apps/native/utils/community-origin.ts communityOrigin). So a directory row naming any other number never shows as a
 * community the phone can knock on and then fails at TLS.
 *
 * Not the cleartext rule (cleartext-address.ts isPrivateHost): that one says where plain http may still go, and reading
 * these ranges as private there would let http reach more of the Internet.
 */

/**
 * An IPv4 address anyone on the Internet could reach: a dotted quad, each part 0 to 255 written without leading zeros
 * (`010.1.1.1` reads as octal to some parsers), and none of 0.0.0.0/8 (some systems connect to it as the device itself),
 * 10/8, 100.64/10 (carrier NAT, and Tailscale's tailnets on a member's phone), 127/8, 169.254/16, 172.16/12, 192.168/16,
 * 198.18/15 (benchmarking networks), nor multicast and above (224/3).
 */
export function isPublicIpv4(host: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    if (o.some((n, i) => n > 255 || String(n) !== m[i + 1])) return false;
    const [a, b] = o;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
}
