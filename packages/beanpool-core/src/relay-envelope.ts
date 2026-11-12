/**
 * What crosses between two communities' servers, item by item, and who vouches for it (messages across communities, slice
 * X1: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2).
 *
 * Every item has a kind, an id, a sender (a member's key and their home: the server of the community they belong to, as
 * other servers name it, `host[:port]` with the port only when it is not 443: node-request-signing.ts nodeHomeOf), a
 * recipient (a member's key, or a group at the community that hosts it) with the recipient's home, and a payload no server
 * can read. Two signatures stand on it:
 *
 *   - **The server's**, on the request that carries it (node-request-signing.ts): which community's server sent it.
 *   - **The member's**, on the item, this file's envelope: who wrote it and where replies go. Ed25519 by the sender's member
 *     key over SHA-256 of the UTF-8 of the JSON array
 *
 *       [tag, kind, sender key, sender home, recipient, recipient home, item id, time, hex SHA-256 of the payload]
 *
 *     one spelling for one list of values, as a direct line's signature is (dm-crypto.ts dmLineSigDigest), under its own
 *     tag so no other signature a member makes can be taken for one.
 *
 * **The home rule.** A receiving server drops an item whose envelope names a sender home other than the server that signed
 * the request ({@link checkRelayItem}, `wrong-home`). So no third server can pass itself off as someone's home and collect
 * the replies: it can carry only items whose senders name it as their home, and their signatures say so. A home on another
 * port is another home: `coop.example.org:8443` is not `coop.example.org`.
 *
 * **The conversation** between two people in different communities is named from their two keys alone
 * ({@link relayConversationId}): a community may change its address (`<name>.beanpool.org` to a domain of its own) and the
 * chat must not split. The home is routing, read from the newest validly signed envelope, never part of the name.
 *
 * Nothing here opens a payload. A direct line keeps its own format-4 signature inside (dm-crypto.ts); the envelope adds the
 * homes around it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isNodeHost, signatureBytesOf } from './node-request-signing.js';
import { toBase64, utf8Bytes, type Signer } from './request-signing.js';

/** First value of every envelope's signed array. */
export const RELAY_ENVELOPE_TAG = 'beanpool-relay-envelope/1';
/** What a cross-community conversation's id is a hash under. */
export const RELAY_CONVERSATION_TAG = 'beanpool-relay-conversation/1';

/** Every kind of item that crosses between servers (design §3.2). */
export const RELAY_ITEM_KINDS = [
    'dm-line', 'dm-blob', 'dm-delete', 'receipt', 'group-invite', 'group-roster', 'group-epoch', 'group-line', 'group-blob',
    'group-leave', 'call-signal', 'complaint',
] as const;
export type RelayItemKind = (typeof RELAY_ITEM_KINDS)[number];

const KEY_HEX = /^[0-9a-f]{64}$/;
/** A group at its host: `group:` and the group's id there. */
const GROUP_RECIPIENT = /^group:[0-9A-Za-z_-]{1,64}$/;
const ITEM_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;

export function isRelayItemKind(kind: unknown): kind is RelayItemKind {
    return typeof kind === 'string' && (RELAY_ITEM_KINDS as readonly string[]).includes(kind);
}

/** A recipient as an envelope names one: a member's key (64 lower-case hex), or `group:<id>` for a group at its host. */
export function isRelayRecipient(recipient: unknown): recipient is string {
    return typeof recipient === 'string' && (KEY_HEX.test(recipient) || GROUP_RECIPIENT.test(recipient));
}

/** What an envelope says, unsigned. */
export interface RelayEnvelopeFields {
    kind: RelayItemKind;
    /** The item's own id: 8 to 64 letters, digits, `-` or `_` (a UUID fits). Replays die on it. */
    itemId: string;
    /** The writer's member key, raw Ed25519, lower-case hex. */
    senderKey: string;
    /** The home of the writer's community's server, as {@link isNodeHost} spells one: its host, and its port when not 443. */
    senderHome: string;
    recipient: string;
    /** The home of the recipient's community's server, or of the group's, spelled the same way. */
    recipientHome: string;
    /** When the sender signed it, milliseconds by their clock. */
    at: number;
    /** {@link relayPayloadHash} of the payload it travels with. */
    payloadHash: string;
}

