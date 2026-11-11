/**
 * Private contacts: the lock (scratch/fable-design/DESIGN-private-contacts-fable.md §4.2, slice C0). A member's contacts
 * list is one locked blob, made on their device with a key only their account's secret makes, and kept as it is at every
 * community they belong to (slice C1, apps/server engine/contact-copies.ts). No server, admin or owner can open it, and
 * nobody but the member can make one that opens.
 *
 * ## The pieces
 *
 * - **The key**: HKDF-SHA256 over the account's 32-byte seed (salt `beanpool-contacts`, info `beanpool-contacts-key/1`).
 *   The seed always goes through {@link toEd25519Seed}: the web app keeps a PKCS8 key, the phone the bare seed, and fed raw
 *   a PKCS8 key makes a different key that opens nothing (the shared vectors catch it). One key for the member, the same
 *   on every device that holds the account; the same key whichever community the copy is kept at.
 * - **The box**: XChaCha20-Poly1305 (the DM path's cipher and library) with a fresh random 24-byte nonce for every save.
 *   Its associated data names this use, the owner's key and the copy's number (`beanpool-contacts/1|<owner>|<seq>`): a box
 *   shown as another member's, or under another number, doesn't open.
 * - **Padding**: the list's JSON is padded with spaces (JSON whitespace, so it parses as it was) to the next 16 KiB, so a
 *   server sees one of 32 sizes (16 KiB to 512 KiB), not a count. 16 KiB is about 150 contacts.
 * - **The header**: readable, and signed with the account key under its own first line, so no other signature by the key
 *   can be taken for it: the owner, the copy's number, the padded size, a digest of the locked bytes and the device's clock.
 *   The server checks the signature, the number and the size ({@link readContactsCopy}); the device checks the box too
 *   ({@link openContactsCopy}). The box is under the member's own secret, so the signature is a second check, not the only
 *   one (unlike the names copy's box, which anyone who knows the public key could make: design §4.2).
 *
 * Pure JavaScript (`@noble/*`), as the DM path, so it runs on Hermes, in the web app and on the server, which uses only
 * {@link readContactsCopy}: it never holds the key.
 */
import { Buffer } from 'buffer';
import { ed25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** The header's first line: no other statement starts with it. */
export const CONTACTS_COPY_STATEMENT = 'beanpool-contacts-copy/1';
/** The box's associated data starts with this, then `|owner|seq`. */
export const CONTACTS_AAD_TAG = 'beanpool-contacts/1';
/** The list's JSON is padded to a whole number of these. */
export const CONTACTS_PAD_STEP = 16 * 1024;
/** The most a padded list may be: 32 steps. The locked bytes are this and the 16-byte tag. */
export const CONTACTS_COPY_MAX_BYTES = 512 * 1024;

const HKDF_SALT = utf8ToBytes('beanpool-contacts');
const HKDF_INFO = utf8ToBytes('beanpool-contacts-key/1');
const KEY_LEN = 32;
const NONCE_LEN = 24;
const TAG_LEN = 16;
const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const WHOLE = /^[1-9][0-9]{0,14}$/;
const SAVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The largest copy number: a save a minute for a thousand years is far below it, and it stays a safe integer. */
export const CONTACTS_SEQ_MAX = 999_999_999_999_999;

/** Raised when a list can't be locked. Opening never throws: it answers a refusal. The apps own the sentence. */
export class ContactsCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContactsCryptoError';
    }
}

/** The member's keys as a device holds them: the public key (hex), and the identity key (raw seed or PKCS8, hex or bytes). */
export interface ContactsSigner {
    publicKey: string;
    privateKey: string | Uint8Array;
}

function seedOf(privateKey: string | Uint8Array): Uint8Array {
    return toEd25519Seed(typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey);
}

/** The contacts key of the account whose identity key this is (either spelling). The caller zeroes it when done. */
export function contactsKey(privateKey: string | Uint8Array): Uint8Array {
    const seed = seedOf(privateKey);
    try {
        return hkdf(sha256, seed, HKDF_SALT, HKDF_INFO, KEY_LEN);
    } finally {
        seed.fill(0);
    }
}

function aad(owner: string, seq: number): Uint8Array {
    return utf8ToBytes(`${CONTACTS_AAD_TAG}|${owner}|${seq}`);
}

function checkSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > CONTACTS_SEQ_MAX) throw new ContactsCryptoError('A copy’s number is a whole number from 1.');
}

/** How big `bytes` of list JSON is once padded: the next whole 16 KiB step, at least one. */
export function contactsPaddedSize(bytes: number): number {
    return Math.max(1, Math.ceil(bytes / CONTACTS_PAD_STEP)) * CONTACTS_PAD_STEP;
}

/** Whether `n` is a padded size a copy may have: a whole number of 16 KiB steps, from one to 32. */
export function isContactsPaddedSize(n: unknown): n is number {
    return Number.isSafeInteger(n) && (n as number) >= CONTACTS_PAD_STEP && (n as number) <= CONTACTS_COPY_MAX_BYTES && (n as number) % CONTACTS_PAD_STEP === 0;
}

/** The locked list: the nonce and the AEAD output (padded JSON and the tag), each in base64. */
export interface ContactsBox {
    nonce: string;
    sealed: string;
}

/**
 * Locks `json` (the list as {@link writeContactsList} makes it) for `owner` under copy number `seq`, with the key `privateKey`
 * makes. `nonceForVectors` is for the frozen vectors only: every real save takes a fresh random nonce. Throws
 * {@link ContactsCryptoError} for a list over {@link CONTACTS_COPY_MAX_BYTES} once padded ("too big").
 */
export function sealContactsBox(json: string, privateKey: string | Uint8Array, ctx: { owner: string; seq: number }, nonceForVectors?: Uint8Array): ContactsBox & { paddedSize: number } {
    const owner = typeof ctx.owner === 'string' ? ctx.owner.toLowerCase() : '';
    if (!HEX_KEY.test(owner)) throw new ContactsCryptoError('The owner is 64 hexadecimal characters.');
    checkSeq(ctx.seq);
    const body = utf8ToBytes(json);
    const paddedSize = contactsPaddedSize(body.length);
    if (paddedSize > CONTACTS_COPY_MAX_BYTES) throw new ContactsCryptoError('The contacts list is too big to lock.');
    // Trailing spaces are JSON whitespace: the padded text parses as it was.
    const padded = new Uint8Array(paddedSize).fill(0x20);
    padded.set(body);
    let nonce: Uint8Array;
    if (nonceForVectors) {
        if (nonceForVectors.length !== NONCE_LEN) throw new ContactsCryptoError('A nonce is 24 bytes.');
        nonce = nonceForVectors;
    } else {
        assertRecoveryCsprngAvailable();
        nonce = randomBytes(NONCE_LEN);
    }
    const key = contactsKey(privateKey);
    try {
        const sealed = xchacha20poly1305(key, nonce, aad(owner, ctx.seq)).encrypt(padded);
        return { nonce: Buffer.from(nonce).toString('base64'), sealed: Buffer.from(sealed).toString('base64'), paddedSize };
    } finally {
        key.fill(0);
        padded.fill(0);
    }
}

/** Opens a box for `owner` under `seq` with the key `privateKey` makes: the list's JSON text, or null when it doesn't open. */
export function openContactsBox(box: ContactsBox, privateKey: string | Uint8Array, ctx: { owner: string; seq: number }): string | null {
    const shape = readBoxShape(box);
    if (!shape) return null;
    const owner = typeof ctx.owner === 'string' ? ctx.owner.toLowerCase() : '';
    if (!HEX_KEY.test(owner) || !Number.isSafeInteger(ctx.seq) || ctx.seq < 1 || ctx.seq > CONTACTS_SEQ_MAX) return null;
    let key: Uint8Array;
    try { key = contactsKey(privateKey); } catch { return null; }
    try {
        const plain = xchacha20poly1305(key, shape.nonce, aad(owner, ctx.seq)).decrypt(shape.sealed);
        return Buffer.from(plain).toString('utf8').trimEnd();
    } catch {
        return null;
    } finally {
        key.fill(0);
    }
}

