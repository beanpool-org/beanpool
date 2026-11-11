/**
 * Direct messages, end to end: the one implementation both apps use (apps/native/utils/e2e-crypto.ts and
 * apps/pwa/src/lib/e2e-crypto.ts re-export it), so a line one app writes is a line the other reads.
 *
 * The key and the cipher are NAT-1's and have not changed:
 *   Key:    X25519 between the two members' Ed25519 identities (normalised by toEd25519Seed first: the web app keeps a
 *           PKCS8 key, the phone the bare seed), HKDF-SHA256 salted with the conversation id, info 'beanpool-dm-v2'.
 *           One key for the two of them in that conversation, the same in both directions. Static keys, so no forward
 *           secrecy.
 *   Cipher: XChaCha20-Poly1305, a fresh random 24-byte nonce for every line.
 *
 * Line format 4, the only one written and the only one opened (the 1.4.0 clean-slate cutover: Marty, 10 Nov 2026, old chat
 * is wiped at the deploy, so no reader of an older format is kept anywhere; scratch/fable-design/DESIGN-clean-slate-cutover-
 * fable.md §6 item 5).
 *   The seal: the associated data names the conversation, the SENDER's key, the message id, which part of the message it is
 *     (the words, the photo, or the listing it is about) and, for a reply, the id of the message it answers. Shown as
 *     someone else's, under another id, in another conversation, as an answer to another message, or one part in another's
 *     place, it doesn't open. The sealed bytes start with the format byte, then the id of the newest line the sender had
 *     from the node when they wrote it ("after"): a line shown before the line it was written after has been moved, and
 *     checkDmThread marks it.
 *   The signature: the two people share one key, so either could seal a line naming the other as its sender. So the sender
 *     also signs the sealed bytes with their member key: who wrote them, to whom, in which conversation, under which id,
 *     which part, when by their clock, the nonce and a hash of the sealed bytes (dmLineSigDigest). It sits BESIDE the seal,
 *     not under it, so the node and a moderator can check who wrote a line without opening it, and nobody can tell what
 *     it says (a report stands on it: dm-line-report.ts). Every part is signed, the photo and the listing too, by
 *     sealDmLine itself, and openDmLine opens nothing whose signature isn't its named sender's: a line not signed by its
 *     claimed sender is never shown as theirs, nor are its words shown.
 *   Wire: nonce column 'x25519-xc20p-v2:' + base64(nonce), as before; ciphertext column base64 of
 *     [4][the signature, 64 bytes][when it was signed, 24 bytes of ISO 8601][the AEAD output]. The node can't open a line
 *     but it can check that form, and refuses every other one into a DM (engine/messaging.ts), an older format's line
 *     first among them: a format-2 or format-3 line is the AEAD output alone.
 *
 * A DM row that isn't an encrypted line (readable `plaintext-v1`, `00000`, any other nonce) is never shown as anyone's
 * words: the node could have written it (dmLineKind). Only three kinds are the node's own by design, and each is shown
 * as the node's, never as a member's: its notices (author SYSTEM or type system), a tombstone (fixed text in the apps,
 * never the row's words), and the message the admin page sends (metadata DM_FROM_ADMINS_KEY), shown marked as from the
 * community's admins and readable by the server.
 *
 * Old chat, read-only (conversion code, log row OLDCHAT, remove in 1.5.0; the block "Old chat" at the end of this file):
 * a line from before 1.4.0 is shown again, its words opened as they were then, marked old (DmLineView.old) and under one
 * label in both apps, never answered, quoted, edited or reacted to.
 *
 * Not covered, by design: the node can still withhold or delay a line, and put an edit's earlier words back (an edit keeps
 * its line's id, and both versions are the sender's own, each signed).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { toEd25519Seed } from './ed25519-key.js';
import { word } from './words.js';

/** The nonce column's prefix for every encrypted line. */
export const DM_NONCE_PREFIX = 'x25519-xc20p-v2:';
/** The line format this code writes, and the only one it opens. */
export const DM_LINE_FORMAT = 4;
/** First word of format 4's associated data: the format's own name, so no other use of the key can be taken for it. */
export const DM_LINE_AAD_TAG = 'beanpool-dm-line/4';
/** First word of what a sender signs: this use's own name, so no other signature by the key can be taken for it. */
export const DM_LINE_SIG_TAG = 'beanpool-dm-line-sig/2';

const HKDF_INFO = utf8ToBytes('beanpool-dm-v2');
const NONCE_LEN = 24;
const SIG_LEN = 64;
/** When a line was signed, as the column carries it: Date.toISOString(), always 24 characters. */
const AT_LEN = 24;
const AT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AEAD_TAG_LEN = 16;
/** The smallest ciphertext column: the format byte, the signature, when, and an AEAD tag around no bytes. */
const MIN_COLUMN_BYTES = 1 + SIG_LEN + AT_LEN + AEAD_TAG_LEN;
const MAX_AFTER_BYTES = 255;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** My key, the other person's, and the conversation: what the key is made from. */
export interface DmKeyContext {
    /** My Ed25519 private key, hex: the bare 32-byte seed (phone) or PKCS8 (web app). */
    myEdPrivHex: string;
    /** The other person's Ed25519 public key, hex. */
    peerEdPubHex: string;
    /** The conversation the line is written in: salts the key and is bound in the associated data. */
    conversationId: string;
}

/** The two keys, without a conversation (a thread's lines may have been written under an older conversation id). */
export type DmKeys = Pick<DmKeyContext, 'myEdPrivHex' | 'peerEdPubHex'>;

/**
 * The words of a message, its photo, or the listing it is about (chat-about.ts). Each part is sealed and signed on its own,
 * bound to its message id and to its part name, so one can never be shown in another's place.
 */
export type DmPart = 'body' | 'attachment' | 'about';

