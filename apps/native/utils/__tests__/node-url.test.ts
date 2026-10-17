import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeNodeUrl, looksLikeNodeAddress, isBareCommunityName, isPlainNodeAddress, shouldBlockCleartextNodeUrl } from '../node-url';

describe('normalizeNodeUrl — community name or node address', () => {
    it('expands a bare community name', () => {
        // The point of the change: someone recovering knows "mullum", not the URL.
        expect(normalizeNodeUrl('mullum')).toBe('https://mullum.beanpool.org');
        expect(normalizeNodeUrl('  Mullum  ')).toBe('https://mullum.beanpool.org');
        expect(normalizeNodeUrl('yarra-valley')).toBe('https://yarra-valley.beanpool.org');
    });

    it('leaves a full address alone', () => {
        expect(normalizeNodeUrl('mullum.beanpool.org')).toBe('https://mullum.beanpool.org');
        expect(normalizeNodeUrl('https://mullum.beanpool.org')).toBe('https://mullum.beanpool.org');
        expect(normalizeNodeUrl('http://node.example.com')).toBe('http://node.example.com');
    });

    it('does not hijack a self-hosted node on its own domain', () => {
        expect(normalizeNodeUrl('beans.mycommunity.nz')).toBe('https://beans.mycommunity.nz');
    });

    it('still uses http for IPs and localhost', () => {
        expect(normalizeNodeUrl('192.168.1.10:8443')).toBe('http://192.168.1.10:8443');
        expect(normalizeNodeUrl('localhost:8443')).toBe('http://localhost:8443');
    });

    it('returns empty for blank input', () => {
        expect(normalizeNodeUrl('')).toBe('');
        expect(normalizeNodeUrl('   ')).toBe('');
    });

    it('produces something looksLikeNodeAddress accepts, which a bare name did not before', () => {
        expect(looksLikeNodeAddress(normalizeNodeUrl('mullum'))).toBe(true);
        expect(looksLikeNodeAddress(normalizeNodeUrl('localhost:8443'))).toBe(true);
    });
});

