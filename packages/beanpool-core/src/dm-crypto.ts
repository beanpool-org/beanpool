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
 *   Wire:   nonce column 'x25519-xc20p-v2:' + base64(nonce), ciphertext base64(AEAD output). Kept exactly as it was: a
 *           node of any version stores a new line (it refuses every other form as unencrypted, engine/messaging.ts), and
 *           an app from before this change shows one as a message it can't decrypt, never as a run of base64.
 *
 * What a line is bound to (crypto review M F2, 2026-10-02):
 *   Format 2, every line written before this change: the associated data is the conversation id alone. With one key both
 *     ways, the node could show A's line as B's, store it again as a new message, or move it, and every one opened.
 *     Still read, and every one is marked (checkDmThread): nothing in it proves who wrote it.
 *   Format 3: the associated data names the conversation, the SENDER's key, the message id, which part of the message
 *     it is (the words or the photo) and, for a reply, the id of the message it answers. Shown as someone else's, under
 *     another id, in another conversation, as an answer to another message, or a caption in a photo's place, it doesn't
 *     open. The sealed bytes start with a header: the format byte, then the id of the newest line the sender had from
 *     the node when they wrote it ("after"). A line shown before the line it was written after has been moved, and
 *     checkDmThread marks it.
 *
 * A DM row that isn't an encrypted line (readable `plaintext-v1`, `00000`, any other nonce) is never shown as anyone's
 * words: the node could have written it (dmLineKind). Only three kinds are the node's own by design, and each is shown
 * as the node's, never as a member's: its notices (author SYSTEM or type system), a tombstone (fixed text in the apps,
 * never the row's words), and the message the admin page sends (metadata DM_FROM_ADMINS_KEY), shown marked as from the
 * community's admins and readable by the server.
 *
 * Which format a line is in is found by opening it, format 3 first: the associated data differs, so a line opens under
 * exactly one of them, and the node can't turn one into the other. Nothing on the wire says which, so nothing the node
 * controls decides it.
 *
 * Not covered, by design: the two people share one secret, so either of them could seal a line naming the other as
 * sender (only a signature per line would prove authorship between the two; the node alone can do none of this). The
 * node can still withhold or delay a line, put an edit's earlier words back (an edit keeps its line's id, and both
 * versions are the sender's own), and show an old format-2 line (marked as such).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { toEd25519Seed } from './ed25519-key.js';

/** The nonce column's prefix for every encrypted line, format 2 and 3 alike. */
export const DM_NONCE_PREFIX = 'x25519-xc20p-v2:';
/** The line format this code writes. */
export const DM_LINE_FORMAT = 3;
/** First word of format 3's associated data: the format's own name, so no other use of the key can be taken for it. */
export const DM_LINE_AAD_TAG = 'beanpool-dm-line/3';

const HKDF_INFO = utf8ToBytes('beanpool-dm-v2');
const NONCE_LEN = 24;
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

/** The words of a message, or its photo. */
export type DmPart = 'body' | 'attachment';

/** What a format-3 line is bound to besides its conversation. */
export interface DmLineBinding {
    /** The sender's public key, hex, exactly as the node stores it as the line's author. */
    senderPubHex: string;
    /** The message id, exactly as the node stores it: the client's own UUID v4, lower case (the node lowers it). */
    messageId: string;
    /** The words (default) or the photo. */
    part?: DmPart;
}

/** A line as it goes to the node. */
export interface DmPayload {
    ciphertext: string;
    nonce: string;
}

/** A line that opened. */
export interface OpenedDmLine {
    text: string;
    format: 2 | 3;
    /** Format 3: the newest line the sender had from the node when they wrote this one; null if none, or format 2. */
    after: string | null;
    /** The conversation id it opened under. */
    conversationId: string;
    /** It opened only under an older conversation id named in its metadata, not the one it is stored in. */
    moved: boolean;
}

/** Thrown when a line doesn't open: it was changed, or moved, or isn't the sender's or this pair's. */
export class DmLineNotVerifiedError extends Error {
    constructor(message = "This message couldn't be verified.") {
        super(message);
        this.name = 'DmLineNotVerifiedError';
    }
}

/** True if a stored nonce is an encrypted line's (format 2 or 3; they share the wire form). */
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

/** The conversation's key. The same for format 2 and 3, and for both people. */
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
 * Format 3's associated data: the UTF-8 of a JSON array of strings, [tag, conversation, sender, message id, part], and for
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
 * The message a line answers, as its metadata names it (`replyToId`, which the node stores and can read): bound into a
 * format-3 line, so the node can't point an answer at another message. undefined when the metadata names one that no
 * app writes (not a non-empty string): no format-3 line opens then.
 */
export function dmReplyToOf(metadata: unknown): string | null | undefined {
    const meta = parsedMetadata(metadata);
    if (!meta || typeof meta !== 'object' || meta.replyToId === undefined || meta.replyToId === null) return null;
    return typeof meta.replyToId === 'string' && meta.replyToId ? meta.replyToId : undefined;
}

/** Format 3's sealed bytes: [3][length of after][after, UTF-8][the words, UTF-8]. */
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

/**
 * Seal a line (its words, or its photo as a data URI) in format 3. `after` is the id of the newest line this person had
 * from the node when they wrote it (an edit keeps its line's own). Refuses to seal a line naming anyone but me as
 * sender, or an id the node would store differently.
 */
export function sealDmLine(
    text: string,
    ctx: DmKeyContext,
    line: DmLineBinding & { after?: string | null; replyToId?: string | null },
    nonceForVectors?: Uint8Array,
): DmPayload {
    if (!UUID_V4.test(line.messageId)) throw new Error('A line is sealed under its own lower-case UUID v4.');
    if (line.senderPubHex !== dmPublicKeyOf(ctx.myEdPrivHex)) throw new Error('A line is sealed only as its sender.');
    if (line.replyToId !== undefined && line.replyToId !== null && (typeof line.replyToId !== 'string' || !line.replyToId)) {
        throw new Error('A reply is sealed to the id of the message it answers.');
    }
    const key = deriveDmKey(ctx);
    const nonce = nonceForVectors ?? randomBytes(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) throw new Error('A line nonce is 24 bytes.');
    const ct = xchacha20poly1305(key, nonce, dmLineAad(ctx.conversationId, line, line.replyToId)).encrypt(frame(text, line.after));
    return { ciphertext: b64(ct), nonce: DM_NONCE_PREFIX + b64(nonce) };
}

/**
 * Format 2, as every line before this change was written. The apps never send it: it is here to write the history the
 * tests read, and the vectors.
 */
export function encryptDmFormat2(text: string, ctx: DmKeyContext, nonceForVectors?: Uint8Array): DmPayload {
    const key = deriveDmKey(ctx);
    const nonce = nonceForVectors ?? randomBytes(NONCE_LEN);
    const ct = xchacha20poly1305(key, nonce, utf8ToBytes(ctx.conversationId)).encrypt(utf8ToBytes(text));
    return { ciphertext: b64(ct), nonce: DM_NONCE_PREFIX + b64(nonce) };
}

function nonceBytes(nonce: string): Uint8Array {
    if (!isDmEncryptedNonce(nonce)) throw new DmLineNotVerifiedError('Not an encrypted line.');
    const nb = unb64(nonce.slice(DM_NONCE_PREFIX.length));
    if (nb.length !== NONCE_LEN) throw new DmLineNotVerifiedError();
    return nb;
}

/** Open a format-2 line under one conversation id. Throws if it isn't one, or the tag fails. */
export function decryptDmFormat2(ciphertext: string, nonce: string, ctx: DmKeyContext): string {
    const pt = xchacha20poly1305(deriveDmKey(ctx), nonceBytes(nonce), utf8ToBytes(ctx.conversationId)).decrypt(unb64(ciphertext));
    return utf8(pt);
}

/**
 * The conversation ids a line may have been written under: the one it is stored in, then any older one its metadata
 * names (a line the node moved when two threads were folded into one, or out of a conversation kept while blocked).
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
    return [...new Set(ids)];
}

/** One line to open: where the node shows it, and what it says the line is. */
export interface DmLineRef extends DmLineBinding {
    /** The conversation the line is stored in. */
    conversationId: string;
    /**
     * Its metadata as stored (a JSON string or the parsed object): older conversation ids are read from it, and the
     * message a reply answers (`replyToId`), which a format-3 line is bound to.
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

function openWith(
    payload: DmPayload,
    keys: DmKeys,
    line: DmLineRef,
    formats: ReadonlyArray<2 | 3>,
    myPubHex: string,
    cache?: KeyCache,
): OpenedDmLine {
    // Only the two of them share this key; a line the node names as anyone else's is no line of theirs.
    if (line.senderPubHex !== myPubHex && line.senderPubHex !== keys.peerEdPubHex) throw new DmLineNotVerifiedError();
    const nonce = nonceBytes(payload.nonce);
    const ct = unb64(payload.ciphertext);
    const ids = dmConversationIdsToTry(line.conversationId, line.metadata);
    const replyToId = dmReplyToOf(line.metadata);
    for (const format of formats) {
        // A reply id no app writes: no format-3 line was sealed to it.
        if (format === 3 && replyToId === undefined) continue;
        for (const conversationId of ids) {
            let key: Uint8Array;
            try { key = keyFor(keys, conversationId, cache); } catch { throw new DmLineNotVerifiedError(); }
            const aad = format === 3 ? dmLineAad(conversationId, line, replyToId) : utf8ToBytes(conversationId);
            let pt: Uint8Array;
            try { pt = xchacha20poly1305(key, nonce, aad).decrypt(ct); } catch { continue; }
            const moved = conversationId !== line.conversationId;
            if (format === 2) return { text: utf8(pt), format, after: null, conversationId, moved };
            return { ...unframe(pt), format, conversationId, moved };
        }
    }
    throw new DmLineNotVerifiedError();
}

/**
 * Open one line: format 3 under each conversation id it may have been written under, then format 2. Throws
 * DmLineNotVerifiedError when none opens. `formats` narrows it: a photo opens only in its message's own format.
 */
export function openDmLine(payload: DmPayload, keys: DmKeys, line: DmLineRef, formats: ReadonlyArray<2 | 3> = [3, 2]): OpenedDmLine {
    return openWith(payload, keys, line, formats, dmPublicKeyOf(keys.myEdPrivHex));
}

/**
 * The metadata key the node's admin page sets on the message it sends (state-engine.ts adminSendMessage): readable words
 * the node stores in the admin's name, by design. The node controls metadata, so the key proves nothing about who wrote
 * the words: such a line is shown as the community admins' message, which the server can read, never as a private one.
 */
export const DM_FROM_ADMINS_KEY = 'fromCommunityAdmins';

/** What a DM row is, before anything is opened. */
export type DmLineKind =
    /** An encrypted line (format 2 or 3): opened, and checked against the thread. */
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
    /** Format 2: nothing in it proves who wrote it, wherever it sits in the thread. */
    | 'old-app'
    /** Format 3, shown before the line it was written after. */
    | 'out-of-order'
    /** Format 3, opened only under an older conversation id its metadata names. */
    | 'moved'
    /** An encrypted line that didn't open: shown as DM_LINE_NOT_VERIFIED_TEXT, as nobody's words. */
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
    format: 2 | 3 | null;
    after: string | null;
    mark: DmLineMark;
}

function decodeReadable(ciphertext: string): string | null {
    try {
        const text = Buffer.from(ciphertext, 'base64').toString('utf8');
        return text.includes('\uFFFD') ? null : text;
    } catch {
        return null;
    }
}

/**
 * Check every line of one DM thread. `lines` is the thread in the order it is shown, oldest first (dmThreadInShownOrder):
 * the node's own notices are passed over; every other line gets a view, by id. An encrypted line is opened bound to its
 * named sender and id, and its "after" is checked against the lines shown before it. The key is derived once per
 * conversation id. `keys` null (the other person isn't known yet): no encrypted line opens.
 */
export function checkDmThread(lines: readonly DmThreadLine[], keys: DmKeys | null, conversationId: string): Map<string, DmLineView> {
    const views = new Map<string, DmLineView>();
    let myPubHex = '';
    if (keys) {
        try { myPubHex = dmPublicKeyOf(keys.myEdPrivHex); } catch { myPubHex = ''; }
    }
    const cache: KeyCache = new Map();
    const position = new Map<string, number>();
    lines.forEach((l, i) => { if (!position.has(l.id)) position.set(l.id, i); });

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
                    { conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }, [3, 2], myPubHex, cache);
            } catch { opened = null; }
        }
        if (!opened) {
            views.set(l.id, { text: null, format: null, after: null, mark: 'not-verified' });
            return;
        }
        let mark: DmLineMark = null;
        if (opened.format === 3) {
            const afterAt = opened.after ? position.get(opened.after) : undefined;
            if (opened.moved) mark = 'moved';
            else if (afterAt !== undefined && afterAt > i) mark = 'out-of-order';
        } else {
            mark = 'old-app';
        }
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

/** What both apps show in place of a line that didn't open. */
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
 * line that didn't open, one that isn't encrypted, and the admin page's message.
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
        case 'old-app': return "Sent from an older version of the app: BeanPool can't confirm who wrote it.";
        case 'out-of-order': return 'Shown out of the order it was written in.';
        case 'moved': return 'Moved here from another conversation.';
        case 'from-admins': return "From your community's admins. Not a private message: the community's server can read it.";
        default: return null;
    }
}