/** What a line is bound to besides its conversation. */
export interface DmLineBinding {
    /** The sender's public key, hex, exactly as the node stores it as the line's author. */
    senderPubHex: string;
    /** The message id, exactly as the node stores it: the client's own UUID v4, lower case (the node lowers it). */
    messageId: string;
    /** The words (default), the photo, or the listing it is about. */
    part?: DmPart;
}

/** A line as it goes to the node: the ciphertext column carries the sender's signature beside the sealed bytes. */
export interface DmPayload {
    ciphertext: string;
    nonce: string;
}

/** A line that opened, its sender's signature verified. */
export interface OpenedDmLine {
    text: string;
    format: 4;
    /** The newest line the sender had from the node when they wrote this one; null if none. */
    after: string | null;
    /** The conversation id it opened under. */
    conversationId: string;
    /** It opened only under an older conversation id named in its metadata, not the one it is stored in. */
    moved: boolean;
}

/** Thrown when a line doesn't open: it was changed, or moved, or isn't the sender's or this pair's, or they didn't sign it. */
export class DmLineNotVerifiedError extends Error {
    constructor(message = "This message couldn't be verified.") {
        super(message);
        this.name = 'DmLineNotVerifiedError';
    }
}

/** True if a stored nonce is an encrypted line's. */
export function isDmEncryptedNonce(nonce: string | null | undefined): boolean {
    return typeof nonce === 'string' && nonce.startsWith(DM_NONCE_PREFIX);
}

/** A new message id for a line: UUID v4, lower case, from the platform's CSPRNG (no secure context needed). */
export function newDmMessageId(): string {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = bytesToHex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}
function unb64(s: string): Uint8Array {
    if (typeof s !== 'string') throw new DmLineNotVerifiedError();
    return new Uint8Array(Buffer.from(s, 'base64'));
}
/** Standard padded base64 in its one spelling (as both apps write it), decoded; null for anything else. */
function strictUnb64(s: unknown): Uint8Array | null {
    if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
    const bytes = Buffer.from(s, 'base64');
    return bytes.toString('base64') === s ? new Uint8Array(bytes) : null;
}
function utf8(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('utf8');
}

/** My public key, hex, from my private key in either spelling. */
export function dmPublicKeyOf(myEdPrivHex: string): string {
    return bytesToHex(ed25519.getPublicKey(toEd25519Seed(hexToBytes(myEdPrivHex))));
}

/**
 * My X25519 secret, from my Ed25519 private key in either spelling: the one derivation direct messages and group keys
 * (group-crypto.ts) both use. Normalised, not length-checked: the X25519 secret must come from the seed, and a
 * PKCS8-wrapped key silently derives a different one.
 */
export function identityX25519Secret(myEdPrivHex: string): Uint8Array {
    return ed25519.utils.toMontgomerySecret(toEd25519Seed(hexToBytes(myEdPrivHex)));
}

/** A member's X25519 public key, from their Ed25519 public key, hex: the other half of identityX25519Secret. */
export function identityX25519Public(edPubHex: string): Uint8Array {
    return ed25519.utils.toMontgomery(hexToBytes(edPubHex));
}

/** The conversation's key, the same for both people. */
export function deriveDmKey(ctx: DmKeyContext): Uint8Array {
    try {
        const myXPriv = identityX25519Secret(ctx.myEdPrivHex);
        const peerXPub = identityX25519Public(ctx.peerEdPubHex);
        const shared = x25519.getSharedSecret(myXPriv, peerXPub);
        return hkdf(sha256, shared, utf8ToBytes(ctx.conversationId), HKDF_INFO, 32);
    } catch (e: any) {
        throw new Error(`Failed to derive DM encryption key: ${e?.message || e}`);
    }
}

/**
 * Format 4's associated data: the UTF-8 of a JSON array of strings, [tag, conversation, sender, message id, part], and for
 * a reply a sixth, the id of the message it answers. A JSON array of strings has one spelling for one list of values, so
 * no two different bindings share bytes, and a reply's never equals a line's that answers nothing.
 */
export function dmLineAad(conversationId: string, line: DmLineBinding, replyToId?: string | null): Uint8Array {
    const parts = [DM_LINE_AAD_TAG, conversationId, line.senderPubHex, line.messageId, line.part ?? 'body'];
    if (replyToId) parts.push(replyToId);
    return utf8ToBytes(JSON.stringify(parts));
}

function parsedMetadata(metadata: unknown): any {
    if (typeof metadata === 'string' && metadata) {
        try { return JSON.parse(metadata); } catch { return null; }
    }
    return metadata && typeof metadata === 'object' ? metadata : null;
}

/**
 * The message a line answers, as its metadata names it (`replyToId`, which the node stores and can read): bound into the
 * line, so the node can't point an answer at another message. undefined when the metadata names one that no app writes
 * (not a non-empty string): no line opens then.
 */
export function dmReplyToOf(metadata: unknown): string | null | undefined {
    const meta = parsedMetadata(metadata);
    if (!meta || typeof meta !== 'object' || meta.replyToId === undefined || meta.replyToId === null) return null;
    return typeof meta.replyToId === 'string' && meta.replyToId ? meta.replyToId : undefined;
}

/** The sealed plaintext: [4][length of after][after, UTF-8][the words, UTF-8]. */
function frame(text: string, after: string | null | undefined): Uint8Array {
    let a = typeof after === 'string' && after ? utf8ToBytes(after) : new Uint8Array(0);
    if (a.length > MAX_AFTER_BYTES) a = new Uint8Array(0);
    const t = utf8ToBytes(text);
    const out = new Uint8Array(2 + a.length + t.length);
    out[0] = DM_LINE_FORMAT;
    out[1] = a.length;
    out.set(a, 2);
    out.set(t, 2 + a.length);
    return out;
}

function unframe(pt: Uint8Array): { text: string; after: string | null } {
    if (pt.length < 2 || pt[0] !== DM_LINE_FORMAT || pt.length < 2 + pt[1]) throw new DmLineNotVerifiedError();
    const len = pt[1];
    return { after: len ? utf8(pt.subarray(2, 2 + len)) : null, text: utf8(pt.subarray(2 + len)) };
}