// A bare public IPv4 address used to become http://, which the app then refused as cleartext to a public host, and an
// IPv6 literal was refused outright by looksLikeNodeAddress. The cleartext rule itself (core) is not changed here.
describe('a bare IP address: https unless it is private, IPv6 bracketed and over https only', () => {
    const NORMALISED: Array<[typed: string, url: string]> = [
        // Public IPv4: https, never the http the app would refuse.
        ['203.0.113.7:8443', 'https://203.0.113.7:8443'],
        ['203.0.113.7', 'https://203.0.113.7'],
        ['8.8.8.8:443', 'https://8.8.8.8:443'],
        ['172.32.0.1:8080', 'https://172.32.0.1:8080'], // just outside 172.16.0.0/12
        ['100.64.1.2:8080', 'https://100.64.1.2:8080'], // shared address space: public to the cleartext rule
        // Private, loopback, link-local and localhost: http, as before.
        ['192.168.1.10:8443', 'http://192.168.1.10:8443'],
        ['10.0.2.2:8080', 'http://10.0.2.2:8080'],
        ['172.16.0.5', 'http://172.16.0.5'],
        ['172.31.255.1:8080', 'http://172.31.255.1:8080'],
        ['127.0.0.1:8443', 'http://127.0.0.1:8443'],
        ['169.254.10.1:8080', 'http://169.254.10.1:8080'],
        ['localhost:8443', 'http://localhost:8443'],
        // IPv6 literals: always https (the cleartext rule can't tell a public one from a private one).
        ['[2001:db8::7]:8443', 'https://[2001:db8::7]:8443'],
        ['[2001:db8::7]', 'https://[2001:db8::7]'],
        ['[::1]:8080', 'https://[::1]:8080'],
        ['[fd00::20]', 'https://[fd00::20]'],
        // A scheme typed by the member stays as typed (and the cleartext rule then decides).
        ['http://203.0.113.7:8443', 'http://203.0.113.7:8443'],
        ['https://192.168.1.10:8443', 'https://192.168.1.10:8443'],
    ];

    it.each(NORMALISED)('normalizeNodeUrl(%j) is %j', (typed, url) => {
        expect(normalizeNodeUrl(typed)).toBe(url);
    });

    it.each(NORMALISED.filter(([typed]) => !/^https?:/i.test(typed)))(
        'a bare %j becomes an address the typed-address screens accept, and never one the cleartext rule refuses', (typed) => {
            const url = normalizeNodeUrl(typed);
            expect(looksLikeNodeAddress(url)).toBe(true);
            expect(isPlainNodeAddress(url)).toBe(true);
            expect(shouldBlockCleartextNodeUrl(url)).toBe(false);
        },
    );

    it('the cleartext rule is unchanged: http to a public IPv4 address is still refused', () => {
        expect(shouldBlockCleartextNodeUrl('http://203.0.113.7:8443')).toBe(true);
        expect(shouldBlockCleartextNodeUrl(normalizeNodeUrl('http://203.0.113.7:8443'))).toBe(true);
        expect(shouldBlockCleartextNodeUrl(normalizeNodeUrl('203.0.113.7:8443'))).toBe(false);
    });

    const ACCEPTED = [
        'https://[2001:db8::7]:8443',
        'https://[2001:db8::7]',
        'https://[2001:db8::7]/',
        'https://[2001:db8::7]:8443/api/x',
        'HTTPS://[2001:DB8::7]',
        'https://[::1]',
        'https://[fe80::1]:8443',
        'https://[::]',
        'https://[1:2:3:4:5:6:7:8]',
        'https://[1:2:3:4:5:6:7::]',
        'https://[::ffff:192.0.2.1]',
        'https://[64:ff9b::203.0.113.7]',
        'https://[1:2:3:4:5:6:192.0.2.1]',
    ];
    it.each(ACCEPTED)('looksLikeNodeAddress accepts %j', (url) => {
        expect(looksLikeNodeAddress(url)).toBe(true);
    });

    const REFUSED = [
        // Cleartext to an IPv6 literal: the cleartext rule lets every one through, so the typed-address check doesn't.
        'http://[2001:db8::7]:8443',
        'http://[::1]:8080',
        'http://[fd00::20]',
        // Not an IPv6 address.
        'https://[]',
        'https://[2001:db8::7',
        'https://[2001:db8:::7]',
        'https://[1::2::3]',
        'https://[1:2:3:4:5:6:7]',
        'https://[1:2:3:4:5:6:7:8:9]',
        'https://[1:2:3:4:5:6:7:8::]',
        'https://[12345::1]',
        'https://[g::1]',
        'https://[:1:2:3:4:5:6:7]',
        'https://[1:2:3:4:5:6:7:]',
        'https://[::ffff:999.0.2.1]',
        'https://[::ffff:1.2.3]',
        'https://[1.2.3.4::]',
        'https://[1.2.3.4]',
        'https://[a:b]',
        'https://[deadbeef.de]',
        'https://[2001:db8::7]x',
        // Not one plain host (node-url.ts isPlainNodeAddress): a zone, a login, a backslash, a six-digit port.
        'https://[fe80::1%25en0]',
        'https://[::1]@evil.test',
        'https://[::1]\\@evil.test',
        'https://evil.test@[::1]',
        'https://[::1]:123456',
        'https://[::1]?x@evil.test/',
    ];
    it.each(REFUSED)('looksLikeNodeAddress refuses %j', (url) => {
        expect(looksLikeNodeAddress(url)).toBe(false);
    });

    it('a claim link or typed claim address and a re-key community take a bare public IP or IPv6 literal as https', async () => {
        const { claimNodeOrigin } = await import('../claim-link');
        const { rekeyCommunityUrl } = await import('../rekey-redeem');
        expect(claimNodeOrigin('203.0.113.7:8443')).toBe('https://203.0.113.7:8443');
        expect(claimNodeOrigin('[2001:db8::7]:8443')).toBe('https://[2001:db8::7]:8443');
        expect(claimNodeOrigin('http://203.0.113.7:8443')).toBeNull();
        expect(rekeyCommunityUrl('203.0.113.7:8443')).toBe('https://203.0.113.7:8443');
        expect(rekeyCommunityUrl('[2001:db8::7]:8443')).toBe('https://[2001:db8::7]:8443');
        expect(rekeyCommunityUrl('http://[2001:db8::7]:8443')).toBeNull();
    });
});

