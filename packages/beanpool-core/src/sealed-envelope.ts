/**
 * Sealed envelopes (`bpseal/v1`) — a payload locked to a community's owners and its printed
 * recovery code, so that any ONE of them can open it and nobody else can.
 *
 * Design authority: scratch/overnight/design/sealed-keys.md §2 (Fable, 2026-09-19). This module is
 * slice 1 of that design: the format and the primitives, with no callers yet. The take-over bundle
 * (§2.1) and sealed backups (§6) are built on it in later slices.
 *
 * ## Shape
 *
 * A hybrid envelope. The payload is encrypted ONCE, in chunks, under a random 32-byte data key
 * (the DEK); the DEK is wrapped once per recipient. On the wire:
 *
 *     u32be headerLength ‖ header (canonical JSON, UTF-8) ‖ chunk₀ ‖ chunk₁ ‖ … ‖ chunkₙ
 *
 * - **Recipient stanzas** (§2.2, §2.3): ephemeral X25519 → ECDH with the recipient's X25519 public
 *   key → HKDF-SHA256 (info `beanpool-seal-dek-v1`) → XChaCha20-Poly1305 over the DEK, with
 *   AAD = `"bpseal/v1" ‖ kind ‖ envelopeId ‖ recipient pubkey`. For an owner, the recipient key is
 *   their existing Ed25519 member key converted to X25519, so an owner who restores their 12 words
 *   onto a new phone can open the envelope with nothing else. For the recovery code (§2.6), it is
 *   `x25519(scrypt(code))`, so the server that seals never holds the code.
 * - **Body** (§2.2): XChaCha20-Poly1305 chunks of `chunkSize` plaintext bytes under the DEK.
 *   Nonce = envelopeId (16 bytes) ‖ u32be chunk index ‖ u32be final flag; AAD = SHA-256 of the
 *   exact header bytes, signature included. A reordered chunk fails on its index, a dropped final
 *   chunk leaves a non-final chunk last, a truncated chunk fails its tag, and a header edited by
 *   one byte changes the AAD of every chunk.
 * - **Header signature** (§2.2): Ed25519 over the canonical header minus `sig`, by the node's
 *   libp2p key, so a standby can check the envelope came from its pinned primary. Opening does NOT
 *   need it: a passing AEAD tag is proof enough for an owner, who has no pin to check against.
 *
 * ## What the AEAD binds, and why it can here when keeper-crypto could not
 *
 * `keeper-crypto.ts` binds its fragments to a fixed label because the reader there cannot learn
 * the owner's pubkey. Here the opener always knows its own public key (owners derive it from the
 * seed; the code derives it from the code), so each stanza binds to the recipient it was made for,
 * and the envelope's kind and id. A stanza lifted into another envelope, or relabelled from
 * `takeover` to `backup`, fails its tag.
 *
 * ## Key formats
 *
 * Owner private keys go through {@link toEd25519Seed} and nowhere else (§2.5). The PWA stores a
 * 48-byte PKCS8 envelope, native stores the bare 32-byte seed; fed raw, a PKCS8 key derives a
 * different X25519 secret and fails the tag with no hint why.
 *
 * ## Hermes
 *
 * Pure JavaScript, on the same three noble libraries as keeper-crypto and the DM path, which
 * already run on Hermes. Bytes → text uses `Buffer` rather than `TextDecoder` for the same reason.
 */

import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** The format identifier: written into every header, and the first element of every stanza AAD. */
export const SEALED_ENVELOPE_VERSION = 'bpseal/v1';

/** The only two things this format seals. A closed set, so the AAD concatenation is unambiguous. */
export type SealedEnvelopeKind = 'takeover' | 'backup';
const KINDS: readonly SealedEnvelopeKind[] = ['takeover', 'backup'];

/** §2.2: 1 MiB plaintext per chunk. Also the ceiling an opener will accept. */
export const SEALED_ENVELOPE_CHUNK_SIZE = 1_048_576;
/** Smallest chunk an opener accepts — small enough for tests, large enough to stop a header
 *  asking for millions of 16-byte tags. */
const MIN_CHUNK_SIZE = 1024;

/** The largest header an opener will read. Recipients are a handful of owners and a code. */
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_RECIPIENTS = 256;

const KEY_LEN = 32;
const XNONCE_LEN = 24;
const TAG_LEN = 16;
const ENVELOPE_ID_LEN = 16;
const HEADER_LEN_PREFIX = 4;

const HKDF_INFO_DEK = utf8ToBytes('beanpool-seal-dek-v1');
const VERSION_BYTES = utf8ToBytes(SEALED_ENVELOPE_VERSION);

/**
 * Recovery-code scrypt cost (§2.6): the same cost and the same floor and ceiling as
 * keeper-crypto's sign-in fragment. The floor stops a tampered header weakening its own key; the
 * ceiling stops one asking a phone for gigabytes (scrypt memory ≈ 128·N·r; 65536 × 8 ≈ 67 MB).
 */
export const RECOVERY_CODE_SCRYPT = { N: 16384, r: 8, p: 1, dkLen: 32 } as const;
export const RECOVERY_CODE_SCRYPT_MIN_N = 16384;
export const RECOVERY_CODE_SCRYPT_MAX_N = 65536;