// ─── The signature beside the seal ──────────────────────────────────────────────────────────

/** A line's signature as its ciphertext column carries it. */
export interface DmLineSig {
    /** Ed25519 over dmLineSigDigest, base64. */
    sig: string;
    /** When, by the sender's own clock (ISO 8601). */
    at: string;
}

/** What a sender signs besides the sealed bytes and the nonce. */
export interface DmLineSigBinding {
    conversationId: string;
    senderPubHex: string;
    /** Who it was written to: the other person's key the line is sealed to. */
    recipientPubHex: string;
    messageId: string;
    part: DmPart;
    /** When, by the sender's own clock: Date.toISOString(). */
    at: string;
}

/** A ciphertext column taken apart: the signature, when it was signed, and the sealed bytes (the AEAD output). */
interface SignedColumn {
    sig: Uint8Array;
    at: string;
    sealed: Uint8Array;
}

/** The parts of a format-4 ciphertext column, or null when it isn't one (an older format's line is the AEAD output alone). */
function columnParts(ciphertext: unknown): SignedColumn | null {
    const bytes = strictUnb64(ciphertext);
    if (!bytes || bytes.length < MIN_COLUMN_BYTES || bytes[0] !== DM_LINE_FORMAT) return null;
    const atBytes = bytes.subarray(1 + SIG_LEN, 1 + SIG_LEN + AT_LEN);
    for (const c of atBytes) if (c < 0x20 || c > 0x7e) return null;
    const at = utf8(atBytes);
    if (!AT_ISO.test(at)) return null;
    return { sig: bytes.subarray(1, 1 + SIG_LEN), at, sealed: bytes.subarray(1 + SIG_LEN + AT_LEN) };
}

/**
 * True when a line is in format 4's form: an encrypted line's nonce (24 bytes) and a ciphertext column holding a signature
 * slot, the time it was signed and an AEAD output. What the node can check without a key (engine/messaging.ts): it says
 * nothing about who signed it, which only a reader with the binding checks (openDmLine, dm-line-report.ts).
 */
export function isDmLineForm(ciphertext: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'string' || !isDmEncryptedNonce(nonce)) return false;
    const nb = strictUnb64(nonce.slice(DM_NONCE_PREFIX.length));
    return !!nb && nb.length === NONCE_LEN && columnParts(ciphertext) !== null;
}

/** The signature a line's ciphertext column carries, or null when it isn't a format-4 line. */
export function dmLineSigOf(ciphertext: unknown): DmLineSig | null {
    const parts = columnParts(ciphertext);
    return parts ? { sig: b64(parts.sig), at: parts.at } : null;
}

/**
 * The digest a sender signs: SHA-256 of the UTF-8 of a JSON array of strings, one spelling for one list of values, as the
 * associated data is (dmLineAad): [tag, conversation, sender, recipient, message id, part, when, nonce column, hex SHA-256
 * of the sealed bytes].
 */
export function dmLineSigDigest(nonce: string, sealed: Uint8Array, b: DmLineSigBinding): Uint8Array {
    return sha256(utf8ToBytes(JSON.stringify([
        DM_LINE_SIG_TAG, b.conversationId, b.senderPubHex, b.recipientPubHex, b.messageId, b.part, b.at, nonce, bytesToHex(sha256(sealed)),
    ])));
}

/**
 * Signatures that verified, remembered (as group lines' are: group-crypto.ts GroupLineVerifyMemo, "verify once, store the
 * verdict"; ~50 ms an Ed25519 verify on an API-26 phone, and both apps judge a whole thread on every load). Keyed by a hash
 * of the signature, the exact digest it signs and the key it verified under: a strict verify is a pure function of those
 * three, so a hit is the same answer, not a shortcut. A changed byte anywhere, another sender or another binding is another
 * key and is verified afresh. Only signatures that verified are kept, the oldest dropped past the cap. Nothing in it is secret.
 */
const VERIFIED_MAX = 4096;
const verified = new Set<string>();

function verifiedBy(sig: Uint8Array, digest: Uint8Array, signerPubHex: string): boolean {
    let key: string;
    let signer: Uint8Array;
    try {
        signer = hexToBytes(signerPubHex);
        key = bytesToHex(sha256(concatBytes(utf8ToBytes('beanpool-dm-line-verdict/1'), sig, digest, signer)));
    } catch {
        return false;
    }
    if (verified.has(key)) return true;
    let ok: boolean;
    // Strict RFC 8032, as every verifier here: one signature for one key and message.
    try { ok = ed25519.verify(sig, digest, signer, { zip215: false }); } catch { ok = false; }
    if (ok) {
        verified.add(key);
        if (verified.size > VERIFIED_MAX) verified.delete(verified.values().next().value as string);
    }
    return ok;
}

/**
 * Whether a line's ciphertext column carries `binding.senderPubHex`'s signature over its sealed bytes, to this person, under
 * this conversation and id, as this part. For a reader who doesn't open the line (the node, a moderator: dm-line-report.ts).
 */
export function dmLineSigVerifies(line: DmPayload, binding: Omit<DmLineSigBinding, 'at'>): boolean {
    const parts = columnParts(line?.ciphertext);
    if (!parts || typeof line.nonce !== 'string') return false;
    return verifiedBy(parts.sig, dmLineSigDigest(line.nonce, parts.sealed, { ...binding, at: parts.at }), binding.senderPubHex);
}

/**
 * Seal a line (its words, its photo as a data URI, or the listing it is about) in format 4, and sign it as me, to the other
 * person. `after` is the id of the newest line this person had from the node when they wrote it (an edit keeps its line's
 * own). Refuses to seal a line naming anyone but me as sender, or an id the node would store differently. `nonceForVectors`
 * and `at` pin the bytes for the vectors (dm-line-vectors.ts); the apps give neither.
 */
