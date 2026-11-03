/**
 * Browser to phone (front doors S9): the browser seals from its session key (the QR's `pub`) to the key the phone offered,
 * and the phone opens with the QR's `pub`. A seal by any other key, for another session, or of the other direction fails.
 */
import { describe, it, expect } from 'vitest';
import {
    createPairingSession,
    createPairInKey,
    encryptPairingPayload,
    openPairingPayloadOnPhone,
    sealPairingPayloadToPhone,
} from '../pairing-crypto.js';

const ACCOUNT = { version: 1, publicKey: 'a'.repeat(64), mnemonic: ['apple', 'banana', 'cherry', 'date', 'elder', 'fig', 'grape', 'hazel', 'kiwi', 'lemon', 'mango', 'olive'] };

describe('pairing to a phone', () => {
    it('opens on the phone with the QR key, exactly', () => {
        const browser = createPairingSession();
        const phone = createPairInKey();
        expect(phone.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(phone.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
        const sealed = sealPairingPayloadToPhone(ACCOUNT, browser.privateKeyHex, phone.publicKeyHex, browser.sessionId);
        expect(sealed.nonceHex).toMatch(/^[0-9a-f]{48}$/);
        expect(openPairingPayloadOnPhone(sealed.ciphertextHex, sealed.nonceHex, browser.publicKeyHex, phone.privateKeyHex, browser.sessionId))
            .toEqual(ACCOUNT);
    });

    it('refuses a seal made by any key but the QR one (a relay swapping in another account)', () => {
        const browser = createPairingSession();
        const other = createPairingSession();
        const phone = createPairInKey();
        const swapped = sealPairingPayloadToPhone(ACCOUNT, other.privateKeyHex, phone.publicKeyHex, browser.sessionId);
        expect(() => openPairingPayloadOnPhone(swapped.ciphertextHex, swapped.nonceHex, browser.publicKeyHex, phone.privateKeyHex, browser.sessionId))
            .toThrow();
    });

    it('refuses a seal for another session, or to another phone', () => {
        const browser = createPairingSession();
        const phone = createPairInKey();
        const otherPhone = createPairInKey();
        const sealed = sealPairingPayloadToPhone(ACCOUNT, browser.privateKeyHex, phone.publicKeyHex, browser.sessionId);
        expect(() => openPairingPayloadOnPhone(sealed.ciphertextHex, sealed.nonceHex, browser.publicKeyHex, phone.privateKeyHex, 'f'.repeat(32)))
            .toThrow();
        expect(() => openPairingPayloadOnPhone(sealed.ciphertextHex, sealed.nonceHex, browser.publicKeyHex, otherPhone.privateKeyHex, browser.sessionId))
            .toThrow();
    });

    it("never opens the other direction's seal (its own HKDF label)", () => {
        const phone = createPairInKey();
        const session = createPairingSession();
        // A phone-to-browser seal to the phone's key, from a key whose public half the phone is told is the browser's.
        const fromPhoneWay = encryptPairingPayload(ACCOUNT, phone.publicKeyHex, session.sessionId);
        expect(() => openPairingPayloadOnPhone(fromPhoneWay.ciphertextHex, fromPhoneWay.nonceHex, fromPhoneWay.mobilePubHex, phone.privateKeyHex, session.sessionId))
            .toThrow();
    });
});
