/**
 * Keeper-share encryption — the layer between {@link splitRecoveryPhrase} and the wire.
 *
 * `recovery-split.ts` turns a phrase into interchangeable fragments and deliberately stops
 * there: nothing about a fragment says whose it is. This module is the next step — sealing
 * each fragment to the keeper who will hold it, in a form the node stores but cannot read.
 *
 * The four keeper types (docs/ONBOARDING.md Part 0) do NOT share one scheme, because they do
 * not share one reader:
 *
 * | Keeper | Read by | Scheme |
 * |---|---|---|
 * | K1 device | nobody — the bytes never leave the phone | not sealed here at all |
 * | K2 hub | **the node**, handing it to a device that holds no key | plaintext, stated |
 * | K4/K5+ member | the keeper's own app, with their identity key | X25519 ECDH → XChaCha20-Poly1305 |
 * | K3 sign-in | any device that can re-obtain the provider `sub` | HKDF(sub) → XChaCha20-Poly1305 |
 *
 * ## Why XChaCha20-Poly1305 and not AES-256-GCM
 *
 * Revisions 3.0–3.7 of the spec said AES-256-GCM. This implements XChaCha20-Poly1305 instead
 * (decision 2026-08-09), for one reason that outweighs the others: `apps/native/utils/e2e-crypto.ts`
 * already does X25519 ECDH into XChaCha20-Poly1305, in production, on Hermes, and byte-compatibly
 * with the PWA. Recovery is the wrong feature to prove a second crypto stack on — its failures are
 * silent and surface only when somebody has already lost their phone.
 *
 * The supporting reasons: neither cipher is hardware-accelerated under Hermes (both are pure JS
 * here), so AES's usual performance argument does not apply; and XChaCha's 24-byte nonce is safe
 * to draw at random indefinitely, where GCM's 12-byte nonce has a birthday bound that a re-split
 * loop could in principle walk into. Nothing about the model depends on which was chosen — the
 * fields on the wire (`encryptedShare`, `shareIv`, `shareTag`) fit either, and the node treats
 * all three as opaque strings.
 *
 * ## What the AEAD is bound to, and what it is not
 *
 * The associated data is a fixed per-scheme label, NOT the owner's public key — which would be
 * the stronger binding and was the first design. It is not available where it would be needed:
 * a device recovering via K3 has a callsign and a session, and `/api/recovery/collect` never
 * returns an owner pubkey (it deliberately returns as little as possible to an unauthenticated
 * device). Binding to a value one reader cannot obtain buys nothing and costs an unopenable
 * fragment.
 *
 * The defence that actually catches a fragment from the wrong split is downstream and already
 * exists: {@link combineRecoveryPhrase} verifies a checksum over the rebuilt phrase and raises
 * rather than returning a plausible wrong answer. AEAD binding would report it earlier and more
 * precisely; the checksum reports it reliably. Only the second property is load-bearing.
 *
 * ## Hermes
 *
 * Pure JavaScript throughout — `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, all of which
 * the native app already bundles and runs. Randomness comes from `@noble/hashes` `randomBytes`,
 * which reads `crypto.getRandomValues`; on React Native that is the `expo-crypto` polyfill in
 * `apps/native/utils/crypto.ts`, installed as an import side effect. {@link assertRecoveryCsprngAvailable}
 * is called on the way into every seal for the same reason the split calls it — a missing
 * polyfill should say so, not throw from inside a dependency.
 */

import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** XChaCha20 nonce width. */
const NONCE_LEN = 24;
/** Poly1305 tag width — what `xchacha20poly1305().encrypt` appends to the ciphertext. */
const TAG_LEN = 16;
/** Ed25519 and X25519 keys are both 32 bytes. */
const KEY_LEN = 32;

/** Scheme identifiers, written into `kdfParams` so a future change is detectable, not silent. */
export const KEEPER_ALG_MEMBER = 'x25519-xc20p-v1';
export const KEEPER_ALG_SSO = 'hkdf-sha256-xc20p-v1';
/** K2's honest name for "not encrypted". See {@link recordShareForHub}. */
export const KEEPER_ALG_PLAINTEXT = 'plaintext-v1';
/** The scheme a keeper re-wraps under when releasing to a recovering device. */
export const KEEPER_ALG_REWRAP = 'x25519-xc20p-rewrap-v1';

