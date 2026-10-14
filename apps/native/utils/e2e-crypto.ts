/**
 * e2e-crypto — end-to-end encryption for direct messages (NAT-1).
 *
 * The implementation is packages/beanpool-core/src/dm-crypto.ts, which the web app's lib/e2e-crypto.ts re-exports too,
 * so a line either app writes is a line the other reads (the vectors in @beanpool/core/dm-line-vectors pin the bytes).
 *
 *   Key agreement: X25519 from each member's Ed25519 identity; the node never sees a key.
 *   KDF:           HKDF-SHA256, salted with the conversation id.
 *   Cipher:        XChaCha20-Poly1305, a fresh 24-byte nonce per line.
 *   Line format 3: the associated data names the conversation, the sender, the message id and the part (words or
 *                  photo), and the sealed words carry the id of the line they were written after. So the node can't show
 *                  a line as someone else's, replay it as a new message, move it or reorder it unnoticed (crypto review
 *                  M F2, 2026-10-02). Lines from before (format 2: the conversation id alone) still open.
 *
 * Wire format, unchanged: ciphertext = base64(AEAD output); nonce column = "x25519-xc20p-v2:" + base64(nonce).
 * A DM row that isn't an encrypted line is never shown as anyone's words (core dmLineKind; see db.ts). Only static identity keys are used, so there
 * is no forward secrecy yet (a ratchet is future work).
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
    encryptDmFormat2,
    decryptDmFormat2,
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
