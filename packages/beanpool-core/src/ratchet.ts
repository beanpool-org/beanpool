/**
 * Forward secrecy for chats with people in other communities (DESIGN-cross-chat-voice-fable.md §11, X8 part 1): a Double
 * Ratchet, in core, with its vectors. NOTHING CALLS IT YET: no app, no node route and no message path imports this file in
 * part 1, so no member's chat changes. Part 2 wires it (see the PR).
 *
 * Written from two public specifications, never from anyone's code:
 *   [DR]  "The Double Ratchet Algorithm", Trevor Perrin and Moxie Marlinspike, Signal, revision 1, 2016-11-20 (public domain).
 *         The algorithm: §2.2 the symmetric-key ratchet, §2.3/§3.5 the Diffie-Hellman ratchet, §2.6/§3.5 skipped message keys
 *         and MAX_SKIP, §3.5 "if an exception is raised ... discard any changes to the state", §4 the security notes on
 *         deleting keys and on stored skipped keys, §5.2 the recommended primitives.
 *   [OLM] "Olm: A Cryptographic Ratchet", version 1, Matrix.org (docs/olm.md in matrix-org/olm; Apache-2.0). Olm IS a Double
 *         Ratchet that fixes every choice [DR] leaves open, so it is the one we follow byte for byte: §"Initial setup" (the
 *         triple Diffie-Hellman start), §"Advancing the root key", §"Advancing the chain key", §"Creating a message key",
 *         §"Sending messages", §"Receiving messages", §"The Olm Message format" and §"Olm Authentication".
 * Why Olm's concrete choices and not our own: [DR] gives no test vectors and leaves the KDFs, the cipher and the header to the
 * implementer; [OLM] fixes all of them, and vodozemac (Apache-2.0, an independent, audited implementation of Olm) can then check
 * this file byte for byte (vectors/ratchet-vodozemac.json, written by oracles/vodozemac-ratchet; vodozemac is a test oracle only,
 * never shipped and never a dependency of any package, design §9). The [DR] §5.2 recommendations and [OLM]'s choices are the
 * same primitives: HKDF-SHA-256, HMAC-SHA-256 with constant inputs 0x01 and 0x02, AES-256-CBC with PKCS#7 and HMAC-SHA-256.
 *
 * Where this file differs from vodozemac (both are inside [OLM], which sets no limits):
 *   - Limits: a message may skip at most RATCHET_MAX_SKIP keys in its chain ([DR] MAX_SKIP); at most RATCHET_MAX_SKIPPED_KEYS
 *     skipped keys are kept for late messages in the whole session, oldest out; at most RATCHET_MAX_RECEIVING_CHAINS chains.
 *   - A message whose ratchet key we have never seen, arriving while we have no sending chain of our own out, is refused
 *     outright: the other side cannot have answered a key we have not sent ([OLM] §"Receiving messages" derives with our newest
 *     ratchet key; there is none).
 *   - The decoder is strict: the fields in [OLM]'s order, each once, keys of 32 bytes, shortest varints, nothing unknown.
 *
 * What a stolen state reveals ([DR] §4 "Deletion of skipped message keys" and the Olm header having no "previous chain length"):
 * every used message key, every chain key we have moved past and every ratchet secret we have used is gone from the returned
 * state, so earlier messages can't be read from it. What it still holds, by design: up to RATCHET_MAX_SKIPPED_KEYS keys of
 * messages that were skipped and never arrived, and the chain keys of up to RATCHET_MAX_RECEIVING_CHAINS receiving chains, which
 * read later messages of those chains (Olm keeps old receiving chains because its header can't say where a chain ended).
 *
 * The caller keeps one RatchetState per conversation and REPLACES it with the state each call returns; a refused message leaves
 * the state exactly as it was (the input is never changed). Erasing bytes from memory is beyond what JavaScript promises: the
 * guarantee is about what the returned state contains.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { cbc } from '@noble/ciphers/aes.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

/** [OLM] §"The Olm Message format": the version byte of a pre-key message, and of a normal message with the 8-byte MAC. */
export const RATCHET_WIRE_VERSION = 3;
/** vodozemac's version 2: a normal message with the whole 32-byte MAC says so with version byte 4 (pre-key messages stay 3). */
export const RATCHET_WIRE_VERSION_FULL_MAC = 4;
/** [DR] MAX_SKIP: the most message keys one message may skip in its chain. Further ahead is refused. */
export const RATCHET_MAX_SKIP = 1000;
/** Skipped keys kept for late messages, in the whole session; when more wait, the oldest go. */
export const RATCHET_MAX_SKIPPED_KEYS = 200;
/** Receiving chains kept for late messages of earlier chains; when more exist, the oldest goes with its skipped keys. */
export const RATCHET_MAX_RECEIVING_CHAINS = 5;
/** [OLM] chain indexes are 32-bit. A sending chain never passes this. */
export const RATCHET_MAX_INDEX = 0xffff_ffff;

