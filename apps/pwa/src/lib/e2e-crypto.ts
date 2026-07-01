/**
 * E2E Crypto — End-to-end encryption for BeanPool messaging
 *
 * v1 (legacy): plaintext base64 (nonce "plaintext-v1"). Still read for old messages.
 * v2 (NAT-1):  real E2E for direct messages —
 *   Key agreement: X25519 ECDH from each user's Ed25519 identity
 *   KDF:           HKDF-SHA256 salted with the conversationId
 *   Cipher:        XChaCha20-Poly1305 (AEAD), conversationId bound as associated data
 *
 * Wire format: ciphertext = base64(AEAD); nonce = "x25519-xc20p-v2:" + base64(24-byte nonce).
 *
 * ⚠️ MUST stay byte-compatible with apps/native/utils/e2e-crypto.ts so DMs work
 * across PWA ↔ native. Shared reference vector: scratch/e2e-vector.mjs. Static
 * identity keys → no forward secrecy yet, but the node/LAN can no longer read DMs.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';

export const V2_NONCE_PREFIX = 'x25519-xc20p-v2:';
const HKDF_INFO = utf8ToBytes('beanpool-dm-v2');
const NONCE_LEN = 24;
const td = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function b64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

export interface DMKeyContext {
    myEdPrivHex: string;
    peerEdPubHex: string;
    conversationId: string;
}

/** True if a stored nonce denotes a v2-encrypted message. */
export function isEncryptedNonce(nonce: string | null | undefined): boolean {
    return typeof nonce === 'string' && nonce.startsWith(V2_NONCE_PREFIX);
}

function deriveKey(ctx: DMKeyContext): Uint8Array {
    let myPrivBytes = hexToBytes(ctx.myEdPrivHex);
    if (myPrivBytes.length === 48) {
        myPrivBytes = myPrivBytes.slice(16);
    }
    const myXPriv = ed25519.utils.toMontgomerySecret(myPrivBytes);
    const peerXPub = ed25519.utils.toMontgomery(hexToBytes(ctx.peerEdPubHex));
    const shared = x25519.getSharedSecret(myXPriv, peerXPub);
    return hkdf(sha256, shared, utf8ToBytes(ctx.conversationId), HKDF_INFO, 32);
}

/** Encrypt a DM. Returns ciphertext + versioned nonce to store/send. */
export function encryptDM(text: string, ctx: DMKeyContext): { ciphertext: string; nonce: string } {
    const key = deriveKey(ctx);
    const nonce = randomBytes(NONCE_LEN);
    const aad = utf8ToBytes(ctx.conversationId);
    const ct = xchacha20poly1305(key, nonce, aad).encrypt(utf8ToBytes(text));
    return { ciphertext: bytesToB64(ct), nonce: V2_NONCE_PREFIX + bytesToB64(nonce) };
}

/** Decrypt a v2 DM. Throws if the nonce isn't v2 or the AEAD tag fails. */
export function decryptDM(ciphertext: string, nonce: string, ctx: DMKeyContext): string {
    if (!isEncryptedNonce(nonce)) throw new Error('not a v2-encrypted message');
    const key = deriveKey(ctx);
    const nb = b64ToBytes(nonce.slice(V2_NONCE_PREFIX.length));
    const aad = utf8ToBytes(ctx.conversationId);
    const pt = xchacha20poly1305(key, nb, aad).decrypt(b64ToBytes(ciphertext));
    return td.decode(pt);
}

// ───────────────────────── legacy v1 (kept for old messages) ─────────────────────────

/** Encode a message for sending. V1 = base64 plaintext. Prefer encryptDM for DMs. */
export function encodePlaintext(text: string): { ciphertext: string; nonce: string } {
    return {
        ciphertext: btoa(unescape(encodeURIComponent(text))),
        nonce: 'plaintext-v1',
    };
}

/** Decode a received message (legacy plaintext path). */
export function decodePlaintext(ciphertext: string, nonce: string): string {
    if (nonce.startsWith('plaintext')) {
        return decodeURIComponent(escape(atob(ciphertext)));
    }
    throw new Error('E2E message — use decryptDM with a key context');
}