/** 128 bits of entropy per code (§2.6). */
const CODE_ENTROPY_LEN = 16;
/** 128 bits → 26 base32 characters (the last carries 3 bits and 2 zero pad bits). */
const CODE_DATA_CHARS = 26;
/** 10 check bits → 2 characters. */
const CODE_CHECK_CHARS = 2;
const CODE_CHARS = CODE_DATA_CHARS + CODE_CHECK_CHARS;
const CODE_PREFIX = 'BPRC';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Raised when an envelope cannot be sealed or opened. Callers match on the class (or `name`), not
 * the message: the sentence a frightened owner reads belongs to the client.
 */
export class SealedEnvelopeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SealedEnvelopeError';
    }
}

/**
 * The typed recovery code is not a code: wrong length, a character that is not in the alphabet,
 * or check characters that do not match. Always raised BEFORE any scrypt work, so a typo costs
 * nothing and says "check what you typed" rather than "wrong code".
 */
export class RecoveryCodeError extends SealedEnvelopeError {
    constructor(message: string) {
        super(message);
        this.name = 'RecoveryCodeError';
    }
}

// ── Header types ────────────────────────────────────────────────────────────────────────────

export interface OwnerStanza {
    type: 'owner';
    /** Ed25519 member pubkey, lowercase hex. */
    pubkey: string;
    callsign: string;
    /** Ephemeral X25519 public key, base64. */
    eph: string;
    /** 24-byte XChaCha nonce, base64. */
    nonce: string;
    /** The wrapped DEK with its Poly1305 tag (48 bytes), base64. */
    wrappedDek: string;
}

/**
 * The public record of a recovery code — everything the server keeps, and nothing that opens.
 * `codePub` is `x25519.getPublicKey(scrypt(entropy, salt))`.
 */
export interface RecoveryCodeRecord {
    /** The code number printed as `BPRC-<codeId>`. Not secret. */
    codeId: number;
    /** X25519 public key, base64. */
    codePub: string;
    /** scrypt salt, base64. */
    salt: string;
    N: number;
    r: number;
    p: number;
    /** ISO 8601. */
    createdAt: string;
}

export interface CodeStanza extends RecoveryCodeRecord {
    type: 'code';
    eph: string;
    nonce: string;
    wrappedDek: string;
}

export type RecipientStanza = OwnerStanza | CodeStanza;

export interface SealedEnvelopeHeader {
    v: typeof SEALED_ENVELOPE_VERSION;
    kind: SealedEnvelopeKind;
    /** 16 random bytes, lowercase hex. Also the body nonce prefix. */
    envelopeId: string;
    communityId: string;
    nodePeerId: string;
    /** ISO 8601. */
    createdAt: string;
    recipients: RecipientStanza[];
    chunkSize: number;
    /** Ed25519 signature over the canonical header minus `sig`, base64. */
    sig: string;
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function unb64(value: unknown, field: string, expectedLen?: number): Uint8Array {
    if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new SealedEnvelopeError(`Envelope field '${field}' is missing or not base64.`);
    }
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (expectedLen !== undefined && bytes.length !== expectedLen) {
        throw new SealedEnvelopeError(`Envelope field '${field}' must be ${expectedLen} bytes, got ${bytes.length}.`);
    }
    return bytes;
}

/** Key material from hex or a byte array. Same width rule as keeper-crypto's `asBytes`. */
function asBytes(key: string | Uint8Array, field: string): Uint8Array {
    if (ArrayBuffer.isView(key) && (key as Uint8Array).BYTES_PER_ELEMENT === 1) {
        return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    }
    if (typeof key !== 'string' || !/^[0-9a-fA-F]+$/.test(key) || key.length % 2 !== 0) {
        throw new SealedEnvelopeError(`${field} must be hex or raw bytes.`);
    }
    return hexToBytes(key.toLowerCase());
}

function requireKey32(key: string | Uint8Array, field: string): Uint8Array {
    const bytes = asBytes(key, field);
    if (bytes.length !== KEY_LEN) {
        throw new SealedEnvelopeError(`${field} must be ${KEY_LEN} bytes, got ${bytes.length}.`);
    }
    return bytes;
}

/**
 * The single entry point for an Ed25519 private key (§2.5): 32-byte seed or 48-byte PKCS8, hex or
 * bytes. `toEd25519Seed` throws a bare Error on a bad PKCS8 header; restated here as this module's
 * error so a caller matching on {@link SealedEnvelopeError} catches it.
 */
function privateSeed(key: string | Uint8Array, field: string): Uint8Array {
    const bytes = asBytes(key, field);
    try {
        return toEd25519Seed(bytes);
    } catch (e) {
        throw new SealedEnvelopeError(`${field}: ${(e as Error).message}`);
    }
}

function edToX25519Public(edPublicKey: Uint8Array, what: string): Uint8Array {
    try {
        return ed25519.utils.toMontgomery(edPublicKey);
    } catch (e) {
        throw new SealedEnvelopeError(`${what} is not a usable Ed25519 point: ${(e as Error).message}`);
    }
}

/**
 * ECDH into the stanza key. `@noble/curves` refuses the all-zero shared secret (RFC 7748 §6.1),
 * which is what rejects all six small-order Ed25519 points once converted; keeper-crypto measured
 * this and its tests, and this module's, pin it. Restated as {@link SealedEnvelopeError}.
 */
function agreeKey(mySecret: Uint8Array, theirPublic: Uint8Array, what: string): Uint8Array {
    try {
        return hkdf(sha256, x25519.getSharedSecret(mySecret, theirPublic), undefined, HKDF_INFO_DEK, KEY_LEN);
    } catch (e) {
        throw new SealedEnvelopeError(`${what} could not be agreed: ${(e as Error).message}`);
    }
}