/** [OLM] §"Olm Authentication": the MAC is truncated to 8 bytes; vodozemac's version 2 keeps all 32. Fixed per session. */
export type RatchetMacBytes = 8 | 32;

const KEY_LEN = 32;
const INFO_ROOT = utf8ToBytes('OLM_ROOT');
const INFO_RATCHET = utf8ToBytes('OLM_RATCHET');
const INFO_KEYS = utf8ToBytes('OLM_KEYS');
const CHAIN_STEP = Uint8Array.of(0x02);
const MESSAGE_STEP = Uint8Array.of(0x01);
const TAG_RATCHET_KEY = 0x0a;
const TAG_CHAIN_INDEX = 0x10;
const TAG_CIPHERTEXT = 0x22;
const TAG_ONE_TIME_KEY = 0x0a;
const TAG_BASE_KEY = 0x12;
const TAG_IDENTITY_KEY = 0x1a;
const TAG_MESSAGE = 0x22;

/** A source of random bytes. Tests pass a fixed one; everything else uses the platform's. */
export type RatchetRng = (n: number) => Uint8Array;

/** Why a message was refused. The state is unchanged whatever the reason. */
export type RatchetRefusal =
    | 'malformed' // not a message in [OLM]'s format, or not one this session takes
    | 'session-mismatch' // a pre-key message for another session
    | 'mac' // the MAC does not match: changed, or not for these keys
    | 'too-far-ahead' // skips more than RATCHET_MAX_SKIP keys
    | 'no-key' // its key was used already (a replay) or dropped (a skipped key evicted, a chain evicted)
    | 'unexpected-ratchet-key' // a new ratchet key while we have no new key of ours out
    | 'bad-key'; // a Diffie-Hellman result of all zeros (a low-order key)

export class RatchetRefusedError extends Error {
    constructor(readonly reason: RatchetRefusal) {
        super(`ratchet: message refused (${reason})`);
        this.name = 'RatchetRefusedError';
    }
}

/** The three public keys that name a session ([OLM] §"Initial setup"): I_A, E_A and E_B, always as Alice sent them. */
export interface RatchetSessionKeys {
    identityKey: Uint8Array;
    baseKey: Uint8Array;
    oneTimeKey: Uint8Array;
}

export interface RatchetSendingChain {
    /** T_i, our ratchet key's secret half, and its public half as it goes out in every message of this chain. */
    ratchetSecret: Uint8Array;
    ratchetKey: Uint8Array;
    /** C_{i,j}, and j: the index of the next message this chain will seal. */
    chainKey: Uint8Array;
    index: number;
}

export interface RatchetReceivingChain {
    /** T_i of the other side. */
    ratchetKey: Uint8Array;
    /** C_{i,j}, and j: the index of the next message key this chain makes. */
    chainKey: Uint8Array;
    index: number;
}

export interface RatchetSkippedKey {
    ratchetKey: Uint8Array;
    index: number;
    messageKey: Uint8Array;
}