export function sealDmLine(
    text: string,
    ctx: DmKeyContext,
    line: DmLineBinding & { after?: string | null; replyToId?: string | null; at?: string },
    nonceForVectors?: Uint8Array,
): DmPayload {
    if (!UUID_V4.test(line.messageId)) throw new Error('A line is sealed under its own lower-case UUID v4.');
    if (line.senderPubHex !== dmPublicKeyOf(ctx.myEdPrivHex)) throw new Error('A line is sealed only as its sender.');
    if (line.replyToId !== undefined && line.replyToId !== null && (typeof line.replyToId !== 'string' || !line.replyToId)) {
        throw new Error('A reply is sealed to the id of the message it answers.');
    }
    const at = line.at ?? new Date().toISOString();
    if (!AT_ISO.test(at)) throw new Error('A line is signed with the time as Date.toISOString() writes it.');
    const key = deriveDmKey(ctx);
    const nonce = nonceForVectors ?? randomBytes(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) throw new Error('A line nonce is 24 bytes.');
    const nonceColumn = DM_NONCE_PREFIX + b64(nonce);
    const part = line.part ?? 'body';
    const sealed = xchacha20poly1305(key, nonce, dmLineAad(ctx.conversationId, line, line.replyToId)).encrypt(frame(text, line.after));
    const digest = dmLineSigDigest(nonceColumn, sealed, {
        conversationId: ctx.conversationId, senderPubHex: line.senderPubHex, recipientPubHex: ctx.peerEdPubHex, messageId: line.messageId, part, at,
    });
    const sig = ed25519.sign(digest, toEd25519Seed(hexToBytes(ctx.myEdPrivHex)));
    return { ciphertext: b64(concatBytes(new Uint8Array([DM_LINE_FORMAT]), sig, utf8ToBytes(at), sealed)), nonce: nonceColumn };
}

function nonceBytes(nonce: string): Uint8Array {
    if (!isDmEncryptedNonce(nonce)) throw new DmLineNotVerifiedError('Not an encrypted line.');
    const nb = unb64(nonce.slice(DM_NONCE_PREFIX.length));
    if (nb.length !== NONCE_LEN) throw new DmLineNotVerifiedError();
    return nb;
}

/**
 * The most conversation ids a line is tried under, the one it is stored in among them. Its sender writes its metadata and
 * only the length is limited (64 KB, about 11,000 short ids), and each id costs the reader's device a key derivation and a
 * decrypt, on its one thread: 0.7 ms an id on a Mac (measured), so one such line held a chat for 7.5 s, and for far longer on
 * an old phone. The signature is checked once, under the id the line opened under, never once an id.
 *
 * 64, from what the node writes. Each fold names one id, `originalConversationId`. The one list, `originalConversationIds`,
 * is repairConsolidatedMessagesMetadata's: one id for each per-post thread a pair had, and those ended before the first
 * public release (1 July 2026), so no pair's list grows. Nothing in the code limits how long one is, so this is a judgement:
 * far past what two people had, at 51 ms for a line that names too many. A line sealed under an id past the cap reads as any
 * line that doesn't open.
 */
export const DM_CONVERSATION_IDS_MAX = 64;

/**
 * The conversation ids a line may have been written under: the one it is stored in, then any older one its metadata
 * names (a line the node moved when two threads were folded into one, or out of a conversation kept while blocked), at
 * most DM_CONVERSATION_IDS_MAX.
 */
export function dmConversationIdsToTry(conversationId: string, metadata: unknown): string[] {
    const ids = [conversationId];
    const meta = parsedMetadata(metadata);
    if (meta && typeof meta === 'object') {
        if (typeof meta.originalConversationId === 'string' && meta.originalConversationId) ids.push(meta.originalConversationId);
        if (Array.isArray(meta.originalConversationIds)) {
            for (const id of meta.originalConversationIds) if (typeof id === 'string' && id) ids.push(id);
        }
    }
    return [...new Set(ids)].slice(0, DM_CONVERSATION_IDS_MAX);
}

/** One line to open: where the node shows it, and what it says the line is. */
export interface DmLineRef extends DmLineBinding {
    /** The conversation the line is stored in. */
    conversationId: string;
    /**
     * Its metadata as stored (a JSON string or the parsed object): older conversation ids are read from it, and the
     * message a reply answers (`replyToId`), which a line is bound to.
     */
    metadata?: unknown;
}

/** Keys derived once per conversation id, for the lines of one thread. */
type KeyCache = Map<string, Uint8Array>;

function keyFor(keys: DmKeys, conversationId: string, cache?: KeyCache): Uint8Array {
    const hit = cache?.get(conversationId);
    if (hit) return hit;
    const key = deriveDmKey({ ...keys, conversationId });
    cache?.set(conversationId, key);
    return key;
}

function openWith(payload: DmPayload, keys: DmKeys, line: DmLineRef, myPubHex: string, cache?: KeyCache): OpenedDmLine {
    // Only the two of them share this key; a line the node names as anyone else's is no line of theirs.
    if (line.senderPubHex !== myPubHex && line.senderPubHex !== keys.peerEdPubHex) throw new DmLineNotVerifiedError();
    const recipientPubHex = line.senderPubHex === myPubHex ? keys.peerEdPubHex : myPubHex;
    const nonce = nonceBytes(payload.nonce);
    const column = columnParts(payload.ciphertext);
    if (!column) throw new DmLineNotVerifiedError();
    const replyToId = dmReplyToOf(line.metadata);
    // A reply id no app writes: no line was sealed to it.
    if (replyToId === undefined) throw new DmLineNotVerifiedError();
    const part = line.part ?? 'body';
    for (const conversationId of dmConversationIdsToTry(line.conversationId, line.metadata)) {
        let key: Uint8Array;
        try { key = keyFor(keys, conversationId, cache); } catch { throw new DmLineNotVerifiedError(); }
        let pt: Uint8Array;
        try { pt = xchacha20poly1305(key, nonce, dmLineAad(conversationId, line, replyToId)).decrypt(column.sealed); } catch { continue; }
        // It opened under this id, so it was sealed under it, and only under it: either of the two could have sealed it
        // naming the other, so it is the named sender's only if they signed it, here, to the other one.
        const digest = dmLineSigDigest(payload.nonce, column.sealed, {
            conversationId, senderPubHex: line.senderPubHex, recipientPubHex, messageId: line.messageId, part, at: column.at,
        });
        if (!verifiedBy(column.sig, digest, line.senderPubHex)) throw new DmLineNotVerifiedError();
        return { ...unframe(pt), format: DM_LINE_FORMAT, conversationId, moved: conversationId !== line.conversationId };
    }
    throw new DmLineNotVerifiedError();
}

