/**
 * Pairing Relay & Crypto Test Suite (#89).
 *
 * Verifies:
 * 1. Session initialization & validation
 * 2. In-memory relay storage and status transitions ('waiting' -> 'transferred' -> purged)
 * 3. Strict single-use destruction on successful poll
 * 4. End-to-end cryptographic roundtrip between Desktop and Mobile via relay
 * 5. What an unsigned sender can hold (#1950): 10,000 waiting sessions, 1,000 payloads, 4,096 hex each
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pairing-relay.ts
 */

import {
    initPairingSession,
    transferPairingPayload,
    pollPairingSession,
    cancelPairingSession,
    clearAllPairingSessions,
    PAIRING_RELAY_LIMITS,
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

    const pollEmpty = pollPairingSession('');
    assert(pollEmpty.status === 'expired', 'Polling empty sessionId returns status "expired"');

    const pollInvalid = pollPairingSession('invalid-session-id!');
    assert(pollInvalid.status === 'expired', 'Polling invalid sessionId format returns status "expired"');

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

    // Payload size cap validation
    const badTransfer = transferPairingPayload(
        desktopSession2.sessionId,
        encrypted.mobilePubHex,
        encrypted.nonceHex,
        'zz-not-hex'
    );
    assert(!badTransfer.ok, 'Rejects non-hex ciphertext');

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

    // Second poll within grace period also succeeds (resilience against dropped responses)
    const pollRetry = pollPairingSession(desktopSession2.sessionId);
    assert(pollRetry.status === 'transferred', 'Immediate retry poll succeeds during resilience grace period');

    // Explicit cancellation purges immediately
    cancelPairingSession(desktopSession2.sessionId);
    const pollCancelledAfter = pollPairingSession(desktopSession2.sessionId);
    assert(pollCancelledAfter.status === 'expired', 'Explicit cancellation purges session immediately');

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

    // 5. The relay's caps (#1950): what one unsigned sender can hold for the 2 minutes
    console.log('\n── 5. the relay\'s caps ──');
    clearAllPairingSessions();
    assert(PAIRING_RELAY_LIMITS.sessions === 10_000 && PAIRING_RELAY_LIMITS.heldPayloads === 1_000 && PAIRING_RELAY_LIMITS.ciphertextHex === 4_096,
        `10,000 waiting sessions, 1,000 payloads held, 4,096 hex a payload (${JSON.stringify(PAIRING_RELAY_LIMITS)})`);
    const mobileHex = '11'.repeat(32);
    const nonce = '00'.repeat(24);
    const opened = () => { const d = createPairingSession(); return initPairingSession(d.sessionId, d.publicKeyHex).ok ? d : null; };
    const edge = opened()!;
    const tooLong = transferPairingPayload(edge.sessionId, mobileHex, nonce, 'a'.repeat(4_097));
    assert(!tooLong.ok && pollPairingSession(edge.sessionId).status === 'waiting', 'a payload of 4,097 hex is refused, and its session stays waiting');
    assert(transferPairingPayload(edge.sessionId, mobileHex, nonce, 'a'.repeat(4_096)).ok, 'one of 4,096 hex is taken');
    // The largest the phone builds (apps/native/app/pair-device.tsx): a 32-character name in the costliest characters to
    // send (each a control character JSON writes as 6 bytes), the longest key the phone keeps, 24 eight-letter words.
    const big = createPairingSession();
    initPairingSession(big.sessionId, big.publicKeyHex);
    const largest = encryptPairingPayload({
        callsign: '\u0001'.repeat(32), publicKey: '11'.repeat(32), privateKey: '22'.repeat(64),
        mnemonic: Array.from({ length: 24 }, () => 'abstract'), createdAt: new Date().toISOString(), version: 1,
    }, big.publicKeyHex, big.sessionId);
    assert(largest.ciphertextHex.length < 4_096 / 2 && transferPairingPayload(big.sessionId, largest.mobilePubHex, largest.nonceHex, largest.ciphertextHex).ok,
        `the largest payload the phone builds is ${largest.ciphertextHex.length} hex, under half the limit, and is taken`);
    clearAllPairingSessions();
    const ids: string[] = [];
    for (let i = 0; i < 1_001; i++) { const d = opened(); if (d) ids.push(d.sessionId); }
    const marker = (i: number) => i.toString(16).padStart(4, '0');
    let taken = 0;
    for (let i = 0; i < 1_000; i++) if (transferPairingPayload(ids[i], mobileHex, nonce, marker(i) + 'c'.repeat(60)).ok) taken++;
    const over = transferPairingPayload(ids[1_000], mobileHex, nonce, 'd'.repeat(64));
    assert(ids.length === 1_001 && taken === 1_000 && !over.ok && over.error === 'Pairing relay at capacity. Please try again shortly.',
        `1,000 payloads are held; the 1,001st is refused with the relay's busy answer (${taken} taken, then ${JSON.stringify(over)})`);
    assert(pollPairingSession(ids[1_000]).status === 'waiting', 'its session stays waiting, so the phone can try again');
    let intact = 0;
    for (let i = 0; i < 1_000; i++) {
        const got = pollPairingSession(ids[i]);
        if (got.status === 'transferred' && got.payload?.ciphertextHex === marker(i) + 'c'.repeat(60)) intact++;
    }
    assert(intact === 1_000, `and nothing was dropped to make room: each of the first 1,000 still holds its own payload (${intact})`);
    const another = opened();
    assert(!!another, 'a new waiting session still opens while the payloads are full');
    cancelPairingSession(ids[0]);
    assert(transferPairingPayload(ids[1_000], mobileHex, nonce, 'd'.repeat(64)).ok, 'once one computer is done, the waiting phone\'s payload is taken');
    assert(!transferPairingPayload(another!.sessionId, mobileHex, nonce, 'e'.repeat(64)).ok, 'and the cap holds again at 1,000');
    clearAllPairingSessions();

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
