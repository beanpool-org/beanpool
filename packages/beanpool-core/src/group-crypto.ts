/**
 * Group chats, end to end: the locks both apps and the node share (design: scratch/global-node/
 * DESIGN-group-chat-encryption-fable.md §2, §7; Marty's picks of 10 Oct 2026). Nothing here is switched on yet: no route,
 * no app calls it. Slice 2 gives the node its tables and checks, slices 3 and 4 the apps.
 *
 * Keys. Each group has a chain of epochs 1, 2, 3 … and each epoch a random 32-byte key made on a member's device. The
 * member whose action changed the membership makes the next one and locks ("wraps") it to every active member: an
 * ephemeral X25519 key agreed with the member's identity-derived X25519 key (dm-crypto.ts identityX25519Secret /
 * identityX25519Public, the one derivation direct messages use), HKDF-SHA256 salted with the ephemeral public key, info
 * 'beanpool-group-key/1', and XChaCha20-Poly1305 bound to [tag, group, epoch, recipient, wrapper]. A wrap moved to another
 * group, epoch or member, or claimed by another wrapper, doesn't open. The node stores the wraps and can open none.
 *
 * The epoch record. Who made the epoch, why, whose membership changed, when, and every wrap, signed by the maker with
 * their Ed25519 identity over a canonical JSON array (groupEpochCanonical). A changed recipient list fails the signature;
 * a maker who could not have made the epoch (§2.3: not a member after the change, a joiner other than the one who
 * joined, a removed member) fails verifyGroupEpochRecord even with a good signature.
 *
 * Lines. Each message has its own key, mk = HKDF-SHA256(epoch key, salt = message id, info 'beanpool-group-line/1'), so a
 * member reporting one line can hand a moderator that line's key and nothing else (§7.1, §13). A line is
 * XChaCha20-Poly1305 under mk, bound to [tag, group, epoch, sender, message id, part, reply-to?], and sealed inside it is
 * the sender's Ed25519 signature over the associated data, the nonce and the rest of the frame (Marty's pick 7: a member
 * cannot be framed). Every member holds the epoch key, so any of them could seal a line naming someone else as its
 * sender: the AEAD opens, the signature doesn't verify, and openGroupLine refuses it.
 *
 * The signatures sign a SHA-256 digest whose input starts with this format's own tag. Nothing else the identity key signs
 * in core is a bare 32-byte value someone else chose (request signing prefixes 0xff to the request text; names lists,
 * owner unlock, sealed envelopes and vault answers sign their own framed bytes), so no other signature stands in for one.
 *
 * Wire: the nonce column is 'group-xc20p-v1:' + base64(nonce), deliberately NOT the DM's 'x25519-xc20p-v2:': both apps'
 * DM guards treat a conversation holding a line with the DM prefix as a DM for ever.
 *
 * Identity keys arrive as hex in either spelling (web app PKCS8, phone bare seed) and are normalised once, by
 * toEd25519Seed, at each entry point.
 *
 * Not covered, by design (§8): the node decides membership, so it could add a member of its own and the next epoch would
 * be wrapped to them (members see the join line). A maker could wrap different keys to different members; lines then
 * fail to open for some, which shows, but isn't prevented here.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, randomBytes as cryptoRandomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { toEd25519Seed } from './ed25519-key.js';
import { dmPublicKeyOf, identityX25519Public, identityX25519Secret } from './dm-crypto.js';

/** The nonce column's prefix for every encrypted group line. Not the DM's (see the header). */
export const GROUP_NONCE_PREFIX = 'group-xc20p-v1:';
/** Wrap: HKDF info and the first word of its associated data. */
export const GROUP_KEY_WRAP_TAG = 'beanpool-group-key/1';
/** Epoch record: the first word of its canonical form. */
export const GROUP_EPOCH_TAG = 'beanpool-group-epoch/1';
/** Top-up wrap (§2.5): the first word of its canonical form. */
export const GROUP_TOP_UP_TAG = 'beanpool-group-wrap/1';
/** Line: the per-message key's HKDF info and the first word of the line's associated data. */
export const GROUP_LINE_TAG = 'beanpool-group-line/1';
/** The first byte of a sealed line's frame. */
export const GROUP_LINE_FORMAT = 1;

