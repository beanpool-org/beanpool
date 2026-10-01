/**
 * E2E Crypto — End-to-end encryption for BeanPool messaging
 *
 * v1 (legacy): plaintext base64 (nonce "plaintext-v1"). Still read for old messages.
 * Direct messages (NAT-1) are encrypted end to end by packages/beanpool-core/src/dm-crypto.ts, re-exported here and by
 * the phone's utils/e2e-crypto.ts, so a line either app writes the other reads (vectors: @beanpool/core/dm-line-vectors):
 *   Key agreement: X25519 from each member's Ed25519 identity
 *   KDF:           HKDF-SHA256 salted with the conversation id
 *   Cipher:        XChaCha20-Poly1305 (AEAD), a fresh 24-byte nonce per line
 *   Line format 3: the associated data names the conversation, the sender, the message id and the part (words or
 *                  photo), and the sealed words carry the id of the line they were written after, so the node can't
 *                  show a line as someone else's, replay, move or reorder it unnoticed (crypto review M F2, 2026-10-02).
 *                  Lines from before (format 2: the conversation id alone) still open.
 *
 * Wire format, unchanged: ciphertext = base64(AEAD); nonce = "x25519-xc20p-v2:" + base64(24-byte nonce). Static
 * identity keys → no forward secrecy yet, but the node/LAN can't read DMs.
 */
export {
    DM_NONCE_PREFIX as V2_NONCE_PREFIX,
    isDmEncryptedNonce as isEncryptedNonce,
    sealDmLine,
    openDmLine,
    checkDmThread,
    dmAfterReference,
    dmLineMarkText,
    newDmMessageId,
    encryptDmFormat2,
    decryptDmFormat2,
    DM_LINE_NOT_VERIFIED_TEXT,
    DmLineNotVerifiedError,
    type DmKeyContext as DMKeyContext,
    type DmLineView,
    type DmLineMark,
    type DmPart,
    type DmThreadLine,
    type OpenedDmLine,
} from '@beanpool/core';

// ───────────────────────── legacy v1 (kept for old messages) ─────────────────────────

/** Encode a message for sending. V1 = base64 plaintext: node-readable chats only; a DM is sealed (sealDmLine). */
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
    throw new Error('E2E message — open it with openDmLine or checkDmThread');
}
