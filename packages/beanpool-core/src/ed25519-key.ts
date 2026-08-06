/**
 * Ed25519 private-key formats — one definition, shared by both clients.
 *
 * The same identity is stored differently on each platform, for reasons that are historical
 * rather than considered:
 *
 *   native   the raw 32-byte seed, because @noble/ed25519 signs with exactly that
 *   PWA      a 48-byte PKCS8 envelope, because WebCrypto's importKey('pkcs8', …) wants one
 *
 * Both hold the identical secret and derive the identical public key. A key moved between
 * platforms therefore looks completely correct — right account, right name, right balance —
 * and then fails to sign, because the receiving side reads 16 bytes of ASN.1 header as if it
 * were the start of the secret. The server answers 401 with nothing to distinguish it from a
 * wrong password, which is a slow thing to chase.
 *
 * Every consumer had been individually taught to cope, which is how the format assumption
 * ended up written out five times across four files: three copies of the header bytes, and
 * two hardcoded `.slice(16)` offsets. That is survivable while the set of consumers is
 * closed. It stops being survivable when new ones arrive — key export, device pairing, and
 * above all the recovery split, where a secret is divided on one device and reassembled on
 * another by design. One of those forgetting the check is a signature that fails for a
 * reason nobody can see.
 *
 * So the knowledge lives here instead, stated once. These are pure byte operations with no
 * dependencies, which is what lets the same code run under Hermes and in a browser.
 *
 * The canonical in-memory form is the **raw 32-byte seed**: it is the smaller of the two, it
 * is what the split operates on, and it is the only part that is actually secret — the
 * envelope is a fixed constant that carries no information.
 *
 * Storage is deliberately left alone. Each platform keeps writing what it already writes, so
 * no existing identity needs migrating; conversion happens at the point of use.
 */

/**
 * The 16-byte ASN.1 prefix of a PKCS8-wrapped Ed25519 private key.
 *
 * SEQUENCE(46) { INTEGER 0, SEQUENCE(5) { OID 1.3.101.112 }, OCTET STRING(34) { OCTET
 * STRING(32) { seed } } } — fixed for every Ed25519 key, which is exactly why it can be
 * sliced off and stuck back on rather than parsed.
 */
// Not frozen: Object.freeze throws on a typed array that has elements. Read-only by
// convention — nothing here mutates it, and toEd25519Pkcs8 copies it into a fresh buffer.
export const ED25519_PKCS8_HEADER = new Uint8Array([
    0x30, 0x2e,                          // SEQUENCE, 46 bytes
    0x02, 0x01, 0x00,                    // INTEGER 0 (version)
    0x30, 0x05,                          // SEQUENCE, 5 bytes
    0x06, 0x03, 0x2b, 0x65, 0x70,        // OID 1.3.101.112 (Ed25519)
    0x04, 0x22,                          // OCTET STRING, 34 bytes
    0x04, 0x20,                          // OCTET STRING, 32 bytes (the seed follows)
]);

/** Length of a raw Ed25519 seed. */
export const ED25519_SEED_LENGTH = 32;

/** Length of a PKCS8-wrapped Ed25519 private key: header + seed. */
export const ED25519_PKCS8_LENGTH = ED25519_PKCS8_HEADER.length + ED25519_SEED_LENGTH;

function describe(key: Uint8Array): string {
    return `${key.length}-byte key (expected ${ED25519_SEED_LENGTH} raw or ${ED25519_PKCS8_LENGTH} PKCS8)`;
}

/**
 * The raw 32-byte seed, whichever form was handed in.
 *
 * Use before anything that signs with noble, derives an X25519 secret, or splits the key.
 * Throws on any other length rather than passing it along: the alternative is a signature
 * computed over the wrong bytes, which verifies nowhere and explains nothing.
 */
export function toEd25519Seed(key: Uint8Array): Uint8Array {
    if (key.length === ED25519_SEED_LENGTH) return key;
    if (key.length === ED25519_PKCS8_LENGTH) return key.slice(ED25519_PKCS8_HEADER.length);
    throw new Error(`Unrecognised Ed25519 private key: ${describe(key)}`);
}

/**
 * The 48-byte PKCS8 form, whichever form was handed in.
 *
 * Use before WebCrypto's `importKey('pkcs8', …)`, which will not take a bare seed.
 */
export function toEd25519Pkcs8(key: Uint8Array): Uint8Array {
    if (key.length === ED25519_PKCS8_LENGTH) return key;
    if (key.length !== ED25519_SEED_LENGTH) {
        throw new Error(`Unrecognised Ed25519 private key: ${describe(key)}`);
    }
    const out = new Uint8Array(ED25519_PKCS8_LENGTH);
    out.set(ED25519_PKCS8_HEADER);
    out.set(key, ED25519_PKCS8_HEADER.length);
    return out;
}