function stanzaAad(kind: SealedEnvelopeKind, envelopeId: Uint8Array, recipientPub: Uint8Array): Uint8Array {
    return concatBytes(VERSION_BYTES, utf8ToBytes(kind), envelopeId, recipientPub);
}

function u32be(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n, false);
    return out;
}

function chunkNonce(envelopeId: Uint8Array, index: number, final: boolean): Uint8Array {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
        throw new SealedEnvelopeError('The envelope has more chunks than its format can count.');
    }
    return concatBytes(envelopeId, u32be(index), u32be(final ? 1 : 0));
}

/** A macrotask yield between chunks, so sealing a large backup never stalls the event loop. */
function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function isoNow(): string {
    return new Date().toISOString();
}

// ── Canonical JSON ──────────────────────────────────────────────────────────────────────────

/**
 * How deep canonical JSON will nest. A real header is four levels deep; a hostile one under the
 * 256 KiB header cap could otherwise nest far enough to overflow the stack with a RangeError
 * instead of this module's error.
 */
const MAX_JSON_DEPTH = 32;

/**
 * Canonical JSON: object keys sorted, no whitespace, integers only. The header is signed and
 * hashed in this form, and an opener refuses a header whose bytes are not already canonical, so
 * there is exactly one byte string for any header.
 */
export function canonicalJson(value: unknown, depth = 0): string {
    if (depth > MAX_JSON_DEPTH) {
        throw new SealedEnvelopeError(`Canonical JSON nests deeper than ${MAX_JSON_DEPTH} levels.`);
    }
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new SealedEnvelopeError(`Canonical JSON admits only safe integers, got ${value}.`);
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`).join(',')}}`;
    }
    throw new SealedEnvelopeError(`Canonical JSON cannot encode a ${typeof value}.`);
}

function unsignedHeaderBytes(header: Omit<SealedEnvelopeHeader, 'sig'> | SealedEnvelopeHeader): Uint8Array {
    return utf8ToBytes(canonicalJson({ ...header, sig: undefined }));
}

// ── Recovery code (§2.6) ────────────────────────────────────────────────────────────────────

