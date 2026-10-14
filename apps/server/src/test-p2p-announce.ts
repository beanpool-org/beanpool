/**
 * The federation announce addresses built from PUBLIC_IP (p2p-announce.ts).
 *
 * The global node's first deploy (2026-09-25) crash-looped: its host answered ifconfig.me with an IPv6 address, the
 * node wrote it into `/ip4/…`, and libp2p threw "Invalid IPv4 address" at start. Every address this builds is parsed
 * with the multiaddr library, the same check that threw, so a wrong protocol fails here instead of on a server.
 *
 * A hand-set value (#1135's review): a host name is announced as /dns, and a real libp2p node on localhost announcing one
 * starts and is dialled by a peer at that address (the p2p layer supports it, measured here rather than assumed); an IPv6
 * address with a zone, which node:net takes and libp2p refuses at start, is refused with the reason; so is anything
 * else that is neither an address nor a host name. And the multiaddr p2p-announce.ts checks with is the copy libp2p
 * parses with (#1333 review), so its check and libp2p's can't drift apart.
 */
import assert from 'node:assert/strict';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
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

/** What announceAddrsFor warns, while it runs `fn`. */
function warnings(fn: () => void): string[] {
    const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => { warned.push(m); };
    try { fn(); } finally { console.warn = warn; }
    return warned;
}

check('something that is neither an address nor a host name announces nothing instead of stopping the node, and says what to set', () => {
    const refused = ['<html>502 Bad Gateway</html>', '999.1.1.1', 'https://bean.example.org', 'bean.example.org:8443',
        'bean.example.org/', '-bean.example.org', 'bean..example.org', 'bean_example.org', `${'a'.repeat(64)}.example.org`];
    const warned = warnings(() => {
        for (const v of refused) assert.equal(announceAddrsFor(v, 1, 2), undefined, v);
    });
    assert.equal(warned.length, refused.length);
    assert.ok(warned.every((m) => m.includes('is not an IP address or a host name') && m.includes('such as bean.example.org')), warned.join('\n'));
});

// A host name used to announce nothing (this file's old check had ifconfig.me there, refused): apps/server/README.md tells
// self-hosters to set one, and the p2p layer dials a /dns address (the libp2p check below).
check('a host name is announced as /dns, and both addresses parse', () => {
    const a = announceAddrsFor('bean.example.org', 4001, 4002);
    assert.deepEqual(a, ['/dns/bean.example.org/tcp/4001', '/dns/bean.example.org/tcp/4002/ws']);
    a!.forEach((x) => assert.ok(parses(x)));
    assert.deepEqual(announceAddrsFor('ifconfig.me', 1, 2), ['/dns/ifconfig.me/tcp/1', '/dns/ifconfig.me/tcp/2/ws']);
    assert.deepEqual(announceAddrsFor('Bean-1.Example.ORG', 1, 2), ['/dns/Bean-1.Example.ORG/tcp/1', '/dns/Bean-1.Example.ORG/tcp/2/ws']);
});

check('a host name written with its trailing dot (bean.example.org.) is announced without it', () => {
    assert.deepEqual(announceAddrsFor('bean.example.org.', 1, 2), ['/dns/bean.example.org/tcp/1', '/dns/bean.example.org/tcp/2/ws']);
});

check('an IPv6 address with a zone (fe80::1%eth0) is refused with the reason: node:net takes it, libp2p stopped the node on it', () => {
    let out: string[] | undefined = [];
    const warned = warnings(() => { out = announceAddrsFor('fe80::1%eth0', 4001, 4002); });
    assert.equal(out, undefined);
    assert.equal(warned.length, 1);
    assert.ok(warned[0].includes('names a network interface') && warned[0].includes('"%eth0"') && warned[0].includes('or 2001:db8::7'), warned[0]);
    // What the old code built from it, and what the parser libp2p uses says of that.
    assert.throws(() => multiaddr('/ip6/fe80::1%eth0/tcp/4001'));
});

// The p2p layer itself, on localhost: libp2p throws on a zone id as a node starts (why it is refused above), and a node
// announcing a /dns address starts and a peer dials it there. Nothing leaves this machine.
async function libp2pChecks(): Promise<void> {
    const opts = (listen: string[], announce?: string[]) => ({
        addresses: { listen, announce },
        transports: [tcp(), webSockets()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
        services: { identify: identify() },
    });

    // What startP2P (p2p.ts) does: create, start, then read the addresses to log them.
    let threw = '';
    const z = await createLibp2p(opts(['/ip4/127.0.0.1/tcp/0'], ['/ip6/fe80::1%eth0/tcp/4001']));
    try {
        await z.start();
        z.getMultiaddrs();
    } catch (e: any) { threw = String(e?.message ?? e); } finally { try { await z.stop(); } catch { /* it may not have started */ } }
    assert.ok(/Invalid IPv6 address/.test(threw), `libp2p throws on a zone id as startP2P starts it (${threw || 'nothing thrown'})`);
    passed++;
    console.log('✓ announcing an IPv6 address with a zone throws as startP2P starts the node: the restart loop the refusal above prevents');

    // A free port for the node to listen on and announce.
    const probe = await createLibp2p(opts(['/ip4/127.0.0.1/tcp/0']));
    const port = Number(probe.getMultiaddrs()[0].toString().split('/tcp/')[1].split('/')[0]);
    await probe.stop();

    const announce = announceAddrsFor('localhost', port, port + 1)!;
    const a = await createLibp2p(opts([`/ip4/127.0.0.1/tcp/${port}`], [announce[0]]));
    const b = await createLibp2p(opts(['/ip4/127.0.0.1/tcp/0']));
    try {
        const announced = a.getMultiaddrs().map((m) => m.toString());
        assert.deepEqual(announced, [`/dns/localhost/tcp/${port}/p2p/${a.peerId.toString()}`]);
        passed++;
        console.log(`✓ a node announcing a host name starts, and announces ${announced[0].split('/p2p/')[0]}`);
        // p2p-announce.ts checks each address with the multiaddr this file imports. That check is only as good as its
        // agreement with the copy libp2p parses with (#1333 review: the server had 12.5.1, libp2p 13.0.1). One copy:
        // what libp2p hands back is an instance of the very class the server's import makes.
        assert.equal(Object.getPrototypeOf(a.getMultiaddrs()[0]), Object.getPrototypeOf(multiaddr('/ip4/127.0.0.1/tcp/1')),
            'libp2p and apps/server load different copies of @multiformats/multiaddr: keep apps/server/package.json on the major libp2p uses');
        passed++;
        console.log('✓ libp2p parses with the same copy of @multiformats/multiaddr that p2p-announce.ts checks with');
        const conn = await b.dial(a.getMultiaddrs()[0], { signal: AbortSignal.timeout(10_000) });
        assert.equal(conn.status, 'open');
        assert.equal(conn.remotePeer.toString(), a.peerId.toString());
        passed++;
        console.log('✓ and a peer dials it at that /dns address');
    } finally {
        await b.stop();
        await a.stop();
    }
}

libp2pChecks().then(() => {
    console.log(`\nAll ${passed} p2p announce checks passed.`);
    process.exit(0);
}).catch((e) => {
    console.error('✗', e);
    process.exit(1);
});
