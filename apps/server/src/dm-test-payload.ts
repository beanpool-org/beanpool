/**
 * A direct message as the apps send one: end-to-end encrypted, in the v2 wire form (apps/pwa/src/lib/e2e-crypto.ts).
 * The node refuses any other form into a DM (engine/messaging.ts, isEncryptedDmPayload), so a suite that needs a DM
 * line sends one of these. The bytes are random: the node never holds the key, so it cannot tell them from real
 * ciphertext, and a suite needs no key either.
 *
 * No import from the engine on purpose: suites set BEANPOOL_DATA_DIR before they load the database, and a static
 * import of the engine from here would open it first.
 */
import crypto from 'node:crypto';

/** engine/messaging.ts DM_ENCRYPTED_NONCE_PREFIX. */
const V2_NONCE_PREFIX = 'x25519-xc20p-v2:';

/** A fresh encrypted-form payload: `bytes` of ciphertext (at least the 16-byte AEAD tag) and a 24-byte nonce. */
export function lockedDm(bytes = 32): { ciphertext: string; nonce: string } {
    return {
        ciphertext: crypto.randomBytes(Math.max(16, bytes)).toString('base64'),
        nonce: V2_NONCE_PREFIX + crypto.randomBytes(24).toString('base64'),
    };
}
