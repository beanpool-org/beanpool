/**
 * The names list's encryption (community modes slice 2; scratch/global-node/DESIGN-community-modes-fable.md §4.3 option
 * B, Marty's answer 3 of 2026-10-01; the trust model is scratch/global-node/DESIGN-names-list-trust-fable.md): a
 * community's real-names list kept on its node, readable only on its admins' phones. The server, BeanPool and a thief
 * with the database, a backup or a standby's copy hold scrambled text.
 *
 * ## The pieces
 *
 * - **A list key**: 32 random bytes, made on an admin's phone with a new generation of the list
 *   (names-list-trust.ts), and never sent anywhere in the clear. Each generation has its own key, named by the
 *   generation's id (the SHA-256 of its signed statement).
 * - **An entry**: a name and a note, sealed under one generation's key with XChaCha20-Poly1305 and a random 24-byte
 *   nonce. The node keeps the sealed text (`names_entries.ciphertext`) and the id of the key it was sealed under, and
 *   nothing else of it. An entry is sealed when it is written or edited, and never again: a new key carries nothing over.
 * - **A ring box** ({@link sealNamesRing}): every list key an admin's phone holds, sealed to another admin's account key
 *   with the member scheme the keeper-recovery code already uses (keeper-crypto.ts {@link sealToMemberKey}: X25519 ECDH
 *   into XChaCha20-Poly1305), under the names list's own labels. It is how one admin gives another the list: the whole
 *   ring in one box, under a header the giver signs (names-list-trust.ts).
 * - **A pin blob** ({@link sealNamesPinBlob}): the phone's own record of whom it trusts and the keys it holds, sealed
 *   under a key the phone keeps in its secure store, so the keys never sit in plain app storage.
 *
 * ## What each box is bound to
 *
 * - A ring box's associated data names the community, the giver, the recipient and the giver's head generation. A box
 *   made for one admin doesn't open as another's, or as a share from someone else.
 * - An entry's associated data names its id and the id of its key. A node that swaps two entries' boxes, so an admin
 *   confirms one person against another's name, or relabels the key an entry names, is caught: the box doesn't open.
 *
 * ## Length
 *
 * The sealed text is padded to a multiple of {@link ENTRY_PAD} bytes, so its length tells a reader of the database
 * roughly nothing about the length of a name.
 *
 * Pure JavaScript (`@noble/*`), as keeper-crypto.ts, so it runs on Hermes, in the web app and on the server, which uses
 * only the shape checks here: it never holds a list key.
 */

import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { KeeperCryptoError, openWithMemberKey, sealToMemberKey, type MemberKeyDomain, type SealedShare } from './keeper-crypto.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** The scheme name a ring box carries in its `kdfParams`. */
export const NAMES_RING_ALG = 'x25519-xc20p-names-ring-v2';
/** The version an entry's sealed text carries (`v`). */
export const NAMES_ENTRY_VERSION = 2;

/**
 * The sizes everything is held to, on the phone and on the node alike. A name and a note only: no address, no date of
 * birth, no ID number (design §4.3, data minimisation). The node keeps at most `entries` entries; a ring box carries at
 * most `ringKeys` keys.
 */
export const NAMES_LIMITS = {
    nameChars: 100,
    noteChars: 500,
    /** The longest sealed text a node stores: the longest name and note, four bytes a character, padded and in base64. */
    ciphertextChars: 4096,
    entries: 2000,
    ringKeys: 1000,
} as const;

const KEY_LEN = 32;
const NONCE_LEN = 24;
const TAG_LEN = 16;
/** The sealed text's plaintext is padded to a multiple of this many bytes. */
export const ENTRY_PAD = 64;

const RING_INFO = 'beanpool-names-ring';
const RING_AAD = 'beanpool-names-ring-v2';
const ENTRY_AAD = 'beanpool-names-entry-v2';
const PIN_AAD = 'beanpool-names-pin-v1';

/** Raised when a box or an entry can't be made or opened. The apps own the sentence an admin sees. */
export class NamesListCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NamesListCryptoError';
    }
}

