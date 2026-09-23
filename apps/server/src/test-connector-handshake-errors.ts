/**
 * A peer that fails oddly must not skip the rest of the handshake round.
 *
 * WHY THIS SUITE EXISTS. #1033 stopped a non-Error handshake rejection crashing the node, by wrapping the
 * whole of `handshakeConnectedPeers` in an outer try. What it did not fix is the PER-PEER handler inside that
 * loop, which read `e.message` directly. JavaScript lets anything be thrown, and libp2p transports reject with
 * plenty that is not an Error — `undefined` from a torn-down dialler, a bare string from a hand-rolled
 * timeout. On those, `e.message` throws a TypeError from inside the very handler meant to record the failure.
 * That throw escapes the per-peer catch, unwinds the `for` loop, and lands in the outer catch: the first bad
 * peer in the list silently cancels the handshake for every peer after it, once every 10 seconds, forever.
 * Nothing crashes and nothing is logged against the skipped peers, so the symptom is peers that simply stop
 * being verified — which is why this is worth a suite rather than a one-line diff.
 *
 * HOW IT DRIVES THE REAL CODE. `sendHandshake` propagates whatever `node.dialProtocol` rejects with (it only
 * has a `finally`), so a stub libp2p node whose `dialProtocol` rejects with a chosen value reproduces the
 * exact shape without a transport. The stub also captures the `peer:connect` listener that
 * `initConnectorManager` registers, which is how the connectors here are marked connected — the same path a
 * real connection takes. NO NETWORK IS TOUCHED: every peer id below is a sha256 of a fixed label, and the
 * stub node never dials anything.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-connector-handshake-errors.ts
 */
import { createHash } from 'node:crypto';
import { base58btc } from 'multiformats/bases/base58';
import { initStateEngine } from './state-engine.js';
import {
    addConnector,
    connectToAddress,
    getConnectorByAddress,
    handshakeConnectedPeers,
    initConnectorManager,
} from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/**
 * A syntactically valid peer id that belongs to nobody: the sha2-256 of a label, wrapped as a multihash, so
 * `peerIdFromString` parses it (the manager calls that on every round) while it names no real node.
 */