function base32Encode(bytes: Uint8Array, chars: number): string {
    let out = '';
    let acc = 0;
    let bits = 0;
    for (const b of bytes) {
        acc = (acc << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += CROCKFORD[(acc >>> (bits - 5)) & 31];
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
    }
    if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
    return out.slice(0, chars);
}

/** 10 check bits: the first 10 bits of SHA-256 of the entropy, as two characters. */
function checkChars(entropy: Uint8Array): string {
    const h = sha256(entropy);
    const bits10 = (h[0] << 2) | (h[1] >>> 6);
    return CROCKFORD[(bits10 >>> 5) & 31] + CROCKFORD[bits10 & 31];
}

/**
 * The printed form: `BPRC-3  XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` — 26 data characters then 2 check
 * characters, in groups of four.
 */
export function formatRecoveryCode(codeId: number, entropy: Uint8Array): string {
    requireCodeId(codeId);
    if (entropy.length !== CODE_ENTROPY_LEN) {
        throw new RecoveryCodeError(`A recovery code carries ${CODE_ENTROPY_LEN} bytes, got ${entropy.length}.`);
    }
    const body = base32Encode(entropy, CODE_DATA_CHARS) + checkChars(entropy);
    const groups = body.match(/.{4}/g)!;
    return `${CODE_PREFIX}-${codeId}  ${groups.join('-')}`;
}

export interface ParsedRecoveryCode {
    /** The code number, when the `BPRC-n` prefix was typed. */
    codeId?: number;
    /** The 16 bytes of entropy — the scrypt password. */
    entropy: Uint8Array;
}

/**
 * Read a typed recovery code. Case-insensitive; spaces and hyphens ignored; `I`/`L` → `1`,
 * `O` → `0` (Crockford). The `BPRC-n` prefix is optional.
 *
 * Every rejection here is a {@link RecoveryCodeError} and happens before any key derivation. The
 * check characters catch a mistyped character with probability 1 − 2⁻¹⁰, and a change that only
 * touches the final character's two pad bits is refused as non-canonical.
 */
export function parseRecoveryCode(input: string): ParsedRecoveryCode {
    if (typeof input !== 'string') throw new RecoveryCodeError('A recovery code must be text.');
    let s = input.toUpperCase().replace(/[\s\-_]/g, '');
    let codeId: number | undefined;
    if (s.startsWith(CODE_PREFIX) && s.length > CODE_CHARS) {
        const idPart = s.slice(CODE_PREFIX.length, s.length - CODE_CHARS);
        if (!/^[0-9]+$/.test(idPart)) {
            throw new RecoveryCodeError('The code number after BPRC is not a number.');
        }
        codeId = Number(idPart);
        // A typed number of 0 is a typo like any other: the same class, so "check what you
        // typed" handlers catch it.
        if (!Number.isSafeInteger(codeId) || codeId < 1) {
            throw new RecoveryCodeError(`There is no recovery code #${idPart}: check what you typed.`);
        }
        s = s.slice(s.length - CODE_CHARS);
    }
    s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
    if (s.length !== CODE_CHARS) {
        throw new RecoveryCodeError(`A recovery code has ${CODE_CHARS} characters; this has ${s.length}.`);
    }
    const values: number[] = [];
    for (const ch of s) {
        const v = CROCKFORD.indexOf(ch);
        if (v < 0) throw new RecoveryCodeError(`'${ch}' is not a character a recovery code uses.`);
        values.push(v);
    }
    // 26 × 5 = 130 bits: 128 of entropy, then 2 pad bits that must be zero.
    const entropy = new Uint8Array(CODE_ENTROPY_LEN);
    let acc = 0;
    let bits = 0;
    let pos = 0;
    for (let i = 0; i < CODE_DATA_CHARS; i++) {
        acc = (acc << 5) | values[i];
        bits += 5;
        if (bits >= 8) {
            entropy[pos++] = (acc >>> (bits - 8)) & 0xff;
            bits -= 8;
            acc &= (1 << bits) - 1;
        }
    }
    if (bits !== 2 || acc !== 0) {
        throw new RecoveryCodeError('That recovery code has a typo: check what you typed.');
    }
    if (s.slice(CODE_DATA_CHARS) !== checkChars(entropy)) {
        throw new RecoveryCodeError('That recovery code has a typo: check what you typed.');
    }
    return { codeId, entropy };
}

function requireCodeId(codeId: unknown): asserts codeId is number {
    if (typeof codeId !== 'number' || !Number.isSafeInteger(codeId) || codeId < 1) {
        throw new SealedEnvelopeError(`A recovery code number must be a positive integer, got ${String(codeId)}.`);
    }
}

/** Refuse costs outside the floor/ceiling, and any r/p this module never writes. */
function requireScryptParams(N: unknown, r: unknown, p: unknown): void {
    if (typeof N !== 'number' || !Number.isInteger(N) || N < RECOVERY_CODE_SCRYPT_MIN_N || N > RECOVERY_CODE_SCRYPT_MAX_N
        || (N & (N - 1)) !== 0) {
        throw new SealedEnvelopeError(
            `A recovery-code stanza claims a scrypt cost of ${String(N)}, outside the permitted range `
            + `${RECOVERY_CODE_SCRYPT_MIN_N}–${RECOVERY_CODE_SCRYPT_MAX_N}.`,
        );
    }
    if (r !== RECOVERY_CODE_SCRYPT.r || p !== RECOVERY_CODE_SCRYPT.p) {
        throw new SealedEnvelopeError(
            `A recovery-code stanza claims scrypt r=${String(r)}, p=${String(p)}; only r=${RECOVERY_CODE_SCRYPT.r}, `
            + `p=${RECOVERY_CODE_SCRYPT.p} is accepted.`,
        );
    }
}

async function deriveCodeSecret(entropy: Uint8Array, salt: Uint8Array, N: number): Promise<Uint8Array> {
    try {
        return await scryptAsync(entropy, salt, {
            N, r: RECOVERY_CODE_SCRYPT.r, p: RECOVERY_CODE_SCRYPT.p, dkLen: RECOVERY_CODE_SCRYPT.dkLen,
        });
    } catch (e) {
        throw new SealedEnvelopeError(`The recovery code's key could not be derived: ${(e as Error).message}`);
    }
}

/**
 * Make a new recovery code (§2.6). Returns the printed code — shown ONCE and never stored — and
 * the public record the server keeps. Sealing to the code needs only the record.
 */
export async function createRecoveryCode(
    codeId: number, opts: { createdAt?: string } = {},
): Promise<{ code: string; record: RecoveryCodeRecord }> {
    requireCodeId(codeId);
    assertRecoveryCsprngAvailable();
    const entropy = randomBytes(CODE_ENTROPY_LEN);
    const salt = randomBytes(KEY_LEN);
    const secret = await deriveCodeSecret(entropy, salt, RECOVERY_CODE_SCRYPT.N);
    return {
        code: formatRecoveryCode(codeId, entropy),
        record: {
            codeId,
            codePub: b64(x25519.getPublicKey(secret)),
            salt: b64(salt),
            N: RECOVERY_CODE_SCRYPT.N,
            r: RECOVERY_CODE_SCRYPT.r,
            p: RECOVERY_CODE_SCRYPT.p,
            createdAt: opts.createdAt ?? isoNow(),
        },
    };
}

/** The code parsed cleanly but is a different code from the one on record. Internal. */
class WrongRecoveryCodeError extends SealedEnvelopeError {}

/**
 * Derive the code's X25519 secret against a record, checking in the order that costs least:
 * typo (free) → code number → scrypt bounds → scrypt → public key comparison.
 */
async function codeSecretFor(code: string, record: RecoveryCodeRecord): Promise<Uint8Array> {
    const parsed = parseRecoveryCode(code);
    if (parsed.codeId !== undefined && parsed.codeId !== record.codeId) {
        throw new WrongRecoveryCodeError(`This needs recovery code #${record.codeId}; the code typed is #${parsed.codeId}.`);
    }
    requireScryptParams(record.N, record.r, record.p);
    const salt = unb64(record.salt, 'salt');
    const codePub = unb64(record.codePub, 'codePub', KEY_LEN);
    const secret = await deriveCodeSecret(parsed.entropy, salt, record.N);
    const derived = x25519.getPublicKey(secret);
    if (bytesToHex(derived) !== bytesToHex(codePub)) {
        throw new WrongRecoveryCodeError(`That is not recovery code #${record.codeId}.`);
    }
    return secret;
}

/**
 * "Check the code" (§7): does this typed code match the stored record? A typo still throws
 * {@link RecoveryCodeError}, so the screen can say which of the two happened.
 */
export async function checkRecoveryCode(code: string, record: RecoveryCodeRecord): Promise<boolean> {
    try {
        await codeSecretFor(code, record);
        return true;
    } catch (e) {
        if (e instanceof WrongRecoveryCodeError) return false;
        throw e;
    }
}

// ── Sealing ─────────────────────────────────────────────────────────────────────────────────

export interface SealRecipients {
    owners: { pubkey: string | Uint8Array; callsign: string }[];
    codes?: RecoveryCodeRecord[];
}

export interface SealOptions {
    kind: SealedEnvelopeKind;
    communityId: string;
    nodePeerId: string;
    recipients: SealRecipients;
    /** The node's Ed25519 identity key (32-byte seed or 48-byte PKCS8, hex or bytes). */
    signingKey: string | Uint8Array;
    /** Default {@link SEALED_ENVELOPE_CHUNK_SIZE}. Smaller only for tests. */
    chunkSize?: number;
    /** ISO 8601; default now. */
    createdAt?: string;
}

function requireKind(kind: unknown): asserts kind is SealedEnvelopeKind {
    if (!KINDS.includes(kind as SealedEnvelopeKind)) {
        throw new SealedEnvelopeError(`An envelope's kind must be 'takeover' or 'backup', got '${String(kind)}'.`);
    }
}

function requireChunkSize(chunkSize: unknown): asserts chunkSize is number {
    if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize)
        || chunkSize < MIN_CHUNK_SIZE || chunkSize > SEALED_ENVELOPE_CHUNK_SIZE) {
        throw new SealedEnvelopeError(
            `An envelope's chunk size must be ${MIN_CHUNK_SIZE}–${SEALED_ENVELOPE_CHUNK_SIZE} bytes, got ${String(chunkSize)}.`,
        );
    }
}

