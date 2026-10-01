/**
 * The names list's encryption (community modes slice 2; scratch/global-node/DESIGN-community-modes-fable.md §4.3 option
 * B, Marty's answer 3 of 2026-10-01): a community's real-names list kept on its node, readable only on its admins'
 * phones. The server, BeanPool and a thief with the database, a backup or a standby's copy hold scrambled text.
 *
 * ## The pieces
 *
 * - **The list key**: 32 random bytes, made on an admin's phone and never sent anywhere in the clear.
 * - **A wrap**: the list key sealed to one admin's account key, with the member scheme the keeper-recovery code already
 *   uses (keeper-crypto.ts {@link sealToMemberKey}: X25519 ECDH into XChaCha20-Poly1305), under the names list's own
 *   labels. The node keeps one wrap per admin and generation (`names_list_keys`) and hands each admin only their own.
 * - **An entry**: a name and a note, sealed under the list key with XChaCha20-Poly1305 and a random 24-byte nonce. The
 *   node keeps the sealed text (`names_entries.ciphertext`) and nothing else of it.
 * - **The generation**: which list key an entry or a wrap belongs to. A new key (when an admin stops being one) is the
 *   next generation, so a removed admin, who may keep the key they had, can't open what is written after.
 *
 * ## What each box is bound to
 *
 * - A wrap's associated data names its generation and its holder's key. A node that serves an old generation's wrap as
 *   the current one, which would have an admin's phone write new entries under a key a removed admin still has, is
 *   caught: the box doesn't open.
 * - An entry's associated data names its id and its generation. A node that swaps two entries' boxes, so an admin
 *   confirms one person against another's name, is caught the same way.
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
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { KeeperCryptoError, openWithMemberKey, sealToMemberKey, type MemberKeyDomain, type SealedShare } from './keeper-crypto.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** The scheme name a wrap carries in its `kdfParams`. */
export const NAMES_KEY_ALG = 'x25519-xc20p-names-key-v1';
/** The version an entry's sealed text carries (`v`). */
export const NAMES_ENTRY_VERSION = 1;

/**
 * The sizes everything is held to, on the phone and on the node alike. A name and a note only: no address, no date of
 * birth, no ID number (design §4.3, data minimisation). The node keeps at most `entries` entries; a re-encryption after
 * a new key is sent `batch` at a time.
 */
export const NAMES_LIMITS = {
    nameChars: 100,
    noteChars: 500,
    /** The longest sealed text a node stores: the longest name and note, four bytes a character, padded and in base64. */
    ciphertextChars: 4096,
    entries: 2000,
    batch: 100,
} as const;

const KEY_LEN = 32;
const NONCE_LEN = 24;
const TAG_LEN = 16;
/** The sealed text's plaintext is padded to a multiple of this many bytes. */
export const ENTRY_PAD = 64;

const KEY_INFO = 'beanpool-names-key';
const ENTRY_AAD = 'beanpool-names-entry-v1';

/** Raised when a wrap or an entry can't be made or opened. The apps own the sentence an admin sees. */
export class NamesListCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NamesListCryptoError';
    }
}

/** A wrap as the node stores and returns it (names_list_keys): every field base64 but `kdfParams`, compact JSON. */
export interface WrappedNamesKey {
    wrappedKey: string;
    wrapIv: string;
    wrapTag: string;
    ephemeralPubkey: string;
    kdfParams: string;
}

