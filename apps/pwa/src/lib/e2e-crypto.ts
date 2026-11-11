/**
 * E2E Crypto — End-to-end encryption for BeanPool messaging
 *
 * plaintext-v1 (base64, node-readable): the chats the node reads by design (an event's, an enterprise's thread, a group not
 * locked), its own notices and tombstones, and the admin page's message. Never a member's line in a DM.
 * Direct messages (NAT-1) are encrypted end to end by packages/beanpool-core/src/dm-crypto.ts, re-exported here and by
 * the phone's utils/e2e-crypto.ts, so a line either app writes the other reads (vectors: @beanpool/core/dm-line-vectors):
 *   Key agreement: X25519 from each member's Ed25519 identity
 *   KDF:           HKDF-SHA256 salted with the conversation id
 *   Cipher:        XChaCha20-Poly1305 (AEAD), a fresh 24-byte nonce per line
 *   Line format 4: the associated data names the conversation, the sender, the message id and the part (words, photo or
 *                  listing), and the sealed words carry the id of the line they were written after, so the node can't
 *                  show a line as someone else's, replay, move or reorder it unnoticed (crypto review M F2, 2026-10-02);
 *                  and the sender signs every part beside the seal, so the other person can't put words in their name
 *                  either: a line its named sender didn't sign is never shown as theirs. The only format read (the
 *                  1.4.0 cutover wipes every older line).
 *
 * Wire format: ciphertext = base64([4][signature][signing time][AEAD output]); nonce = "x25519-xc20p-v2:" + base64(24-byte
 * nonce). Static identity keys → no forward secrecy yet, but the node/LAN can't read DMs.
 */
export {
    DM_NONCE_PREFIX as V2_NONCE_PREFIX,
    isDmEncryptedNonce as isEncryptedNonce,
    sealDmLine,
    openDmLine,
    checkDmThread,
    dmAfterReference,
    dmLineMarkText,
    dmLineShownText,
    dmLineIsUnattributed,
    dmLineKind,
    dmReplyToOf,
    dmThreadInShownOrder,
    dmQuoteFrom,
    dmQuoteLabel,
    newDmMessageId,
    DM_LINE_NOT_VERIFIED_TEXT,
    DM_LINE_NOT_ENCRYPTED_TEXT,
    DM_LINE_DELETED_TEXT,
    DM_FROM_ADMINS_KEY,
    DmLineNotVerifiedError,
    type DmKeyContext as DMKeyContext,
    type DmLineView,
    type DmQuoteFrom,
    type DmLineMark,
    type DmPart,
    type DmThreadLine,
    type OpenedDmLine,
} from '@beanpool/core';

// ───────────────────────── plaintext-v1: node-readable chats ─────────────────────────

/** Encode a message for sending. V1 = base64 plaintext: node-readable chats only; a DM is sealed (sealDmLine). */
export function encodePlaintext(text: string): { ciphertext: string; nonce: string } {
    return {
        ciphertext: btoa(unescape(encodeURIComponent(text))),
        nonce: 'plaintext-v1',
    };
}

/** Decode a node-readable message (plaintext-v1): never a DM line, which only openDmLine or checkDmThread opens. */
export function decodePlaintext(ciphertext: string, nonce: string): string {
    if (nonce.startsWith('plaintext')) {
        return decodeURIComponent(escape(atob(ciphertext)));
    }
    throw new Error('E2E message — open it with openDmLine or checkDmThread');
}
