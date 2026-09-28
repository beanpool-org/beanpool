/**
 * The key vault's wire formats (key vault design §1.3–§1.4): what the vault (apps/vault) issues and opens, and what
 * the phone (V4), global's web app (V6) and global's door (V5) build and check. One definition for all of them.
 *
 * Pure JavaScript (@noble/*, no `node:` import), so the phone bundles it (see __tests__/barrel-is-universal.test.ts).
 *
 * ## A ticket
 *
 * The vault signs `{v, n, key, purpose, exp}` with its Ed25519 ticket key:
 *
 *   ticket = base64url(payload JSON) "." base64url(signature)
 *   signature = Ed25519(ticketKey, utf8("beanpool-vault-ticket/1\n" ‖ base64url(payload JSON)))
 *
 * `n` is 32 random bytes, `key` the hex Ed25519 key the ticket was asked for (the member's key for a deposit, a
 * throwaway key for a restore), and `exp` ten minutes after issue, in milliseconds. The provider nonce a sign-in
 * carries is {@link vaultTicketNonce}: base64url(SHA-256(ticket)), 43 characters like a node's nonce. So a provider
 * token names one ticket, the ticket names one key, and only the vault can sign a ticket.
 *
 * Before opening a provider's sign-in sheet the phone checks the ticket with {@link checkVaultTicket} against the
 * vault's pinned public keys and its own key. A relay that hands the phone a real ticket for the relay's key is then
 * refused on the phone; one that forwards the phone's own ticket gets a release sealed to the phone.
 *
 * ## A box (deposit and release)
 *
 * X25519 from a fresh ephemeral key to the recipient, HKDF-SHA256 with the tag, the ephemeral key and the recipient
 * key as `info`, then XChaCha20-Poly1305 (the same stack as keeper-crypto.ts) with the tag and the parties as AAD:
 *
 * - **deposit**: the phone seals `{clientCopy, pushToken?}` to the vault's X25519 deposit key; AAD names the member
 *   key and the provider, so a box can't be deposited under another key or for another provider.
 * - **release**: the vault seals `{provider, pubkey, clientCopy}` to the restoring device's throwaway key (its
 *   Ed25519 key, as an X25519 point). The device opens it with that key's private half and then opens `clientCopy`
 *   with the provider `sub` (keeper-crypto.ts `openSeedFromSso`), and saves the seed only if it makes `pubkey`.
 *
 * `clientCopy` is exactly what the apps seal today, `sealSeedToSso(seed, provider, sub, {words})`: this module never
 * changes that format and the vault never holds the plain seed.
 */

import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { KEEPER_ALG_SSO_SINGLE, type SealedShare } from './keeper-crypto.js';

// ─── Bytes ─────────────────────────────────────────────────────────────────────────────────

/** base64url without padding. */
export function vaultB64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strict base64url: only the alphabet, no padding, and only the one spelling of the bytes (a string whose unused
 * trailing bits are set is refused), so two different strings never decode to the same bytes. Null otherwise.
 */
export function vaultUnb64(value: unknown, maxBytes = 1 << 20): Uint8Array | null {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
    if (value.length > Math.ceil((maxBytes * 4) / 3)) return null;
    const bytes = new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    return vaultB64(bytes) === value ? bytes : null;
}

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/** A member, throwaway or custodian key as the vault spells it: 64 lower-case hex characters. */
export function isVaultKeyHex(value: unknown): value is string {
    return typeof value === 'string' && HEX_KEY_RE.test(value);
}

// ─── Tickets ───────────────────────────────────────────────────────────────────────────────

export const VAULT_TICKET_TAG = 'beanpool-vault-ticket/1';
/** A ticket is good for this long after the vault signs it (design §1.3). */
export const VAULT_TICKET_TTL_MS = 10 * 60 * 1000;
/** How far a ticket's expiry may sit beyond issue + TTL before it is refused as not the vault's. */
export const VAULT_TICKET_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Longer than any ticket the vault signs (about 300 characters). */
const MAX_TICKET_CHARS = 1024;

