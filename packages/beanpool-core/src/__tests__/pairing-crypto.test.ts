import { describe, it, expect } from 'vitest';
import { createPairingSession, encryptPairingPayload, decryptPairingPayload } from '../pairing-crypto.js';

describe('Pairing Crypto', () => {
    it('generates session with valid hex keys and 16-byte sessionId', () => {
        const session = createPairingSession();
        expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/);
        expect(session.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(session.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    });

    it('encrypts and decrypts an identity payload roundtrip', () => {
        const desktopSession = createPairingSession();

        const testIdentity = {
            callsign: 'Alice',
            publicKey: 'a'.repeat(64),
            privateKey: 'b'.repeat(64),
            mnemonic: ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'hazelnut', 'kiwi', 'lemon', 'mango', 'nectarine'],
            version: 1,
        };

        const encrypted = encryptPairingPayload(
            testIdentity,
            desktopSession.publicKeyHex,
            desktopSession.sessionId
        );

        expect(encrypted.mobilePubHex).toMatch(/^[0-9a-f]{64}$/);
        expect(encrypted.nonceHex).toMatch(/^[0-9a-f]{48}$/);
        expect(encrypted.ciphertextHex.length).toBeGreaterThan(0);

        const decrypted = decryptPairingPayload(
            encrypted.ciphertextHex,
            encrypted.nonceHex,
            encrypted.mobilePubHex,
            desktopSession.privateKeyHex,
            desktopSession.sessionId
        );

        expect(decrypted).toEqual(testIdentity);
    });

    it('fails decryption with mismatched session ID (AAD tampering)', () => {
        const desktopSession = createPairingSession();
        const testIdentity = { callsign: 'Bob' };

        const encrypted = encryptPairingPayload(
            testIdentity,
            desktopSession.publicKeyHex,
            desktopSession.sessionId
        );

        expect(() => {
            decryptPairingPayload(
                encrypted.ciphertextHex,
                encrypted.nonceHex,
                encrypted.mobilePubHex,
                desktopSession.privateKeyHex,
                'wrong-session-id-12345678901234'
            );
        }).toThrow();
    });

    it('fails decryption with wrong desktop private key', () => {
        const desktopSession = createPairingSession();
        const wrongSession = createPairingSession();
        const testIdentity = { callsign: 'Charlie' };

        const encrypted = encryptPairingPayload(
            testIdentity,
            desktopSession.publicKeyHex,
            desktopSession.sessionId
        );

        expect(() => {
            decryptPairingPayload(
                encrypted.ciphertextHex,
                encrypted.nonceHex,
                encrypted.mobilePubHex,
                wrongSession.privateKeyHex,
                desktopSession.sessionId
            );
        }).toThrow();
    });
});