function requireText(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new SealedEnvelopeError(`Envelope field '${field}' must be non-empty text.`);
    }
}

function wrapDek(
    dek: Uint8Array, recipientX: Uint8Array, aad: Uint8Array, what: string,
): { eph: string; nonce: string; wrappedDek: string } {
    const ephSecret = randomBytes(KEY_LEN);
    const ephPub = x25519.getPublicKey(ephSecret);
    const key = agreeKey(ephSecret, recipientX, what);
    const nonce = randomBytes(XNONCE_LEN);
    const wrapped = xchacha20poly1305(key, nonce, aad).encrypt(dek);
    return { eph: b64(ephPub), nonce: b64(nonce), wrappedDek: b64(wrapped) };
}

interface Sealer {
    headerBytes: Uint8Array;
    header: SealedEnvelopeHeader;
    encryptChunk(index: number, final: boolean, plain: Uint8Array): Uint8Array;
}

function prepareSeal(opts: SealOptions): Sealer {
    requireKind(opts.kind);
    requireText(opts.communityId, 'communityId');
    requireText(opts.nodePeerId, 'nodePeerId');
    const chunkSize = opts.chunkSize ?? SEALED_ENVELOPE_CHUNK_SIZE;
    requireChunkSize(chunkSize);
    const owners = opts.recipients?.owners ?? [];
    const codes = opts.recipients?.codes ?? [];
    if (owners.length + codes.length === 0) {
        // §9: no owner and no code means nobody to seal to — the caller makes no envelope.
        throw new SealedEnvelopeError('An envelope needs at least one owner or recovery code to seal to.');
    }
    if (owners.length + codes.length > MAX_RECIPIENTS) {
        throw new SealedEnvelopeError(`An envelope can hold at most ${MAX_RECIPIENTS} recipients.`);
    }
    const signingSeed = privateSeed(opts.signingKey, 'signingKey');
    assertRecoveryCsprngAvailable();

    const dek = randomBytes(KEY_LEN);
    const envelopeId = randomBytes(ENVELOPE_ID_LEN);
    const recipients: RecipientStanza[] = [];
    const seenOwners = new Set<string>();
    for (const owner of owners) {
        const edPub = requireKey32(owner.pubkey, 'owner pubkey');
        const hex = bytesToHex(edPub);
        if (seenOwners.has(hex)) throw new SealedEnvelopeError(`Owner ${hex} is listed twice.`);
        seenOwners.add(hex);
        requireText(owner.callsign, 'callsign');
        const ownerX = edToX25519Public(edPub, `Owner ${owner.callsign}'s key`);
        recipients.push({
            type: 'owner',
            pubkey: hex,
            callsign: owner.callsign,
            ...wrapDek(dek, ownerX, stanzaAad(opts.kind, envelopeId, edPub), `A key with owner ${owner.callsign}`),
        });
    }
    const seenCodes = new Set<number>();
    for (const code of codes) {
        requireCodeId(code.codeId);
        if (seenCodes.has(code.codeId)) throw new SealedEnvelopeError(`Recovery code #${code.codeId} is listed twice.`);
        seenCodes.add(code.codeId);
        requireScryptParams(code.N, code.r, code.p);
        unb64(code.salt, 'salt');
        requireText(code.createdAt, 'code createdAt');
        const codePub = unb64(code.codePub, 'codePub', KEY_LEN);
        recipients.push({
            type: 'code',
            codeId: code.codeId,
            codePub: code.codePub,
            salt: code.salt,
            N: code.N,
            r: code.r,
            p: code.p,
            createdAt: code.createdAt,
            ...wrapDek(dek, codePub, stanzaAad(opts.kind, envelopeId, codePub), `A key with recovery code #${code.codeId}`),
        });
    }

    const unsigned: Omit<SealedEnvelopeHeader, 'sig'> = {
        v: SEALED_ENVELOPE_VERSION,
        kind: opts.kind,
        envelopeId: bytesToHex(envelopeId),
        communityId: opts.communityId,
        nodePeerId: opts.nodePeerId,
        createdAt: opts.createdAt ?? isoNow(),
        recipients,
        chunkSize,
    };
    const header: SealedEnvelopeHeader = {
        ...unsigned,
        sig: b64(ed25519.sign(unsignedHeaderBytes(unsigned), signingSeed)),
    };
    const headerJson = utf8ToBytes(canonicalJson(header));
    const headerBytes = concatBytes(u32be(headerJson.length), headerJson);
    const bodyAad = sha256(headerJson);
    return {
        header,
        headerBytes,
        encryptChunk: (index, final, plain) =>
            xchacha20poly1305(dek, chunkNonce(envelopeId, index, final), bodyAad).encrypt(plain),
    };
}

