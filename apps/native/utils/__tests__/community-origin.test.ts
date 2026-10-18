/**
 * A server's number is a community's address too, over https (scratch/global-node/DESIGN-https-anywhere-fable.md §3, D3,
 * slice S3): a server that has its own certificate for its public IP is reached at `https://203.0.113.5` from Communities
 * near you, the find card, Home's "Ask a community to let you in" and a knock, as a server with a name is. Before S3,
 * communityOrigin refused every IP literal ("a community with nothing to knock on").
 *
 * The rest stays refused: cleartext to anyone, a private, loopback or link-local number (core isPrivateHost, the
 * cleartext rule's own reading, which normalizeNodeUrl and withNodeScheme read too), 0.0.0.0/8 and multicast, a
 * carrier-NAT (100.64.0.0/10) or benchmarking (198.18.0.0/15) number, which the server never holds a certificate for
 * (one rule for both, core isPublicIpv4: review of #2138), an IPv6 literal, a malformed number, a login, and the global
 * node.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPrivateHost } from '@beanpool/core';
import { communityOrigin } from '../community-origin';
import { normalizeNodeUrl } from '../node-url';
import { GLOBAL_NODE_URL } from '../global-node-url';

describe('a public IPv4 address over https is a community\'s address', () => {
    it.each([
        ['https://203.0.113.5', 'https://203.0.113.5'],
        ['https://203.0.113.5/', 'https://203.0.113.5'],
        ['https://203.0.113.5/api/join/knock?x=1#y', 'https://203.0.113.5'],
        ['https://203.0.113.5:8443', 'https://203.0.113.5:8443'],
        ['https://203.0.113.5:443', 'https://203.0.113.5'],
        ['HTTPS://8.8.8.8', 'https://8.8.8.8'],
        ['https://172.32.0.1', 'https://172.32.0.1'], // just outside 172.16.0.0/12
        ['https://223.255.255.254', 'https://223.255.255.254'],
        // Just outside carrier NAT (100.64.0.0/10) and the benchmarking networks (198.18.0.0/15).
        ['https://100.63.255.255', 'https://100.63.255.255'],
        ['https://100.128.0.1', 'https://100.128.0.1'],
        ['https://198.17.255.255', 'https://198.17.255.255'],
        ['https://198.20.0.1', 'https://198.20.0.1'],
    ])('%j → %j', (raw, origin) => {
        expect(communityOrigin(raw)).toBe(origin);
    });

    it('is the address the phone makes of the same number typed bare (normalizeNodeUrl), so the two agree', () => {
        expect(normalizeNodeUrl('203.0.113.5')).toBe('https://203.0.113.5');
        expect(communityOrigin(normalizeNodeUrl('203.0.113.5'))).toBe('https://203.0.113.5');
    });
});

describe('everything else stays refused', () => {
    it.each([
        // Cleartext, to a public number or a name.
        'http://203.0.113.5', 'http://203.0.113.5:8080', 'http://beans.example.org',
        // Private, loopback and link-local numbers: the cleartext rule's own reading.
        'https://10.0.0.5', 'https://172.16.0.5', 'https://172.31.255.1', 'https://192.168.1.10:8443', 'https://127.0.0.1',
        'https://169.254.10.1',
        // Carrier NAT (and Tailscale's tailnets on a member's phone) and the benchmarking networks: the server's own
        // rule refuses them (review of #2138), so no server there has a certificate.
        'https://100.64.0.1', 'https://100.100.100.100', 'https://100.127.255.254', 'https://198.18.0.1', 'https://198.19.255.254',
        // Nothing serves there: 0.0.0.0/8 (some systems connect to it as the phone itself), multicast and above.
        'https://0.0.0.0', 'https://0.1.2.3', 'https://224.0.0.1', 'https://239.1.2.3', 'https://255.255.255.255',
        // Not a number at all, though all digits and dots.
        'https://999.1.1.1', 'https://1.2.3', 'https://1.2.3.4.5', 'https://203.0.113.5.', 'https://010.1.1.1',
        'https://203.000.113.5',
        // IPv6: S3 is IPv4 first (phones on IPv4-only networks can't reach an IPv6-only server).
        'https://[2001:db8::1]', 'https://[2001:db8::1]:8443',
        // A login before the number.
        'https://user@203.0.113.5', 'https://user.name:1234@203.0.113.5', 'https://203.0.113.5@evil.example.org',
    ])('%j is no address', (raw) => {
        expect(communityOrigin(raw)).toBeNull();
    });

    it('every private number refused here is one the cleartext rule calls private, so the two never disagree', () => {
        for (const ip of ['10.0.0.5', '172.16.0.5', '192.168.1.10', '127.0.0.1', '169.254.10.1']) {
            expect(isPrivateHost(ip), ip).toBe(true);
            expect(communityOrigin(`https://${ip}`), ip).toBeNull();
        }
    });

    it('a server\'s number is read by the server\'s own rule: one copy, in core, so the phone never offers a number no server is certified for', () => {
        // The server's certificate rule (isCertifiableHost) is in host-kinds.ts since S2 (#2135); own-addresses.ts re-exports it.
        const engine = (name: string) => fs.readFileSync(path.resolve(__dirname, `../../../server/src/engine/${name}`), 'utf8');
        const server = engine('host-kinds.ts');
        expect(server).toMatch(/import \{[^}]*\bisPublicIpv4\b[^}]*\} from '@beanpool\/core';/);
        expect(server).toMatch(/if \(\/\^\[\\d\.\]\+\$\/\.test\(host\)\) return isPublicIpv4\(host\);/);
        for (const name of ['host-kinds.ts', 'own-addresses.ts']) expect(engine(name), name).not.toMatch(/function isPublicIpv4\b|\bisPublicIpv4 = /);
        const phone = fs.readFileSync(path.resolve(__dirname, '../community-origin.ts'), 'utf8');
        expect(phone).toMatch(/import \{[^}]*\bisPublicIpv4\b[^}]*\} from '@beanpool\/core';/);
    });

    it('names are as before, and the global node is still never one', () => {
        expect(communityOrigin('https://mullum.beanpool.org')).toBe('https://mullum.beanpool.org');
        expect(communityOrigin('https://node.example.org:8443/')).toBe('https://node.example.org:8443');
        expect(communityOrigin(GLOBAL_NODE_URL)).toBeNull();
        expect(communityOrigin('https://localhost')).toBeNull();
        expect(communityOrigin('https://intranet:8443')).toBeNull();
    });
});
