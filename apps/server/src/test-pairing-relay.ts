/**
 * Pairing Relay & Crypto Test Suite (#89).
 *
 * Verifies:
 * 1. Session initialization & validation
 * 2. In-memory relay storage and status transitions ('waiting' -> 'transferred' -> purged)
 * 3. Strict single-use destruction on successful poll
 * 4. End-to-end cryptographic roundtrip between Desktop and Mobile via relay
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pairing-relay.ts
 */

import {
    initPairingSession,
    transferPairingPayload,
    pollPairingSession,
    cancelPairingSession,
    clearAllPairingSessions,
} from './pairing-relay.js';
import {
    createPairingSession,
    encryptPairingPayload,
    decryptPairingPayload,
} from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main() {
    console.log('🧪 Starting QR Device Pairing Test Suite (#89)...\n');

    clearAllPairingSessions();

    // 1. Validation tests
    const badInit1 = initPairingSession('', 'abc');
    assert(!badInit1.ok, 'Rejects empty sessionId');

    const badInit2 = initPairingSession('1234567890abcdef', 'not-64-hex');
    assert(!badInit2.ok, 'Rejects invalid desktopPubHex length');

    // 2. Lifecycle: Init -> Poll Waiting -> Cancel
    const desktopSession1 = createPairingSession();
    const initRes = initPairingSession(desktopSession1.sessionId, desktopSession1.publicKeyHex);
    assert(initRes.ok, 'Initializes valid pairing session');
    assert(typeof initRes.expiresAt === 'number' && initRes.expiresAt > Date.now(), 'Sets future expiration timestamp');

    const pollWaiting = pollPairingSession(desktopSession1.sessionId);
    assert(pollWaiting.status === 'waiting', 'Polling unfulfilled session returns status "waiting"');
    assert(pollWaiting.desktopPubHex === desktopSession1.publicKeyHex, 'Polling returns desktopPubHex');

    cancelPairingSession(desktopSession1.sessionId);
    const pollCancelled = pollPairingSession(desktopSession1.sessionId);
    assert(pollCancelled.status === 'expired', 'Cancelled session returns status "expired"');

    // 3. Single-Use & Purge Guarantee
    const desktopSession2 = createPairingSession();
    initPairingSession(desktopSession2.sessionId, desktopSession2.publicKeyHex);

    const testPayload = {
        callsign: 'Damien',
        publicKey: '11'.repeat(32),
        privateKey: '22'.repeat(32),
        mnemonic: ['climb', 'ridge', 'forest', 'creek', 'solar', 'harvest', 'garden', 'timber', 'breeze', 'summit', 'valley', 'meadow'],
        createdAt: new Date().toISOString(),
    };

    const encrypted = encryptPairingPayload(
        testPayload,
        desktopSession2.publicKeyHex,
        desktopSession2.sessionId
    );

    const transferRes = transferPairingPayload(
        desktopSession2.sessionId,
        encrypted.mobilePubHex,
        encrypted.nonceHex,
        encrypted.ciphertextHex
    );
    assert(transferRes.ok, 'Transfers encrypted payload successfully');

    // First poll receives payload
    const pollSuccess = pollPairingSession(desktopSession2.sessionId);
    assert(pollSuccess.status === 'transferred', 'Poll returns status "transferred"');
    assert(!!pollSuccess.payload, 'Poll returns payload object');
    assert(pollSuccess.payload?.ciphertextHex === encrypted.ciphertextHex, 'Payload ciphertext matches');

    // Second poll must be expired / deleted (single-use guarantee)
    const pollSecond = pollPairingSession(desktopSession2.sessionId);
    assert(pollSecond.status === 'expired', 'Immediate second poll returns "expired" (single-use purged)');

    // 4. End-to-End Decryption Verification
    const decrypted = decryptPairingPayload(
        pollSuccess.payload!.ciphertextHex,
        pollSuccess.payload!.nonceHex,
        pollSuccess.payload!.mobilePubHex,
        desktopSession2.privateKeyHex,
        desktopSession2.sessionId
    );

    assert(decrypted.callsign === 'Damien', 'Decrypted callsign matches "Damien"');
    assert(decrypted.publicKey === testPayload.publicKey, 'Decrypted publicKey matches');
    assert(decrypted.privateKey === testPayload.privateKey, 'Decrypted privateKey matches');
    assert(Array.isArray(decrypted.mnemonic) && decrypted.mnemonic.length === 12, 'Decrypted mnemonic is 12 words');
    assert(decrypted.mnemonic[0] === 'climb', 'Decrypted mnemonic first word matches');

    console.log(`\nDevice Pairing Test Summary: ${passed}/${run} assertions passed.`);
    if (passed < run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error in Device Pairing test suite:', err);
    process.exit(1);
});