/** What an entry holds once opened. */
export interface NamesEntryText {
    name: string;
    note: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

function holderHex(publicKey: string): string {
    const hex = typeof publicKey === 'string' ? publicKey.toLowerCase() : '';
    if (!HEX_KEY.test(hex)) throw new NamesListCryptoError('An admin key must be 64 hexadecimal characters.');
    return hex;
}

function wholeGeneration(generation: number): number {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new NamesListCryptoError('A list key generation is a whole number from 1.');
    return generation;
}

function keyDomain(generation: number, holder: string): MemberKeyDomain {
    return { alg: NAMES_KEY_ALG, info: KEY_INFO, aad: `beanpool-names-key-v1|${wholeGeneration(generation)}|${holderHex(holder)}` };
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

/** Wraps the list key of `generation` to one admin's account key (hex). */
export function wrapNamesListKey(listKey: Uint8Array, holderPublicKey: string, generation: number): WrappedNamesKey {
    const sealed = sealToMemberKey(requireListKey(listKey), holderHex(holderPublicKey), keyDomain(generation, holderPublicKey));
    return {
        wrappedKey: sealed.encryptedShare,
        wrapIv: sealed.shareIv,
        wrapTag: sealed.shareTag,
        ephemeralPubkey: sealed.ephemeralPubkey as string,
        kdfParams: sealed.kdfParams,
    };
}

/**
 * Opens this admin's own wrap with their identity key (PKCS8 or raw seed). `holderPublicKey` and `generation` are what
 * the phone expects the wrap to be: its own key, and the generation it asked for. A wrap made for anyone else, or for
 * another generation, doesn't open.
 */
export function unwrapNamesListKey(wrapped: WrappedNamesKey, privateKey: string | Uint8Array, holderPublicKey: string, generation: number): Uint8Array {
    const sealed: SealedShare = {
        encryptedShare: wrapped.wrappedKey,
        shareIv: wrapped.wrapIv,
        shareTag: wrapped.wrapTag,
        ephemeralPubkey: wrapped.ephemeralPubkey,
        kdfParams: wrapped.kdfParams,
    };
    try {
        const key = openWithMemberKey(sealed, privateKey, keyDomain(generation, holderPublicKey));
        return requireListKey(key);
    } catch (e) {
        if (e instanceof NamesListCryptoError) throw e;
        if (e instanceof KeeperCryptoError) throw new NamesListCryptoError(`The names list's key did not open: ${e.message}`);
        throw e;
    }
}

function entryAad(entryId: string, generation: number): Uint8Array {
    if (!isNamesEntryId(entryId)) throw new NamesListCryptoError('An entry id is 32 hexadecimal characters.');
    return utf8ToBytes(`${ENTRY_AAD}|${entryId}|${wholeGeneration(generation)}`);
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

/** Seals an entry's name and note under the list key of `generation`, bound to its id. Returns the text the node stores. */
export function sealNamesEntry(listKey: Uint8Array, entryId: string, generation: number, text: NamesEntryText): string {
    const checked = normaliseNamesEntryText(text);
    if (!checked.ok) throw new NamesListCryptoError(checked.error);
    assertRecoveryCsprngAvailable();
    const body = utf8ToBytes(JSON.stringify({ n: checked.value.name, t: checked.value.note }));
    // Trailing spaces are JSON whitespace, so the padded text parses as it was.
    const padded = new Uint8Array(Math.ceil((body.length + 1) / ENTRY_PAD) * ENTRY_PAD).fill(0x20);
    padded.set(body);
    const nonce = randomBytes(NONCE_LEN);
    const sealed = xchacha20poly1305(requireListKey(listKey), nonce, entryAad(entryId, generation)).encrypt(padded);
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
    const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
    if (!b64.test(p.n) || !b64.test(p.c)) return null;
    if (Buffer.from(p.n, 'base64').length !== NONCE_LEN) return null;
    const sealedLen = Buffer.from(p.c, 'base64').length;
    // At least one padded block and its tag, and always whole blocks.
    if (sealedLen < ENTRY_PAD + TAG_LEN || (sealedLen - TAG_LEN) % ENTRY_PAD !== 0) return null;
    return { v: p.v, n: p.n, c: p.c };
}

/**
 * Whether `ciphertext` has the shape {@link sealNamesEntry} makes: `{"v":1,"n":<24-byte nonce>,"c":<whole padded blocks
 * and a tag>}`, in base64, within the size limit. The node takes nothing else, so a phone that sent a name in the clear
 * by mistake is refused rather than stored.
 */
export function isNamesEntryCiphertext(ciphertext: unknown): ciphertext is string {
    return readSealedEntry(ciphertext) !== null;
}

/** Opens an entry with the list key of `generation`. A wrong key, id or generation, or an altered box, doesn't open. */
export function openNamesEntry(listKey: Uint8Array, entryId: string, generation: number, ciphertext: string): NamesEntryText {
    const sealed = readSealedEntry(ciphertext);
    if (!sealed) throw new NamesListCryptoError('An entry is not in the names list’s sealed form.');
    let plain: Uint8Array;
    try {
        plain = xchacha20poly1305(requireListKey(listKey), new Uint8Array(Buffer.from(sealed.n, 'base64')), entryAad(entryId, generation))
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

/** Whether `w` has a wrap's shape: base64 fields of the right widths and a `kdfParams` naming {@link NAMES_KEY_ALG}. */
export function isWrappedNamesKey(w: unknown): w is WrappedNamesKey {
    if (!w || typeof w !== 'object') return false;
    const r = w as Record<string, unknown>;
    const b64 = (v: unknown, bytes: number) => typeof v === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === bytes;
    if (!b64(r.wrappedKey, KEY_LEN) || !b64(r.wrapIv, NONCE_LEN) || !b64(r.wrapTag, TAG_LEN) || !b64(r.ephemeralPubkey, KEY_LEN)) return false;
    if (typeof r.kdfParams !== 'string' || r.kdfParams.length > 200) return false;
    try {
        const k = JSON.parse(r.kdfParams) as Record<string, unknown>;
        return !!k && k.alg === NAMES_KEY_ALG;
    } catch {
        return false;
    }
}
