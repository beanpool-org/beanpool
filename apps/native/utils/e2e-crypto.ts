/**
 * e2e-crypto — real end-to-end encryption for direct messages (NAT-1).
 *
 *   Key agreement: X25519 ECDH derived from each user's Ed25519 identity
 *                  (ed25519.utils.toMontgomery{,Secret}) — the node never sees a key.
 *   KDF:           HKDF-SHA256, salted with the conversationId so each thread
 *                  gets a distinct key.
 *   Cipher:        XChaCha20-Poly1305 (AEAD); conversationId bound as associated
 *                  data so a ciphertext can't be replayed into another thread.
 *
 * Wire format: ciphertext = base64(AEAD output); nonce column = "x25519-xc20p-v2:" + base64(24-byte nonce).
 * Legacy messages keep nonce "plaintext-v1" and stay readable (see db.ts).
 *
 * ⚠️ MUST stay byte-compatible with apps/pwa/src/lib/e2e-crypto.ts so DMs work
 * across native ↔ PWA. The shared reference vector lives in scratch/e2e-vector.mjs
 * (derived key + deterministic ciphertext both apps must reproduce). Only static
 * identity keys are used, so there is no forward secrecy yet (a ratchet is future
 * work); this still removes the node operator and LAN from the trust boundary.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { encodeBase64, decodeBase64, decodeUtf8 } from './crypto';

export const V2_NONCE_PREFIX = 'x25519-xc20p-v2:';
const HKDF_INFO = utf8ToBytes('beanpool-dm-v2');
const NONCE_LEN = 24; // XChaCha20 nonce

export interface DMKeyContext {
  /** My Ed25519 private key (hex) — the identity seed. */
  myEdPrivHex: string;
  /** The peer's Ed25519 public key (hex). */
  peerEdPubHex: string;
  /** Conversation id — binds the key + AEAD to this thread. */
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

/** Encrypt a DM. Returns the ciphertext + versioned nonce to store/send. */
export function encryptDM(text: string, ctx: DMKeyContext): { ciphertext: string; nonce: string } {
  const key = deriveKey(ctx);
  const nonce = randomBytes(NONCE_LEN);
  const aad = utf8ToBytes(ctx.conversationId);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(utf8ToBytes(text));
  return { ciphertext: encodeBase64(ct), nonce: V2_NONCE_PREFIX + encodeBase64(nonce) };
}

/** Decrypt a v2 DM. Throws if the nonce isn't v2 or the AEAD tag fails (tamper/wrong key). */
export function decryptDM(ciphertext: string, nonce: string, ctx: DMKeyContext): string {
  if (!isEncryptedNonce(nonce)) throw new Error('not a v2-encrypted message');
  const key = deriveKey(ctx);
  const nb = decodeBase64(nonce.slice(V2_NONCE_PREFIX.length));
  const aad = utf8ToBytes(ctx.conversationId);
  const pt = xchacha20poly1305(key, nb, aad).decrypt(decodeBase64(ciphertext));
  return decodeUtf8(pt);
}