export type VaultTicketPurpose = 'deposit' | 'restore';

export interface VaultTicket {
    v: 1;
    /** 32 random bytes, base64url. What makes each ticket single: the vault spends a ticket by this value. */
    n: string;
    /** The hex Ed25519 key the ticket was issued to. Every request that uses it must be signed by this key. */
    key: string;
    purpose: VaultTicketPurpose;
    /** Milliseconds since the epoch. */
    exp: number;
}

/** The payload's one JSON spelling: fields in this order, no spaces. */
export function vaultTicketPayloadText(t: VaultTicket): string {
    return JSON.stringify({ v: t.v, n: t.n, key: t.key, purpose: t.purpose, exp: t.exp });
}

/** The bytes the ticket key signs. */
export function vaultTicketSigningBytes(payloadB64: string): Uint8Array {
    return utf8ToBytes(`${VAULT_TICKET_TAG}\n${payloadB64}`);
}

/** A fresh ticket payload for `key`, before it is signed. */
export function newVaultTicket(key: string, purpose: VaultTicketPurpose, now: number): VaultTicket {
    if (!isVaultKeyHex(key)) throw new Error('A vault ticket names a 64-character hex key.');
    return { v: 1, n: vaultB64(randomBytes(32)), key, purpose, exp: now + VAULT_TICKET_TTL_MS };
}

/** Sign a ticket payload with a 32-byte Ed25519 seed. The vault's keyholder is the only caller with that seed. */
export function signVaultTicket(t: VaultTicket, ticketSeed: Uint8Array): string {
    const payloadB64 = vaultB64(utf8ToBytes(vaultTicketPayloadText(t)));
    return `${payloadB64}.${vaultB64(ed25519.sign(vaultTicketSigningBytes(payloadB64), ticketSeed))}`;
}

/** The provider nonce for a ticket: base64url(SHA-256(the ticket string)). */
export function vaultTicketNonce(ticket: string): string {
    return vaultB64(sha256(utf8ToBytes(ticket)));
}

export interface ParsedVaultTicket {
    payload: VaultTicket;
    payloadB64: string;
    signature: Uint8Array;
}

/** A ticket read back into its parts, or null when it is not one (in shape; the signature is not checked here). */
export function parseVaultTicket(ticket: unknown): ParsedVaultTicket | null {
    if (typeof ticket !== 'string' || ticket.length > MAX_TICKET_CHARS) return null;
    const dot = ticket.indexOf('.');
    if (dot <= 0 || dot !== ticket.lastIndexOf('.')) return null;
    const payloadB64 = ticket.slice(0, dot);
    const payloadBytes = vaultUnb64(payloadB64, 512);
    const signature = vaultUnb64(ticket.slice(dot + 1), 64);
    if (!payloadBytes || !signature || signature.length !== 64) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(payloadBytes).toString('utf8'));
    } catch {
        return null;
    }
    const p = raw as Record<string, unknown>;
    if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.n !== 'string' || !isVaultKeyHex(p.key)
        || (p.purpose !== 'deposit' && p.purpose !== 'restore') || typeof p.exp !== 'number' || !Number.isSafeInteger(p.exp)) {
        return null;
    }
    const n = vaultUnb64(p.n, 32);
    if (!n || n.length !== 32) return null;
    const payload: VaultTicket = { v: 1, n: p.n, key: p.key, purpose: p.purpose, exp: p.exp };
    // One spelling per ticket: anything but the canonical JSON is not a ticket the vault signed.
    if (vaultTicketPayloadText(payload) !== Buffer.from(payloadBytes).toString('utf8')) return null;
    return { payload, payloadB64, signature };
}

export type VaultTicketRefusal = 'malformed' | 'signature' | 'expired' | 'wrong_key' | 'wrong_purpose';
export type VaultTicketCheck = { ok: true; ticket: VaultTicket } | { ok: false; reason: VaultTicketRefusal };