/**
 * Seal a payload as a stream: yields the header, then one ciphertext chunk at a time, yielding to
 * the event loop between chunks. `source` may deliver pieces of any size; they are re-cut to
 * `chunkSize`. For backups (§6), which run up to the 500 MB restore cap.
 */
export async function* sealEnvelopeStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: SealOptions,
): AsyncGenerator<Uint8Array> {
    const sealer = prepareSeal(opts);
    const chunkSize = sealer.header.chunkSize;
    yield sealer.headerBytes;
    const queue = new ByteQueue();
    let index = 0;
    for await (const piece of source as AsyncIterable<Uint8Array>) {
        queue.push(piece);
        // Strictly greater: a full chunk is held back until we know whether it is the last.
        while (queue.length > chunkSize) {
            yield sealer.encryptChunk(index++, false, queue.take(chunkSize));
            await yieldToEventLoop();
        }
    }
    yield sealer.encryptChunk(index, true, queue.take(queue.length));
}

/** Seal a whole payload in memory. For the take-over bundle (§2.1), which is one chunk. */
export async function sealEnvelope(payload: Uint8Array, opts: SealOptions): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const part of sealEnvelopeStream([payload], opts)) parts.push(part);
    return concatBytes(...parts);
}

// ── Header reading and signature ────────────────────────────────────────────────────────────

function validateStanza(s: unknown, i: number): RecipientStanza {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new SealedEnvelopeError(`Recipient ${i} is not an object.`);
    }
    const r = s as Record<string, unknown>;
    unb64(r.eph, `recipients[${i}].eph`, KEY_LEN);
    unb64(r.nonce, `recipients[${i}].nonce`, XNONCE_LEN);
    unb64(r.wrappedDek, `recipients[${i}].wrappedDek`, KEY_LEN + TAG_LEN);
    if (r.type === 'owner') {
        if (typeof r.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(r.pubkey)) {
            throw new SealedEnvelopeError(`Recipient ${i} has no usable owner pubkey.`);
        }
        requireText(r.callsign, `recipients[${i}].callsign`);
        return r as unknown as OwnerStanza;
    }
    if (r.type === 'code') {
        requireCodeId(r.codeId);
        unb64(r.codePub, `recipients[${i}].codePub`, KEY_LEN);
        unb64(r.salt, `recipients[${i}].salt`);
        requireText(r.createdAt, `recipients[${i}].createdAt`);
        // N, r, p are policed when the code is used, so a stanza with an out-of-range cost still
        // parses and the error names the cost rather than calling the whole header unreadable.
        return r as unknown as CodeStanza;
    }
    throw new SealedEnvelopeError(`Recipient ${i} has unknown type '${String(r.type)}'.`);
}

function parseHeaderJson(headerJson: Uint8Array): SealedEnvelopeHeader {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(headerJson).toString('utf8'));
    } catch {
        throw new SealedEnvelopeError('The envelope header is not readable JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SealedEnvelopeError('The envelope header is not an object.');
    }
    const h = parsed as Record<string, unknown>;
    if (h.v !== SEALED_ENVELOPE_VERSION) {
        throw new SealedEnvelopeError(`This is not a ${SEALED_ENVELOPE_VERSION} envelope (v = '${String(h.v)}').`);
    }
    requireKind(h.kind);
    if (typeof h.envelopeId !== 'string' || !/^[0-9a-f]{32}$/.test(h.envelopeId)) {
        throw new SealedEnvelopeError('The envelope id is not 16 bytes of lowercase hex.');
    }
    requireText(h.communityId, 'communityId');
    requireText(h.nodePeerId, 'nodePeerId');
    requireText(h.createdAt, 'createdAt');
    requireChunkSize(h.chunkSize);
    unb64(h.sig, 'sig', 64);
    if (!Array.isArray(h.recipients) || h.recipients.length === 0 || h.recipients.length > MAX_RECIPIENTS) {
        throw new SealedEnvelopeError('The envelope has no readable recipient list.');
    }
    const recipients = h.recipients.map(validateStanza);
    const owners = recipients.filter((r): r is OwnerStanza => r.type === 'owner').map((r) => r.pubkey);
    const codes = recipients.filter((r): r is CodeStanza => r.type === 'code').map((r) => r.codeId);
    if (new Set(owners).size !== owners.length || new Set(codes).size !== codes.length) {
        throw new SealedEnvelopeError('The envelope lists a recipient twice.');
    }
    // One byte string per header: anything else would give two headers the same meaning and
    // different body AADs.
    if (canonicalJson(parsed) !== Buffer.from(headerJson).toString('utf8')) {
        throw new SealedEnvelopeError('The envelope header is not in canonical form.');
    }
    return parsed as SealedEnvelopeHeader;
}