describe('isBareCommunityName — so a screen can show the guess before making it', () => {
    it('flags bare names, which are the only ones that get expanded', () => {
        expect(isBareCommunityName('mullum')).toBe(true);
        expect(isBareCommunityName('yarra-valley')).toBe(true);
    });

    it('does not flag anything already an address', () => {
        // A community on its own domain must never be silently redirected to beanpool.org.
        expect(isBareCommunityName('beans.mycommunity.nz')).toBe(false);
        expect(isBareCommunityName('https://mullum.beanpool.org')).toBe(false);
        expect(isBareCommunityName('192.168.1.10:8443')).toBe(false);
        expect(isBareCommunityName('localhost:8443')).toBe(false);
        expect(isBareCommunityName('')).toBe(false);
    });
});

describe('edge cases that were wrong before review', () => {
    it('does not treat a name merely starting with "http" as a scheme', () => {
        // startsWith('http') said yes to this, so it never expanded.
        expect(normalizeNodeUrl('httppool')).toBe('https://httppool.beanpool.org');
        expect(isBareCommunityName('httppool')).toBe(true);
    });

    it('handles an uppercase scheme instead of bolting a second one on the front', () => {
        expect(normalizeNodeUrl('HTTP://node.example.com')).toBe('HTTP://node.example.com');
        expect(isBareCommunityName('HTTPS://mullum.beanpool.org')).toBe(false);
    });

    it('does not downgrade a public host that merely begins with "localhost"', () => {
        // This branch picks http://, so the old prefix check was a cleartext downgrade for an
        // attacker-controlled domain.
        expect(normalizeNodeUrl('localhost.attacker.com')).toBe('https://localhost.attacker.com');
        expect(normalizeNodeUrl('localhost-phish.org')).toBe('https://localhost-phish.org');
        expect(normalizeNodeUrl('localhost')).toBe('http://localhost');
        expect(normalizeNodeUrl('localhost:8443')).toBe('http://localhost:8443');
    });

    it('refuses a name that would build an invalid hostname label', () => {
        expect(isBareCommunityName('mullum-')).toBe(false);
        expect(isBareCommunityName('-mullum')).toBe(false);
        expect(isBareCommunityName('mull-um')).toBe(true);
    });
});

describe("the iPhone's own cleartext rule (FABLE-sec-native LOW-1, 2026-10-01)", () => {
    it('App Transport Security stays on, local networking allowed: written in app.json, not left to the template', () => {
        // Measured 2026-10-01 in build 1.2.56 (220): the template already wrote exactly this. Android has no such rule
        // here: a network security config names exact hosts only, never the private ranges a community's own LAN node
        // sits on, so shouldBlockCleartextNodeUrl stays the rule there.
        const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf-8'));
        expect(app.expo.ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true });
    });
});

describe("the phone's cleartext rule is the one `beanpool claim` warns by", () => {
    it("node-url hands out core's own functions, so the server's warning and the phone's refusal cannot drift apart", async () => {
        const core = await import('@beanpool/core');
        const nodeUrl = await import('../node-url');
        expect(nodeUrl.shouldBlockCleartextNodeUrl).toBe(core.shouldBlockCleartextNodeUrl);
        expect(nodeUrl.isPrivateHost).toBe(core.isPrivateHost);
    });

    it('a claim link to a public server over plain http is refused; a home-network or https one is not', async () => {
        const { parseClaimLink } = await import('../claim-link');
        expect(parseClaimLink('beanpool://claim?node=http%3A%2F%2F203.0.113.7&id=0a1b2c3d')?.nodeRefused).toBe(true);
        expect(parseClaimLink('beanpool://claim?node=http%3A%2F%2F192.168.1.20%3A8080&id=0a1b2c3d')?.node).toBe('http://192.168.1.20:8080');
        expect(parseClaimLink('beanpool://claim?node=https%3A%2F%2Fbeans.example.org&id=0a1b2c3d')?.node).toBe('https://beans.example.org');
    });
});
