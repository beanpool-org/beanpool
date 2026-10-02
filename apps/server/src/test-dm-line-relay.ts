/**
 * A direct message relayed by a federation peer is stored under the sender's own message id (crypto review M F2,
 * 2026-10-02). Both apps now seal a DM line to its message id (packages/beanpool-core/src/dm-crypto.ts, format 3): a
 * line stored under an id the node picked instead is a line its recipient can't verify, and the app shows it as such.
 * The send route already keeps a client's id; the libp2p relay (federation-protocol.ts relay_message) gave every
 * relayed line a new one. Through the real handler, with a stand-in libp2p node and stream:
 *
 *   1. a relayed line with the sender's UUID v4 is stored under exactly that id (lowered, as the send route lowers it),
 *      with its author, ciphertext and nonce as relayed
 *   2. a relay carrying no id, or one that isn't a UUID v4, is stored under an id of this node's, as before
 *   3. the same id relayed again by the same sender is the same line, once (the send route's idempotent retry)
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-dm-line-relay.ts
 */
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { db } from './db/db.js';
import { addConnector } from './connector-manager.js';
import { registerFederationHandler } from './federation-protocol.js';
import { lockedDm } from './dm-test-payload.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const keyOf = () => crypto.randomBytes(32).toString('hex');
const PEER_ID = '12D3KooWDmLineRelayTestPeer0000000000000000000001';

/** The handler registerFederationHandler gives libp2p, caught by a stand-in node. */
let handler: ((stream: any, connection: any) => Promise<void>) | null = null;
const fakeNode = { handle: (_protocol: string, fn: any) => { handler = fn; } } as any;

/** One request to the handler as a trusted peer sends it; the answer it writes back. */
async function relay(request: object): Promise<any> {
    const sent: Uint8Array[] = [];
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const stream = {
        async *[Symbol.asyncIterator]() { yield bytes; },
        send: (b: Uint8Array) => { sent.push(b); return true; },
        close: async () => {},
    };
    await handler!(stream, { remotePeer: { toString: () => PEER_ID } });
    const raw = new TextDecoder().decode(Buffer.concat(sent));
    return raw ? JSON.parse(raw) : null;
}

const rowOf = (id: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;

async function main(): Promise<void> {
    console.log('\n=== A relayed DM line keeps its sender\'s message id ===\n');
    initStateEngine();
    const owner = keyOf();
    seedGenesisMember(owner, 'Olive');
    const carol = keyOf();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, 'Carol', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(carol, owner);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(carol);
    addConnector(`/ip4/127.0.0.1/tcp/4001/p2p/${PEER_ID}`, 'peer', 'Peer node', 'https://peer.example.org');
    registerFederationHandler(fakeNode);
    if (!handler) throw new Error('setup: the federation handler was not registered');

    const rita = keyOf();
    const base = { action: 'relay_message', senderPublicKey: rita, senderCallsign: 'Remote Rita', senderNodeUrl: 'https://peer.example.org', recipientPublicKey: carol };

    // ── 1 ──
    console.log('── 1. the sender\'s own id');
    const id = crypto.randomUUID();
    const line = lockedDm();
    const first = await relay({ ...base, id: id.toUpperCase(), ...line });
    const row = rowOf(id);
    assert(first?.success === true && first.messageId === id, `the relay is answered with the sender's id, lowered (got ${JSON.stringify(first)})`);
    assert(!!row && row.author_pubkey === rita && row.ciphertext === line.ciphertext && row.nonce === line.nonce,
        'the line is stored under that id, with its author, ciphertext and nonce as relayed');

    // ── 2 ──
    console.log('\n── 2. no id, or one that is not a UUID v4');
    for (const [what, given] of [['no id', undefined], ['a word', 'line-1'], ['a UUID v1', 'a8098c1a-f86e-11da-bd1a-00112444be1e']] as const) {
        const other = lockedDm();
        const r = await relay({ ...base, ...(given === undefined ? {} : { id: given }), ...other });
        const stored = r?.messageId ? rowOf(r.messageId) : null;
        assert(r?.success === true && stored?.ciphertext === other.ciphertext && r.messageId !== given
            && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.messageId),
            `${what}: stored under an id of this node's, as before (got ${JSON.stringify(r)})`);
    }

    // ── 3 ──
    console.log('\n── 3. the same line relayed again');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?').get(rita) as { n: number }).n;
    const again = await relay({ ...base, id, ...line });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?').get(rita) as { n: number }).n;
    assert(again?.success === true && again.messageId === id && after === before, `the same line, once (count ${before} → ${after})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
