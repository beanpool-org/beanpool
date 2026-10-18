/**
 * A server's public number, in the one copy the server (engine/own-addresses.ts: which numbers it holds a certificate for)
 * and the phone (utils/community-origin.ts: which numbers are a community's address) both read (review of #2138).
 */
import { describe, it, expect } from 'vitest';
import { isPrivateHost, isPublicIpv4 } from '../index.js';

describe('isPublicIpv4', () => {
    it.each([
        '203.0.113.5', '8.8.8.8', '1.1.1.1', '223.255.255.254', '172.15.255.255', '172.32.0.1', '192.167.1.1', '192.169.0.1',
        '100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '169.253.0.1', '11.0.0.1',
    ])('%s is a server\'s public number', (ip) => {
        expect(isPublicIpv4(ip)).toBe(true);
    });

    it.each([
        // Private, loopback, link-local: the cleartext rule's private numbers.
        '10.0.0.5', '172.16.0.5', '172.31.255.1', '192.168.1.10', '127.0.0.1', '169.254.10.1',
        // Carrier NAT (and Tailscale's tailnets), benchmarking networks.
        '100.64.0.1', '100.100.100.100', '100.127.255.254', '198.18.0.1', '198.19.255.254',
        // This device, multicast and above.
        '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.2.3', '255.255.255.255',
        // Not a number as written: out of range, short, long, leading zeros, a port, spaces, a name.
        '999.1.1.1', '1.2.3', '1.2.3.4.5', '010.1.1.1', '203.000.113.5', '203.0.113.5:443', ' 203.0.113.5', 'beans.example.org', '',
    ])('%j is not', (ip) => {
        expect(isPublicIpv4(ip)).toBe(false);
    });

    it('never calls a number public that the cleartext rule calls private', () => {
        for (const ip of ['10.0.0.5', '172.16.0.5', '192.168.1.10', '127.0.0.1', '169.254.10.1']) {
            expect(isPrivateHost(ip), ip).toBe(true);
            expect(isPublicIpv4(ip), ip).toBe(false);
        }
        // …and leaves the cleartext rule as it was: these stay public there (plain http to them is still refused).
        for (const ip of ['100.64.0.1', '198.18.0.1']) expect(isPrivateHost(ip), ip).toBe(false);
    });
});