/**
 * Open one part of a line under each conversation id it may have been written under, its sender's signature verified.
 * Throws DmLineNotVerifiedError when it doesn't open, or opens but its named sender didn't sign it.
 */
export function openDmLine(payload: DmPayload, keys: DmKeys, line: DmLineRef): OpenedDmLine {
    return openWith(payload, keys, line, dmPublicKeyOf(keys.myEdPrivHex));
}

/**
 * The metadata key the node's admin page sets on the message it sends (state-engine.ts adminSendMessage): readable words
 * the node stores in the admin's name, by design. The node controls metadata, so the key proves nothing about who wrote
 * the words: such a line is shown as the community admins' message, which the server can read, never as a private one.
 */
export const DM_FROM_ADMINS_KEY = 'fromCommunityAdmins';

/** What a DM row is, before anything is opened. */
export type DmLineKind =
    /** An encrypted line: opened, its signature verified, and checked against the thread. */
    | 'encrypted'
    /** A deleted line: shown with fixed text (DM_LINE_DELETED_TEXT), never the row's words. */
    | 'tombstone'
    /** The node's own notice (author SYSTEM, or type system): shown as a notice, never as a member's words. */
    | 'node-notice'
    /** The admin page's message: readable, marked as the community admins' (DM_FROM_ADMINS_KEY). */
    | 'from-admins'
    /** Anything else in a member's name (plaintext-v1, 00000, any other nonce): the node could have written it. */
    | 'not-encrypted';

/** A DM row as stored: what dmLineKind looks at. */
export interface DmRowShape {
    authorPubkey: string;
    nonce: string | null | undefined;
    /** The row's type ('text', 'image', 'system', 'removed'). */
    type?: string | null;
    metadata?: unknown;
}

/** What kind of row a DM line is. In a DM only an encrypted line is ever a member's words. */
export function dmLineKind(l: DmRowShape): DmLineKind {
    if (l.type === 'removed') return 'tombstone';
    if (isDmEncryptedNonce(l.nonce)) return 'encrypted';
    if (l.type === 'system' || l.authorPubkey === 'SYSTEM') return 'node-notice';
    if (l.nonce === 'plaintext-v1' && parsedMetadata(l.metadata)?.[DM_FROM_ADMINS_KEY] === true) return 'from-admins';
    return 'not-encrypted';
}

/** Why a line is marked. */
export type DmLineMark =
    /** Shown before the line it was written after. */
    | 'out-of-order'
    /** Opened only under an older conversation id its metadata names. */
    | 'moved'
    /**
     * An encrypted line that didn't open, or opened but wasn't signed by its named sender: shown as
     * DM_LINE_NOT_VERIFIED_TEXT, as nobody's words.
     */
    | 'not-verified'
    /** Not an encrypted line, in a member's name: shown as DM_LINE_NOT_ENCRYPTED_TEXT, as nobody's words. */
    | 'not-encrypted'
    /** The admin page's message: its words, shown as the community admins', marked readable by the server. */
    | 'from-admins'
    | null;

/** A line of a thread as stored, in the order the thread shows it (oldest first). */
export interface DmThreadLine extends DmRowShape {
    id: string;
    ciphertext: string;
    /** When the node says it was written: the order a thread is shown and judged in (dmThreadInShownOrder). */
    timestamp?: string | null;
}

/** What to show for a line. */
export interface DmLineView {
    /**
     * The words: an encrypted line's that opened, the admin page's message, or a tombstone's fixed text. null when there
     * are none to show: show dmLineShownText(view), never the row as anyone's words.
     */
    text: string | null;
    /** 4 when the line's words opened and its sender signed it; null otherwise. */
    format: 4 | null;
    after: string | null;
    mark: DmLineMark;
    /**
     * A line from before 1.4.0 whose words opened as they did then, in its named author's bubble, shown read-only under
     * DM_OLD_LINES_LABEL (dmLineIsOld; conversion code, log row OLDCHAT, remove in 1.5.0). Absent on every other line.
     */
    old?: true;
}

function decodeReadable(ciphertext: string): string | null {
    try {
        const text = Buffer.from(ciphertext, 'base64').toString('utf8');
        return text.includes('�') ? null : text;
    } catch {
        return null;
    }
}

/**
 * Check every line of one DM thread. `lines` is the thread in the order it is shown, oldest first (dmThreadInShownOrder):
 * the node's own notices are passed over; every other line gets a view, by id. An encrypted line is opened bound to its
 * named sender and id, its sender's signature verified, and its "after" is checked against the lines shown before it. The
 * key is derived once per conversation id. `keys` null (the other person isn't known yet): no encrypted line opens.
 *
 * `formerPeers`: keys this phone sealed the thread to before the one in `keys` (the member continued past a key change).
 * A line that doesn't open under `keys` is tried under each: one of mine as sealed and signed to it, and one the row names
 * as the current peer's or as that former key's, as that key's own (a re-key moves the old lines' author to the new key).
 * Never a line the row names as anyone else's. The key is derived once per key and conversation id.
 */
