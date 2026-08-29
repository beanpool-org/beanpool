import { describe, it, expect } from 'vitest';
import { normalizeNodeUrl, looksLikeNodeAddress } from '../node-url';

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