/** Everything one side keeps for one session. Plain data; see exportRatchetState for storage. */
export interface RatchetState {
    macBytes: RatchetMacBytes;
    sessionKeys: RatchetSessionKeys;
    /** True for the side that started the session: its messages are pre-key messages until it has received one. */
    initiator: boolean;
    /** R_i. */
    rootKey: Uint8Array;
    /** Our current sending chain, or null when our next message must start a new one (a new ratchet key). */
    sending: RatchetSendingChain | null;
    /** Oldest first; the last is the newest ratchet key the other side sent. */
    receiving: RatchetReceivingChain[];
    /** Oldest first. */
    skipped: RatchetSkippedKey[];
}

/** An encoded message, as it travels. 'prekey' carries the session's start; 'normal' does not. */
export interface RatchetMessage {
    type: 'prekey' | 'normal';
    body: Uint8Array;
}

/** A parsed normal message ([OLM] §"Normal message"). */
export interface RatchetWireMessage {
    ratchetKey: Uint8Array;
    index: number;
    ciphertext: Uint8Array;
    /** The bytes the MAC covers: the version byte and the three fields. */
    authenticated: Uint8Array;
    mac: Uint8Array;
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys and the KDFs: [OLM] §"Initial setup", §"Advancing the root key", §"Advancing the chain key", §"Creating a message key".

/** An X25519 key pair from 32 random bytes. noble clamps at use, as [OLM]'s Curve25519 does. */
export function ratchetKeyPair(rng: RatchetRng = randomBytes): { secret: Uint8Array; public: Uint8Array } {
    const secret = take(rng, KEY_LEN);
    return { secret, public: x25519.getPublicKey(secret) };
}

/** ECDH(secret, public), refused when the result is all zeros (a low-order public key gives no secret). */
function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array {
    let out: Uint8Array;
    try {
        out = x25519.getSharedSecret(secret, pub);
    } catch {
        throw new RatchetRefusedError('bad-key');
    }
    if (out.every((b) => b === 0)) throw new RatchetRefusedError('bad-key');
    return out;
}

/** [OLM] §"Advancing the root key": R_i ‖ C_{i,0} = HKDF(R_{i-1}, ECDH(T_{i-1}, T_i), "OLM_RATCHET", 64). [DR] KDF_RK. */
function kdfRoot(rootKey: Uint8Array, dhOut: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
    const out = hkdf(sha256, dhOut, rootKey, INFO_RATCHET, 64);
    return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

/** [OLM] §"Advancing the chain key" and §"Creating a message key": C_{i,j+1} = HMAC(C_{i,j}, 0x02), M_{i,j} = HMAC(C_{i,j}, 0x01). [DR] KDF_CK. */
function kdfChain(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
    return { chainKey: hmac(sha256, chainKey, CHAIN_STEP), messageKey: hmac(sha256, chainKey, MESSAGE_STEP) };
}

/** [OLM] §"Sending messages": AES_KEY ‖ HMAC_KEY ‖ AES_IV = HKDF(0, M_{i,j}, "OLM_KEYS", 80). [DR] §5.2 ENCRYPT. */
function messageKeys(messageKey: Uint8Array): { aesKey: Uint8Array; macKey: Uint8Array; iv: Uint8Array } {
    const out = hkdf(sha256, messageKey, undefined, INFO_KEYS, 80);
    return { aesKey: out.slice(0, 32), macKey: out.slice(32, 64), iv: out.slice(64, 80) };
}

/** The Olm session id: SHA-256(I_A ‖ E_A ‖ E_B). Both sides compute the same one; a pre-key message names it by its keys. */
export function ratchetSessionId(keys: RatchetSessionKeys): Uint8Array {
    return sha256(concatBytes(keys.identityKey, keys.baseKey, keys.oneTimeKey));
}

// ---------------------------------------------------------------------------------------------------------------------
// The start: [OLM] §"Initial setup", the triple Diffie-Hellman. (Signal's X3DH is the same idea with a signed pre-key;
// which of Bob's keys are published and signed, and where, is part 2's wiring.)

/** Alice's side: her identity secret, Bob's identity key and one of his one-time keys. Her first messages are pre-key messages. */
export function startOutboundRatchet(args: {
    myIdentitySecret: Uint8Array;
    theirIdentityKey: Uint8Array;
    theirOneTimeKey: Uint8Array;
    macBytes?: RatchetMacBytes;
    rng?: RatchetRng;
}): RatchetState {
    const rng = args.rng ?? randomBytes;
    const macBytes = macLength(args.macBytes);
    for (const k of [args.myIdentitySecret, args.theirIdentityKey, args.theirOneTimeKey]) keyLength(k);
    const base = ratchetKeyPair(rng);
    // S = ECDH(I_A, E_B) ‖ ECDH(E_A, I_B) ‖ ECDH(E_A, E_B); R_0 ‖ C_{0,0} = HKDF(0, S, "OLM_ROOT", 64).
    const shared = concatBytes(
        dh(args.myIdentitySecret, args.theirOneTimeKey),
        dh(base.secret, args.theirIdentityKey),
        dh(base.secret, args.theirOneTimeKey),
    );
    const root = hkdf(sha256, shared, undefined, INFO_ROOT, 64);
    base.secret.fill(0);
    shared.fill(0);
    // [OLM] §"Sending messages": Alice's first chain needs no ratchet step; T_0 is a fresh key of its own.
    const t0 = ratchetKeyPair(rng);
    return {
        macBytes,
        sessionKeys: {
            identityKey: x25519.getPublicKey(args.myIdentitySecret),
            baseKey: base.public,
            oneTimeKey: Uint8Array.from(args.theirOneTimeKey),
        },
        initiator: true,
        rootKey: root.slice(0, 32),
        sending: { ratchetSecret: t0.secret, ratchetKey: t0.public, chainKey: root.slice(32, 64), index: 0 },
        receiving: [],
        skipped: [],
    };
}

/**
 * Bob's side, from Alice's first pre-key message: his identity secret and the secret of the one-time key she used. Returns his
 * session and her first message's plaintext. The caller deletes that one-time key once this returns ([OLM] §"Initial setup":
 * a one-time key is used once); a message that doesn't open throws and starts nothing.
 */
export function startInboundRatchet(args: {
    myIdentitySecret: Uint8Array;
    myOneTimeSecret: Uint8Array;
    message: Uint8Array;
    macBytes?: RatchetMacBytes;
}): { state: RatchetState; plaintext: Uint8Array } {
    const macBytes = macLength(args.macBytes);
    keyLength(args.myIdentitySecret);
    keyLength(args.myOneTimeSecret);
    const pre = decodePreKeyMessage(args.message);
    if (!equalBytes(pre.sessionKeys.oneTimeKey, x25519.getPublicKey(args.myOneTimeSecret))) {
        throw new RatchetRefusedError('session-mismatch');
    }
    const inner = decodeNormalMessage(pre.message, macBytes);
    const shared = concatBytes(
        dh(args.myOneTimeSecret, pre.sessionKeys.identityKey),
        dh(args.myIdentitySecret, pre.sessionKeys.baseKey),
        dh(args.myOneTimeSecret, pre.sessionKeys.baseKey),
    );
    const root = hkdf(sha256, shared, undefined, INFO_ROOT, 64);
    shared.fill(0);
    const fresh: RatchetState = {
        macBytes,
        sessionKeys: pre.sessionKeys,
        initiator: false,
        rootKey: root.slice(0, 32),
        sending: null,
        receiving: [{ ratchetKey: inner.ratchetKey, chainKey: root.slice(32, 64), index: 0 }],
        skipped: [],
    };
    return ratchetDecrypt(fresh, { type: 'prekey', body: args.message });
}

// ---------------------------------------------------------------------------------------------------------------------
// Sending: [OLM] §"Sending messages"; [DR] §3.4 RatchetEncrypt.

/** Seal one message. Returns the message and the state to keep in place of the one passed in. */
export function ratchetEncrypt(
    state: RatchetState,
    plaintext: Uint8Array,
    rng: RatchetRng = randomBytes,
): { state: RatchetState; message: RatchetMessage } {
    const next = cloneState(state);
    if (!next.sending) {
        // [OLM] §"Sending messages": the first message after receiving a new ratchet key makes a new one of ours, T_i, and the
        // chain from R_{i-1} and ECDH(T_i, T_{i-1}). Our previous ratchet secret was erased when theirs arrived.
        const theirs = next.receiving[next.receiving.length - 1];
        if (!theirs) throw new Error('ratchet: a state with no sending chain and nothing received');
        const mine = ratchetKeyPair(rng);
        const step = kdfRoot(next.rootKey, dh(mine.secret, theirs.ratchetKey));
        next.rootKey = step.rootKey;
        next.sending = { ratchetSecret: mine.secret, ratchetKey: mine.public, chainKey: step.chainKey, index: 0 };
    }
    const chain = next.sending;
    if (chain.index > RATCHET_MAX_INDEX) throw new Error('ratchet: the sending chain is exhausted');
    const { chainKey, messageKey } = kdfChain(chain.chainKey);
    const keys = messageKeys(messageKey);
    const ciphertext = cbc(keys.aesKey, keys.iv).encrypt(plaintext);
    const authenticated = concatBytes(
        Uint8Array.of(normalVersion(next.macBytes)),
        field(TAG_RATCHET_KEY, chain.ratchetKey),
        Uint8Array.of(TAG_CHAIN_INDEX),
        varint(chain.index),
        field(TAG_CIPHERTEXT, ciphertext),
    );
    const body = concatBytes(authenticated, hmac(sha256, keys.macKey, authenticated).slice(0, next.macBytes));
    chain.chainKey = chainKey;
    chain.index += 1;
    messageKey.fill(0);
    // [OLM]: until the initiator has received a message, every message carries the session's start.
    if (next.initiator && next.receiving.length === 0) {
        const k = next.sessionKeys;
        const pre = concatBytes(
            Uint8Array.of(RATCHET_WIRE_VERSION),
            field(TAG_ONE_TIME_KEY, k.oneTimeKey),
            field(TAG_BASE_KEY, k.baseKey),
            field(TAG_IDENTITY_KEY, k.identityKey),
            field(TAG_MESSAGE, body),
        );
        return { state: next, message: { type: 'prekey', body: pre } };
    }
    return { state: next, message: { type: 'normal', body } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Receiving: [OLM] §"Receiving messages"; [DR] §3.5 RatchetDecrypt, TrySkippedMessageKeys, SkipMessageKeys, DHRatchet.

/** Open one message. Throws RatchetRefusedError and changes nothing when it can't; otherwise returns the state to keep. */
export function ratchetDecrypt(state: RatchetState, message: RatchetMessage): { state: RatchetState; plaintext: Uint8Array } {
    let body = message.body;
    if (message.type === 'prekey') {
        const pre = decodePreKeyMessage(body);
        const k = state.sessionKeys;
        if (
            !equalBytes(pre.sessionKeys.identityKey, k.identityKey) ||
            !equalBytes(pre.sessionKeys.baseKey, k.baseKey) ||
            !equalBytes(pre.sessionKeys.oneTimeKey, k.oneTimeKey)
        ) {
            throw new RatchetRefusedError('session-mismatch');
        }
        body = pre.message;
    } else if (message.type !== 'normal') {
        throw new RatchetRefusedError('malformed');
    }
    const wire = decodeNormalMessage(body, state.macBytes);
    // Every change happens on a copy, kept only if the MAC checks: [DR] §3.5, "discard any changes to the state".
    const next = cloneState(state);

    // A key we skipped earlier ([DR] TrySkippedMessageKeys).
    const s = next.skipped.findIndex((k) => k.index === wire.index && equalBytes(k.ratchetKey, wire.ratchetKey));
    if (s >= 0) {
        const plaintext = open(next.skipped[s].messageKey, wire);
        next.skipped.splice(s, 1);
        return { state: next, plaintext };
    }

    let chain = next.receiving.find((c) => equalBytes(c.ratchetKey, wire.ratchetKey));
    if (!chain) {
        // A new ratchet key from the other side ([DR] DHRatchet; [OLM] §"Advancing the root key"): one root step with OUR
        // current ratchet secret, which is then erased, so our next message starts a chain of its own.
        if (!next.sending) throw new RatchetRefusedError('unexpected-ratchet-key');
        const step = kdfRoot(next.rootKey, dh(next.sending.ratchetSecret, wire.ratchetKey));
        next.rootKey = step.rootKey;
        next.sending = null;
        chain = { ratchetKey: Uint8Array.from(wire.ratchetKey), chainKey: step.chainKey, index: 0 };
        next.receiving.push(chain);
        if (next.receiving.length > RATCHET_MAX_RECEIVING_CHAINS) {
            const gone = next.receiving.shift()!;
            next.skipped = next.skipped.filter((k) => !equalBytes(k.ratchetKey, gone.ratchetKey));
        }
    }

    // Behind the chain and not a kept skipped key: used already, or dropped.
    if (wire.index < chain.index) throw new RatchetRefusedError('no-key');
    // [DR] SkipMessageKeys: "if state.Nr + MAX_SKIP < until: raise error".
    if (wire.index - chain.index > RATCHET_MAX_SKIP) throw new RatchetRefusedError('too-far-ahead');
    while (chain.index < wire.index) {
        const step = kdfChain(chain.chainKey);
        next.skipped.push({ ratchetKey: chain.ratchetKey, index: chain.index, messageKey: step.messageKey });
        chain.chainKey = step.chainKey;
        chain.index += 1;
    }
    if (next.skipped.length > RATCHET_MAX_SKIPPED_KEYS) next.skipped.splice(0, next.skipped.length - RATCHET_MAX_SKIPPED_KEYS);
    const step = kdfChain(chain.chainKey);
    const plaintext = open(step.messageKey, wire);
    chain.chainKey = step.chainKey;
    chain.index += 1;
    return { state: next, plaintext };
}

/** [OLM] §"Olm Authentication": check the MAC over the version byte and the fields, then decrypt ([DR] §5.2: MAC first). */
function open(messageKey: Uint8Array, wire: RatchetWireMessage): Uint8Array {
    const keys = messageKeys(messageKey);
    const expected = hmac(sha256, keys.macKey, wire.authenticated).slice(0, wire.mac.length);
    if (!equalBytes(expected, wire.mac)) throw new RatchetRefusedError('mac');
    try {
        return cbc(keys.aesKey, keys.iv).decrypt(wire.ciphertext);
    } catch {
        // A matching MAC with bad padding means the sender sealed it that way; still refused, never shown.
        throw new RatchetRefusedError('malformed');
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The wire: [OLM] §"The Olm Message format". A key-value list after the version byte: the key's top bits are the field
// number, its low 3 bits the type (0 an integer, 2 a length-prefixed string); integers are base-128 varints.

function normalVersion(macBytes: RatchetMacBytes): number {
    return macBytes === 8 ? RATCHET_WIRE_VERSION : RATCHET_WIRE_VERSION_FULL_MAC;
}

function field(tag: number, bytes: Uint8Array): Uint8Array {
    return concatBytes(Uint8Array.of(tag), varint(bytes.length), bytes);
}

function varint(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('ratchet: bad varint');
    const out: number[] = [];
    while (n >= 0x80) {
        out.push((n % 0x80) | 0x80);
        n = Math.floor(n / 0x80);
    }
    out.push(n);
    return Uint8Array.from(out);
}

/** A cursor over one message. Every read refuses as 'malformed' rather than guessing. */
class Reader {
    private at = 0;
    constructor(private readonly bytes: Uint8Array) {}
    done(): boolean {
        return this.at === this.bytes.length;
    }
    byte(): number {
        if (this.at >= this.bytes.length) throw new RatchetRefusedError('malformed');
        return this.bytes[this.at++];
    }
    varint(max: number): number {
        let n = 0;
        let scale = 1;
        for (let i = 0; i < 6; i += 1) {
            const b = this.byte();
            n += (b & 0x7f) * scale;
            if (n > max) throw new RatchetRefusedError('malformed');
            if (!(b & 0x80)) {
                // Shortest form only: a trailing zero byte would let one index be written two ways.
                if (i > 0 && b === 0) throw new RatchetRefusedError('malformed');
                return n;
            }
            scale *= 0x80;
        }
        throw new RatchetRefusedError('malformed');
    }
    expect(tag: number): void {
        if (this.byte() !== tag) throw new RatchetRefusedError('malformed');
    }
    string(tag: number, exactly?: number): Uint8Array {
        this.expect(tag);
        const len = this.varint(this.bytes.length);
        if (exactly !== undefined && len !== exactly) throw new RatchetRefusedError('malformed');
        if (this.at + len > this.bytes.length) throw new RatchetRefusedError('malformed');
        const out = this.bytes.slice(this.at, this.at + len);
        this.at += len;
        return out;
    }
}

/** A normal message: version, ratchet key, chain index, ciphertext, then the MAC. */
export function decodeNormalMessage(body: Uint8Array, macBytes: RatchetMacBytes): RatchetWireMessage {
    if (!(body instanceof Uint8Array) || body.length <= macBytes) throw new RatchetRefusedError('malformed');
    const authenticated = body.slice(0, body.length - macBytes);
    const r = new Reader(authenticated);
    if (r.byte() !== normalVersion(macBytes)) throw new RatchetRefusedError('malformed');
    const ratchetKey = r.string(TAG_RATCHET_KEY, KEY_LEN);
    r.expect(TAG_CHAIN_INDEX);
    const index = r.varint(RATCHET_MAX_INDEX);
    const ciphertext = r.string(TAG_CIPHERTEXT);
    // AES-CBC output is whole 16-byte blocks, at least one.
    if (!r.done() || ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new RatchetRefusedError('malformed');
    return { ratchetKey, index, ciphertext, authenticated, mac: body.slice(body.length - macBytes) };
}

/** A pre-key message: version, Bob's one-time key, Alice's base key, Alice's identity key, then the normal message whole. */
export function decodePreKeyMessage(body: Uint8Array): { sessionKeys: RatchetSessionKeys; message: Uint8Array } {
    if (!(body instanceof Uint8Array)) throw new RatchetRefusedError('malformed');
    const r = new Reader(body);
    if (r.byte() !== RATCHET_WIRE_VERSION) throw new RatchetRefusedError('malformed');
    const oneTimeKey = r.string(TAG_ONE_TIME_KEY, KEY_LEN);
    const baseKey = r.string(TAG_BASE_KEY, KEY_LEN);
    const identityKey = r.string(TAG_IDENTITY_KEY, KEY_LEN);
    const message = r.string(TAG_MESSAGE);
    if (!r.done()) throw new RatchetRefusedError('malformed');
    return { sessionKeys: { identityKey, baseKey, oneTimeKey }, message };
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage: a JSON-safe copy of the state (base64 bytes), and back, checked.

export interface RatchetStateJson {
    v: 1;
    macBytes: RatchetMacBytes;
    initiator: boolean;
    sessionKeys: { identityKey: string; baseKey: string; oneTimeKey: string };
    rootKey: string;
    sending: { ratchetSecret: string; ratchetKey: string; chainKey: string; index: number } | null;
    receiving: { ratchetKey: string; chainKey: string; index: number }[];
    skipped: { ratchetKey: string; index: number; messageKey: string }[];
}

export function exportRatchetState(s: RatchetState): RatchetStateJson {
    return {
        v: 1,
        macBytes: s.macBytes,
        initiator: s.initiator,
        sessionKeys: { identityKey: b64(s.sessionKeys.identityKey), baseKey: b64(s.sessionKeys.baseKey), oneTimeKey: b64(s.sessionKeys.oneTimeKey) },
        rootKey: b64(s.rootKey),
        sending: s.sending
            ? { ratchetSecret: b64(s.sending.ratchetSecret), ratchetKey: b64(s.sending.ratchetKey), chainKey: b64(s.sending.chainKey), index: s.sending.index }
            : null,
        receiving: s.receiving.map((c) => ({ ratchetKey: b64(c.ratchetKey), chainKey: b64(c.chainKey), index: c.index })),
        skipped: s.skipped.map((k) => ({ ratchetKey: b64(k.ratchetKey), index: k.index, messageKey: b64(k.messageKey) })),
    };
}

/** Reads a stored state back. Throws on anything that isn't one this file wrote, rather than half-loading it. */
export function importRatchetState(j: RatchetStateJson): RatchetState {
    const bad = (why: string): never => {
        throw new Error(`ratchet: stored state refused (${why})`);
    };
    if (!j || j.v !== 1) bad('version');
    const macBytes = macLength(j.macBytes);
    if (typeof j.initiator !== 'boolean') bad('initiator');
    const key = (v: unknown): Uint8Array => {
        const out = typeof v === 'string' ? unb64(v) : bad('key');
        return out.length === KEY_LEN ? out : bad('key length');
    };
    const index = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= RATCHET_MAX_INDEX + 1 ? (v as number) : bad('index'));
    if (!Array.isArray(j.receiving) || !Array.isArray(j.skipped)) bad('lists');
    if (j.receiving.length > RATCHET_MAX_RECEIVING_CHAINS || j.skipped.length > RATCHET_MAX_SKIPPED_KEYS) bad('too long');
    const state: RatchetState = {
        macBytes,
        initiator: j.initiator,
        sessionKeys: { identityKey: key(j.sessionKeys?.identityKey), baseKey: key(j.sessionKeys?.baseKey), oneTimeKey: key(j.sessionKeys?.oneTimeKey) },
        rootKey: key(j.rootKey),
        sending: j.sending
            ? { ratchetSecret: key(j.sending.ratchetSecret), ratchetKey: key(j.sending.ratchetKey), chainKey: key(j.sending.chainKey), index: index(j.sending.index) }
            : null,
        receiving: j.receiving.map((c) => ({ ratchetKey: key(c.ratchetKey), chainKey: key(c.chainKey), index: index(c.index) })),
        skipped: j.skipped.map((k) => ({ ratchetKey: key(k.ratchetKey), index: index(k.index), messageKey: key(k.messageKey) })),
    };
    if (!state.sending && state.receiving.length === 0) bad('nothing to send or receive with');
    if (state.sending && !equalBytes(x25519.getPublicKey(state.sending.ratchetSecret), state.sending.ratchetKey)) bad('ratchet key pair');
    return state;
}

// ---------------------------------------------------------------------------------------------------------------------

function cloneState(s: RatchetState): RatchetState {
    return {
        macBytes: s.macBytes,
        initiator: s.initiator,
        sessionKeys: { ...s.sessionKeys },
        rootKey: s.rootKey,
        sending: s.sending ? { ...s.sending } : null,
        receiving: s.receiving.map((c) => ({ ...c })),
        skipped: s.skipped.slice(),
    };
}

function macLength(m: unknown): RatchetMacBytes {
    if (m === undefined) return 8;
    if (m !== 8 && m !== 32) throw new Error('ratchet: the MAC is 8 or 32 bytes');
    return m;
}

function keyLength(k: Uint8Array): void {
    if (!(k instanceof Uint8Array) || k.length !== KEY_LEN) throw new Error('ratchet: keys are 32 bytes');
}

function take(rng: RatchetRng, n: number): Uint8Array {
    const out = rng(n);
    if (!(out instanceof Uint8Array) || out.length !== n) throw new Error('ratchet: the random source gave the wrong length');
    return Uint8Array.from(out);
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function unb64(s: string): Uint8Array {
    // Buffer reads loose base64 without complaint; a stored state is only ever what b64 wrote, so anything else is refused.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error('ratchet: stored state refused (base64)');
    return Uint8Array.from(Buffer.from(s, 'base64'));
}