export function checkDmThread(lines: readonly DmThreadLine[], keys: DmKeys | null, conversationId: string, formerPeers: readonly string[] = []): Map<string, DmLineView> {
    const views = new Map<string, DmLineView>();
    let myPubHex = '';
    if (keys) {
        try { myPubHex = dmPublicKeyOf(keys.myEdPrivHex); } catch { myPubHex = ''; }
    }
    const cache: KeyCache = new Map();
    const formerCaches = new Map<string, KeyCache>();
    const former = keys ? formerPeers.filter((k) => !!k && k !== keys.peerEdPubHex) : [];
    const position = new Map<string, number>();
    lines.forEach((l, i) => { if (!position.has(l.id)) position.set(l.id, i); });
    // Old chat: conversion code, log row OLDCHAT, remove in 1.5.0.
    const oldCaches = new Map<string, KeyCache>();

    lines.forEach((l, i) => {
        if (views.has(l.id)) return;
        const kind = dmLineKind(l);
        if (kind === 'node-notice') return;
        if (kind === 'tombstone') {
            views.set(l.id, { text: DM_LINE_DELETED_TEXT, format: null, after: null, mark: null });
            return;
        }
        if (kind === 'from-admins') {
            const text = decodeReadable(l.ciphertext);
            views.set(l.id, text === null
                ? { text: null, format: null, after: null, mark: 'not-encrypted' }
                : { text, format: null, after: null, mark: 'from-admins' });
            return;
        }
        if (kind === 'not-encrypted') {
            views.set(l.id, { text: null, format: null, after: null, mark: 'not-encrypted' });
            return;
        }
        let opened: OpenedDmLine | null = null;
        if (keys && myPubHex) {
            try {
                opened = openWith({ ciphertext: l.ciphertext, nonce: l.nonce as string }, keys,
                    { conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }, myPubHex, cache);
            } catch { opened = null; }
            for (const peer of opened ? [] : former) {
                const mine = l.authorPubkey === myPubHex;
                if (!mine && l.authorPubkey !== keys.peerEdPubHex && l.authorPubkey !== peer) continue;
                let c = formerCaches.get(peer);
                if (!c) formerCaches.set(peer, c = new Map());
                try {
                    opened = openWith({ ciphertext: l.ciphertext, nonce: l.nonce as string }, { myEdPrivHex: keys.myEdPrivHex, peerEdPubHex: peer },
                        { conversationId, senderPubHex: mine ? myPubHex : peer, messageId: l.id, part: 'body', metadata: l.metadata }, myPubHex, c);
                    break;
                } catch { opened = null; }
            }
        }
        if (!opened) {
            // Old chat (conversion code, log row OLDCHAT, remove in 1.5.0): a line from before 1.4.0, opened as it was then,
            // unless the line it says it was written after is newer than the cutover (then it was written after it too).
            const old = keys && myPubHex ? openOldLineOfThread(l, keys, conversationId, myPubHex, former, oldCaches) : null;
            const afterAt = old?.after ? position.get(old.after) : undefined;
            if (old && (afterAt === undefined || dmLineHasOldShape(lines[afterAt]))) {
                const oldMark: DmLineMark = old.moved ? 'moved' : afterAt !== undefined && afterAt > i ? 'out-of-order' : null;
                views.set(l.id, { text: old.text, format: null, after: old.after, mark: oldMark, old: true });
                return;
            }
            views.set(l.id, { text: null, format: null, after: null, mark: 'not-verified' });
            return;
        }
        let mark: DmLineMark = null;
        const afterAt = opened.after ? position.get(opened.after) : undefined;
        if (opened.moved) mark = 'moved';
        else if (afterAt !== undefined && afterAt > i) mark = 'out-of-order';
        views.set(l.id, { text: opened.text, format: opened.format, after: opened.after, mark });
    });
    return views;
}

/**
 * A thread in the order both apps show and judge it: by the time the node gives each line, then the order it gave them
 * in. Never by row order alone: a standby's delta copy writes rows in last-changed order (a question that got a reaction
 * after its answer lands after the answer), so row order isn't the order lines were written in.
 */
export function dmThreadInShownOrder<T extends { timestamp?: string | null }>(lines: readonly T[]): T[] {
    const at = (t: string | null | undefined) => {
        const ms = typeof t === 'string' ? Date.parse(t) : NaN;
        return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
    };
    return lines
        .map((l, i) => ({ l, i, t: at(l.timestamp) }))
        .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
        .map((x) => x.l);
}

/** The id of the newest line a new one is written after: the last encrypted line the node has confirmed. */
export function dmAfterReference(linesOldestFirst: ReadonlyArray<{ id: string; nonce?: string | null; pending?: boolean }>): string | null {
    for (let i = linesOldestFirst.length - 1; i >= 0; i--) {
        const l = linesOldestFirst[i];
        if (!l.pending && isDmEncryptedNonce(l.nonce)) return l.id;
    }
    return null;
}

/** What both apps show in place of a line that didn't open, or opened but wasn't signed by its named sender. */
export const DM_LINE_NOT_VERIFIED_TEXT = "🔒 This message couldn't be verified, so it isn't shown.";
/** What both apps show in place of a row in a member's name that isn't an encrypted line. */
export const DM_LINE_NOT_ENCRYPTED_TEXT = "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.";
/** What both apps show for a deleted line in a DM, whatever words the node's tombstone carries. */
export const DM_LINE_DELETED_TEXT = 'This message was deleted';

/** The words to show for a line: its own, or the text that stands in for words there are none of. */
export function dmLineShownText(view: DmLineView | undefined | null): string {
    if (view?.text != null) return view.text;
    return view?.mark === 'not-encrypted' ? DM_LINE_NOT_ENCRYPTED_TEXT : DM_LINE_NOT_VERIFIED_TEXT;
}

/**
 * True when a line is shown as nobody's: a neutral line in the middle of the chat, not in its named author's bubble. A
 * line that didn't open or wasn't signed by its named sender, one that isn't encrypted, and the admin page's message.
 */
export function dmLineIsUnattributed(view: DmLineView | undefined | null): boolean {
    return view?.mark === 'not-verified' || view?.mark === 'not-encrypted' || view?.mark === 'from-admins';
}