/** A box's bytes, or null when it isn't one: a 24-byte nonce, and whole padded steps within the cap with their tag. */
function readBoxShape(box: unknown): { nonce: Uint8Array; sealed: Uint8Array } | null {
    if (!box || typeof box !== 'object') return null;
    const { nonce, sealed } = box as { nonce?: unknown; sealed?: unknown };
    if (typeof nonce !== 'string' || typeof sealed !== 'string' || !B64.test(nonce) || !B64.test(sealed)) return null;
    if (sealed.length > Math.ceil((CONTACTS_COPY_MAX_BYTES + TAG_LEN) / 3) * 4) return null;
    const n = new Uint8Array(Buffer.from(nonce, 'base64'));
    const s = new Uint8Array(Buffer.from(sealed, 'base64'));
    if (n.length !== NONCE_LEN || !isContactsPaddedSize(s.length - TAG_LEN)) return null;
    return { nonce: n, sealed: s };
}

/** The digest the header names: SHA-256 over the nonce's bytes and then the locked bytes, in hex. */
export function contactsBoxDigest(box: ContactsBox): string {
    return bytesToHex(sha256(concatBytes(new Uint8Array(Buffer.from(box.nonce, 'base64')), new Uint8Array(Buffer.from(box.sealed, 'base64')))));
}

// ── The copy: the box under its signed header ──────────────────────────────────────────────────────────────────────

/** What a copy's header says. */
export interface ContactsCopyClaim {
    owner: string;
    seq: number;
    paddedSize: number;
    digest: string;
    /** The device's clock, ISO 8601 UTC to the second: shown to the member, never compared. */
    savedAt: string;
}

/** A copy as it is sent and kept: `{ header, signature, nonce, sealed }`, and the header's claim read out of it. */
export interface ContactsCopy extends ContactsCopyClaim, ContactsBox {
    header: string;
    signature: string;
}

/** What a copy sends and a server returns: the four fields alone. */
export type ContactsCopyWire = Pick<ContactsCopy, 'header' | 'signature' | 'nonce' | 'sealed'>;

/** The bytes the owner signs, as text (lines joined by `\n`, no trailing newline). */
export function contactsCopyHeader(c: ContactsCopyClaim): string {
    const owner = c.owner.toLowerCase();
    if (!HEX_KEY.test(owner) || !HEX_KEY.test(c.digest)) throw new ContactsCryptoError('A copy names its owner and digest in 64 hexadecimal characters.');
    checkSeq(c.seq);
    if (!isContactsPaddedSize(c.paddedSize)) throw new ContactsCryptoError('A copy’s size is a whole number of 16 KiB steps, at most 512 KiB.');
    if (!SAVED_AT.test(c.savedAt)) throw new ContactsCryptoError('A copy’s time is ISO 8601 UTC to the second.');
    return [CONTACTS_COPY_STATEMENT, owner, String(c.seq), String(c.paddedSize), c.digest, c.savedAt].join('\n');
}

