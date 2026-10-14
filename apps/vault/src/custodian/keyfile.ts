import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * A custodian's key file (key vault design §2.1: "in a file on their own computer ... protected by a passphrase"):
 *
 *   {"v": 2, "publicKey": "<hex>", "kdf": {"name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64url>"},
 *    "nonce": "<b64url>", "ct": "<b64url>"}
 *
 * The 32-byte Ed25519 seed is sealed with XChaCha20-Poly1305 under scrypt(passphrase), with the public key as the
 * associated data. The public key is readable without the passphrase, so a custodian can say which key is theirs.
 * V2's stub files (`{"seed": "<hex>"}`) still open, with a warning that they aren't protected.
 */

export const KEYFILE_AAD = 'beanpool-vault-custodian-key/2\n';
const DEFAULT_N = 2 ** 17;

export interface OpenedKey {
    seed: Uint8Array;
    publicKey: string;
    /** False for a V2 stub file: the seed is in the clear. */
    protectedByPassphrase: boolean;
}

function kek(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
    return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
}

export function sealKeyFile(seed: Uint8Array, passphrase: string, N = DEFAULT_N): string {
    if (seed.length !== 32) throw new Error('A custodian key is a 32-byte seed.');
    if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    const publicKey = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(24);
    const key = kek(passphrase, salt, N, 8, 1);
    try {
        const ct = xchacha20poly1305(key, nonce, Buffer.from(KEYFILE_AAD + publicKey)).encrypt(seed);
        return `${JSON.stringify({
            v: 2, publicKey, kdf: { name: 'scrypt', N, r: 8, p: 1, salt: salt.toString('base64url') },
            nonce: nonce.toString('base64url'), ct: Buffer.from(ct).toString('base64url'),
        }, null, 2)}\n`;
    } finally {
        key.fill(0);
    }
}

export function isProtectedKeyFile(text: string): boolean {
    try {
        return (JSON.parse(text) as { v?: unknown }).v === 2;
    } catch {
        return false;
    }
}

export function openKeyFile(text: string, passphrase: string | null): OpenedKey {
    const f = JSON.parse(text) as {
        v?: number; seed?: string; publicKey?: string; kdf?: { name: string; N: number; r: number; p: number; salt: string }; nonce?: string; ct?: string;
    };
    if (f.v === undefined && typeof f.seed === 'string') {
        const seed = Buffer.from(f.seed, 'hex');
        if (seed.length !== 32) throw new Error('That key file does not hold a 32-byte seed.');
        return { seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), protectedByPassphrase: false };
    }
    if (f.v !== 2 || !f.kdf || f.kdf.name !== 'scrypt' || typeof f.publicKey !== 'string' || !f.nonce || !f.ct) throw new Error('That is not a custodian key file.');
    const { N, r, p } = f.kdf;
    if (![N, r, p].every(Number.isSafeInteger) || N < 2 ** 14 || N > 2 ** 20 || r < 1 || r > 16 || p < 1 || p > 4) throw new Error('That key file has unusable passphrase settings.');
    if (passphrase === null) throw new Error('That key file needs its passphrase.');
    const key = kek(passphrase, Buffer.from(f.kdf.salt, 'base64url'), N, r, p);
    let seed: Uint8Array;
    try {
        seed = xchacha20poly1305(key, Buffer.from(f.nonce, 'base64url'), Buffer.from(KEYFILE_AAD + f.publicKey)).decrypt(Buffer.from(f.ct, 'base64url'));
    } catch {
        throw new Error('Wrong passphrase (or the key file is damaged).');
    } finally {
        key.fill(0);
    }
    if (Buffer.from(ed25519.getPublicKey(seed)).toString('hex') !== f.publicKey) throw new Error('The key file is damaged.');
    return { seed, publicKey: f.publicKey, protectedByPassphrase: true };
}
