/**
 * The federation announce addresses built from PUBLIC_IP (p2p-announce.ts).
 *
 * The global node's first deploy (2026-09-25) crash-looped: its host answered ifconfig.me with an IPv6 address, the
 * node wrote it into `/ip4/…`, and libp2p threw "Invalid IPv4 address" at start. Every address this builds is parsed
 * with the multiaddr library, the same check that threw, so a wrong protocol fails here instead of on a server.
 */
import assert from 'node:assert/strict';
import { multiaddr } from '@multiformats/multiaddr';
import { announceAddrsFor } from './p2p-announce.js';

let passed = 0;
function check(name: string, fn: () => void): void {
    fn();
    passed++;
    console.log(`✓ ${name}`);
}
const parses = (a: string) => { multiaddr(a); return true; };

check('an IPv4 address is announced as /ip4, and both addresses parse', () => {
    const a = announceAddrsFor('159.203.66.240', 4001, 4002);
    assert.deepEqual(a, ['/ip4/159.203.66.240/tcp/4001', '/ip4/159.203.66.240/tcp/4002/ws']);
    a!.forEach((x) => assert.ok(parses(x)));
});

check('an IPv6 address is announced as /ip6, and both addresses parse', () => {
    const a = announceAddrsFor('2604:a880:800:14:0:3:8eea:6000', 4001, 4002);
    assert.deepEqual(a, ['/ip6/2604:a880:800:14:0:3:8eea:6000/tcp/4001', '/ip6/2604:a880:800:14:0:3:8eea:6000/tcp/4002/ws']);
    a!.forEach((x) => assert.ok(parses(x)));
});

check('the old form (an IPv6 address under /ip4) is what the parser refuses: this test would have caught it', () => {
    assert.throws(() => multiaddr('/ip4/2604:a880:800:14:0:3:8eea:6000/tcp/4001'));
});

check('surrounding whitespace (a trailing newline from curl) is trimmed', () => {
    assert.deepEqual(announceAddrsFor(' 203.0.113.7\n', 1, 2), ['/ip4/203.0.113.7/tcp/1', '/ip4/203.0.113.7/tcp/2/ws']);
});

check('no PUBLIC_IP, or an empty one, announces nothing (libp2p then announces its listen addresses)', () => {
    assert.equal(announceAddrsFor(undefined, 1, 2), undefined);
    assert.equal(announceAddrsFor('', 1, 2), undefined);
    assert.equal(announceAddrsFor('   ', 1, 2), undefined);
});

check('something that is not an address (an error page, a hostname) announces nothing instead of stopping the node', () => {
    const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => { warned.push(m); };
    try {
        assert.equal(announceAddrsFor('<html>502 Bad Gateway</html>', 1, 2), undefined);
        assert.equal(announceAddrsFor('ifconfig.me', 1, 2), undefined);
        assert.equal(announceAddrsFor('999.1.1.1', 1, 2), undefined);
    } finally { console.warn = warn; }
    assert.equal(warned.length, 3);
    assert.ok(warned.every((m) => m.includes('not an IP address')));
});

console.log(`\nAll ${passed} p2p announce checks passed.`);