/** An envelope as it travels: the fields, the version and the sender's signature (base64). */
export interface RelayEnvelope extends RelayEnvelopeFields {
    v: 1;
    sig: string;
}

/** One item as it crosses: the envelope, and the payload no server can read (base64 or another text form). */
export interface RelayItem {
    envelope: RelayEnvelope;
    payload: string;
}

/** hex SHA-256 of a payload: of its UTF-8 when it is text (as it travels), of the bytes themselves otherwise. */
export function relayPayloadHash(payload: string | Uint8Array): string {
    return bytesToHex(sha256(typeof payload === 'string' ? utf8Bytes(payload) : payload));
}

/** What the sender signs: SHA-256 of the UTF-8 of the JSON array of the envelope's values, the tag first. */
export function relayEnvelopeDigest(f: RelayEnvelopeFields): Uint8Array {
    return sha256(utf8Bytes(JSON.stringify([
        RELAY_ENVELOPE_TAG, f.kind, f.senderKey, f.senderHome, f.recipient, f.recipientHome, f.itemId, String(f.at), f.payloadHash,
    ])));
}

/** Why fields are not an envelope's, or null when they are. */
function fieldsProblem(f: RelayEnvelopeFields): string | null {
    if (!isRelayItemKind(f.kind)) return 'an unknown kind';
    if (typeof f.itemId !== 'string' || !ITEM_ID.test(f.itemId)) return 'an item id is 8 to 64 letters, digits, - or _';
    if (typeof f.senderKey !== 'string' || !KEY_HEX.test(f.senderKey)) return 'the sender key is not 64 lower-case hex characters';
    if (!isNodeHost(f.senderHome)) return 'the sender home is not a home in its one spelling (host, or host:port)';
    if (!isRelayRecipient(f.recipient)) return 'the recipient is not a member key or group:<id>';
    if (!isNodeHost(f.recipientHome)) return 'the recipient home is not a home in its one spelling (host, or host:port)';
    if (!Number.isSafeInteger(f.at) || f.at < 0) return 'the time is not milliseconds';
    if (typeof f.payloadHash !== 'string' || !HASH_HEX.test(f.payloadHash)) return 'the payload hash is not 64 lower-case hex characters';
    return null;
}

/** The sender's envelope over `f`. Throws, having signed nothing, when the fields are not an envelope's. */
export async function signRelayEnvelope(f: RelayEnvelopeFields, sign: Signer): Promise<RelayEnvelope> {
    const problem = fieldsProblem(f);
    if (problem) throw new Error(`Cannot sign a relay envelope: ${problem}`);
    const fields: RelayEnvelopeFields = {
        kind: f.kind, itemId: f.itemId, senderKey: f.senderKey, senderHome: f.senderHome, recipient: f.recipient,
        recipientHome: f.recipientHome, at: f.at, payloadHash: f.payloadHash,
    };
    return { v: 1, ...fields, sig: toBase64(await sign(relayEnvelopeDigest(fields))) };
}

/** An envelope read back with exactly its fields, each in its one spelling, or null. Its signature is not checked here. */
export function readRelayEnvelope(json: unknown): RelayEnvelope | null {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    const o = json as Record<string, unknown>;
    if (o.v !== 1 || typeof o.sig !== 'string' || !signatureBytesOf(o.sig)) return null;
    const fields = {
        kind: o.kind, itemId: o.itemId, senderKey: o.senderKey, senderHome: o.senderHome, recipient: o.recipient,
        recipientHome: o.recipientHome, at: o.at, payloadHash: o.payloadHash,
    } as RelayEnvelopeFields;
    if (fieldsProblem(fields)) return null;
    return { v: 1, ...fields, sig: o.sig };
}

