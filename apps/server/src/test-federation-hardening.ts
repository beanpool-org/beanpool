/**
 * Federation hardening from the verified peer-traffic audit (scratch/reviews/verify-audit-federation.md, 2026-10-16):
 *
 *   FED-05  a stranger (no connector) who sends 64 KB on a handshake stream and keeps it open is aborted within 6 s,
 *           and so is one who sends a few bytes and goes quiet; the Buffer memory they pinned comes back. Over real
 *           libp2p nodes on 127.0.0.1, configured as p2p.ts configures them. A genuine handshake still works.
 *   FED-02  a new relayed sender's home is the relaying peer's (our connector's public URL), never the payload's; a
 *           sender whose row already names a home keeps it, and the line is stored. M5: a visitor's row with no home
 *           takes the relaying peer's. A local member is still refused.
 *   M3      the same binding for a cross-node buyer in handlePurchaseRequest; the settlement records the asking peer.
 *   B1      (the #2039 review) honest peers the first binding turned away, all served:
 *           7b/7c a member of two communities (one key on every node), known here from B's board, writes and buys
 *                 through A; 7d her own community B still relays for her
 *           10a/10b the operator corrects a peer's public URL: its members' next line and purchase still go through
 *           a peer's refusal of a relayed line is logged by relayLineToPeer (the send route's relay), with the line's
 *           id and the reason and never its text; a stored line logs nothing
 *   FED-09  a relayed line longer than the send route's 64 KB is refused with words, and not stored.
 *   FED-03  a reservation whose reserved_until has passed holds no headroom.
 *   FED-01  writeVisitorRow never stamps a home on a local member.
 *   FED-06  (run `peers-off`, ENABLE_PEER_CONNECTORS unset) a configured peer's verify_member, relay_message,
 *           list_listings and settle_purchase are refused, nothing stored; settle_receipt_status is still answered.
 *           Over real libp2p, the node's handshake answer no longer calls it active (N3), and the relaying node logs
 *           the refusal (N2). The plain run holds the controls: a configured peer's answer says active.
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
    const { cacheRemoteListings } = await import('./federation-listings.js');
    const { writeVisitorRow } = await import('./engine/members.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
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

    // Real peer ids, so a connector's address parses as a libp2p one would.
    const newPeerId = async () => peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const A = await newPeerId();
    const B = await newPeerId();
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

    /**
     * A configured peer (a connector here) talking to this node over real libp2p, both in this process: the answer to
     * its handshake, and for each recipient what relayLineToPeer (the send route's relay) logs for one line to it.
     */
    async function asConfiguredPeer(recipients: string[]): Promise<{
        hs: any; relays: { lineId: string; ciphertext: string; logged: string[] }[]; noHelper: boolean;
    }> {
        const here = await p2pNode();
        registerHandshakeHandler(here);
        fp.registerFederationHandler(here);
        const peer = await p2pNode();
        cm.addConnector(`/ip4/127.0.0.3/tcp/4001/p2p/${peer.peerId}`, 'peer', 'Peer F', 'https://f.example');
        await peer.dial(here.getMultiaddrs());
        const hs = await sendHandshake(peer, here.peerId);
        const relays: { lineId: string; ciphertext: string; logged: string[] }[] = [];
        // A function, so a run against code without it fails its rows instead of throwing.
        const relayLineToPeer = (fp as any).relayLineToPeer;
        const noHelper = typeof relayLineToPeer !== 'function';
        for (const recipient of noHelper ? [] : recipients) {
            const lineId = crypto.randomUUID();
            const line = lockedDm();
            const logged: string[] = [];
            const warn = console.warn;
            console.warn = (...args: any[]) => { logged.push(args.map(String).join(' ')); };
            try {
                await relayLineToPeer(peer, here.peerId, 'Peer F', { id: lineId, senderPublicKey: keyOf(), recipientPublicKey: recipient, ...line });
            } finally {
                console.warn = warn;
            }
            relays.push({ lineId, ciphertext: line.ciphertext, logged });
        }
        await peer.stop();
        await here.stop();
        return { hs, relays, noHelper };
    }
    /** The relaying side's line for a refusal, as relayLineToPeer writes it. */
    const refusalLine = (r: { lineId: string; logged: string[] } | undefined) =>
        r?.logged.find(l => l.includes('refused relayed line') && l.includes(r.lineId));

    // A string, so a run against code without these refusals cannot pass on undefined === undefined.
    const isOff = (r: any): boolean => typeof fp.PEERS_OFF_ERROR === 'string' && r?.error === fp.PEERS_OFF_ERROR;
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
        assert(!!status && !isOff(status),
            `settle_receipt_status is still answered, as under FEDERATION_SETTLEMENT (got ${JSON.stringify(status)})`);

        console.log('\n=== N3 / N2: over real libp2p, a peers-off node says so, and its refusal is heard ===\n');
        const off = await asConfiguredPeer([carol]);
        assert(off.hs.mutualTrust === true && off.hs.remoteActive === false,
            `a configured peer's handshake to it: still trusted, but not active (got ${JSON.stringify(off.hs)})`);
        const heard = refusalLine(off.relays[0]);
        assert(!off.noHelper && !!heard && heard.includes(fp.PEERS_OFF_ERROR) && !heard.includes(off.relays[0].ciphertext),
            `the relaying node logs the refusal with the line's id and the reason, never its text (got ${off.noHelper ? 'no relayLineToPeer' : JSON.stringify(off.relays[0]?.logged)})`);

        console.log(`\n${passed}/${run} passed`);
        process.exit(passed === run ? 0 : 1);
    }

    // ── FED-05 ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== FED-05: a stranger cannot hold a handshake stream open ===\n');
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
    const viaA = await relay(A, alice, { senderNodeUrl: HOME_A });
    assert(viaA?.success === true && linesBy(alice) === linesBefore + 1 && homeOf(alice) === HOME_B,
        `peer A's relay for Alice is stored, and her home is unchanged (B) (got ${JSON.stringify(viaA)}, lines ${linesBefore} → ${linesBy(alice)}, ${homeOf(alice)})`);

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
    const settledHome = (key: string) => (db.prepare('SELECT buyer_home_node FROM settlements WHERE key = ?').get(key) as any)?.buyer_home_node ?? null;
    const aliceViaA = buy('m3-alice', A, alice, 1, HOME_B);
    assert(aliceViaA.accepted === true && homeOf(alice) === HOME_B && settledHome('m3-alice') === HOME_A,
        `peer A buying for Alice (home B) is accepted; her home is unchanged; the settlement names A (got ${JSON.stringify(aliceViaA)}, row ${homeOf(alice)}, settlement ${settledHome('m3-alice')})`);
    const dan = keyOf();
    const danViaA = buy('m3-dan', A, dan, 1, 'https://some-other-community.example');
    assert(danViaA.accepted === true && homeOf(dan) === HOME_A && settledHome('m3-dan') === HOME_A,
        `a new buyer from A gets A's home, not the payload's buyerHomeNode (got ${JSON.stringify(danViaA)}, row ${homeOf(dan)}, settlement ${settledHome('m3-dan')})`);
    const localBuyer = buy('m3-carol', A, carol, 1, HOME_A);
    assert(localBuyer.accepted === false && (localBuyer as any).reason === 'buyer_is_local', `a local member as buyer is still refused (got ${JSON.stringify(localBuyer)})`);

    // ── B1: honest peers the first binding refused ─────────────────────────────────────────────────────────
    console.log('\n=== B1 (#2039 review) 7: a member of two communities ===\n');
    // Ada: one key, a member of B and of A (apps/native/utils/join-another-community.ts keeps the key on every node).
    // This node learned her from B's board.
    const ada = keyOf();
    const board = cacheRemoteListings(B, HOME_B, [{ id: 'ada-piano', type: 'offer', title: 'Piano lessons', credits: 6, authorPublicKey: ada, authorCallsign: 'Ada' }]);
    assert(board.cached === 1 && homeOf(ada) === HOME_B, `setup: Ada's row here says home B, from B's board (got ${JSON.stringify(board)}, ${homeOf(ada)})`);
    const adaLinesBefore = linesBy(ada);
    const adaViaA = await relay(A, ada);
    assert(adaViaA?.success === true && linesBy(ada) === adaLinesBefore + 1 && homeOf(ada) === HOME_B,
        `7b. Ada, a member of A too, writes to Carol through A: stored, her home still B (got ${JSON.stringify(adaViaA)}, ${homeOf(ada)})`);
    const adaBuys = buy('b1-ada', A, ada, 3, HOME_A);
    assert(adaBuys.accepted === true && settledHome('b1-ada') === HOME_A && homeOf(ada) === HOME_B,
        `7c. Ada buys from Sam through A (A pays): accepted, the settlement names A (got ${JSON.stringify(adaBuys)}, settlement ${settledHome('b1-ada')})`);
    const adaViaB = await relay(B, ada);
    assert(adaViaB?.success === true, `7d. and her own community B still relays for her (got ${JSON.stringify(adaViaB)})`);

    console.log('\n=== B1 (#2039 review) 10: the operator corrects a peer\'s public URL ===\n');
    const C = await newPeerId();
    const ADDR_C = `/ip4/127.0.0.4/tcp/4001/p2p/${C}`;
    const HOME_C = 'https://203-0-113-7.example', HOME_C_NAMED = 'https://c.example';
    cm.addConnector(ADDR_C, 'peer', 'Peer C', HOME_C);
    cm.setConnectorCreditCap(ADDR_C, 100);
    const yara = keyOf();
    const yaraFirst = await relay(C, yara);
    assert(yaraFirst?.success === true && homeOf(yara) === HOME_C, `setup: Yara, a member of C, writes; her home is C's first URL (got ${homeOf(yara)})`);
    cm.addConnector(ADDR_C, 'peer', 'Peer C', HOME_C_NAMED);   // the operator's correction, as the connector route makes it
    const yaraLinesBefore = linesBy(yara);
    const yaraAgain = await relay(C, yara);
    assert(yaraAgain?.success === true && linesBy(yara) === yaraLinesBefore + 1,
        `10a. after the URL edit, Yara's next line through C is stored (got ${JSON.stringify(yaraAgain)})`);
    const yaraBuys = buy('b1-yara', C, yara, 1, HOME_C_NAMED);
    assert(yaraBuys.accepted === true && settledHome('b1-yara') === HOME_C_NAMED,
        `10b. and C's purchase for her is accepted, under C's corrected URL (got ${JSON.stringify(yaraBuys)}, settlement ${settledHome('b1-yara')})`);

    console.log('\n=== B1 (#2039 review): a peer\'s refusal of a relayed line is logged ===\n');
    const nobody = keyOf();
    const configured = await asConfiguredPeer([nobody, carol]);
    const refused = configured.relays[0];
    const refusedLine = refusalLine(refused);
    assert(!configured.noHelper && !!refusedLine && refusedLine.includes('Recipient not found on this node') && !refusedLine.includes(refused.ciphertext),
        `a line the peer refuses is logged with its id and the peer's reason, never its text (got ${configured.noHelper ? 'no relayLineToPeer' : JSON.stringify(refused?.logged)})`);
    const stored = configured.relays[1];
    assert(!configured.noHelper && !!stored && !stored.logged.some(l => l.includes(stored.lineId)),
        `a line the peer stores logs nothing (got ${JSON.stringify(stored?.logged)})`);
    assert(configured.hs.mutualTrust === true && configured.hs.remoteActive === true,
        `control for N3: with peer connectors on, a configured peer's handshake answer says active (got ${JSON.stringify(configured.hs)})`);

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