const KEY_LEN = 32;
const NONCE_LEN = 24;
const TAG_LEN = 16;
const SIG_LEN = 64;
const MAX_AFTER_BYTES = 255;
/** The smallest sealed line: format byte, signature, the after length, no after, no words, the AEAD tag. */
const MIN_LINE_CIPHERTEXT = 1 + SIG_LEN + 1 + TAG_LEN;
const PUBKEY_HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Why an epoch was made (§2.1). */
export type GroupEpochReason = 'start' | 'join' | 'approve' | 'invite' | 'remove' | 'leave' | 'rekey' | 'rotate';
export const GROUP_EPOCH_REASONS: readonly GroupEpochReason[] = ['start', 'join', 'approve', 'invite', 'remove', 'leave', 'rekey', 'rotate'];

/** The words of a message, its photo, or an edit of its words (§7.2). */
export type GroupLinePart = 'body' | 'attachment' | 'edit';
const GROUP_LINE_PARTS: readonly GroupLinePart[] = ['body', 'attachment', 'edit'];

/**
 * Where randomness comes from. The platform CSPRNG unless a test or the vectors hand in a fixed one: the apps and the node
 * never pass this.
 */
export interface GroupCryptoRandom {
    randomBytes?: (n: number) => Uint8Array;
}

/** One epoch key locked to one member (§2.2). Field names as the routes use them (Appendix A). */
export interface GroupKeyWrap {
    /** The member it is locked to: their Ed25519 public key, lower-case hex. */
    recipient: string;
    /** The wrapper's one-time X25519 public key, base64 (32 bytes). */
    ephPub: string;
    /** base64 (24 bytes). */
    nonce: string;
    /** The epoch key under XChaCha20-Poly1305, base64 (32 + 16 bytes). */
    wrapped: string;
}

/** An epoch record, signed by its maker (§2.1, §7.3). */
export interface GroupEpochRecord {
    groupId: string;
    epoch: number;
    reason: GroupEpochReason;
    /** Whose membership changed; null for 'start' and 'rotate'. Lower-case hex. */
    subject: string | null;
    /** The maker: lower-case hex. Always one of the recipients (a member after the change). */
    createdBy: string;
    /** When the maker made it, ISO 8601, as signed. */
    createdAt: string;
    wraps: GroupKeyWrap[];
    /** The maker's Ed25519 signature over sha256(groupEpochCanonical(record)), base64 (64 bytes). */
    sig: string;
}

/** A wrap one member hands another who lacks one (§2.5), signed by the wrapper. */
export interface GroupTopUp extends GroupKeyWrap {
    epoch: number;
    /** The member who made it: lower-case hex. */
    wrapper: string;
    /** The wrapper's Ed25519 signature over sha256(groupTopUpCanonical(groupId, topUp)), base64. */
    sig: string;
}

/** A line as it goes to the node. */
export interface GroupLinePayload {
    ciphertext: string;
    nonce: string;
}

/** What a line is bound to: where it is, which key, who wrote it, which message and part, what it answers. */
export interface GroupLineBinding {
    groupId: string;
    epoch: number;
    /** The sender's Ed25519 public key, lower-case hex, exactly as the node stores it as the line's author. */
    senderPubHex: string;
    /** The message id as the node stores it. */
    messageId: string;
    /** Default 'body'. */
    part?: GroupLinePart;
    /** For a reply: the id of the message it answers (metadata.replyToId). */
    replyToId?: string | null;
}

/** A line that opened, signature verified. */
export interface OpenedGroupLine {
    text: string;
    /** The newest line the sender had from the node when they wrote this one; null if none. */
    after: string | null;
}

/** Thrown when an epoch record, a wrap or a top-up doesn't verify or open. */
export class GroupKeyNotVerifiedError extends Error {
    constructor(message = "This group's key couldn't be verified.") {
        super(message);
        this.name = 'GroupKeyNotVerifiedError';
    }
}

