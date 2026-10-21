/**
 * Test coverage for host kinds utility functions in `engine/host-kinds.ts`.
 *
 * Verifies:
 * 1. normalizeAddress handling for valid URL strings, hostnames, non-strings, and long hostnames.
 * 2. isBeanPoolName for beanpool.org and subdomains vs other domains.
 * 3. isLoopbackHost for localhost, 127.0.0.1, 127.0.0.2, [::1], and non-loopback hosts.
 * 4. isLocalNetworkHost for loopback, .local, private IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x), local IPv6, and public hosts.
 * 5. isIpLiteral for IPv4 literals, bracketed IPv6 literals, and hostnames.
 * 6. isCertifiableHost for public IPv4/IPv6, certifiable FQDNs, non-public TLDs, loopback/local hosts, and beanpool.org names.
 * 7. isPublicIpv4Host for public IPv4 vs private/loopback IPv4 and hostnames.
 * 8. ownAddressProblem error messages for various invalid inputs and null for valid certifiable hosts.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-host-kinds.ts
 */

import {
    normalizeAddress,
    BEANPOOL_ZONE,
    isBeanPoolName,
    isLoopbackHost,
    isLocalNetworkHost,
    isIpLiteral,
    isCertifiableHost,
    isPublicIpv4Host,
    ownAddressProblem,
} from './engine/host-kinds.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

console.log('Running test-host-kinds.ts...');

// 1. normalizeAddress
assert(normalizeAddress(null) === null, '1. normalizeAddress(null) -> null');
assert(normalizeAddress(123) === null, '1. normalizeAddress(number) -> null');
assert(normalizeAddress('') === null, '1. normalizeAddress("") -> null');
assert(normalizeAddress('https://example.com/path?query=1') === 'example.com', '1. normalizeAddress URL -> hostname');
assert(normalizeAddress('example.com:8443') === 'example.com', '1. normalizeAddress host:port -> host');
assert(normalizeAddress('a'.repeat(254)) === null, '1. normalizeAddress >253 chars -> null');

// 2. isBeanPoolName
assert(BEANPOOL_ZONE === 'beanpool.org', '2. BEANPOOL_ZONE is beanpool.org');
assert(isBeanPoolName('beanpool.org') === true, '2. beanpool.org is BeanPool name');
assert(isBeanPoolName('community.beanpool.org') === true, '2. sub.beanpool.org is BeanPool name');
assert(isBeanPoolName('notbeanpool.org') === false, '2. notbeanpool.org is not BeanPool name');
assert(isBeanPoolName('fakebeanpool.com') === false, '2. fakebeanpool.com is not BeanPool name');

// 3. isLoopbackHost
assert(isLoopbackHost('localhost') === true, '3. localhost is loopback');
assert(isLoopbackHost('127.0.0.1') === true, '3. 127.0.0.1 is loopback');
assert(isLoopbackHost('127.0.0.2') === true, '3. 127.0.0.2 is loopback');
assert(isLoopbackHost('[::1]') === true, '3. [::1] is loopback');
assert(isLoopbackHost('128.0.0.1') === false, '3. 128.0.0.1 is not loopback');
assert(isLoopbackHost('example.com') === false, '3. example.com is not loopback');

// 4. isLocalNetworkHost
assert(isLocalNetworkHost('localhost') === true, '4. localhost is local network');
assert(isLocalNetworkHost('node.local') === true, '4. *.local is local network');
assert(isLocalNetworkHost('10.0.0.1') === true, '4. 10.x.x.x is local network');
assert(isLocalNetworkHost('172.16.0.1') === true, '4. 172.16.x.x is local network');
assert(isLocalNetworkHost('172.31.255.255') === true, '4. 172.31.x.x is local network');
assert(isLocalNetworkHost('172.32.0.1') === false, '4. 172.32.x.x is not local network');
assert(isLocalNetworkHost('192.168.1.1') === true, '4. 192.168.x.x is local network');
assert(isLocalNetworkHost('169.254.1.1') === true, '4. 169.254.x.x is local network');
assert(isLocalNetworkHost('[fc00::1]') === true, '4. [fc00::1] unique-local IPv6 is local network');
assert(isLocalNetworkHost('[fe80::1]') === true, '4. [fe80::1] link-local IPv6 is local network');
assert(isLocalNetworkHost('8.8.8.8') === false, '4. 8.8.8.8 public IPv4 is not local network');
assert(isLocalNetworkHost('[2001:db8::1]') === false, '4. public IPv6 is not local network');

// 5. isIpLiteral
assert(isIpLiteral('192.168.1.1') === true, '5. 192.168.1.1 is IP literal');
assert(isIpLiteral('[2001:db8::1]') === true, '5. [2001:db8::1] is IP literal');
assert(isIpLiteral('example.com') === false, '5. example.com is not IP literal');

// 6. isCertifiableHost
assert(isCertifiableHost('beans.example.org') === true, '6. beans.example.org is certifiable');
assert(isCertifiableHost('8.8.8.8') === true, '6. 8.8.8.8 public IPv4 is certifiable');
assert(isCertifiableHost('[2001:4860:4860::8888]') === true, '6. public IPv6 is certifiable');
assert(isCertifiableHost('127.0.0.1') === false, '6. 127.0.0.1 loopback is not certifiable');
assert(isCertifiableHost('10.0.0.1') === false, '6. 10.0.0.1 private IPv4 is not certifiable');
assert(isCertifiableHost('sub.beanpool.org') === false, '6. sub.beanpool.org is not certifiable (edge managed)');
assert(isCertifiableHost('node.local') === false, '6. .local is not certifiable');
assert(isCertifiableHost('server.internal') === false, '6. .internal is not certifiable');
assert(isCertifiableHost('singlelabel') === false, '6. single label hostname is not certifiable');
assert(isCertifiableHost('domain.123') === false, '6. numeric TLD is not certifiable');

// 7. isPublicIpv4Host
assert(isPublicIpv4Host('8.8.8.8') === true, '7. 8.8.8.8 is public IPv4 host');
assert(isPublicIpv4Host('127.0.0.1') === false, '7. 127.0.0.1 is not public IPv4 host');
assert(isPublicIpv4Host('192.168.1.1') === false, '7. 192.168.1.1 is not public IPv4 host');
assert(isPublicIpv4Host('example.com') === false, '7. example.com is not public IPv4 host');

// 8. ownAddressProblem
assert(ownAddressProblem('beans.example.org') === null, '8. valid FQDN has no problem');
assert(ownAddressProblem('8.8.8.8') === null, '8. public IPv4 has no problem');
assert(typeof ownAddressProblem('not a valid url ^^^') === 'string', '8. invalid address returns problem text');
assert(typeof ownAddressProblem('mycommunity.beanpool.org') === 'string', '8. beanpool.org name returns problem text');
assert(typeof ownAddressProblem('192.168.1.5') === 'string', '8. local network IP returns problem text');
assert(typeof ownAddressProblem('127.0.0.1') === 'string', '8. loopback IP returns problem text');
assert(typeof ownAddressProblem('server.local') === 'string', '8. non-certifiable TLD returns problem text');

console.log(`\n${passed}/${run} checks passed.`);
if (passed !== run) {
    console.error(`❌ ${run - passed} check(s) failed`);
    process.exit(1);
}

console.log(`${passed}/${run} checks passed.`);
process.exit(0);