/** A ring box as the node stores and returns it (names_shares): every field base64 but `kdfParams`, compact JSON. */
export interface NamesRingBox {
    sealedRing: string;
    ringIv: string;
    ringTag: string;
    ephemeralPubkey: string;
    kdfParams: string;
}

/** What an entry holds once opened. */
export interface NamesEntryText {
    name: string;
    note: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function hexKey(publicKey: unknown, what: string): string {
    const hex = typeof publicKey === 'string' ? publicKey.toLowerCase() : '';
    if (!HEX_KEY.test(hex)) throw new NamesListCryptoError(`${what} must be 64 hexadecimal characters.`);
    return hex;
}

function requireListKey(listKey: Uint8Array): Uint8Array {
    if (!(listKey instanceof Uint8Array) || listKey.length !== KEY_LEN) throw new NamesListCryptoError('A list key is 32 bytes.');
    return listKey;
}

/** A new list key: 32 random bytes. */
export function newNamesListKey(): Uint8Array {
    assertRecoveryCsprngAvailable();
    return randomBytes(KEY_LEN);
}

/** A new entry id: 16 random bytes in hex. The phone chooses it, because the entry is sealed to it before the node sees it. */
export function newNamesEntryId(): string {
    assertRecoveryCsprngAvailable();
    return Buffer.from(randomBytes(16)).toString('hex');
}

/** Whether `id` is an entry id's shape (32 lower-case hexadecimal characters). */
export function isNamesEntryId(id: unknown): id is string {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
}

/** Whether `id` is a generation's id: the SHA-256 of its statement, 64 lower-case hexadecimal characters. */
export function isNamesKeyId(id: unknown): id is string {
    return typeof id === 'string' && HEX_KEY.test(id);
}

// ── The ring box ─────────────────────────────────────────────────────────────────────────────

/** Who a ring box is from and to, and the giver's head when it was made: all of it bound into the box. */
export interface NamesRingContext {
    communityId: string;
    from: string;
    to: string;
    headId: string;
}

function ringDomain(ctx: NamesRingContext): MemberKeyDomain {
    if (typeof ctx.communityId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(ctx.communityId)) throw new NamesListCryptoError('A community id is needed to seal the keys.');
    const from = hexKey(ctx.from, 'The giver');
    const to = hexKey(ctx.to, 'The recipient');
    if (!isNamesKeyId(ctx.headId)) throw new NamesListCryptoError('The giver’s head is a generation id.');
    return { alg: NAMES_RING_ALG, info: RING_INFO, aad: `${RING_AAD}|${ctx.communityId}|${from}|${to}|${ctx.headId}` };
}

/**
 * Seals every key in `ring` (generation id → 32-byte key) to `ctx.to`'s account key, in one box. Takes any number of
 * keys up to {@link NAMES_LIMITS.ringKeys}.
 */
export function sealNamesRing(ring: Record<string, Uint8Array>, ctx: NamesRingContext): NamesRingBox {
    const keys: Record<string, string> = {};
    const ids = Object.keys(ring).sort();
    if (ids.length === 0 || ids.length > NAMES_LIMITS.ringKeys) throw new NamesListCryptoError(`A ring holds from 1 to ${NAMES_LIMITS.ringKeys} keys.`);
    for (const id of ids) {
        if (!isNamesKeyId(id)) throw new NamesListCryptoError('A ring is keyed by generation ids.');
        keys[id] = bytesToHex(requireListKey(ring[id]));
    }
    const body = utf8ToBytes(JSON.stringify({ keys }));
    const sealed = sealToMemberKey(body, hexKey(ctx.to, 'The recipient'), ringDomain(ctx));
    return {
        sealedRing: sealed.encryptedShare,
        ringIv: sealed.shareIv,
        ringTag: sealed.shareTag,
        ephemeralPubkey: sealed.ephemeralPubkey as string,
        kdfParams: sealed.kdfParams,
    };
}

/**
 * Opens a ring box with the recipient's own identity key (PKCS8 or raw seed), for the context the phone expects: its
 * own key as `to`, and the giver and head the signed header names. A box made for anyone else, or under another header,
 * doesn't open. Returns the keys by generation id. Throws {@link NamesListCryptoError}.
 */
export function openNamesRing(box: NamesRingBox, privateKey: string | Uint8Array, ctx: NamesRingContext): Record<string, Uint8Array> {
    const sealed: SealedShare = {
        encryptedShare: box.sealedRing, shareIv: box.ringIv, shareTag: box.ringTag, ephemeralPubkey: box.ephemeralPubkey, kdfParams: box.kdfParams,
    };
    let plain: Uint8Array;
    try {
        plain = openWithMemberKey(sealed, privateKey, ringDomain(ctx));
    } catch (e) {
        if (e instanceof NamesListCryptoError) throw e;
        if (e instanceof KeeperCryptoError) throw new NamesListCryptoError(`The names list’s keys did not open: ${e.message}`);
        throw e;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { throw new NamesListCryptoError('A ring box opened but is not readable.'); }
    const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const raw = (p.keys && typeof p.keys === 'object' ? p.keys : null) as Record<string, unknown> | null;
    if (!raw) throw new NamesListCryptoError('A ring box opened but holds no keys.');
    const keys: Record<string, Uint8Array> = {};
    for (const [id, hex] of Object.entries(raw).slice(0, NAMES_LIMITS.ringKeys)) {
        if (!isNamesKeyId(id) || typeof hex !== 'string' || !HEX_KEY.test(hex)) continue;
        keys[id] = new Uint8Array(Buffer.from(hex, 'hex'));
    }
    return keys;
}

/** The digest a share's signed header names for its box: SHA-256 over its five fields, in order, each on its own line. */
export function namesBoxDigest(box: NamesRingBox): string {
    const text = [box.sealedRing, box.ringIv, box.ringTag, box.ephemeralPubkey, box.kdfParams].join('\n');
    return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Whether `b` has a ring box's shape: base64 fields of the right widths and a `kdfParams` naming {@link NAMES_RING_ALG}. */
export function isNamesRingBox(b: unknown): b is NamesRingBox {
    if (!b || typeof b !== 'object') return false;
    const r = b as Record<string, unknown>;
    const b64 = (v: unknown, bytes?: number) => typeof v === 'string' && v.length > 0 && v.length <= 400_000 && B64.test(v)
        && (bytes === undefined || Buffer.from(v, 'base64').length === bytes);
    if (!b64(r.sealedRing) || !b64(r.ringIv, NONCE_LEN) || !b64(r.ringTag, TAG_LEN) || !b64(r.ephemeralPubkey, KEY_LEN)) return false;
    if (typeof r.kdfParams !== 'string' || r.kdfParams.length > 200) return false;
    try {
        const k = JSON.parse(r.kdfParams) as Record<string, unknown>;
        return !!k && k.alg === NAMES_RING_ALG;
    } catch {
        return false;
    }
}

// ── The locked copy ──────────────────────────────────────────────────────────────────────────

/** The scheme name a locked copy's box carries in its `kdfParams` (DESIGN-names-locked-copy §2). */
export const NAMES_COPY_ALG = 'x25519-xc20p-names-copy-v1';
/** The most ciphertext a locked copy may hold: 1 MiB, about 1,200 generations (design §1). */
export const NAMES_COPY_MAX_BYTES = 1024 * 1024;
const COPY_INFO = 'beanpool-names-copy';
const COPY_AAD = 'beanpool-names-copy-v1';
const COPY_ADDRESS = /^https?:\/\/[^\s|]{1,500}$/i;

/** An admin's own pin, sealed to its own member key: the five fields of a ring box, under the copy's names. */
export interface NamesCopyBox {
    sealedCopy: string;
    copyIv: string;
    copyTag: string;
    ephemeralPubkey: string;
    kdfParams: string;
}

/** Whose copy it is, for which community and address, and its number: all of it bound into the box. */
export interface NamesCopyContext {
    communityId: string;
    /** The phone's own address for the community (an http(s) address, as `communityAddress` makes it). */
    address: string;
    owner: string;
    seq: number;
}

/** Whether `a` can be a copy's address: http(s), no whitespace and no `|` (the AAD's separator). */
export function isNamesCopyAddress(a: unknown): a is string {
    return typeof a === 'string' && COPY_ADDRESS.test(a);
}

function copyDomain(ctx: NamesCopyContext): MemberKeyDomain {
    if (typeof ctx.communityId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(ctx.communityId)) throw new NamesListCryptoError('A community id is needed to seal the copy.');
    if (!isNamesCopyAddress(ctx.address)) throw new NamesListCryptoError('A copy is sealed for the community’s http(s) address.');
    const owner = hexKey(ctx.owner, 'The owner');
    if (!Number.isSafeInteger(ctx.seq) || ctx.seq < 1 || ctx.seq > 999_999_999) throw new NamesListCryptoError('A copy’s number is a whole number from 1.');
    return { alg: NAMES_COPY_ALG, info: COPY_INFO, aad: `${COPY_AAD}|${ctx.communityId}|${ctx.address}|${owner}|${ctx.seq}` };
}

/**
 * Seals `payload` (the copy's JSON) to `ctx.owner`'s own account key, with the member scheme ({@link sealToMemberKey}) under
 * the copy's own labels. Sealing authenticates nothing: names-list-trust.ts `makeNamesCopy` signs a header over the box.
 * Throws {@link NamesListCryptoError} for a payload over {@link NAMES_COPY_MAX_BYTES} ("too big").
 */
export function sealNamesCopy(payload: string | Uint8Array, ctx: NamesCopyContext): NamesCopyBox {
    const body = typeof payload === 'string' ? utf8ToBytes(payload) : payload;
    if (body.length > NAMES_COPY_MAX_BYTES) throw new NamesListCryptoError('The names list’s record is too big to keep a copy on the server.');
    const sealed = sealToMemberKey(body, hexKey(ctx.owner, 'The owner'), copyDomain(ctx));
    return {
        sealedCopy: sealed.encryptedShare,
        copyIv: sealed.shareIv,
        copyTag: sealed.shareTag,
        ephemeralPubkey: sealed.ephemeralPubkey as string,
        kdfParams: sealed.kdfParams,
    };
}

/** Opens a copy's box with the owner's own identity key (PKCS8 or raw seed), for the context its header names. Returns the payload text. */
export function openNamesCopy(box: NamesCopyBox, privateKey: string | Uint8Array, ctx: NamesCopyContext): string {
    if (!isNamesCopyBox(box)) throw new NamesListCryptoError('That is not a copy’s box.');
    const sealed: SealedShare = {
        encryptedShare: box.sealedCopy, shareIv: box.copyIv, shareTag: box.copyTag, ephemeralPubkey: box.ephemeralPubkey, kdfParams: box.kdfParams,
    };
    try {
        return Buffer.from(openWithMemberKey(sealed, privateKey, copyDomain(ctx))).toString('utf8');
    } catch (e) {
        if (e instanceof NamesListCryptoError) throw e;
        if (e instanceof KeeperCryptoError) throw new NamesListCryptoError(`The names list’s copy did not open: ${e.message}`);
        throw e;
    }
}

/** A copy box's digest: the {@link namesBoxDigest} rule, SHA-256 over its five fields in order, each on its own line. */
export function namesCopyBoxDigest(box: NamesCopyBox): string {
    return namesBoxDigest({ sealedRing: box.sealedCopy, ringIv: box.copyIv, ringTag: box.copyTag, ephemeralPubkey: box.ephemeralPubkey, kdfParams: box.kdfParams });
}

/** Whether `b` has a copy box's shape: base64 fields of the right widths, at most 1 MiB sealed, and `kdfParams` naming {@link NAMES_COPY_ALG}. */
export function isNamesCopyBox(b: unknown): b is NamesCopyBox {
    if (!b || typeof b !== 'object') return false;
    const r = b as Record<string, unknown>;
    const b64 = (v: unknown, bytes?: number) => typeof v === 'string' && v.length > 0 && B64.test(v)
        && (bytes === undefined || Buffer.from(v, 'base64').length === bytes);
    if (typeof r.sealedCopy !== 'string' || r.sealedCopy.length > Math.ceil(NAMES_COPY_MAX_BYTES / 3) * 4 || !b64(r.sealedCopy)) return false;
    if (!b64(r.copyIv, NONCE_LEN) || !b64(r.copyTag, TAG_LEN) || !b64(r.ephemeralPubkey, KEY_LEN)) return false;
    if (typeof r.kdfParams !== 'string' || r.kdfParams.length > 200) return false;
    try {
        const k = JSON.parse(r.kdfParams) as Record<string, unknown>;
        return !!k && k.alg === NAMES_COPY_ALG && Object.keys(k).length === 1;
    } catch {
        return false;
    }
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

function entryAad(entryId: string, keyId: string): Uint8Array {
    if (!isNamesEntryId(entryId)) throw new NamesListCryptoError('An entry id is 32 hexadecimal characters.');
    if (!isNamesKeyId(keyId)) throw new NamesListCryptoError('A key id is 64 hexadecimal characters.');
    return utf8ToBytes(`${ENTRY_AAD}|${entryId}|${keyId}`);
}

/** Control characters but a line break and a tab, and lone surrogates (JSON would write each as six bytes). */
const CONTROL = /(?![\n\t])\p{Cc}|\p{Cs}/gu;
const chars = (s: string) => Array.from(s).length;

/**
 * A name and a note as they are kept: control characters out, the name on one line and trimmed, the note trimmed.
 * The name is required; both are held to {@link NAMES_LIMITS}.
 */
export function normaliseNamesEntryText(raw: { name?: unknown; note?: unknown }): { ok: true; value: NamesEntryText } | { ok: false; error: string } {
    const name = typeof raw.name === 'string' ? raw.name.replace(CONTROL, '').replace(/\s+/g, ' ').trim() : '';
    const note = typeof raw.note === 'string' ? raw.note.replace(CONTROL, '').trim() : '';
    if (!name) return { ok: false, error: 'Write the person’s name.' };
    if (chars(name) > NAMES_LIMITS.nameChars) return { ok: false, error: `Keep the name to ${NAMES_LIMITS.nameChars} characters.` };
    if (chars(note) > NAMES_LIMITS.noteChars) return { ok: false, error: `Keep the note to ${NAMES_LIMITS.noteChars} characters.` };
    return { ok: true, value: { name, note } };
}

/** Seals an entry's name and note under the list key whose generation id is `keyId`, bound to the entry's id and that key id. */
export function sealNamesEntry(listKey: Uint8Array, entryId: string, keyId: string, text: NamesEntryText): string {
    const checked = normaliseNamesEntryText(text);
    if (!checked.ok) throw new NamesListCryptoError(checked.error);
    assertRecoveryCsprngAvailable();
    const body = utf8ToBytes(JSON.stringify({ n: checked.value.name, t: checked.value.note }));
    // Trailing spaces are JSON whitespace, so the padded text parses as it was.
    const padded = new Uint8Array(Math.ceil((body.length + 1) / ENTRY_PAD) * ENTRY_PAD).fill(0x20);
    padded.set(body);
    const nonce = randomBytes(NONCE_LEN);
    const sealed = xchacha20poly1305(requireListKey(listKey), nonce, entryAad(entryId, keyId)).encrypt(padded);
    return JSON.stringify({ v: NAMES_ENTRY_VERSION, n: Buffer.from(nonce).toString('base64'), c: Buffer.from(sealed).toString('base64') });
}

interface SealedEntry { v: number; n: string; c: string }

function readSealedEntry(ciphertext: unknown): SealedEntry | null {
    if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > NAMES_LIMITS.ciphertextChars) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(ciphertext); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (Object.keys(p).length !== 3 || p.v !== NAMES_ENTRY_VERSION || typeof p.n !== 'string' || typeof p.c !== 'string') return null;
    if (!B64.test(p.n) || !B64.test(p.c)) return null;
    if (Buffer.from(p.n, 'base64').length !== NONCE_LEN) return null;
    const sealedLen = Buffer.from(p.c, 'base64').length;
    // At least one padded block and its tag, and always whole blocks.
    if (sealedLen < ENTRY_PAD + TAG_LEN || (sealedLen - TAG_LEN) % ENTRY_PAD !== 0) return null;
    return { v: p.v, n: p.n, c: p.c };
}

/**
 * Whether `ciphertext` has the shape {@link sealNamesEntry} makes: `{"v":2,"n":<24-byte nonce>,"c":<whole padded blocks
 * and a tag>}`, in base64, within the size limit. The node takes nothing else, so a phone that sent a name in the clear
 * by mistake is refused rather than stored.
 */
export function isNamesEntryCiphertext(ciphertext: unknown): ciphertext is string {
    return readSealedEntry(ciphertext) !== null;
}

/** Opens an entry with the list key whose id is `keyId`. A wrong key, entry id or key id, or an altered box, doesn't open. */
export function openNamesEntry(listKey: Uint8Array, entryId: string, keyId: string, ciphertext: string): NamesEntryText {
    const sealed = readSealedEntry(ciphertext);
    if (!sealed) throw new NamesListCryptoError('An entry is not in the names list’s sealed form.');
    let plain: Uint8Array;
    try {
        plain = xchacha20poly1305(requireListKey(listKey), new Uint8Array(Buffer.from(sealed.n, 'base64')), entryAad(entryId, keyId))
            .decrypt(new Uint8Array(Buffer.from(sealed.c, 'base64')));
    } catch (e) {
        if (e instanceof NamesListCryptoError) throw e;
        throw new NamesListCryptoError('An entry did not open. The key is wrong, or the entry has been altered.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { throw new NamesListCryptoError('An entry opened but is not readable.'); }
    const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    if (typeof p.n !== 'string' || typeof p.t !== 'string') throw new NamesListCryptoError('An entry opened but is not readable.');
    return { name: p.n, note: p.t };
}

// ── The pin at rest ──────────────────────────────────────────────────────────────────────────

/**
 * Seals the phone's pin (its JSON) under `key`, a 32-byte secret the phone keeps in its secure store, bound to `label`
 * (where the blob is kept: this member's key and the community's address). The blob goes in ordinary app storage,
 * which on Android caps nothing but holds nothing readable.
 */
export function sealNamesPinBlob(json: string, key: Uint8Array, label: string): string {
    assertRecoveryCsprngAvailable();
    const nonce = randomBytes(NONCE_LEN);
    const sealed = xchacha20poly1305(requireListKey(key), nonce, utf8ToBytes(`${PIN_AAD}|${label}`)).encrypt(utf8ToBytes(json));
    return JSON.stringify({ v: 1, n: Buffer.from(nonce).toString('base64'), c: Buffer.from(sealed).toString('base64') });
}

/** Opens {@link sealNamesPinBlob}'s blob; null when it doesn't open (another key, another label, or altered). */
export function openNamesPinBlob(blob: string, key: Uint8Array, label: string): string | null {
    try {
        const p = JSON.parse(blob) as Record<string, unknown>;
        if (p.v !== 1 || typeof p.n !== 'string' || typeof p.c !== 'string') return null;
        const plain = xchacha20poly1305(requireListKey(key), new Uint8Array(Buffer.from(p.n, 'base64')), utf8ToBytes(`${PIN_AAD}|${label}`))
            .decrypt(new Uint8Array(Buffer.from(p.c, 'base64')));
        return Buffer.from(plain).toString('utf8');
    } catch {
        return null;
    }
}
