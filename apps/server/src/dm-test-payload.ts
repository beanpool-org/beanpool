/**
 * A direct message as the apps send one: in line format 4's form (core dm-crypto.ts), the nonce column 'x25519-xc20p-v2:'
 * + base64 of 24 bytes and the ciphertext column [4][signature, 64 bytes][signing time, 24][AEAD output]. The node refuses
 * any other form into a DM (engine/messaging.ts, isEncryptedDmPayload), so a suite that needs a DM line sends one of these.
 * The signature and sealed bytes are random: the node never holds the key and verifies no signature (both apps do, when
 * they open a line), so it cannot tell them from a real line's, and a suite needs no key either.
 *
 * No import from the engine on purpose: suites set BEANPOOL_DATA_DIR before they load the database, and a static
 * import of the engine from here would open it first.
 */
import crypto from 'node:crypto';

/** engine/messaging.ts DM_ENCRYPTED_NONCE_PREFIX. */
const V2_NONCE_PREFIX = 'x25519-xc20p-v2:';
/** The format byte, the signature and the signing time: what a format-4 column carries before its AEAD output. */
const HEAD_BYTES = 1 + 64 + 24;
const AEAD_TAG_BYTES = 16;

/**
 * A ciphertext column in format 4's form, `bytes` long in all (at least the head and an AEAD tag, 105): base64 of exactly
 * `bytes / 3 * 4` characters when `bytes` is a multiple of 3. Its first character is 'B' (the format byte, 4), never '/'.
 */
export function lockedColumn(bytes: number): string {
    const b = crypto.randomBytes(Math.max(HEAD_BYTES + AEAD_TAG_BYTES, bytes));
    b[0] = 4;
    b.write('2026-11-10T00:00:00.000Z', 1 + 64, 'ascii');
    return b.toString('base64');
}

/** A fresh format-4 payload: `bytes` of sealed bytes (at least the 16-byte AEAD tag) after the head, and a 24-byte nonce. */
export function lockedDm(bytes = 32): { ciphertext: string; nonce: string } {
    return {
        ciphertext: lockedColumn(HEAD_BYTES + Math.max(AEAD_TAG_BYTES, bytes)),
        nonce: V2_NONCE_PREFIX + crypto.randomBytes(24).toString('base64'),
    };
}
