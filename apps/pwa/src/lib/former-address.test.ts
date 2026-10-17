/**
 * The address the phone is told to type (lib/former-address.ts webAppAddress, review 4302869884): the community's host,
 * with its port when that isn't the scheme's own. webAppHost, the host a signature names, keeps dropping it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { webAppAddress, webAppHost } from './former-address';

afterEach(() => { localStorage.clear(); });

describe('webAppAddress: an address that reaches the community from a phone', () => {
    it('a community served on a port of its own keeps it; the signed host does not', () => {
        localStorage.setItem('bp_node_url', 'https://mynode.example.org:8443');
        expect(webAppAddress()).toBe('mynode.example.org:8443');
        expect(webAppHost()).toBe('mynode.example.org');
        localStorage.setItem('bp_node_url', 'https://203.0.113.7:8443');
        expect(webAppAddress()).toBe('203.0.113.7:8443');
        localStorage.setItem('bp_node_url', 'https://[2001:db8::7]:8443');
        expect(webAppAddress()).toBe('[2001:db8::7]:8443');
        // An address set without a scheme, read as https as the phone reads it.
        localStorage.setItem('bp_node_url', 'mynode.example.org:8443');
        expect(webAppAddress()).toBe('mynode.example.org:8443');
    });

    it("the scheme's own port is never written: 443 for https, 80 for http", () => {
        localStorage.setItem('bp_node_url', 'https://mynode.example.org:443');
        expect(webAppAddress()).toBe('mynode.example.org');
        localStorage.setItem('bp_node_url', 'https://MyNode.Example.org');
        expect(webAppAddress()).toBe('mynode.example.org');
        localStorage.setItem('bp_node_url', 'http://192.168.1.20:80');
        expect(webAppAddress()).toBe('192.168.1.20');
        // 443 is not http's own.
        localStorage.setItem('bp_node_url', 'http://192.168.1.20:443');
        expect(webAppAddress()).toBe('192.168.1.20:443');
    });

    it('no detached address: the page\'s own, port and all', () => {
        expect(webAppAddress()).toBe(window.location.host);
        expect(webAppHost()).toBe(window.location.hostname);
    });

    it('an address with no host a signature could name: none', () => {
        localStorage.setItem('bp_node_url', 'javascript:alert(1)');
        expect(webAppAddress()).toBeNull();
    });
});