const AAD_MEMBER = utf8ToBytes('beanpool-keeper-member-v1');
const AAD_SSO = utf8ToBytes('beanpool-keeper-sso-v1');
const AAD_REWRAP = utf8ToBytes('beanpool-keeper-rewrap-v1');

const HKDF_INFO_MEMBER = utf8ToBytes('beanpool-keeper-share');
const HKDF_INFO_SSO = utf8ToBytes('beanpool-keeper-sso-v1');
const HKDF_INFO_REWRAP = utf8ToBytes('beanpool-keeper-rewrap');

/**
 * Raised when a fragment cannot be sealed or opened.
 *
 * Like {@link RecoveryCombineError}, these messages are for developers and logs. A member
 * hitting one is mid-recovery and frightened; the client owns the sentence they see, matched
 * on the error type rather than on this string.
 */
export class KeeperCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeeperCryptoError';
    }
}

/**
 * One sealed fragment, in the shape `POST /api/recovery/shares` accepts.
 *
 * Every field is base64 except `kdfParams`, which is compact JSON. The node stores all of them
 * verbatim and can interpret none of them.
 */
export interface SealedShare {
    /** Ciphertext WITHOUT the tag — `shareTag` carries that, matching the DB columns. */
    encryptedShare: string;
    /** The 24-byte XChaCha nonce. */
    shareIv: string;
    /** The 16-byte Poly1305 tag. */
    shareTag: string;
    /** X25519 ephemeral public key. Present for member and re-wrap schemes only. */
    ephemeralPubkey?: string;
    /** `{"alg":...}`, plus `salt` where the scheme has one. */
    kdfParams: string;
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function unb64(value: string, field: string): Uint8Array {
    if (typeof value !== 'string' || value.length === 0) {
        throw new KeeperCryptoError(`Recovery fragment field '${field}' is missing.`);
    }
    return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Key material as bytes, from either the hex the apps store or a byte array.
 *
 * The width check rather than a bare `instanceof Uint8Array` (CR): a typed array that crossed a
 * realm boundary — a worker, a `vm` context, a test harness — fails `instanceof` against this
 * realm's constructor and would fall through to the hex branch and throw. Deliberately NOT the
 * broader `ArrayBuffer.isView`, which the review suggested: that also admits `Float32Array` and
 * `DataView`, so a caller passing eight floats would have them reinterpreted as thirty-two bytes
 * of key material and encrypt happily under nonsense. A loud error beats a silent wrong key.
 */
function asBytes(key: string | Uint8Array, field: string): Uint8Array {
    if (ArrayBuffer.isView(key) && (key as Uint8Array).BYTES_PER_ELEMENT === 1) {
        return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    }
    if (typeof key !== 'string' || !/^[0-9a-fA-F]+$/.test(key) || key.length % 2 !== 0) {
        throw new KeeperCryptoError(`${field} must be hex or raw bytes.`);
    }
    return new Uint8Array(Buffer.from(key, 'hex'));
}

function requirePublicKey(key: string | Uint8Array, field: string): Uint8Array {
    const bytes = asBytes(key, field);
    if (bytes.length !== KEY_LEN) {
        throw new KeeperCryptoError(`${field} must be ${KEY_LEN} bytes, got ${bytes.length}.`);
    }
    return bytes;
}

/**
 * Split noble's `ciphertext‖tag` output across the two columns the schema has.
 *
 * The concatenated form would fit in `encryptedShare` alone with `shareTag` left as a filler,
 * but the columns exist and mean something; using one as padding is the kind of small dishonesty
 * that later reads as a bug.
 */
function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): {
    encryptedShare: string; shareIv: string; shareTag: string;
} {
    assertRecoveryCsprngAvailable();
    const nonce = randomBytes(NONCE_LEN);
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return {
        encryptedShare: b64(sealed.subarray(0, sealed.length - TAG_LEN)),
        shareIv: b64(nonce),
        shareTag: b64(sealed.subarray(sealed.length - TAG_LEN)),
    };
}

function open(key: Uint8Array, sealed: SealedShare, aad: Uint8Array): Uint8Array {
    const nonce = unb64(sealed.shareIv, 'shareIv');
    const ciphertext = unb64(sealed.encryptedShare, 'encryptedShare');
    const tag = unb64(sealed.shareTag, 'shareTag');
    const joined = new Uint8Array(ciphertext.length + tag.length);
    joined.set(ciphertext);
    joined.set(tag, ciphertext.length);
    try {
        return xchacha20poly1305(key, nonce, aad).decrypt(joined);
    } catch {
        // Deliberately does not distinguish a wrong key from a tampered ciphertext: the AEAD
        // cannot tell them apart, and a message implying it could would be a lie in both cases.
        throw new KeeperCryptoError(
            'A recovery fragment did not open. The key is wrong, or the fragment has been altered.',
        );
    }
}

function parseAlg(kdfParams: string | undefined, expected: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(kdfParams ?? '');
    } catch {
        throw new KeeperCryptoError('A recovery fragment has unreadable kdfParams.');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new KeeperCryptoError('A recovery fragment has unreadable kdfParams.');
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.alg !== expected) {
        // A newer client wrote this, or the fragment is of a different keeper type. Refused
        // rather than attempted: guessing the scheme is how a wrong answer gets returned.
        throw new KeeperCryptoError(
            `A recovery fragment uses scheme '${String(obj.alg)}', but '${expected}' was expected.`,
        );
    }
    return obj;
}