function fakePeerId(label: string): string {
    const digest = createHash('sha256').update(label).digest();
    return base58btc.baseEncode(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

const PEERS = ['a', 'b', 'c'].map(suffix => {
    const peerId = fakePeerId(`beanpool-handshake-error-test-${suffix}`);
    return { suffix, peerId, address: `/ip4/127.0.0.1/tcp/4001/p2p/${peerId}` };
});

/** What `dialProtocol`/`dial` should reject with, per peer id. Absent means "resolve" (never used here). */
const rejections = new Map<string, unknown>();
/** Every peer id the round asked to handshake, in order. The whole point of the suite. */
let dialled: string[] = [];

let onPeerConnect: ((evt: { detail: { toString(): string } }) => void) | null = null;

const stubNode: any = {
    peerId: { toString: () => fakePeerId('beanpool-handshake-error-test-self') },
    addEventListener: (name: string, handler: any) => {
        if (name === 'peer:connect') onPeerConnect = handler;
    },
    removeEventListener: () => {},
    // `throw x` inside an async function rejects with x untouched — including when x is undefined, which is
    // the case an ordinary `catch (e: any) { e.message }` cannot survive.
    dialProtocol: async (peerId: any) => {
        const id = peerId.toString();
        dialled.push(id);
        throw rejections.get(id);
    },
    dial: async (ma: any) => {
        dialled.push(String(ma));
        throw rejections.get('dial');
    },
    hangUp: async () => {},
};

/** Mark a connector connected the way a real connection does — through the manager's own event listener. */
function markConnected(peerId: string): void {
    onPeerConnect?.({ detail: { toString: () => peerId } });
}

async function main(): Promise<void> {
    initStateEngine();
    initConnectorManager(stubNode);
    assert(onPeerConnect !== null, 'the manager registered a peer:connect listener on the node');

    for (const peer of PEERS) addConnector(peer.address, 'peer', `peer-${peer.suffix}`);
    for (const peer of PEERS) markConnected(peer.peerId);
    assert(
        PEERS.every(p => getConnectorByAddress(p.address)?.connected === true),
        'all three connectors start the round connected',
    );

    // ── Round 1: the FIRST peer rejects with `undefined` ─────────────────────────────────────────────
    // The killer case. `undefined.message` is a TypeError thrown from inside the error handler, so on the
    // unfixed code peers b and c are never reached.
    rejections.clear();
    rejections.set(PEERS[0].peerId, undefined);
    rejections.set(PEERS[1].peerId, new Error('peer-b stream reset'));
    rejections.set(PEERS[2].peerId, new Error('peer-c stream reset'));
    dialled = [];

    let threw: unknown = null;
    try { await handshakeConnectedPeers(); } catch (e) { threw = e; }

    assert(threw === null, 'a round where the first peer rejects with undefined does not reject');
    assert(
        dialled.length === 3 && PEERS.every(p => dialled.includes(p.peerId)),
        `all three peers were handshaken in the same round (got ${dialled.length}: ${dialled.map(d => d.slice(-6)).join(', ')})`,
    );
    const undefinedError = getConnectorByAddress(PEERS[0].address)?.error;
    assert(
        typeof undefinedError === 'string' && undefinedError.startsWith('Handshake failed: ') && undefinedError.length > 'Handshake failed: '.length,
        `the peer that rejected with undefined records a readable error (got ${JSON.stringify(undefinedError)})`,
    );
    assert(
        getConnectorByAddress(PEERS[2].address)?.error === 'Handshake failed: peer-c stream reset',
        'the last peer in the round still records its own error, unchanged for a normal Error',
    );

    // ── Round 2: the FIRST peer rejects with a plain string ──────────────────────────────────────────
    // `'some string'.message` is undefined rather than a throw, so this one survives the status line and dies
    // on the template reads instead. Same outcome for the peers behind it, different mechanism.
    for (const peer of PEERS) markConnected(peer.peerId);
    rejections.clear();
    rejections.set(PEERS[0].peerId, 'connection reset by peer');
    rejections.set(PEERS[1].peerId, new Error('peer-b unreachable'));
    rejections.set(PEERS[2].peerId, new Error('peer-c unreachable'));
    dialled = [];

    threw = null;
    try { await handshakeConnectedPeers(); } catch (e) { threw = e; }

    assert(threw === null, 'a round where the first peer rejects with a string does not reject');
    assert(
        dialled.length === 3 && PEERS.every(p => dialled.includes(p.peerId)),
        `all three peers were handshaken in that round too (got ${dialled.length})`,
    );
    assert(
        getConnectorByAddress(PEERS[0].address)?.error === 'Handshake failed: connection reset by peer',
        'a thrown string IS the message, so it reaches the status verbatim',
    );
    assert(
        getConnectorByAddress(PEERS[1].address)?.error === 'Handshake failed: peer-b unreachable',
        'the peer behind it recorded its own error rather than being skipped',
    );

    // ── connectToAddress: the same handler shape, one address at a time ──────────────────────────────
    // Here the throw has nowhere to go but the caller, so the unfixed code turns "this peer is down" into a
    // rejected promise — which the retry loop then treats as a loop failure rather than one failed address.
    const soloAddress = `/ip4/127.0.0.1/tcp/4001/p2p/${fakePeerId('beanpool-handshake-error-test-solo')}`;
    addConnector(soloAddress, 'peer', 'peer-solo');

    rejections.clear();
    rejections.set('dial', undefined);
    let connected: boolean | null = null;
    threw = null;
    try { connected = await connectToAddress(soloAddress); } catch (e) { threw = e; }

    assert(threw === null, 'connectToAddress does not throw when the dial rejects with a non-Error');
    assert(connected === false, 'connectToAddress returns false for a dial that rejected with undefined');
    const soloError = getConnectorByAddress(soloAddress)?.error;
    assert(
        typeof soloError === 'string' && soloError.length > 0,
        `connectToAddress records a readable status.error (got ${JSON.stringify(soloError)})`,
    );

    rejections.set('dial', 'host unreachable');
    threw = null;
    try { connected = await connectToAddress(soloAddress); } catch (e) { threw = e; }
    assert(threw === null, 'nor when the dial rejects with a plain string');
    assert(
        getConnectorByAddress(soloAddress)?.error === 'host unreachable',
        'and that string is what the operator sees',
    );

    rejections.set('dial', new Error('ECONNREFUSED 127.0.0.1:4001'));
    threw = null;
    try { connected = await connectToAddress(soloAddress); } catch (e) { threw = e; }
    assert(threw === null, 'and a normal Error still returns rather than throwing');
    assert(
        getConnectorByAddress(soloAddress)?.error === 'ECONNREFUSED 127.0.0.1:4001',
        'a normal Error still reports exactly the message it always did',
    );

    console.log(`\n${passed}/${run} passed`);
    // Explicit: initConnectorManager leaves the handshake and retry timers running, so returning normally
    // would hang the runner instead of reporting a result.
    process.exit(passed === run ? 0 : 1);
}

main();
