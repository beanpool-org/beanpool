/**
 * This server's own key, published, and how it signs a request to another community's server (messages across
 * communities X1: @beanpool/core node-request-signing.ts; routes/node-key.ts answers `GET /api/node/key`).
 *
 * The key is the node key (data/libp2p_key, services/takeover-envelope.ts readNodeIdentity): the one that already signs
 * this server's push notices (engine/push-notices.ts) and its take-over statements. A take-over keeps it, so a promoted
 * standby answers as the same server. Nothing changes a node key today, so the document lists no previous key: the field
 * is in the document, and the verifier (engine/node-signature.ts) honours another server's, for the slice that adds a key
 * change.
 *
 * The document is made at most once an hour (one signature, whoever asks), valid NODE_KEY_VALIDITY_MS from when it was
 * made. A server with no node key yet has no document, and signs nothing: no hard gate, it simply can't speak for itself
 * to another community until it has one.
 *
 * A request this server signs names its own primary address (engine/own-addresses.ts primaryAddress) as its origin, the
 * host the other server fetches this document from. A server that knows none of its names signs nothing.
 */
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { NODE_KEY_VALIDITY_MS, buildNodeRequestHeaders, signNodeKeyDocument, type NodeKeyDocument } from '@beanpool/core';
import { readNodeIdentity } from '../services/takeover-envelope.js';
import { audienceStanding, knowsItsNames, primaryAddress } from './own-addresses.js';

/** The DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A document is made again once it is this old. */
export const NODE_KEY_DOCUMENT_REMADE_AFTER_MS = 60 * 60_000;

interface NodeSigner {
    /** The node key's raw public key, lower-case hex. */
    keyHex: string;
    sign: (bytes: Uint8Array) => Uint8Array;
}

let signer: NodeSigner | null = null;
let made: { at: number; doc: NodeKeyDocument } | null = null;

/**
 * This server's signer, from its node key; null while it has none. Kept once read, as the push signer is: a take-over or a
 * restore that brings another key restarts the server. Throws on a node key file that is not one.
 */
function nodeSigner(): NodeSigner | null {
    if (signer) return signer;
    const identity = readNodeIdentity();
    if (!identity) return null;
    const keyHex = Buffer.from(ed25519.getPublicKey(identity.seed)).toString('hex');
    const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(identity.seed)]), format: 'der', type: 'pkcs8' });
    signer = { keyHex, sign: (bytes) => new Uint8Array(crypto.sign(null, Buffer.from(bytes), key)) };
    return signer;
}

/** This server's key document, or null while it has no node key. */
export async function ownNodeKeyDocument(now = Date.now()): Promise<NodeKeyDocument | null> {
    const s = nodeSigner();
    if (!s) return null;
    if (made && made.doc.key === s.keyHex && now >= made.at && now - made.at < NODE_KEY_DOCUMENT_REMADE_AFTER_MS) return made.doc;
    const doc = await signNodeKeyDocument({ key: s.keyHex, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, s.sign);
    made = { at: now, doc };
    return doc;
}

/**
 * Whether `host` is one of this server's own names, for a request another server signed (engine/node-signature.ts, the
 * destination) or an item it carries (routes/node-key.ts, the recipient's home). Never on a server that knows none of its
 * names: it can't tell a request meant for it from one that wasn't, and a loopback or home-network host is every such
 * server's (own-addresses.ts item 5), so a request signed for one would be good at all of them.
 */
export function isOwnNodeHome(host: string): boolean {
    return knowsItsNames() && audienceStanding(host) === 'own';
}

/** The X-BeanPool-Node header for a request this server sends to `url`. Throws when it has no key or knows none of its names. */
export async function ownNodeRequestHeaders(input: { method: string; url: string; body: string; timestamp?: number; nonce?: string }): Promise<Record<string, string>> {
    const s = nodeSigner();
    if (!s) throw new Error('This server has no node key yet (data/libp2p_key), so it cannot sign a request to another community.');
    const origin = primaryAddress();
    if (!origin) throw new Error('This server knows none of its own names, so it cannot sign a request to another community.');
    return buildNodeRequestHeaders({ ...input, origin, keyHex: s.keyHex, sign: s.sign });
}

/** Tests: forget the key and the document read so far (a suite that writes a new node key file). */
export function forgetOwnNodeKeyForTests(): void {
    signer = null;
    made = null;
}