/**
 * An Ed25519 public key as an X25519 point, or a stated error.
 *
 * Both callers take this key from somewhere they do not control — a keeper's key comes from the
 * node, and a recovering device's key comes off the wire — so "not a point" is an input case,
 * not an assertion.
 */
function toX25519Public(edPublicKey: Uint8Array, what: string): Uint8Array {
    try {
        return ed25519.utils.toMontgomery(edPublicKey);
    } catch (e) {
        throw new KeeperCryptoError(`${what} is not a usable Ed25519 point: ${(e as Error).message}`);
    }
}

/**
 * ECDH into a 32-byte AEAD key, with every failure stated in this module's vocabulary.
 *
 * ## Small-order points
 *
 * Review raised that an attacker-supplied public key could be low-order, making the shared secret
 * predictable — which would matter most at {@link rewrapShareToDevice}, where the key arrives from
 * an unauthenticated device mid-recovery. Measured against `@noble/curves` v2 rather than reasoned
 * about: `getSharedSecret` **already refuses all six small-order Ed25519 points**, throwing
 * "invalid private or public key received" — it checks for the all-zero shared secret required by
 * RFC 7748 §6.1. The identity point does not even survive `toMontgomery`.
 *
 * The guard the review proposed (reject when the *public key* is all zero) would have caught one
 * of the six: it is true only for the order-2 point, and orders 4 and 8 pass straight through it.
 * Adding it would have looked like a defence while covering a sixth of the cases.
 *
 * So the fix here is not a guard but the reporting: noble throws a bare `Error`, which is a real
 * defect at this boundary because a caller matching on {@link KeeperCryptoError} would not catch a
 * hostile key at all. `test-keeper-crypto` pins noble's refusal for all six points, so if a future
 * version relaxes it we find out from a failing test rather than from the property quietly going
 * missing — the safety is a dependency's behaviour, and undocumented dependency behaviour is
 * exactly what a test should hold in place.
 */
function agreeKey(mySecret: Uint8Array, theirPublic: Uint8Array, info: Uint8Array, what: string): Uint8Array {
    try {
        return hkdf(sha256, x25519.getSharedSecret(mySecret, theirPublic), undefined, info, 32);
    } catch (e) {
        throw new KeeperCryptoError(`${what} could not be agreed: ${(e as Error).message}`);
    }
}

/** X25519 ephemeral keypair. Raw random bytes — X25519 clamps, so any 32 bytes is a valid secret. */
function ephemeralKeypair(): { secret: Uint8Array; publicKey: Uint8Array } {
    assertRecoveryCsprngAvailable();
    const secret = randomBytes(KEY_LEN);
    return { secret, publicKey: x25519.getPublicKey(secret) };
}

/**
 * Seal a fragment to a human keeper's account key (K4, K5+).
 *
 * Ephemeral-to-static rather than static-to-static — the DM path in `e2e-crypto.ts` uses both
 * identity keys because both parties must derive the same key repeatedly. Here only the keeper
 * ever reads it, so the sender's half is thrown away with the ephemeral secret. That is the
 * point: the owner's identity key being compromised later does not retroactively expose the
 * fragments they deposited with their keepers.
 *
 * @param share            one fragment from {@link splitRecoveryPhrase}
 * @param keeperPublicKey  the keeper's Ed25519 account key (hex or raw)
 */
