/**
 * Federation hardening from the verified peer-traffic audit (scratch/reviews/verify-audit-federation.md, 2026-10-16):
 *
 *   FED-05  a stranger (no connector) who sends 64 KB on a handshake stream and keeps it open is aborted within 6 s,
 *           and so is one who sends a few bytes and goes quiet; the Buffer memory they pinned comes back. Over real
 *           libp2p nodes on 127.0.0.1, configured as p2p.ts configures them. A genuine handshake still works.
 *   FED-02  a relayed sender's home is the relaying peer's (our connector's public URL), never the payload's; a peer
 *           relaying "from" a member whose row names another home is refused, with no line stored. M5: a visitor's
 *           row with no home takes the relaying peer's. A local member is still refused.
 *   M3      the same binding for a cross-node buyer in handlePurchaseRequest.
 *   FED-09  a relayed line longer than the send route's 64 KB is refused with words, and not stored.
 *   FED-03  a reservation whose reserved_until has passed holds no headroom.
 *   FED-01  writeVisitorRow never stamps a home on a local member.
 *   FED-06  (run `peers-off`, ENABLE_PEER_CONNECTORS unset) a configured peer's verify_member, relay_message,
 *           list_listings and settle_purchase are refused, nothing stored; settle_receipt_status is still answered.
 *
 * FED-10 (/api/federation/links members-only) is measured through the real middleware in test-federation-link (5a0, 5a)
 * and test-read-auth-default.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-federation-hardening.ts
 */
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';

const PEERS_OFF = process.env.ENABLE_PEER_CONNECTORS !== 'true';
// Settlement on, for the purchase rows (M3, FED-03); set before the modules that read it at import.
process.env.FEDERATION_SETTLEMENT = 'true';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const keyOf = () => crypto.randomBytes(32).toString('hex');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
async function external(): Promise<number> {
    for (let i = 0; i < 3; i++) { gc(); await sleep(50); }
    return process.memoryUsage().external;
}