/** Split `u32be length ‖ header` off the front of `bytes`. */
function splitHeader(bytes: Uint8Array): { headerJson: Uint8Array; bodyOffset: number } {
    if (bytes.length < HEADER_LEN_PREFIX) throw new SealedEnvelopeError('The envelope is truncated before its header.');
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    if (len === 0 || len > MAX_HEADER_BYTES) {
        throw new SealedEnvelopeError(`The envelope header claims ${len} bytes, outside 1–${MAX_HEADER_BYTES}.`);
    }
    if (bytes.length < HEADER_LEN_PREFIX + len) throw new SealedEnvelopeError('The envelope is truncated inside its header.');
    return { headerJson: bytes.subarray(HEADER_LEN_PREFIX, HEADER_LEN_PREFIX + len), bodyOffset: HEADER_LEN_PREFIX + len };
}

/**
 * Read an envelope's public header without opening it — to show who can unlock it and which
 * recovery code number it needs. Not authenticated: see {@link verifySealedHeader}.
 */
export function readSealedHeader(bytes: Uint8Array): SealedEnvelopeHeader {
    return parseHeaderJson(splitHeader(bytes).headerJson);
}

/**
 * Check the header's signature against the signer's Ed25519 public key — for a standby, its pinned
 * primary. Strict RFC 8032 verification (not ZIP-215).
 */
export function verifySealedHeader(header: SealedEnvelopeHeader, signerPublicKey: string | Uint8Array): boolean {
    const pub = requireKey32(signerPublicKey, 'signerPublicKey');
    let sig: Uint8Array;
    try {
        sig = unb64(header.sig, 'sig', 64);
    } catch {
        return false;
    }
    try {
        return ed25519.verify(sig, unsignedHeaderBytes(header), pub, { zip215: false });
    } catch {
        return false;
    }
}

// ── Opening ─────────────────────────────────────────────────────────────────────────────────

/** How the opener proves it is a recipient: an owner's member key, or the printed code. */
export type SealedEnvelopeKey =
    | { type: 'owner'; privateKey: string | Uint8Array }
    | { type: 'code'; code: string };

export interface OpenOptions {
    /** The kind the caller expects. An envelope of the other kind is refused. */
    kind: SealedEnvelopeKind;
}

/** Validate the key before touching the envelope, so a typo in the code costs nothing. */
function preflightKey(key: SealedEnvelopeKey): void {
    if (key?.type === 'code') parseRecoveryCode(key.code);
    else if (key?.type === 'owner') privateSeed(key.privateKey, 'privateKey');
    else throw new SealedEnvelopeError("The key must be { type: 'owner' } or { type: 'code' }.");
}

async function unwrapDek(header: SealedEnvelopeHeader, key: SealedEnvelopeKey): Promise<Uint8Array> {
    const envelopeId = hexToBytes(header.envelopeId);
    let stanza: RecipientStanza | undefined;
    let mySecret: Uint8Array;
    let myPub: Uint8Array;
    if (key.type === 'owner') {
        const seed = privateSeed(key.privateKey, 'privateKey');
        myPub = ed25519.getPublicKey(seed);
        const hex = bytesToHex(myPub);
        stanza = header.recipients.find((r) => r.type === 'owner' && r.pubkey === hex);
        if (!stanza) throw new SealedEnvelopeError('This key is not one of the owners this envelope is locked to.');
        mySecret = ed25519.utils.toMontgomerySecret(seed);
    } else {
        const parsed = parseRecoveryCode(key.code);
        const codeStanzas = header.recipients.filter((r): r is CodeStanza => r.type === 'code');
        if (codeStanzas.length === 0) throw new SealedEnvelopeError('This envelope is not locked to any recovery code.');
        const match = parsed.codeId !== undefined
            ? codeStanzas.find((r) => r.codeId === parsed.codeId)
            : codeStanzas.length === 1 ? codeStanzas[0] : undefined;
        if (!match) {
            const ids = codeStanzas.map((r) => `#${r.codeId}`).join(', ');
            throw new SealedEnvelopeError(
                parsed.codeId !== undefined
                    ? `This envelope needs recovery code ${ids}; the code typed is #${parsed.codeId}.`
                    : `This envelope accepts recovery codes ${ids}; type the code with its BPRC number.`,
            );
        }
        stanza = match;
        mySecret = await codeSecretFor(key.code, match);
        myPub = unb64(match.codePub, 'codePub', KEY_LEN);
    }
    const ephX = unb64(stanza.eph, 'eph', KEY_LEN);
    const k = agreeKey(mySecret, ephX, 'The key that opens this envelope');
    try {
        return xchacha20poly1305(k, unb64(stanza.nonce, 'nonce', XNONCE_LEN), stanzaAad(header.kind, envelopeId, myPub))
            .decrypt(unb64(stanza.wrappedDek, 'wrappedDek', KEY_LEN + TAG_LEN));
    } catch {
        throw new SealedEnvelopeError('The envelope did not open: the key is wrong, or the envelope has been altered.');
    }
}

