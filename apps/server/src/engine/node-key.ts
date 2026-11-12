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
 * A request this server signs names its own home as its origin (ownNodeHome): its primary address (engine/own-addresses.ts
 * primaryAddress) as `host[:port]` (@beanpool/core nodeHomeOf), with its public address's port when that is not 443. That
 * is the home the other server fetches this document from, on that port. A server that knows none of its names signs
 * nothing, and takes no other server's request (isOwnNodeHome).
 */
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { NODE_KEY_VALIDITY_MS, audienceOf, buildNodeRequestHeaders, nodeHomeOf, signNodeKeyDocument, type NodeKeyDocument } from '@beanpool/core';
import { PUBLIC_URL_RULES, resolvePublicNodeUrl } from '../state-engine.js';
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
 * The home this server answers as at `host`, one of its own names: its public address (resolvePublicNodeUrl, own-addresses.ts
 * item 1) with that address's port, when the public address is `host` on a port other than 443; `host` itself (port 443)
 * for every other name.
 */
function homeOfOwnName(host: string): string {
    const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community);
    const published = url ? nodeHomeOf(url) : null;
    return published && audienceOf(published) === host ? published : host;
}

/**
 * This server's home: how other servers name it, the origin of every request it signs, where they fetch its key document.
 * Its primary address (own-addresses.ts primaryAddress) as `host[:port]`: a server published at coop.example.org:8443 is
 * the home coop.example.org:8443, one at byron.beanpool.org (port 443) the home byron.beanpool.org. Null while it knows
 * none of its names.
 */
export function ownNodeHome(): string | null {
    const primary = primaryAddress();
    return primary ? homeOfOwnName(primary) : null;
}

/**
 * Whether `home` is one of this server's own homes, for a request another server signed (engine/node-signature.ts, the
 * destination) or an item it carries (routes/node-key.ts, the recipient's home): one of its names (own-addresses.ts) on
 * the port it answers there (homeOfOwnName). A home on another port is another server's: a server published at
 * coop.example.org:8443 is not the home coop.example.org, whatever answers on 443 there. Never on a server that knows none
 * of its names: it can't tell a request meant for it from one that wasn't, and a loopback or home-network host is every
 * such server's (own-addresses.ts item 5), so a request signed for one would be good at all of them.
 */
export function isOwnNodeHome(home: string): boolean {
    if (!knowsItsNames()) return false;
    const host = audienceOf(home);
    if (!host || audienceStanding(host) !== 'own') return false;
    return homeOfOwnName(host) === home;
}

/** The X-BeanPool-Node header for a request this server sends to `url`. Throws when it has no key or knows none of its names. */
export async function ownNodeRequestHeaders(input: { method: string; url: string; body: string; timestamp?: number; nonce?: string }): Promise<Record<string, string>> {
    const s = nodeSigner();
    if (!s) throw new Error('This server has no node key yet (data/libp2p_key), so it cannot sign a request to another community.');
    const origin = ownNodeHome();
    if (!origin) throw new Error('This server knows none of its own names, so it cannot sign a request to another community.');
    return buildNodeRequestHeaders({ ...input, origin, keyHex: s.keyHex, sign: s.sign });
}

/** Tests: forget the key and the document read so far (a suite that writes a new node key file). */
export function forgetOwnNodeKeyForTests(): void {
    signer = null;
    made = null;
}
