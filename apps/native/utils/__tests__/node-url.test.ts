import { describe, it, expect } from 'vitest';
import { normalizeNodeUrl, looksLikeNodeAddress, isBareCommunityName } from '../node-url';

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
