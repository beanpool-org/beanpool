/**
 * Pairing Crypto — End-to-End Encrypted QR Device Pairing (#89).
 *
 * Ephemeral Key Agreement:
 * - Desktop PWA generates ephemeral X25519 keypair (desktopPriv, desktopPub) + sessionId.
 * - Mobile App scans QR code containing (sessionId, desktopPub) and generates ephemeral (mobilePriv, mobilePub).
 * - Shared secret derived via X25519 ECDH + HKDF-SHA256 bound to sessionId.
 * - Encrypted via XChaCha20-Poly1305 AEAD with 24-byte random nonce.
 *
 * Zero-Knowledge: The relay server only passes opaque ciphertext and cannot read keys or mnemonics.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';

const HKDF_INFO = utf8ToBytes('beanpool-pairing-v1');
const NONCE_LEN = 24;

export interface PairingSessionInit {
    sessionId: string;
    privateKeyHex: string;
    publicKeyHex: string;
}

export interface EncryptedPairingPayload {
    mobilePubHex: string;
    nonceHex: string;
    ciphertextHex: string;
}

/**
 * Generates an ephemeral X25519 keypair and 128-bit session ID for pairing initiation.
 */
export function createPairingSession(): PairingSessionInit {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const sessionIdBytes = randomBytes(16);

    return {
        sessionId: bytesToHex(sessionIdBytes),
        privateKeyHex: bytesToHex(priv),
        publicKeyHex: bytesToHex(pub),
    };
}

/**
 * Encrypts an identity payload from the authenticated mobile device for the waiting desktop.
 */
export function encryptPairingPayload(
    payload: any,
    desktopPubHex: string,
    sessionId: string
): EncryptedPairingPayload {
    const mobilePriv = x25519.utils.randomSecretKey();
    const mobilePub = x25519.getPublicKey(mobilePriv);
    const desktopPub = hexToBytes(desktopPubHex);

    const sharedSecret = x25519.getSharedSecret(mobilePriv, desktopPub);
    const key = hkdf(sha256, sharedSecret, utf8ToBytes(sessionId), HKDF_INFO, 32);

    const nonce = randomBytes(NONCE_LEN);
    const aad = utf8ToBytes(sessionId);
    const plaintext = utf8ToBytes(JSON.stringify(payload));

    const cipher = xchacha20poly1305(key, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);

    return {
        mobilePubHex: bytesToHex(mobilePub),
        nonceHex: bytesToHex(nonce),
        ciphertextHex: bytesToHex(ciphertext),
    };
}

/**
 * Decrypts the transferred payload on the desktop using its ephemeral private key.
 */
export function decryptPairingPayload<T = any>(
    ciphertextHex: string,
    nonceHex: string,
    mobilePubHex: string,
    desktopPrivHex: string,
    sessionId: string
): T {
    const desktopPriv = hexToBytes(desktopPrivHex);
    const mobilePub = hexToBytes(mobilePubHex);
    const nonce = hexToBytes(nonceHex);
    const ciphertext = hexToBytes(ciphertextHex);

    const sharedSecret = x25519.getSharedSecret(desktopPriv, mobilePub);
    const key = hkdf(sha256, sharedSecret, utf8ToBytes(sessionId), HKDF_INFO, 32);

    const aad = utf8ToBytes(sessionId);
    const cipher = xchacha20poly1305(key, nonce, aad);
    const plaintextBytes = cipher.decrypt(ciphertext);

    const jsonStr = new TextDecoder().decode(plaintextBytes);
    return JSON.parse(jsonStr) as T;
}

/**
 * The other way, browser to phone (front doors S9). The browser seals its account with the session key whose public half
 * its QR shows (`pub`), to the key the phone offered. The phone opens it with the QR's `pub`, never with a key the relay
 * names, so only an account sealed by the browser it scanned opens: a relay that swapped in another account's seal fails
 * the AEAD. Its own HKDF label, so a seal of one direction never opens as the other's.
 */
const TO_PHONE_INFO = utf8ToBytes('beanpool-pairing-to-phone-v1');

function toPhoneKey(ownPrivHex: string, otherPubHex: string, sessionId: string): Uint8Array {
    const shared = x25519.getSharedSecret(hexToBytes(ownPrivHex), hexToBytes(otherPubHex));
    return hkdf(sha256, shared, utf8ToBytes(sessionId), TO_PHONE_INFO, 32);
}

/** A fresh X25519 key for the phone's offer (its private half never leaves the phone). */
export function createPairInKey(): { privateKeyHex: string; publicKeyHex: string } {
    const priv = x25519.utils.randomSecretKey();
    return { privateKeyHex: bytesToHex(priv), publicKeyHex: bytesToHex(x25519.getPublicKey(priv)) };
}

/** The browser seals `payload` from its session key (`browserPrivHex`) to the phone's offered key. */
export function sealPairingPayloadToPhone(
    payload: unknown,
    browserPrivHex: string,
    phonePubHex: string,
    sessionId: string,
): { nonceHex: string; ciphertextHex: string } {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = xchacha20poly1305(toPhoneKey(browserPrivHex, phonePubHex, sessionId), nonce, utf8ToBytes(sessionId));
    return { nonceHex: bytesToHex(nonce), ciphertextHex: bytesToHex(cipher.encrypt(utf8ToBytes(JSON.stringify(payload)))) };
}

/** The phone opens the browser's seal with its own key and the QR's `pub` (`browserPubHex`). Throws on any other seal. */
export function openPairingPayloadOnPhone<T = unknown>(
    ciphertextHex: string,
    nonceHex: string,
    browserPubHex: string,
    phonePrivHex: string,
    sessionId: string,
): T {
    const cipher = xchacha20poly1305(toPhoneKey(phonePrivHex, browserPubHex, sessionId), hexToBytes(nonceHex), utf8ToBytes(sessionId));
    return JSON.parse(new TextDecoder().decode(cipher.decrypt(hexToBytes(ciphertextHex)))) as T;
}