export interface VaultTicketCheckOptions {
    /** The vault's ticket public keys (hex), newest first. The phone has them built in. */
    ticketKeys: readonly string[];
    /** Milliseconds since the epoch. */
    now: number;
    /** The key the ticket must name: the checker's own (phone), or the request's signer (vault, door). */
    key?: string;
    purpose?: VaultTicketPurpose;
}

/**
 * Whether `ticket` is one the vault signed, unexpired, for `key` and `purpose`. Whether it has been used is the
 * vault's (and the door's) own record, not something the ticket can say.
 */
export function checkVaultTicket(ticket: unknown, opts: VaultTicketCheckOptions): VaultTicketCheck {
    const parsed = parseVaultTicket(ticket);
    if (!parsed) return { ok: false, reason: 'malformed' };
    const bytes = vaultTicketSigningBytes(parsed.payloadB64);
    const signed = opts.ticketKeys.some(k => {
        if (!isVaultKeyHex(k)) return false;
        try {
            return ed25519.verify(parsed.signature, bytes, hexToBytes(k), { zip215: false });
        } catch {
            return false;
        }
    });
    if (!signed) return { ok: false, reason: 'signature' };
    if (parsed.payload.exp <= opts.now) return { ok: false, reason: 'expired' };
    if (parsed.payload.exp > opts.now + VAULT_TICKET_TTL_MS + VAULT_TICKET_CLOCK_SKEW_MS) return { ok: false, reason: 'malformed' };
    if (opts.key !== undefined && parsed.payload.key !== opts.key) return { ok: false, reason: 'wrong_key' };
    if (opts.purpose !== undefined && parsed.payload.purpose !== opts.purpose) return { ok: false, reason: 'wrong_purpose' };
    return { ok: true, ticket: parsed.payload };
}

// ─── Boxes ─────────────────────────────────────────────────────────────────────────────────

export const VAULT_DEPOSIT_TAG = 'beanpool-vault-deposit/1';
export const VAULT_RELEASE_TAG = 'beanpool-vault-release/1';

/** A sealed box, every field base64url. `kid` names the recipient key where the recipient has more than one. */
export interface VaultSealedBox {
    v: 1;
    kid?: string;
    epk: string;
    n: string;
    ct: string;
}

/** The HKDF `info` that binds a box key to its tag and to both X25519 keys. */
function boxInfo(tag: string, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
    return concatBytes(utf8ToBytes(tag), epk, recipient);
}

/** Seal `plaintext` to the X25519 key `recipient`. Exported for the vault's own boxes (custodian shares). */
export function sealToX25519(recipient: Uint8Array, plaintext: Uint8Array, tag: string, aad: Uint8Array): VaultSealedBox {
    if (recipient.length !== 32) throw new Error('A box is sealed to a 32-byte X25519 key.');
    const secret = randomBytes(32);
    try {
        const epk = x25519.getPublicKey(secret);
        const key = hkdf(sha256, x25519.getSharedSecret(secret, recipient), undefined, boxInfo(tag, epk, recipient), 32);
        const nonce = randomBytes(24);
        const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
        key.fill(0);
        return { v: 1, epk: vaultB64(epk), n: vaultB64(nonce), ct: vaultB64(ct) };
    } finally {
        secret.fill(0);
    }
}

/** Open a box with the X25519 secret `secret`. Throws on anything that isn't a box sealed to it with this AAD. */
export function openWithX25519(secret: Uint8Array, box: unknown, tag: string, aad: Uint8Array, maxBytes = 64 * 1024): Uint8Array {
    const b = box as Partial<VaultSealedBox> | null;
    if (!b || typeof b !== 'object' || b.v !== 1) throw new Error('Not a vault box.');
    const epk = vaultUnb64(b.epk, 32);
    const nonce = vaultUnb64(b.n, 24);
    const ct = vaultUnb64(b.ct, maxBytes + 16);
    if (!epk || epk.length !== 32 || !nonce || nonce.length !== 24 || !ct || ct.length < 16) throw new Error('Not a vault box.');
    const recipient = x25519.getPublicKey(secret);
    let shared: Uint8Array;
    try {
        shared = x25519.getSharedSecret(secret, epk);
    } catch {
        throw new Error('The box names a key no box is sealed from.');
    }
    const key = hkdf(sha256, shared, undefined, boxInfo(tag, epk, recipient), 32);
    shared.fill(0);
    try {
        return xchacha20poly1305(key, nonce, aad).decrypt(ct);
    } catch {
        throw new Error('The box does not open with this key.');
    } finally {
        key.fill(0);
    }
}