async function main(): Promise<void> {
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const cm = await import('./connector-manager.js');
    const fp = await import('./federation-protocol.js');
    const { registerHandshakeHandler, sendHandshake } = await import('./handshake.js');
    const { handlePurchaseRequest } = await import('./federation-settlement-exchange.js');
    const { writeVisitorRow } = await import('./engine/members.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');

    initStateEngine();
    const owner = keyOf();
    seedGenesisMember(owner, 'Olive');
    const addLocal = (name: string) => {
        const pk = keyOf();
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(pk, name, owner);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        return pk;
    };
    const carol = addLocal('Carol');
    const sam = addLocal('Sam');

    // Two real peer ids, so a connector's address parses as a libp2p one would.
    const A = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const B = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const ADDR_A = `/ip4/127.0.0.1/tcp/4001/p2p/${A}`;
    const ADDR_B = `/ip4/127.0.0.2/tcp/4001/p2p/${B}`;
    const HOME_A = 'https://a.example';
    const HOME_B = 'https://b.example';
    cm.addConnector(ADDR_A, 'peer', 'Peer A', HOME_A);
    cm.addConnector(ADDR_B, 'peer', 'Peer B', HOME_B);

    /** The handler registerFederationHandler gives libp2p, caught by a stand-in node (as test-dm-line-relay). */
    let handler: ((stream: any, connection: any) => Promise<void>) | null = null;
    fp.registerFederationHandler({ handle: (_p: string, fn: any) => { handler = fn; } } as any);
    async function ask(peerId: string, request: object): Promise<any> {
        const sent: Uint8Array[] = [];
        const bytes = new TextEncoder().encode(JSON.stringify(request));
        const stream = {
            async *[Symbol.asyncIterator]() { yield bytes; },
            send: (b: Uint8Array) => { sent.push(b); return true; },
            close: async () => {},
            abort: () => {},
        };
        await handler!(stream, { remotePeer: { toString: () => peerId } });
        const raw = new TextDecoder().decode(Buffer.concat(sent));
        return raw ? JSON.parse(raw) : null;
    }
    const linesBy = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?').get(pk) as { n: number }).n;
    const homeOf = (pk: string) => (db.prepare('SELECT home_node_url FROM members WHERE public_key = ?').get(pk) as any)?.home_node_url ?? null;
    const relay = (peerId: string, sender: string, extra: object = {}) => ask(peerId, {
        action: 'relay_message', id: crypto.randomUUID(), senderPublicKey: sender, senderCallsign: null,
        recipientPublicKey: carol, ...lockedDm(), ...extra,
    });

    // A string, so a run against code without these refusals cannot pass on undefined === undefined.
    const isOff = (r: any) => typeof fp.PEERS_OFF_ERROR === 'string' && isOff(r);
    if (PEERS_OFF) {
        console.log('\n=== FED-06: ENABLE_PEER_CONNECTORS off reaches inbound ===\n');
        const rita = keyOf();
        const lookup = await ask(A, { action: 'verify_member', publicKey: carol });
        assert(isOff(lookup) && lookup.isMember === undefined, `verify_member is refused (got ${JSON.stringify(lookup)})`);
        const r = await relay(A, rita);
        assert(isOff(r) && linesBy(rita) === 0 && homeOf(rita) === null,
            `relay_message is refused and nothing is stored (got ${JSON.stringify(r)}, lines ${linesBy(rita)})`);
        const listings = await ask(A, { action: 'list_listings' });
        assert(isOff(listings) && listings.listings === undefined, `list_listings is refused (got ${JSON.stringify(listings)})`);
        const buy = await ask(A, { action: 'settle_purchase', key: 'k-off', buyerPublicKey: rita, sellerPublicKey: sam, amount: 1 });
        const settlementRows = (db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE key = 'k-off'").get() as { n: number }).n;
        assert(isOff(buy) && settlementRows === 0, `settle_purchase is refused, no settlement row (got ${JSON.stringify(buy)})`);
        const status = await ask(A, { action: 'settle_receipt_status', key: 'k-none' });
        assert(!!status && status.error !== fp.PEERS_OFF_ERROR,
            `settle_receipt_status is still answered, as under FEDERATION_SETTLEMENT (got ${JSON.stringify(status)})`);
        console.log(`\n${passed}/${run} passed`);
        process.exit(passed === run ? 0 : 1);
    }

    // ── FED-05 ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-05: a stranger cannot hold a handshake stream open ===\n');
    const { createLibp2p } = await import('libp2p');
    const { tcp } = await import('@libp2p/tcp');
    const { noise } = await import('@libp2p/noise');
    const { yamux } = await import('@libp2p/yamux');
    const { identify } = await import('@libp2p/identify');
    const p2pNode = () => createLibp2p({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
        services: { identify: identify() },
    });
    const HS = '/beanpool/handshake/1.0.0';
    const victim = await p2pNode();
    registerHandshakeHandler(victim);
    fp.registerFederationHandler(victim);
    const stranger = await p2pNode();
    const openHandshakes = () => victim.getConnections().flatMap((c: any) => c.streams)
        .filter((s: any) => s.protocol === HS && s.status === 'open').length;

    await stranger.dial(victim.getMultiaddrs());
    // Settle libp2p's own allocations first: one genuine handshake, from the stranger (no connector, so untrusted).
    const hello = await sendHandshake(stranger, victim.peerId);
    assert(hello.mutualTrust === false && hello.remoteTrustLevel === null,
        `a genuine ~200-byte handshake from a stranger is still answered (got ${JSON.stringify(hello)})`);
    const baseline = await external();

    const BIG_STREAMS = 16, QUIET_STREAMS = 4;
    const started = Date.now();
    const strangerStreams: any[] = [];
    for (let i = 0; i < BIG_STREAMS; i++) {
        const s = await stranger.dialProtocol(victim.peerId, HS);
        s.send(crypto.randomBytes(64 * 1024));   // 64 KB, and never closes
        strangerStreams.push(s);
    }
    for (let i = 0; i < QUIET_STREAMS; i++) {
        const s = await stranger.dialProtocol(victim.peerId, HS);
        s.send(new TextEncoder().encode('{"type":"handshake_req"'));   // a few bytes, then nothing
        strangerStreams.push(s);
    }
    while (openHandshakes() > 0 && Date.now() - started < 6000) await sleep(100);
    const left = openHandshakes();
    const tookMs = Date.now() - started;
    assert(left === 0, `every stranger stream (${BIG_STREAMS} × 64 KB, ${QUIET_STREAMS} quiet) is aborted within 6 s (open at ${tookMs} ms: ${left})`);
    const after = await external();
    const grewKb = Math.round((after - baseline) / 1024);
    assert(after - baseline < 256 * 1024,
        `and Buffer memory is back to baseline (${Math.round(baseline / 1024)} KB → ${Math.round(after / 1024)} KB, +${grewKb} KB; ${BIG_STREAMS} × 64 KB were sent)`);
    for (const s of strangerStreams) { try { s.abort(new Error('done')); } catch { /* gone */ } }
    await stranger.stop();
    await victim.stop();

    // ── FED-02 / M5 ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-02: a relayed sender\'s home is the relaying peer\'s ===\n');
    const alice = keyOf();
    const genuine = await relay(B, alice, { senderNodeUrl: HOME_B });
    assert(genuine?.success === true && homeOf(alice) === HOME_B, `peer B relays Alice's line; her home is B (got ${JSON.stringify(genuine)}, ${homeOf(alice)})`);
    const linesBefore = linesBy(alice);
    const forged = await relay(A, alice, { senderNodeUrl: HOME_B });
    assert(typeof fp.SENDER_ELSEWHERE_ERROR === 'string' && forged?.error === fp.SENDER_ELSEWHERE_ERROR && linesBy(alice) === linesBefore && homeOf(alice) === HOME_B,
        `peer A relaying "from Alice" (home B) is refused, no line stored, her home unchanged (got ${JSON.stringify(forged)}, lines ${linesBefore} → ${linesBy(alice)})`);

    const bob = keyOf();
    const claimed = await relay(A, bob, { senderNodeUrl: HOME_B });
    assert(claimed?.success === true && homeOf(bob) === HOME_A,
        `a new sender relayed by A gets A's home, not the payload's senderNodeUrl (got ${homeOf(bob)})`);

    const eve = keyOf();
    writeVisitorRow(eve, 'Eve');   // a visitor's row a local DM made: no home
    const eveRelay = await relay(A, eve);
    assert(eveRelay?.success === true && homeOf(eve) === HOME_A,
        `M5: a visitor's row with no home takes the relaying peer's (got ${JSON.stringify(eveRelay)}, ${homeOf(eve)})`);

    const asLocal = await relay(A, sam);
    assert(asLocal?.error === 'Sender impersonates a local member' && linesBy(sam) === 0,
        `a local member as sender is still refused (got ${JSON.stringify(asLocal)})`);

    // ── M3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== M3: a cross-node buyer\'s home is the asking peer\'s ===\n');
    cm.setConnectorCreditCap(ADDR_A, 100);
    cm.setConnectorCreditCap(ADDR_B, 100);
    const buy = (key: string, peerId: string, buyer: string, amount: number, buyerHomeNode: string | null = null) =>
        handlePurchaseRequest({ key, peerId, buyerPublicKey: buyer, buyerCallsign: 'Buyer', buyerHomeNode, sellerPublicKey: sam, postId: null, amount });
    const aliceViaA = buy('m3-alice', A, alice, 1, HOME_A);
    assert(aliceViaA.accepted === false && (aliceViaA as any).reason === 'buyer_elsewhere',
        `peer A buying for Alice (home B) is refused (got ${JSON.stringify(aliceViaA)})`);
    const dan = keyOf();
    const danViaA = buy('m3-dan', A, dan, 1, 'https://some-other-community.example');
    const danRow = db.prepare("SELECT buyer_home_node FROM settlements WHERE key = 'm3-dan'").get() as any;
    assert(danViaA.accepted === true && homeOf(dan) === HOME_A && danRow?.buyer_home_node === HOME_A,
        `a new buyer from A gets A's home, not the payload's buyerHomeNode (got ${JSON.stringify(danViaA)}, row ${homeOf(dan)}, settlement ${danRow?.buyer_home_node})`);
    const localBuyer = buy('m3-carol', A, carol, 1, HOME_A);
    assert(localBuyer.accepted === false && (localBuyer as any).reason === 'buyer_is_local', `a local member as buyer is still refused (got ${JSON.stringify(localBuyer)})`);

    // ── FED-09 ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-09: a relayed line takes the send route\'s 64 KB ===\n');
    const long = keyOf();
    const tooLong = await relay(A, long, lockedDm(70 * 1024));
    assert(typeof tooLong?.error === 'string' && /too long/i.test(tooLong.error) && linesBy(long) === 0,
        `a 70 KB relayed line is answered with the refusal, no row (got ${JSON.stringify(tooLong).slice(0, 160)})`);

    // ── FED-03 ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-03: a lapsed reservation holds no headroom ===\n');
    const fred = keyOf();
    const full = buy('f3-full', B, fred, 100);
    assert(full.accepted === true, `peer B reserves its whole cap of 100 (got ${JSON.stringify(full)})`);
    const whileHeld = buy('f3-held', B, fred, 10);
    assert(whileHeld.accepted === false && (whileHeld as any).reason === 'cap_exhausted', `while it holds, a further 10 is refused (got ${JSON.stringify(whileHeld)})`);
    db.prepare("UPDATE settlements SET reserved_until = ? WHERE key = 'f3-full'").run(new Date(Date.now() - 1000).toISOString());
    const afterLapse = buy('f3-after', B, fred, 10);
    assert(afterLapse.accepted === true, `once reserved_until has passed, 10 is accepted before any sweep (got ${JSON.stringify(afterLapse)})`);

    // ── FED-01 ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-01: no home stamped on a local member ===\n');
    writeVisitorRow(carol, undefined, HOME_A);
    assert(homeOf(carol) === null, `writeVisitorRow(Carol, -, url) leaves her home_node_url NULL (got ${homeOf(carol)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