export function sealShareToMember(share: Uint8Array, keeperPublicKey: string | Uint8Array): SealedShare {
    const keeperX = toX25519Public(requirePublicKey(keeperPublicKey, 'keeperPublicKey'), "That keeper's public key");
    const eph = ephemeralKeypair();
    const key = agreeKey(eph.secret, keeperX, HKDF_INFO_MEMBER, "A key with that keeper");
    return {
        ...seal(key, share, AAD_MEMBER),
        ephemeralPubkey: b64(eph.publicKey),
        kdfParams: JSON.stringify({ alg: KEEPER_ALG_MEMBER }),
    };
}

/**
 * Open a fragment held for somebody else, using this keeper's own identity key.
 *
 * @param privateKey the keeper's Ed25519 private key — PKCS8 or raw seed, normalised by
 *                   {@link toEd25519Seed}, because a PKCS8-wrapped key silently derives a
 *                   different X25519 secret and would fail the tag with no hint why.
 */
export function openShareAsMember(sealed: SealedShare, privateKey: string | Uint8Array): Uint8Array {
    parseAlg(sealed.kdfParams, KEEPER_ALG_MEMBER);
    if (!sealed.ephemeralPubkey) {
        throw new KeeperCryptoError('A member fragment is missing the ephemeral public key that opens it.');
    }
    const seed = toEd25519Seed(asBytes(privateKey, 'privateKey'));
    const myX = ed25519.utils.toMontgomerySecret(seed);
    const ephX = requirePublicKey(unb64(sealed.ephemeralPubkey, 'ephemeralPubkey'), 'ephemeralPubkey');
    const key = agreeKey(myX, ephX, HKDF_INFO_MEMBER, 'The key that opens this fragment');
    return open(key, sealed, AAD_MEMBER);
}

/**
 * Seal the sign-in fragment (K3) under a key derived from the provider's subject claim.
 *
 * ## The salt here is NOT the lookup salt
 *
 * The spec's step 3 reads `HKDF-SHA256(sub, salt)` where `salt` is the lookup salt, and that is
 * not implementable in the order the deposit actually happens: the node generates the lookup
 * salt in `keeper-deposit.ts` AFTER verifying the `id_token`, and the client has to have
 * encrypted the fragment before it sends it. This salt is the client's own, generated here and
 * carried in `kdfParams`, which the node stores without reading.
 *
 * Keeping them separate is also the better of the two. The lookup hash sits in the same row as
 * the ciphertext, so a shared salt would let anyone who guesses `sub` confirm the guess against
 * the hash — the confirmation is free either way, but there is no reason to build the oracle in.
 *
 * ## This key is weak on purpose
 *
 * `sub` is not a secret: the provider knows it, and this node may well be able to derive it.
 * What that yields an attacker is ONE fragment, and the threshold is three. Security here comes
 * from the threshold, not from this key — which is the architectural point of Revision 3, and
 * the reason this is acceptable where it would not be if K3 stood alone.
 */
export function sealShareToSso(share: Uint8Array, provider: string, sub: string): SealedShare {
    if (!provider || !sub) {
        throw new KeeperCryptoError('A sign-in fragment needs both a provider and a subject claim.');
    }
    assertRecoveryCsprngAvailable();
    const salt = randomBytes(KEY_LEN);
    const key = hkdf(sha256, utf8ToBytes(`${provider}:${sub}`), salt, HKDF_INFO_SSO, 32);
    return {
        ...seal(key, share, AAD_SSO),
        kdfParams: JSON.stringify({ alg: KEEPER_ALG_SSO, salt: b64(salt) }),
    };
}

/** Re-derive K3's key from a freshly obtained `sub` and open the fragment. */
export function openShareFromSso(sealed: SealedShare, provider: string, sub: string): Uint8Array {
    // Checked on the way out as well as the way in (CR): an empty sub would otherwise derive a key
    // from the string ":" and fail on the tag, reporting a corrupt fragment when what actually
    // happened is that the sign-in returned nothing.
    if (!provider || !sub) {
        throw new KeeperCryptoError('A sign-in fragment needs both a provider and a subject claim.');
    }
    const params = parseAlg(sealed.kdfParams, KEEPER_ALG_SSO);
    if (typeof params.salt !== 'string') {
        throw new KeeperCryptoError('A sign-in fragment is missing the salt its key derives from.');
    }
    const key = hkdf(sha256, utf8ToBytes(`${provider}:${sub}`), unb64(params.salt, 'salt'), HKDF_INFO_SSO, 32);
    return open(key, sealed, AAD_SSO);
}