/** The id a deposit box names its deposit key by: the first 8 bytes of SHA-256 of the key, base64url. */
export function vaultDepositKeyId(depositPublicKey: Uint8Array): string {
    return vaultB64(sha256(depositPublicKey).slice(0, 8));
}

/** The Ed25519 public key of a 32-byte seed (or PKCS8), as hex. */
export function vaultPublicKeyHex(privateKey: Uint8Array): string {
    const seed = toEd25519Seed(privateKey);
    try {
        return bytesToHex(ed25519.getPublicKey(seed));
    } finally {
        seed.fill(0);
    }
}

/** An Expo push token, the only kind the vault sends to. */
export function isVaultPushToken(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 300 && /^Expo(?:nent)?PushToken\[[^\]\s]{1,256}\]$/.test(value);
}

/** Largest `clientCopy` the vault keeps. A real one with its words box is about 400 bytes of JSON. */
export const MAX_VAULT_CLIENT_COPY_CHARS = 8192;

/**
 * Whether `value` has the shape of what `sealSeedToSso` returns: a single-blob sign-in copy of a 32-byte seed. The
 * vault can't open it (it has no `sub` to open it with, by design); this only stops it keeping something no app can.
 */
export function isVaultClientCopy(value: unknown): value is SealedShare {
    const c = value as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    const keys = Object.keys(c);
    if (keys.some(k => !['encryptedShare', 'shareIv', 'shareTag', 'kdfParams'].includes(k))) return false;
    if (typeof c.encryptedShare !== 'string' || typeof c.shareIv !== 'string' || typeof c.shareTag !== 'string'
        || typeof c.kdfParams !== 'string' || c.kdfParams.length > 4096) return false;
    if (JSON.stringify(c).length > MAX_VAULT_CLIENT_COPY_CHARS) return false;
    const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
    if (!b64.test(c.encryptedShare) || !b64.test(c.shareIv) || !b64.test(c.shareTag)) return false;
    if (Buffer.from(c.encryptedShare, 'base64').length !== 32 || Buffer.from(c.shareIv, 'base64').length !== 24
        || Buffer.from(c.shareTag, 'base64').length !== 16) return false;
    try {
        const params = JSON.parse(c.kdfParams) as Record<string, unknown>;
        return !!params && params.alg === KEEPER_ALG_SSO_SINGLE;
    } catch {
        return false;
    }
}

function depositAad(memberKey: string, provider: string): Uint8Array {
    return utf8ToBytes(`${VAULT_DEPOSIT_TAG}\n${memberKey}\n${provider}`);
}

export interface VaultDepositContents {
    clientCopy: SealedShare;
    /** This device's Expo push token, for the vault's notices (design §1.5). */
    pushToken?: string;
}

/**
 * The phone's deposit box: `{clientCopy, pushToken?}` sealed to the vault's deposit key (base64url, pinned in the
 * app) for `memberKey` and `provider`.
 */