/** Whether `env` carries its sender's signature over exactly its fields (strict RFC 8032). */
export function relayEnvelopeVerifies(env: RelayEnvelope): boolean {
    const sig = signatureBytesOf(env?.sig);
    if (!sig || fieldsProblem(env)) return false;
    try {
        return ed25519.verify(sig, relayEnvelopeDigest(env), hexToBytes(env.senderKey), { zip215: false });
    } catch {
        return false;
    }
}

/**
 * The home rule: whether the server that signed the request carrying `env` (its verified origin) is the home the sender
 * names. False drops the item.
 */
export function relayEnvelopeFromItsHome(env: Pick<RelayEnvelopeFields, 'senderHome'>, signingServer: string): boolean {
    return isNodeHost(signingServer) && env.senderHome === signingServer;
}

/** Why an item is dropped. */
export type RelayItemDrop =
    /** Not an item: no envelope, a malformed one, or no payload. */
    | 'malformed'
    /** Its sender names a home other than the server that signed the request. */
    | 'wrong-home'
    /** Its recipient's home is not the server it was sent to. */
    | 'not-for-here'
    /** Its payload is not the one the sender signed. */
    | 'payload-changed'
    /** Its sender's signature does not check out. */
    | 'bad-signature';

export type RelayItemVerdict = { ok: true; item: RelayItem } | { ok: false; reason: RelayItemDrop };

/** The longest payload an item may carry here, in characters: 3 MiB (a 2 MiB sealed blob, base64, with room). */
export const RELAY_PAYLOAD_MAX_CHARS = 3 * 1024 * 1024;

/**
 * What a receiving server makes of one item, in this order, the cheapest first: its form; the home rule against
 * `signedBy`, the verified origin of the request that carried it; whether it is for this server (`isHere`, its own names);
 * the payload against the hash the sender signed; the sender's signature. Nothing here asks whether the recipient is a
 * member (a server answers that alike for everyone: the mailbox's 202 and drop, X2) or whether the id is new.
 */
export function checkRelayItem(item: unknown, ctx: { signedBy: string; isHere: (host: string) => boolean }): RelayItemVerdict {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'malformed' };
    const o = item as Record<string, unknown>;
    const envelope = readRelayEnvelope(o.envelope);
    const payload = o.payload;
    if (!envelope || typeof payload !== 'string' || payload.length > RELAY_PAYLOAD_MAX_CHARS) return { ok: false, reason: 'malformed' };
    if (!relayEnvelopeFromItsHome(envelope, ctx.signedBy)) return { ok: false, reason: 'wrong-home' };
    let here: boolean;
    try {
        here = ctx.isHere(envelope.recipientHome);
    } catch {
        here = false;
    }
    if (!here) return { ok: false, reason: 'not-for-here' };
    if (relayPayloadHash(payload) !== envelope.payloadHash) return { ok: false, reason: 'payload-changed' };
    if (!relayEnvelopeVerifies(envelope)) return { ok: false, reason: 'bad-signature' };
    return { ok: true, item: { envelope, payload } };
}

/**
 * The id of the conversation between two people in different communities, from their two member keys alone: the first 16
 * bytes of SHA-256 of the UTF-8 of `tag \n lower key \n higher key`, written as a UUID (version and variant bits set, as
 * every conversation id is checked for one). The same on both phones whoever computes it, and the same after either home
 * changes its address. Throws for a key that is not 64 lower-case hex characters, and for the same key twice.
 */
export function relayConversationId(keyA: string, keyB: string): string {
    if (!KEY_HEX.test(keyA) || !KEY_HEX.test(keyB)) throw new Error('A conversation is named from two keys of 64 lower-case hex characters');
    if (keyA === keyB) throw new Error('A conversation across communities is between two different keys');
    const [lo, hi] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
    const hash = sha256(utf8Bytes(`${RELAY_CONVERSATION_TAG}\n${lo}\n${hi}`)).slice(0, 16);
    hash[6] = (hash[6] & 0x0f) | 0x40;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = bytesToHex(hash);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