/** A time as a header carries it: ISO 8601 UTC to the second. */
export function contactsSavedAt(when: Date = new Date()): string {
    return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A copy of `json` (the list's JSON) locked and signed by `me` under copy number `seq`. Throws {@link ContactsCryptoError}
 * for a list too big to lock, and for keys that don't match (the public key is checked against the private one, so a copy
 * is never signed for an account other than the one whose key locks it).
 */
export function makeContactsCopy(opts: { json: string; me: ContactsSigner; seq: number; savedAt?: string | Date; nonceForVectors?: Uint8Array }): ContactsCopy {
    const seed = seedOf(opts.me.privateKey);
    try {
        const owner = bytesToHex(ed25519.getPublicKey(seed));
        if (owner !== opts.me.publicKey.toLowerCase()) throw new ContactsCryptoError('A copy is signed by the key that locks it.');
        const box = sealContactsBox(opts.json, seed, { owner, seq: opts.seq }, opts.nonceForVectors);
        const when = opts.savedAt === undefined ? new Date() : opts.savedAt;
        const claim: ContactsCopyClaim = {
            owner, seq: opts.seq, paddedSize: box.paddedSize, digest: contactsBoxDigest(box), savedAt: typeof when === 'string' ? when : contactsSavedAt(when),
        };
        const header = contactsCopyHeader(claim);
        const signature = bytesToHex(ed25519.sign(utf8ToBytes(header), seed));
        return { ...claim, header, signature, nonce: box.nonce, sealed: box.sealed };
    } finally {
        seed.fill(0);
    }
}

/** Why a copy is refused: its shape, its signature, a size that isn't a 16 KiB step, one over the cap, or a box its header doesn't name. */
export type ContactsCopyRefusal = { ok: false; reason: 'shape' | 'signature' | 'size_step' | 'too_big' | 'digest' };

/**
 * A copy from what a device sent or a server returned (`{ header, signature, nonce, sealed }`): the header in its one
 * form, the signature checked for the owner it names (strict RFC 8032), the locked bytes' size a whole number of steps
 * within the cap and the header's, and their digest the header's. What a server checks on a save; the first half of
 * {@link openContactsCopy}. Never a partial result.
 */
export function readContactsCopy(raw: unknown): { ok: true; copy: ContactsCopy } | ContactsCopyRefusal {
    const no = (reason: ContactsCopyRefusal['reason']): ContactsCopyRefusal => ({ ok: false, reason });
    if (!raw || typeof raw !== 'object') return no('shape');
    const { header, signature, nonce, sealed } = raw as Record<string, unknown>;
    if (typeof header !== 'string' || header.length > 400 || typeof nonce !== 'string' || typeof sealed !== 'string') return no('shape');
    const lines = header.split('\n');
    if (lines.length !== 6 || lines[0] !== CONTACTS_COPY_STATEMENT) return no('shape');
    const [, owner, seqText, sizeText, digest, savedAt] = lines;
    if (!HEX_KEY.test(owner) || !WHOLE.test(seqText) || !WHOLE.test(sizeText) || !HEX_KEY.test(digest) || !SAVED_AT.test(savedAt)) return no('shape');
    const seq = Number(seqText);
    const paddedSize = Number(sizeText);
    if (seq > CONTACTS_SEQ_MAX) return no('shape');
    if (typeof signature !== 'string' || !HEX_SIG.test(signature.toLowerCase())) return no('signature');
    try {
        if (!ed25519.verify(hexToBytes(signature.toLowerCase()), utf8ToBytes(header), hexToBytes(owner), { zip215: false })) return no('signature');
    } catch {
        return no('signature');
    }
    // The size, before anything decodes the bytes: a step that isn't one is malformed, one past the cap too big.
    if (paddedSize > CONTACTS_COPY_MAX_BYTES) return no('too_big');
    if (!isContactsPaddedSize(paddedSize)) return no('size_step');
    if (!B64.test(nonce) || Buffer.from(nonce, 'base64').length !== NONCE_LEN) return no('shape');
    if (!B64.test(sealed)) return no('shape');
    const sealedBytes = Buffer.byteLength(sealed, 'base64');
    if (sealedBytes - TAG_LEN > CONTACTS_COPY_MAX_BYTES) return no('too_big');
    if (sealedBytes - TAG_LEN !== paddedSize) return no('size_step');
    if (contactsBoxDigest({ nonce, sealed }) !== digest) return no('digest');
    return { ok: true, copy: { owner, seq, paddedSize, digest, savedAt, header, signature: signature.toLowerCase(), nonce, sealed } };
}

/** Why a device refuses a copy it was given: {@link readContactsCopy}'s reasons, another member's copy, or a box that doesn't open. */
export type ContactsCopyOpenRefusal = ContactsCopyRefusal | { ok: false; reason: 'not_mine' | 'box' };

/**
 * A device's whole check of a copy a server returned: {@link readContactsCopy}, the owner `me`, and the box opened with
 * `me`'s key for the owner and number its header names. Returns the list's JSON text for {@link readContactsList}.
 */
export function openContactsCopy(raw: unknown, me: ContactsSigner): { ok: true; json: string; copy: ContactsCopy } | ContactsCopyOpenRefusal {
    const read = readContactsCopy(raw);
    if (!read.ok) return read;
    if (read.copy.owner !== me.publicKey.toLowerCase()) return { ok: false, reason: 'not_mine' };
    const json = openContactsBox(read.copy, me.privateKey, { owner: read.copy.owner, seq: read.copy.seq });
    if (json === null) return { ok: false, reason: 'box' };
    return { ok: true, json, copy: read.copy };
}

/** The wire form of a copy: what a device sends in a save and a server returns. */
export function contactsCopyWire(c: ContactsCopy): ContactsCopyWire {
    return { header: c.header, signature: c.signature, nonce: c.nonce, sealed: c.sealed };
}