/**
 * Who a quoted line (the message a reply answers) is shown as from. A quote follows the quoted line's own check, never its
 * row's raw words and named author: the node can rewrite the row a verified reply answers while keeping its id.
 *   'author':  a line whose words opened (or a tombstone): its named author, with its mark (dmLineMarkText) if it has one;
 *   'admins':  the admin page's message: from the community's admins;
 *   'notice':  the node's own notice: a notice, never either person;
 *   'nobody':  a line that didn't open or wasn't encrypted, or one that isn't there: nobody's, with dmLineShownText.
 */
export type DmQuoteFrom = 'author' | 'admins' | 'notice' | 'nobody';

export function dmQuoteFrom(row: DmRowShape | null | undefined, view: DmLineView | null | undefined): DmQuoteFrom {
    if (!row) return 'nobody';
    if (dmLineKind(row) === 'node-notice') return 'notice';
    if (view?.mark === 'from-admins') return 'admins';
    if (dmLineIsUnattributed(view)) return 'nobody';
    return 'author';
}

/** The name a quote shows for a line that isn't quoted as its named author's (dmQuoteFrom), in both apps' words. */
export function dmQuoteLabel(from: Exclude<DmQuoteFrom, 'author'>): string {
    switch (from) {
        case 'admins': return "Your community's admins";
        case 'notice': return 'Notice';
        default: return 'Not confirmed';
    }
}

/** The one line under a marked message, in both apps' words. */
export function dmLineMarkText(mark: DmLineMark | undefined): string | null {
    switch (mark) {
        case 'out-of-order': return 'Shown out of the order it was written in.';
        case 'moved': return 'Moved here from another conversation.';
        case 'from-admins': return "From your community's admins. Not a private message: the community's server can read it.";
        default: return null;
    }
}

// ─── Old chat, read-only ─────────────────────────────────────────────────────────────────────────────────────────────
// conversion code, log row OLDCHAT, remove in 1.5.0
//
// Marty, 12 Nov 2026, after the 1.4.0 live run: bring back members' chat from before 1.4.0, the same on the phone and the
// web, read-only. Nothing was deleted at the cutover: every line is still on every node, in the formats 1.2.x and 1.3.x
// apps wrote, which 1.4.0 doesn't open (format 4 only), so each reads as DM_LINE_NOT_VERIFIED_TEXT. The key and the
// cipher never changed, so each still opens as it did then: format 3 (the associated data 'beanpool-dm-line/3' names the
// conversation, the sender, the message id, the part and a reply's answered id; the sealed bytes are framed [3][length of
// after][after][words]), else format 2 (the associated data is the conversation id alone; the sealed bytes are the words).
//
// A line is old only if it is NOT in format 4's form AND the node's time for it is before DM_OLD_LINE_CUTOFF, the 1.4.0
// deploy. Anything else without a valid signature stays hidden exactly as before: a format-4 line that doesn't verify,
// whatever time it carries, and an old-format line from after the cutover (a 1.4.0 node refuses one: engine/messaging.ts).
// The node chooses the time, so it can always make an old line new (it is hidden then, as the node could already withhold
// it); it cannot make a new line old: a forged line in format 4's form is never old, and an old-format line the node can't
// write (it holds no key) and the apps no longer send. Only the other person, who shares the key, could seal one in format
// 3 naming you, and only a node that took it in for them could store it: format 3's own hole (no signature), the reason
// format 4 came, which the label says. One check catches a careless one: a line whose sealed "after" names a line newer
// than the cutover was written after it, so it is hidden as a forgery.
//
// Shown: a sealed line that opens, in its named author's bubble (with the mark a moved or reordered line had before), under
// DM_OLD_LINES_LABEL once above its run (dmOldLineRunStarts); neither app answers, quotes, edits or reacts to one
// (dmLineIsOld). A photo stays locked.
//
// NOT shown: a readable row (plaintext-v1, 00000) stays the hidden line it is today, whatever its time. The node holds no
// key, but it can write a readable row in anyone's name dated whenever it likes, so nothing can show one is old: shown, a
// row written today and dated last month would pass as an old line, which the rule above refuses (and the apps' tests pin
// that such a row never shows its words: MessagesPage.dm-lines.test.tsx, "a row in Ben's name that isn't an encrypted line").

/** The 1.4.0 deploy: a line the node dates before this, not in format 4's form, is from before every message was signed. */
export const DM_OLD_LINE_CUTOFF = '2026-11-11T19:16:00.000Z';
const DM_OLD_LINE_CUTOFF_MS = Date.UTC(2026, 10, 11, 19, 16, 0, 0);

/** The one label above a run of old lines, in both apps (t() it where it is shown). */
export const DM_OLD_LINES_LABEL = word('Older messages from before 12 November 2026. They were sent before BeanPool signed every message.');

/** The first word of format 3's associated data, as 1.2.x and 1.3.x apps sealed it. */
const DM_OLD_FORMAT3_AAD_TAG = 'beanpool-dm-line/3';

/**
 * A time as the node stores one (strftime('%Y-%m-%dT%H:%M:%fZ') or Date.toISOString(); a first-release row may carry
 * SQLite's 'YYYY-MM-DD HH:MM:SS', which is UTC), parsed the same way on every engine: Date.parse differs between them on the
 * space form, and the two apps must agree which lines are old.
 */
const DM_OLD_STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

function stampMs(timestamp: unknown): number | null {
    if (typeof timestamp !== 'string') return null;
    const m = DM_OLD_STAMP.exec(timestamp);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const ms = Date.UTC(y, mo - 1, d, h, mi, s, m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0);
    const dt = new Date(ms);
    // A field out of range (month 13, 31 February) rolls over in Date.UTC: not a time the node wrote.
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
    const zone = m[8];
    if (!zone || zone === 'Z') return ms;
    const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
    return zone[0] === '-' ? ms + offset : ms - offset;
}