export function sealVaultDepositBox(
    contents: VaultDepositContents, depositPublicKey: string, memberKey: string, provider: string,
): VaultSealedBox {
    const recipient = vaultUnb64(depositPublicKey, 32);
    if (!recipient || recipient.length !== 32) throw new Error('The vault deposit key is not a 32-byte base64url key.');
    if (!isVaultKeyHex(memberKey)) throw new Error('A deposit names a 64-character hex member key.');
    if (!isVaultClientCopy(contents.clientCopy)) throw new Error('A deposit holds a single-blob sign-in copy.');
    if (contents.pushToken !== undefined && !isVaultPushToken(contents.pushToken)) throw new Error('That is not an Expo push token.');
    const body = contents.pushToken ? { clientCopy: contents.clientCopy, pushToken: contents.pushToken } : { clientCopy: contents.clientCopy };
    const box = sealToX25519(recipient, utf8ToBytes(JSON.stringify(body)), VAULT_DEPOSIT_TAG, depositAad(memberKey, provider));
    return { v: 1, kid: vaultDepositKeyId(recipient), epk: box.epk, n: box.n, ct: box.ct };
}

/** Open a deposit box with the vault's X25519 deposit secret. Throws unless it opens and holds a usable copy. */
export function openVaultDepositBox(box: unknown, depositSecret: Uint8Array, memberKey: string, provider: string): VaultDepositContents {
    const plain = openWithX25519(depositSecret, box, VAULT_DEPOSIT_TAG, depositAad(memberKey, provider), 16 * 1024);
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(Buffer.from(plain).toString('utf8')) as Record<string, unknown>;
    } catch {
        throw new Error('The deposit box does not hold JSON.');
    } finally {
        plain.fill(0);
    }
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some(k => k !== 'clientCopy' && k !== 'pushToken')) {
        throw new Error('The deposit box holds something other than a copy and a push token.');
    }
    if (!isVaultClientCopy(parsed.clientCopy)) throw new Error('The deposit box does not hold a single-blob sign-in copy.');
    if (parsed.pushToken !== undefined && !isVaultPushToken(parsed.pushToken)) throw new Error('The deposit box holds a push token that is not Expo\'s.');
    return parsed.pushToken === undefined
        ? { clientCopy: parsed.clientCopy }
        : { clientCopy: parsed.clientCopy, pushToken: parsed.pushToken as string };
}

function releaseAad(requesterKey: string): Uint8Array {
    return utf8ToBytes(`${VAULT_RELEASE_TAG}\n${requesterKey}`);
}

export interface VaultReleaseContents {
    provider: string;
    /** The BeanPool key the copy belongs to. A device saves the opened seed only if it makes this key. */
    pubkey: string;
    clientCopy: SealedShare;
}

/** The vault's release: the copy sealed to the restoring device's hex Ed25519 key. */
export function sealVaultRelease(contents: VaultReleaseContents, requesterKey: string): VaultSealedBox {
    if (!isVaultKeyHex(requesterKey)) throw new Error('A release is sealed to a 64-character hex key.');
    let recipient: Uint8Array;
    try {
        recipient = ed25519.utils.toMontgomery(hexToBytes(requesterKey));
    } catch {
        throw new Error('The restoring key is not an Ed25519 point.');
    }
    const body = { provider: contents.provider, pubkey: contents.pubkey, clientCopy: contents.clientCopy };
    return sealToX25519(recipient, utf8ToBytes(JSON.stringify(body)), VAULT_RELEASE_TAG, releaseAad(requesterKey));
}

/** Open a release with the restoring device's Ed25519 private key (seed or PKCS8). */
export function openVaultRelease(box: unknown, requesterPrivateKey: Uint8Array): VaultReleaseContents {
    const seed = toEd25519Seed(requesterPrivateKey);
    const requesterKey = bytesToHex(ed25519.getPublicKey(seed));
    const secret = ed25519.utils.toMontgomerySecret(seed);
    seed.fill(0);
    let plain: Uint8Array;
    try {
        plain = openWithX25519(secret, box, VAULT_RELEASE_TAG, releaseAad(requesterKey), 16 * 1024);
    } finally {
        secret.fill(0);
    }
    const parsed = JSON.parse(Buffer.from(plain).toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.provider !== 'string' || !isVaultKeyHex(parsed.pubkey) || !isVaultClientCopy(parsed.clientCopy)) {
        throw new Error('The release does not hold a copy.');
    }
    return { provider: parsed.provider, pubkey: parsed.pubkey, clientCopy: parsed.clientCopy };
}