function decryptChunk(
    dek: Uint8Array, envelopeId: Uint8Array, bodyAad: Uint8Array, index: number, final: boolean, ct: Uint8Array,
): Uint8Array {
    try {
        return xchacha20poly1305(dek, chunkNonce(envelopeId, index, final), bodyAad).decrypt(ct);
    } catch {
        throw new SealedEnvelopeError(
            `The envelope's contents did not open at chunk ${index}: it has been altered, reordered or cut short.`,
        );
    }
}

export interface OpenedStream {
    header: SealedEnvelopeHeader;
    /**
     * Plaintext, one chunk at a time. A truncated or altered envelope throws partway through or at
     * the very end, so a caller must treat everything it received as untrusted until the iterator
     * finishes without throwing.
     */
    chunks: AsyncGenerator<Uint8Array>;
}

/**
 * Open a streamed envelope. The header is read and the DEK unwrapped before this resolves, so a
 * wrong key, a wrong kind or a typo throws here, not from the chunk iterator.
 */
export async function openEnvelopeStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, key: SealedEnvelopeKey, opts: OpenOptions,
): Promise<OpenedStream> {
    requireKind(opts?.kind);
    preflightKey(key);
    const it = (Symbol.asyncIterator in (source as object)
        ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (async function* () { yield* source as Iterable<Uint8Array>; })());
    const queue = new ByteQueue();
    let done = false;
    const fill = async (n: number): Promise<boolean> => {
        while (queue.length < n && !done) {
            const next = await it.next();
            if (next.done) done = true;
            else queue.push(next.value);
        }
        return queue.length >= n;
    };

    // Whenever this stops early — a throw here, a throw in the chunk iterator, or a caller that
    // breaks out — the source is closed, so a file-backed source does not leak its handle.
    const release = async (): Promise<void> => {
        if (done) return;
        done = true;
        try { await it.return?.(); } catch { /* the original error matters more */ }
    };

    let header: SealedEnvelopeHeader;
    let headerJson: Uint8Array;
    let dek: Uint8Array;
    try {
        if (!(await fill(HEADER_LEN_PREFIX))) throw new SealedEnvelopeError('The envelope is truncated before its header.');
        const lenBytes = queue.take(HEADER_LEN_PREFIX);
        const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, false);
        if (len === 0 || len > MAX_HEADER_BYTES) {
            throw new SealedEnvelopeError(`The envelope header claims ${len} bytes, outside 1–${MAX_HEADER_BYTES}.`);
        }
        if (!(await fill(len))) throw new SealedEnvelopeError('The envelope is truncated inside its header.');
        headerJson = queue.take(len);
        header = parseHeaderJson(headerJson);
        if (header.kind !== opts.kind) {
            throw new SealedEnvelopeError(`This is a '${header.kind}' envelope, not a '${opts.kind}' one.`);
        }
        dek = await unwrapDek(header, key);
    } catch (e) {
        await release();
        throw e;
    }
    const envelopeId = hexToBytes(header.envelopeId);
    const bodyAad = sha256(headerJson);
    const segment = header.chunkSize + TAG_LEN;

    async function* chunks(): AsyncGenerator<Uint8Array> {
        let index = 0;
        try {
            for (;;) {
                // Read one byte past a full segment: if it is there, this segment is not the last.
                const more = await fill(segment + 1);
                if (more) {
                    yield decryptChunk(dek, envelopeId, bodyAad, index++, false, queue.take(segment));
                    await yieldToEventLoop();
                    continue;
                }
                if (queue.length < TAG_LEN) {
                    throw new SealedEnvelopeError('The envelope is cut short: its last chunk is missing.');
                }
                yield decryptChunk(dek, envelopeId, bodyAad, index, true, queue.take(queue.length));
                return;
            }
        } finally {
            await release();
        }
    }
    return { header, chunks: chunks() };
}

/** Open a whole envelope in memory. */
export async function openEnvelope(
    bytes: Uint8Array, key: SealedEnvelopeKey, opts: OpenOptions,
): Promise<{ header: SealedEnvelopeHeader; payload: Uint8Array }> {
    const { header, chunks } = await openEnvelopeStream([bytes], key, opts);
    const parts: Uint8Array[] = [];
    for await (const part of chunks) parts.push(part);
    return { header, payload: concatBytes(...parts) };
}

// ── Byte queue ──────────────────────────────────────────────────────────────────────────────

/** A FIFO of byte pieces. Each piece is copied once on the way in (see push), never again. */
class ByteQueue {
    private pieces: Uint8Array[] = [];
    private head = 0;
    length = 0;

    push(piece: Uint8Array): void {
        if (!(ArrayBuffer.isView(piece) && (piece as Uint8Array).BYTES_PER_ELEMENT === 1)) {
            throw new SealedEnvelopeError('A stream piece must be a byte array.');
        }
        if (piece.length === 0) return;
        // Copy: sealing and opening hold bytes across an `await`, and a source may reuse its
        // buffer for the next piece (a read loop into one scratch buffer). Holding the caller's
        // view would seal or open whatever the buffer holds later, silently.
        this.pieces.push(new Uint8Array(piece));
        this.length += piece.length;
    }

    take(n: number): Uint8Array {
        const out = new Uint8Array(n);
        let off = 0;
        while (off < n) {
            const first = this.pieces[0];
            const avail = first.length - this.head;
            const want = Math.min(avail, n - off);
            out.set(first.subarray(this.head, this.head + want), off);
            off += want;
            this.head += want;
            if (this.head === first.length) {
                this.pieces.shift();
                this.head = 0;
            }
        }
        this.length -= n;
        return out;
    }
}