/** True when the node dates a line before DM_OLD_LINE_CUTOFF. A missing or unreadable time is never old. */
export function dmLineSentBeforeCutover(timestamp: unknown): boolean {
    const ms = stampMs(timestamp);
    return ms !== null && ms < DM_OLD_LINE_CUTOFF_MS;
}

/** A line in the shape only an old line has: not in format 4's form, dated before the cutover. Says nothing about who wrote it. */
export function dmLineHasOldShape(l: { ciphertext?: unknown; nonce?: unknown; timestamp?: string | null } | null | undefined): boolean {
    return !!l && !isDmLineForm(l.ciphertext, l.nonce) && dmLineSentBeforeCutover(l.timestamp);
}

/** True for a line shown old: read-only, under DM_OLD_LINES_LABEL; never answered, quoted, edited or reacted to. */
export function dmLineIsOld(view: DmLineView | undefined | null): boolean {
    return view?.old === true;
}

/**
 * Where DM_OLD_LINES_LABEL goes: once above each run of old lines, in the order a thread is shown (oldest first). `old`
 * says of each line whether it is old (dmLineIsOld), or null for a line a run passes over (the node's own notice, a day's
 * label): such a line neither starts a run nor ends one. Returns, line by line, whether the label goes above it.
 */
export function dmOldLineRunStarts(old: ReadonlyArray<boolean | null>): boolean[] {
    let inRun = false;
    return old.map((o) => {
        if (o === null) return false;
        const starts = o && !inRun;
        inRun = o;
        return starts;
    });
}

/** An old line's words, opened. */
export interface OpenedDmOldLine {
    text: string;
    format: 2 | 3;
    /** Format 3: the newest line the sender had from the node when they wrote it; null if none, or format 2. */
    after: string | null;
    conversationId: string;
    moved: boolean;
}

function openOldWith(payload: DmPayload, keys: DmKeys, line: DmLineRef, myPubHex: string, cache?: KeyCache): OpenedDmOldLine {
    // Only the two of them share this key; a line the node names as anyone else's is no line of theirs.
    if (line.senderPubHex !== myPubHex && line.senderPubHex !== keys.peerEdPubHex) throw new DmLineNotVerifiedError();
    const nonce = nonceBytes(payload.nonce);
    // Read as 1.2.x and 1.3.x read it (the cipher's tag is the check, not the spelling).
    const sealed = unb64(payload.ciphertext);
    const ids = dmConversationIdsToTry(line.conversationId, line.metadata);
    const replyToId = dmReplyToOf(line.metadata);
    const part = line.part ?? 'body';
    for (const format of [3, 2] as const) {
        // A reply id no app writes: no format-3 line was sealed to it. Format 2 sealed words and photos, never a listing.
        if (format === 3 && replyToId === undefined) continue;
        if (format === 2 && part === 'about') continue;
        for (const conversationId of ids) {
            let key: Uint8Array;
            try { key = keyFor(keys, conversationId, cache); } catch { throw new DmLineNotVerifiedError(); }
            const aad = format === 3
                ? utf8ToBytes(JSON.stringify([DM_OLD_FORMAT3_AAD_TAG, conversationId, line.senderPubHex, line.messageId, part, ...(replyToId ? [replyToId] : [])]))
                : utf8ToBytes(conversationId);
            let pt: Uint8Array;
            try { pt = xchacha20poly1305(key, nonce, aad).decrypt(sealed); } catch { continue; }
            const moved = conversationId !== line.conversationId;
            if (format === 2) return { text: utf8(pt), format, after: null, conversationId, moved };
            if (pt.length < 2 || pt[0] !== 3 || pt.length < 2 + pt[1]) throw new DmLineNotVerifiedError();
            const len = pt[1];
            return { text: utf8(pt.subarray(2 + len)), format, after: len ? utf8(pt.subarray(2, 2 + len)) : null, conversationId, moved };
        }
    }
    throw new DmLineNotVerifiedError();
}

/**
 * Open one part of a line from before 1.4.0 as it opened then: format 3 under each conversation id it may have been written
 * under, then format 2. Only a line with the old shape (dmLineHasOldShape; `timestamp` is the node's time for the line):
 * throws DmLineNotVerifiedError for anything else, and when none opens. No signature is checked: these lines had none.
 */
export function openDmOldLine(payload: DmPayload, keys: DmKeys, line: DmLineRef & { timestamp: string | null | undefined }): OpenedDmOldLine {
    if (!dmLineHasOldShape({ ...payload, timestamp: line.timestamp })) throw new DmLineNotVerifiedError();
    return openOldWith(payload, keys, line, dmPublicKeyOf(keys.myEdPrivHex));
}

/** checkDmThread's old reader: the pinned key, then each former one, as the format-4 reader tries them (keys cached per key). */
function openOldLineOfThread(
    l: DmThreadLine, keys: DmKeys, conversationId: string, myPubHex: string, former: readonly string[], caches: Map<string, KeyCache>,
): OpenedDmOldLine | null {
    if (!dmLineHasOldShape(l)) return null;
    const payload = { ciphertext: l.ciphertext, nonce: l.nonce as string };
    const cacheOf = (peer: string) => {
        let c = caches.get(peer);
        if (!c) caches.set(peer, c = new Map());
        return c;
    };
    try {
        return openOldWith(payload, keys, { conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }, myPubHex, cacheOf(keys.peerEdPubHex));
    } catch { /* a former key */ }
    const mine = l.authorPubkey === myPubHex;
    for (const peer of former) {
        if (!mine && l.authorPubkey !== keys.peerEdPubHex && l.authorPubkey !== peer) continue;
        try {
            return openOldWith(payload, { myEdPrivHex: keys.myEdPrivHex, peerEdPubHex: peer },
                { conversationId, senderPubHex: mine ? myPubHex : peer, messageId: l.id, part: 'body', metadata: l.metadata }, myPubHex, cacheOf(peer));
        } catch { /* the next former key */ }
    }
    return null;
}
// ─── end of old chat (OLDCHAT) ───────────────────────────────────────────────────────────────────────────────────────