/**
 * Record the hub fragment (K2) — which is **not encrypted**, and says so.
 *
 * This looks like a mistake and is not. `/api/recovery/collect/hub` hands K2 to a device that
 * has just been made and holds no key of the owner's at all; if the node could not read it, it
 * could not hand back anything the device could use. Revisions 3.0–3.6 specified an env-held
 * wrapping key and it was withdrawn on 2026-08-08 rather than built, because losing that
 * variable — a node rebuild, a redeploy, an operator handover — would make every member's K2
 * permanently undecryptable, discovered only when somebody tried to recover.
 *
 * The honest statement of the margin: a database snapshot yields two readable pieces, K2 and
 * K3 (whose key derives from `sub`). The threshold is three, so the model holds — by exactly
 * one human keeper. **Anything that lets the node reach a third piece breaks recovery outright.**
 *
 * The IV and tag are stated sentinels rather than random filler, so that a reader of the table
 * can see this row is plaintext instead of inferring it from a decrypt that never happens.
 */
export function recordShareForHub(share: Uint8Array): SealedShare {
    return {
        encryptedShare: b64(share),
        shareIv: b64(utf8ToBytes(KEEPER_ALG_PLAINTEXT)),
        shareTag: b64(utf8ToBytes(KEEPER_ALG_PLAINTEXT)),
        kdfParams: JSON.stringify({ alg: KEEPER_ALG_PLAINTEXT }),
    };
}

/** Read back a hub fragment. Present so no caller has to know that K2 is stored in the clear. */
export function readHubShare(sealed: SealedShare): Uint8Array {
    parseAlg(sealed.kdfParams, KEEPER_ALG_PLAINTEXT);
    return unb64(sealed.encryptedShare, 'encryptedShare');
}

/**
 * Re-wrap an opened fragment to the ephemeral key of the device being recovered.
 *
 * This is the step that makes `/api/recovery/approve-keeper` the only path that releases a
 * member fragment: it needs the keeper's private key, so the node cannot perform it and the
 * approve button cannot quietly stand in for it. The keeper's app opens its own fragment with
 * {@link openShareAsMember} and seals the result to the recovering device with this.
 *
 * @param devicePublicKey the recovering device's Ed25519 ephemeral key, from the collect session
 */
export function rewrapShareToDevice(share: Uint8Array, devicePublicKey: string | Uint8Array): SealedShare {
    // This key arrives from an unauthenticated device mid-recovery — the least trusted input in
    // the module, and the reason the ECDH failure path here is not theoretical.
    const deviceX = toX25519Public(requirePublicKey(devicePublicKey, 'devicePublicKey'), "The recovering device's key");
    const eph = ephemeralKeypair();
    const key = agreeKey(eph.secret, deviceX, HKDF_INFO_REWRAP, 'A key with the recovering device');
    return {
        ...seal(key, share, AAD_REWRAP),
        ephemeralPubkey: b64(eph.publicKey),
        kdfParams: JSON.stringify({ alg: KEEPER_ALG_REWRAP }),
    };
}

/**
 * Open a re-wrapped fragment on the recovering device.
 *
 * `/api/recovery/collect/fragments` returns these as `payload`/`payloadIv`/`payloadTag` and does
 * NOT return `kdfParams`, so the scheme cannot be read off the wire — it is fixed by construction
 * and asserted here rather than negotiated.
 */
export function openRewrappedShare(
    sealed: Omit<SealedShare, 'kdfParams'>,
    ephemeralPrivateKey: string | Uint8Array,
): Uint8Array {
    if (!sealed.ephemeralPubkey) {
        throw new KeeperCryptoError('A released fragment is missing the ephemeral public key that opens it.');
    }
    const seed = toEd25519Seed(asBytes(ephemeralPrivateKey, 'ephemeralPrivateKey'));
    const myX = ed25519.utils.toMontgomerySecret(seed);
    const senderX = requirePublicKey(unb64(sealed.ephemeralPubkey, 'ephemeralPubkey'), 'ephemeralPubkey');
    const key = agreeKey(myX, senderX, HKDF_INFO_REWRAP, 'The key that opens this released fragment');
    return open(key, { ...sealed, kdfParams: '' }, AAD_REWRAP);
}