/** Thrown when a line doesn't open or its signature doesn't verify. */
export class GroupLineNotVerifiedError extends Error {
    constructor(message = "This message couldn't be verified.") {
        super(message);
        this.name = 'GroupLineNotVerifiedError';
    }
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

/** base64 of exactly `len` bytes, in its one canonical spelling, or null. */
function strictB64(s: unknown, len: number): Uint8Array | null {
    if (typeof s !== 'string') return null;
    const bytes = new Uint8Array(Buffer.from(s, 'base64'));
    if (bytes.length !== len || b64(bytes) !== s) return null;
    return bytes;
}

function utf8(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('utf8');
}

function rngOf(opts?: GroupCryptoRandom): (n: number) => Uint8Array {
    return opts?.randomBytes ?? cryptoRandomBytes;
}

function isPubHex(s: unknown): s is string {
    return typeof s === 'string' && PUBKEY_HEX.test(s);
}

function isEpoch(n: unknown): n is number {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
}

function isGroupId(s: unknown): s is string {
    return typeof s === 'string' && s.length > 0;
}

/** My seed and public key from my private key in either spelling. */
function me(myEdPrivHex: string): { seed: Uint8Array; pubHex: string } {
    return { seed: toEd25519Seed(hexToBytes(myEdPrivHex)), pubHex: dmPublicKeyOf(myEdPrivHex) };
}

function verifySig(sig: Uint8Array, digest: Uint8Array, pubHex: string): boolean {
    try {
        return ed25519.verify(sig, digest, hexToBytes(pubHex), { zip215: false });
    } catch {
        return false;
    }
}

// ─── Wraps (§2.2) ───────────────────────────────────────────────────────────────────────────

/** Where a wrap belongs: what its associated data names. */
export interface GroupWrapBinding {
    groupId: string;
    epoch: number;
    recipientPubHex: string;
    wrapperPubHex: string;
}

/** A wrap's associated data: the UTF-8 of [tag, group, epoch, recipient, wrapper] as a JSON array of strings. */
export function groupKeyWrapAad(b: GroupWrapBinding): Uint8Array {
    return utf8ToBytes(JSON.stringify([GROUP_KEY_WRAP_TAG, b.groupId, String(b.epoch), b.recipientPubHex, b.wrapperPubHex]));
}

function checkWrapBinding(b: GroupWrapBinding): void {
    if (!isGroupId(b.groupId) || !isEpoch(b.epoch) || !isPubHex(b.recipientPubHex) || !isPubHex(b.wrapperPubHex)) {
        throw new Error('A group key is wrapped to one group, one epoch, one recipient and one wrapper, each named exactly.');
    }
}

/**
 * Lock an epoch key to one member. RNG order (pinned by the vectors): the ephemeral secret (32), then the nonce (24).
 */
export function wrapGroupKey(groupKey: Uint8Array, b: GroupWrapBinding, opts?: GroupCryptoRandom): GroupKeyWrap {
    if (!(groupKey instanceof Uint8Array) || groupKey.length !== KEY_LEN) throw new Error('A group key is 32 bytes.');
    checkWrapBinding(b);
    const rng = rngOf(opts);
    const recipientX = identityX25519Public(b.recipientPubHex);
    const eph = rng(KEY_LEN);
    const ephPub = x25519.getPublicKey(eph);
    const k = hkdf(sha256, x25519.getSharedSecret(eph, recipientX), ephPub, utf8ToBytes(GROUP_KEY_WRAP_TAG), KEY_LEN);
    const nonce = rng(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) throw new Error('A wrap nonce is 24 bytes.');
    const wrapped = xchacha20poly1305(k, nonce, groupKeyWrapAad(b)).encrypt(groupKey);
    return { recipient: b.recipientPubHex, ephPub: b64(ephPub), nonce: b64(nonce), wrapped: b64(wrapped) };
}

/**
 * Open a wrap locked to me: the epoch key, 32 bytes. Throws GroupKeyNotVerifiedError if it isn't mine, or was made for
 * another group, epoch or wrapper, or was changed. The caller keeps the key in memory only (§4).
 */
export function openGroupKeyWrap(
    wrap: GroupKeyWrap,
    b: Omit<GroupWrapBinding, 'recipientPubHex'>,
    myEdPrivHex: string,
): Uint8Array {
    let mine: { seed: Uint8Array; pubHex: string };
    try { mine = me(myEdPrivHex); } catch { throw new GroupKeyNotVerifiedError('Not a private key this app can use.'); }
    if (!wrap || wrap.recipient !== mine.pubHex) throw new GroupKeyNotVerifiedError('This key is locked to another member.');
    const binding: GroupWrapBinding = { ...b, recipientPubHex: mine.pubHex };
    try { checkWrapBinding(binding); } catch { throw new GroupKeyNotVerifiedError(); }
    const ephPub = strictB64(wrap.ephPub, KEY_LEN);
    const nonce = strictB64(wrap.nonce, NONCE_LEN);
    const wrapped = strictB64(wrap.wrapped, KEY_LEN + TAG_LEN);
    if (!ephPub || !nonce || !wrapped) throw new GroupKeyNotVerifiedError();
    try {
        const shared = x25519.getSharedSecret(identityX25519Secret(myEdPrivHex), ephPub);
        const k = hkdf(sha256, shared, ephPub, utf8ToBytes(GROUP_KEY_WRAP_TAG), KEY_LEN);
        return xchacha20poly1305(k, nonce, groupKeyWrapAad(binding)).decrypt(wrapped);
    } catch {
        throw new GroupKeyNotVerifiedError();
    }
}

// ─── Epoch records (§2.3, §7.3) ─────────────────────────────────────────────────────────────

/**
 * The canonical form an epoch record's signature covers: JSON.stringify of
 * [tag, group, String(epoch), reason, subject ?? '', createdBy, createdAt, [[recipient, ephPub, nonce, wrapped] …]], the
 * wraps sorted by recipient (code-unit order, which for lower-case hex is byte order, the same on every engine).
 */
export function groupEpochCanonical(r: Omit<GroupEpochRecord, 'sig'>): string {
    const wraps = r.wraps
        .map((w) => [w.recipient, w.ephPub, w.nonce, w.wrapped])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify([GROUP_EPOCH_TAG, r.groupId, String(r.epoch), r.reason, r.subject ?? '', r.createdBy, r.createdAt, wraps]);
}

/** What makeGroupEpochRecord needs. */
export interface MakeGroupEpochInput {
    /** The maker's Ed25519 private key, hex, bare seed or PKCS8. */
    myEdPrivHex: string;
    groupId: string;
    /** The node's current epoch + 1 (1 for a new group). */
    epoch: number;
    reason: GroupEpochReason;
    /** Whose membership changed; omit for 'start' and 'rotate'. */
    subject?: string | null;
    /** ISO 8601. */
    createdAt: string;
    /** Every active member after the change, the maker included. */
    recipients: readonly string[];
}

/**
 * Make the next epoch: a fresh key, wrapped to every recipient, signed. Refuses a record verifyGroupEpochRecord would
 * refuse. RNG order (pinned by the vectors): the epoch key (32), then per recipient in sorted order its ephemeral secret
 * (32) and nonce (24).
 */
export function makeGroupEpochRecord(input: MakeGroupEpochInput, opts?: GroupCryptoRandom): { record: GroupEpochRecord; groupKey: Uint8Array } {
    const { seed, pubHex } = me(input.myEdPrivHex);
    const recipients = [...input.recipients].sort();
    const rng = rngOf(opts);
    const groupKey = rng(KEY_LEN);
    if (groupKey.length !== KEY_LEN) throw new Error('A group key is 32 bytes.');
    const unsigned: Omit<GroupEpochRecord, 'sig'> = {
        groupId: input.groupId,
        epoch: input.epoch,
        reason: input.reason,
        subject: input.subject ?? null,
        createdBy: pubHex,
        createdAt: input.createdAt,
        wraps: recipients.map((recipientPubHex) =>
            wrapGroupKey(groupKey, { groupId: input.groupId, epoch: input.epoch, recipientPubHex, wrapperPubHex: pubHex }, { randomBytes: rng })),
    };
    const problem = epochRecordProblem(unsigned);
    if (problem) throw new Error(`Not an epoch record this member can make: ${problem}`);
    const sig = ed25519.sign(sha256(utf8ToBytes(groupEpochCanonical(unsigned))), seed);
    return { record: { ...unsigned, sig: b64(sig) }, groupKey };
}

/** Everything about a record that needs no signature check and no roster: its shape and §2.3's rules. */
function epochRecordProblem(r: Omit<GroupEpochRecord, 'sig'>): string | null {
    if (!r || typeof r !== 'object') return 'not a record';
    if (!isGroupId(r.groupId)) return 'no group';
    if (!isEpoch(r.epoch)) return 'the epoch is not a whole number from 1';
    if (!GROUP_EPOCH_REASONS.includes(r.reason)) return 'an unknown reason';
    if (!isPubHex(r.createdBy)) return 'no maker';
    if (r.subject !== null && !isPubHex(r.subject)) return 'the subject is not a member key';
    if (typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) return 'no time';
    if (!Array.isArray(r.wraps) || r.wraps.length === 0) return 'no wraps';
    const recipients = new Set<string>();
    for (const w of r.wraps) {
        if (!w || !isPubHex(w.recipient)) return 'a wrap names no member';
        if (recipients.has(w.recipient)) return 'two wraps for one member';
        recipients.add(w.recipient);
        if (!strictB64(w.ephPub, KEY_LEN) || !strictB64(w.nonce, NONCE_LEN) || !strictB64(w.wrapped, KEY_LEN + TAG_LEN)) return 'a malformed wrap';
    }
    // §2.3: the maker is an active member AFTER the change, and every active member gets a wrap, so the maker is a
    // recipient. A leaver, a removed member or an outsider never is.
    if (!recipients.has(r.createdBy)) return 'the maker is not a member after the change';
    const subjectIn = r.subject !== null && recipients.has(r.subject);
    switch (r.reason) {
        case 'start':
            if (r.epoch !== 1) return "'start' is epoch 1 only";
            if (r.subject !== null) return "'start' names no subject";
            break;
        case 'rotate':
            if (r.subject !== null) return "'rotate' names no subject";
            break;
        case 'join':
        case 'invite':
            // An open join, or an invitation accepted: the newcomer makes the epoch themselves.
            if (r.subject !== r.createdBy) return 'only the member who joined makes their join epoch';
            break;
        case 'approve':
            if (r.subject === null || r.subject === r.createdBy || !subjectIn) return 'an approval names the approved member, who is a recipient';
            break;
        case 'remove':
        case 'leave':
            if (r.subject === null || r.subject === r.createdBy || subjectIn) return 'the member who left or was removed gets no wrap and makes no epoch';
            break;
        case 'rekey':
            if (r.subject === null) return "'rekey' names the member";
            break;
    }
    return null;
}

/** What verifyGroupEpochRecord checks a record against. */
export interface GroupEpochCheck {
    /** The group the caller asked about: a record for any other doesn't verify. */
    groupId: string;
    /** The epoch the caller expects, if it knows (the node's current + 1). */
    epoch?: number;
    /**
     * The active members per the roster the caller holds (§7.3): the maker must be one. Omit only where no roster is
     * known; the record's own rules still apply.
     */
    activeMembers?: readonly string[];
}

/**
 * Check an epoch record: its shape, the §2.3 rules on who may make it, its signature under its maker's key (strict RFC
 * 8032), and, when given, the group, the epoch and the roster. Throws GroupKeyNotVerifiedError saying why.
 */
export function verifyGroupEpochRecord(record: GroupEpochRecord, check: GroupEpochCheck): void {
    const problem = epochRecordProblem(record);
    if (problem) throw new GroupKeyNotVerifiedError(`Epoch record refused: ${problem}.`);
    if (record.groupId !== check.groupId) throw new GroupKeyNotVerifiedError('Epoch record refused: made for another group.');
    if (check.epoch !== undefined && record.epoch !== check.epoch) throw new GroupKeyNotVerifiedError('Epoch record refused: another epoch.');
    if (check.activeMembers && !check.activeMembers.includes(record.createdBy)) {
        throw new GroupKeyNotVerifiedError('Epoch record refused: its maker is not an active member.');
    }
    const sig = strictB64(record.sig, SIG_LEN);
    if (!sig || !verifySig(sig, sha256(utf8ToBytes(groupEpochCanonical(record))), record.createdBy)) {
        throw new GroupKeyNotVerifiedError('Epoch record refused: the signature does not verify.');
    }
}

/** Verify an epoch record, then open my wrap in it: the epoch key. */
export function openGroupEpochRecord(record: GroupEpochRecord, myEdPrivHex: string, check: GroupEpochCheck): Uint8Array {
    verifyGroupEpochRecord(record, check);
    let myPub: string;
    try { myPub = dmPublicKeyOf(myEdPrivHex); } catch { throw new GroupKeyNotVerifiedError('Not a private key this app can use.'); }
    const wrap = record.wraps.find((w) => w.recipient === myPub);
    if (!wrap) throw new GroupKeyNotVerifiedError('This epoch was not locked to me.');
    return openGroupKeyWrap(wrap, { groupId: record.groupId, epoch: record.epoch, wrapperPubHex: record.createdBy }, myEdPrivHex);
}

// ─── Top-ups (§2.5) ─────────────────────────────────────────────────────────────────────────

/**
 * The canonical form a top-up's signature covers: JSON.stringify of
 * [tag, group, String(epoch), recipient, wrapper, ephPub, nonce, wrapped]. The design names a signature on the top-up
 * route (Appendix A) without its form; this is it.
 */
export function groupTopUpCanonical(groupId: string, t: Omit<GroupTopUp, 'sig'>): string {
    return JSON.stringify([GROUP_TOP_UP_TAG, groupId, String(t.epoch), t.recipient, t.wrapper, t.ephPub, t.nonce, t.wrapped]);
}

/** Hand an epoch key I hold to a member who lacks a wrap for it, signed as me. */
export function makeGroupTopUp(
    groupKey: Uint8Array,
    input: { myEdPrivHex: string; groupId: string; epoch: number; recipientPubHex: string },
    opts?: GroupCryptoRandom,
): GroupTopUp {
    const { seed, pubHex } = me(input.myEdPrivHex);
    const wrap = wrapGroupKey(groupKey, { groupId: input.groupId, epoch: input.epoch, recipientPubHex: input.recipientPubHex, wrapperPubHex: pubHex }, opts);
    const unsigned: Omit<GroupTopUp, 'sig'> = { ...wrap, epoch: input.epoch, wrapper: pubHex };
    const sig = ed25519.sign(sha256(utf8ToBytes(groupTopUpCanonical(input.groupId, unsigned))), seed);
    return { ...unsigned, sig: b64(sig) };
}

/** Check a top-up's shape and its wrapper's signature (the node and the recipient both do). Throws GroupKeyNotVerifiedError. */
export function verifyGroupTopUp(groupId: string, t: GroupTopUp): void {
    if (!t || typeof t !== 'object' || !isGroupId(groupId) || !isEpoch(t.epoch) || !isPubHex(t.recipient) || !isPubHex(t.wrapper)
        || !strictB64(t.ephPub, KEY_LEN) || !strictB64(t.nonce, NONCE_LEN) || !strictB64(t.wrapped, KEY_LEN + TAG_LEN)) {
        throw new GroupKeyNotVerifiedError('Top-up refused: malformed.');
    }
    const sig = strictB64(t.sig, SIG_LEN);
    if (!sig || !verifySig(sig, sha256(utf8ToBytes(groupTopUpCanonical(groupId, t))), t.wrapper)) {
        throw new GroupKeyNotVerifiedError('Top-up refused: the signature does not verify.');
    }
}

/** Verify a top-up locked to me, then open it: the epoch key. */
export function openGroupTopUp(groupId: string, t: GroupTopUp, myEdPrivHex: string): Uint8Array {
    verifyGroupTopUp(groupId, t);
    return openGroupKeyWrap(t, { groupId, epoch: t.epoch, wrapperPubHex: t.wrapper }, myEdPrivHex);
}

// ─── Lines (§7.1, §7.2) ─────────────────────────────────────────────────────────────────────

/** One message's own key (§7.1): what a reporter discloses for that line, and nothing else opens with it. */
export function groupMessageKey(groupKey: Uint8Array, messageId: string): Uint8Array {
    if (!(groupKey instanceof Uint8Array) || groupKey.length !== KEY_LEN) throw new Error('A group key is 32 bytes.');
    if (typeof messageId !== 'string' || !messageId) throw new Error('A message key is made for one message id.');
    return hkdf(sha256, groupKey, utf8ToBytes(messageId), utf8ToBytes(GROUP_LINE_TAG), KEY_LEN);
}

/**
 * A line's associated data: the UTF-8 of [tag, group, String(epoch), sender, message id, part] as a JSON array of strings,
 * and for a reply a seventh, the id of the message it answers (as DM format 3: a reply's never equals a line's that
 * answers nothing).
 */
export function groupLineAad(b: GroupLineBinding): Uint8Array {
    const parts = [GROUP_LINE_TAG, b.groupId, String(b.epoch), b.senderPubHex, b.messageId, b.part ?? 'body'];
    if (b.replyToId) parts.push(b.replyToId);
    return utf8ToBytes(JSON.stringify(parts));
}

/** [format][after length][after, UTF-8][the words, UTF-8]: the frame without its signature. */
function unsignedFrame(text: string, after: string | null | undefined): Uint8Array {
    let a = typeof after === 'string' && after ? utf8ToBytes(after) : new Uint8Array(0);
    if (a.length > MAX_AFTER_BYTES) a = new Uint8Array(0);
    const t = utf8ToBytes(text);
    const out = new Uint8Array(2 + a.length + t.length);
    out[0] = GROUP_LINE_FORMAT;
    out[1] = a.length;
    out.set(a, 2);
    out.set(t, 2 + a.length);
    return out;
}

/** What the sender signs: sha256(associated data ‖ nonce ‖ frame without the signature). */
function lineDigest(aad: Uint8Array, nonce: Uint8Array, unsigned: Uint8Array): Uint8Array {
    return sha256(concatBytes(aad, nonce, unsigned));
}

/** True if a stored nonce is an encrypted group line's. */
export function isGroupEncryptedNonce(nonce: string | null | undefined): boolean {
    return typeof nonce === 'string' && nonce.startsWith(GROUP_NONCE_PREFIX);
}

/**
 * The node's keyless check (Appendix B): the group prefix, a 24-byte nonce, and a ciphertext at least as long as the
 * smallest sealed line. It proves the shape, not that the line opens.
 */
export function isGroupEncryptedPayload(p: { ciphertext?: unknown; nonce?: unknown } | null | undefined): boolean {
    if (!p || typeof p.nonce !== 'string' || typeof p.ciphertext !== 'string' || !isGroupEncryptedNonce(p.nonce)) return false;
    if (!strictB64(p.nonce.slice(GROUP_NONCE_PREFIX.length), NONCE_LEN)) return false;
    const ct = Buffer.from(p.ciphertext, 'base64');
    return ct.length >= MIN_LINE_CIPHERTEXT && b64(ct) === p.ciphertext;
}

function checkLineBinding(b: GroupLineBinding): void {
    if (!isGroupId(b.groupId) || !isEpoch(b.epoch) || !isPubHex(b.senderPubHex) || typeof b.messageId !== 'string' || !b.messageId) {
        throw new Error('A line is bound to one group, one epoch, one sender and one message id.');
    }
    if (b.part !== undefined && !GROUP_LINE_PARTS.includes(b.part)) throw new Error('A line part is body, attachment or edit.');
    if (b.replyToId !== undefined && b.replyToId !== null && (typeof b.replyToId !== 'string' || !b.replyToId)) {
        throw new Error('A reply is sealed to the id of the message it answers.');
    }
}

/** What sealGroupLine needs besides the words. */
export interface SealGroupLineInput {
    /** The sender's Ed25519 private key, hex, bare seed or PKCS8: signs the line, and names its sender. */
    myEdPrivHex: string;
    /** The epoch key (openGroupEpochRecord). */
    groupKey: Uint8Array;
    groupId: string;
    epoch: number;
    /** The client's own UUID v4, lower case. */
    messageId: string;
    part?: GroupLinePart;
    /** The id of the newest line I had from the node; an edit names the message's own id (§7.4). */
    after?: string | null;
    replyToId?: string | null;
}

/**
 * Seal a line (its words, its photo as a data URI, or an edit) as me: sign, then encrypt under the message's own key.
 * RNG order (pinned by the vectors): the nonce (24).
 */
export function sealGroupLine(text: string, input: SealGroupLineInput, opts?: GroupCryptoRandom): GroupLinePayload {
    if (typeof text !== 'string') throw new Error('A line is text.');
    if (!UUID_V4.test(input.messageId)) throw new Error('A line is sealed under its own lower-case UUID v4.');
    const { seed, pubHex } = me(input.myEdPrivHex);
    const binding: GroupLineBinding = {
        groupId: input.groupId, epoch: input.epoch, senderPubHex: pubHex, messageId: input.messageId,
        part: input.part ?? 'body', replyToId: input.replyToId ?? null,
    };
    checkLineBinding(binding);
    const nonce = rngOf(opts)(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) throw new Error('A line nonce is 24 bytes.');
    const aad = groupLineAad(binding);
    const unsigned = unsignedFrame(text, input.after);
    const sig = ed25519.sign(lineDigest(aad, nonce, unsigned), seed);
    const frame = concatBytes(unsigned.subarray(0, 1), sig, unsigned.subarray(1));
    const ct = xchacha20poly1305(groupMessageKey(input.groupKey, input.messageId), nonce, aad).encrypt(frame);
    return { ciphertext: b64(ct), nonce: GROUP_NONCE_PREFIX + b64(nonce) };
}

/**
 * Open a line with its message key (a moderator holding one disclosed line's key, §13) and verify its sender's
 * signature. Throws GroupLineNotVerifiedError when it doesn't open, or opens but wasn't signed by the sender it names.
 */
export function openGroupLineWithMessageKey(payload: GroupLinePayload, ref: GroupLineBinding, messageKey: Uint8Array): OpenedGroupLine {
    try { checkLineBinding(ref); } catch { throw new GroupLineNotVerifiedError(); }
    if (!payload || !isGroupEncryptedNonce(payload.nonce) || typeof payload.ciphertext !== 'string') {
        throw new GroupLineNotVerifiedError('Not an encrypted group line.');
    }
    const nonce = strictB64(payload.nonce.slice(GROUP_NONCE_PREFIX.length), NONCE_LEN);
    if (!nonce || !(messageKey instanceof Uint8Array) || messageKey.length !== KEY_LEN) throw new GroupLineNotVerifiedError();
    const aad = groupLineAad(ref);
    let frame: Uint8Array;
    try {
        frame = xchacha20poly1305(messageKey, nonce, aad).decrypt(new Uint8Array(Buffer.from(payload.ciphertext, 'base64')));
    } catch {
        throw new GroupLineNotVerifiedError();
    }
    if (frame.length < 2 + SIG_LEN || frame[0] !== GROUP_LINE_FORMAT) throw new GroupLineNotVerifiedError();
    const sig = frame.subarray(1, 1 + SIG_LEN);
    const unsigned = concatBytes(frame.subarray(0, 1), frame.subarray(1 + SIG_LEN));
    const afterLen = unsigned[1];
    if (unsigned.length < 2 + afterLen) throw new GroupLineNotVerifiedError();
    if (!verifySig(sig, lineDigest(aad, nonce, unsigned), ref.senderPubHex)) throw new GroupLineNotVerifiedError();
    return {
        after: afterLen ? utf8(unsigned.subarray(2, 2 + afterLen)) : null,
        text: utf8(unsigned.subarray(2 + afterLen)),
    };
}

/** Open a line with its epoch's key and verify its sender's signature. Throws GroupLineNotVerifiedError. */
export function openGroupLine(payload: GroupLinePayload, ref: GroupLineBinding, groupKey: Uint8Array): OpenedGroupLine {
    let mk: Uint8Array;
    try { mk = groupMessageKey(groupKey, ref.messageId); } catch { throw new GroupLineNotVerifiedError(); }
    return openGroupLineWithMessageKey(payload, ref, mk);
}

// ─── Mentions (§9) ──────────────────────────────────────────────────────────────────────────

/**
 * The members @mentioned in a message: "@" + a member's callsign (any case), starting the text or after a
 * non-word character, and not running on into more letters or digits. Callsigns may contain spaces.
 *
 * Moved here from the node (engine/group-thread.ts, which imports it): in an encrypted group the node can't read the
 * words, so the sending app runs this on the text it is about to seal and declares metadata.mentions (§9).
 */
export function detectMentions(text: string, candidates: { pubkey: string; callsign: string | null | undefined }[]): string[] {
    const lower = text.toLowerCase();
    const found = new Set<string>();
    for (const c of candidates) {
        const cs = (c.callsign || '').trim().toLowerCase();
        if (cs.length < 2) continue;
        const needle = `@${cs}`;
        let from = 0;
        while (from <= lower.length) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            const before = at === 0 ? '' : lower[at - 1];
            const after = lower[at + needle.length] ?? '';
            if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
                found.add(c.pubkey);
                break;
            }
            from = at + 1;
        }
    }
    return Array.from(found);
}
