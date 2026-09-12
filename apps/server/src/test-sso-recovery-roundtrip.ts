/**
 * End-to-end integration test suite for SSO recovery (both single-blob and legacy two-layer).
 *
 * Test cases:
 * 1. New-format single-blob round trip (1 share, no hub row, threshold 1, no hub fetch, seed matches).
 * 2. Old-format round trip still working (hub + sso, threshold 2, hub release, seed matches).
 * 3. Wrong sub failing LOUDLY on both formats (Poly1305 tag fails via KeeperCryptoError) + corrupted hub failing with TwoLayerCombineError.
 * 4. Multi-provider enrol and disconnect (Google + Apple enrolled without hub, each independently reconstructs seed; disconnect Google leaves Apple intact and recoverable; disconnect Apple clears all).
 * 5. Member who enrolled old-format then re-enrols becoming new-format without losing recoverability at any point.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {
    splitHubAndWhole,
    combineHubAndWhole,
    seedChecksum,
    TwoLayerCombineError,
    sealShareToSso,
    sealSeedToSso,
    recordShareForHub,
    openShareFromSso,
    readHubShare,
    isSingleBlobSso,
    KeeperCryptoError,
    TWO_LAYER_THRESHOLD,
} from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { getCurrentShares } from './engine/recovery-shares.js';

initStateEngine();

let passed = 0;
function test(msg: string, fn: () => void | Promise<void>) {
    return Promise.resolve(fn()).then(() => {
        console.log(`✓ ${msg}`);
        passed++;
    });
}

// Google fixture setup
const GOOGLE_KID = 'test-sso-google-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
const GOOGLE_EMAIL = 'monnunit@gmail.com';
const { publicKey: googleRsaPub, privateKey: googleRsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GOOGLE_JWK = { ...googleRsaPub.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any;

function mintGoogleToken(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: 'https://accounts.google.com',
        aud: GOOGLE_AUD,
        sub,
        email: GOOGLE_EMAIL,
        email_verified: true,
        iat: now,
        exp: now + 3600,
        nonce,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), googleRsaPriv).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// Apple fixture setup
const APPLE_KID = 'test-sso-apple-kid';
const APPLE_AUD = 'org.beanpool.pillar';
const APPLE_SUB = '001234.fedcba9876543210fedcba9876543210.0123';
const APPLE_EMAIL = 'monnunit@privaterelay.appleid.com';
const { publicKey: appleRsaPub, privateKey: appleRsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const APPLE_JWK = { ...appleRsaPub.export({ format: 'jwk' }), kid: APPLE_KID, alg: 'RS256', use: 'sig' } as any;

function mintAppleToken(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: APPLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: 'https://appleid.apple.com',
        aud: APPLE_AUD,
        sub,
        email: APPLE_EMAIL,
        email_verified: true,
        iat: now,
        exp: now + 3600,
        nonce,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), appleRsaPriv).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [GOOGLE_JWK], expiresAt: Date.now() + 3600_000 });
    _resetJwksCacheForTests('apple', { keys: [APPLE_JWK], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
}

const deps: any = {
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, d = 20) => d,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};
const keeperRouter = createKeeperRoutes(deps);
const collectRouter = createRecoveryCollectRoutes(deps);

function handlerFor(path: string, method: string = 'POST') {
    const layer = [...(keeperRouter as any).stack, ...(collectRouter as any).stack].find(
        (l: any) => l.path === path && l.methods.includes(method),
    );
    if (!layer) throw new Error(`No route: ${method} ${path}`);
    return layer.stack[layer.stack.length - 1];
}

async function signedCall(
    path: string,
    actorPubkey: string,
    body: unknown,
    method: string = 'POST',
    params: Record<string, string> = {},
) {
    const ctx: any = {
        state: { actor: actorPubkey },
        requestBody: body,
        params,
        status: 200,
        body: undefined,
    };
    await handlerFor(path, method)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

function createTestMember(prefix: string): { seed: Buffer; pubHex: string; callsign: string } {
    const seed = crypto.randomBytes(32);
    const edKey = crypto.createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            seed,
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const edPub = crypto.createPublicKey(edKey);
    const pubHex = (edPub.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `${prefix}-${pubHex.slice(0, 6)}`;

    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'genesis', 'genesis')
    `).run(pubHex, callsign);

    return { seed, pubHex, callsign };
}

function derivePubHex(seed: Uint8Array): string {
    const edKey = crypto.createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            Buffer.from(seed),
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const edPub = crypto.createPublicKey(edKey);
    return (edPub.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

async function main() {
    console.log('\n── SSO Recovery Round-Trip Comprehensive Suite ──\n');
    primeJwks();

    // =========================================================================
    // 1. New-format single-blob round trip
    // =========================================================================
    console.log('--- 1. New-format Single-Blob SSO Round Trip ---');
    const m1 = createTestMember('SingleBlob');
    const ssoSealed1 = await sealSeedToSso(m1.seed, 'google', GOOGLE_SUB);

    // Enrol deposit with exactly 1 share (single blob)
    const nonceRes1 = await signedCall('/api/recovery/sso-nonce', m1.pubHex, {});
    assert.strictEqual(nonceRes1.status, 200);
    const token1 = mintGoogleToken(GOOGLE_SUB, nonceRes1.body.nonce);

    const depositRes1 = await signedCall('/api/recovery/shares/sso', m1.pubHex, {
        provider: 'google',
        idToken: token1,
        nonce: nonceRes1.body.nonce,
        shares: [
            { holderType: 'sso', holderRef: 'google', shareIndex: 1, ...ssoSealed1 },
        ],
    });

    await test('1.1 deposit succeeds with 1 share, threshold 1, generation 1', () => {
        assert.strictEqual(depositRes1.status, 200);
        assert.strictEqual(depositRes1.body.generation, 1);
        assert.strictEqual(depositRes1.body.threshold, 1);
        assert.strictEqual(depositRes1.body.shareCount, 1);
    });

    await test('1.2 storage holds exactly 1 row (sso) and NO hub row', () => {
        const shares = getCurrentShares(m1.pubHex);
        assert.strictEqual(shares.length, 1);
        assert.strictEqual(shares[0].holderType, 'sso');
        assert.strictEqual(shares[0].holderRef, 'google');
        assert(isSingleBlobSso(shares[0].kdfParams));
    });

    const statusRes1 = await signedCall('/api/recovery/shares/status', m1.pubHex, {});
    await test('1.3 status route reports threshold 1, recoverable true, canRemoveKeeper false', () => {
        assert.strictEqual(statusRes1.status, 200);
        assert.strictEqual(statusRes1.body.threshold, 1);
        assert.strictEqual(statusRes1.body.total, 1);
        assert.strictEqual(statusRes1.body.recoverable, true);
        assert.strictEqual(statusRes1.body.canRemoveKeeper, false);
    });

    // Recovery collection
    const ephPubHex1 = crypto.randomBytes(32).toString('hex');
    const openRes1 = await signedCall('/api/recovery/collect', ephPubHex1, { callsign: m1.callsign });
    await test('1.4 collection opens with threshold 1', () => {
        assert.strictEqual(openRes1.status, 200);
        assert.strictEqual(openRes1.body.threshold, 1);
        assert.strictEqual(openRes1.body.generation, 1);
    });
    const collId1 = openRes1.body.collectionId;

    const collectNonceRes1 = await signedCall('/api/recovery/collect/sso-nonce', ephPubHex1, { collectionId: collId1 });
    assert.strictEqual(collectNonceRes1.status, 200);
    const collectToken1 = mintGoogleToken(GOOGLE_SUB, collectNonceRes1.body.nonce);

    const collectSsoRes1 = await signedCall('/api/recovery/collect/sso', ephPubHex1, {
        collectionId: collId1,
        provider: 'google',
        idToken: collectToken1,
        nonce: collectNonceRes1.body.nonce,
    });
    await test('1.5 collect sso marks session enough=true with 1 collected fragment', () => {
        assert.strictEqual(collectSsoRes1.status, 200);
        assert.strictEqual(collectSsoRes1.body.collected, 1);
        assert.strictEqual(collectSsoRes1.body.threshold, 1);
        assert.strictEqual(collectSsoRes1.body.enough, true);
        assert.deepStrictEqual(collectSsoRes1.body.releasedTypes, ['sso']);
    });

    const fragsRes1 = await signedCall('/api/recovery/collect/fragments', ephPubHex1, { collectionId: collId1 });
    await test('1.6 fragments route returns 1 single-blob fragment without hub', () => {
        assert.strictEqual(fragsRes1.status, 200);
        assert.strictEqual(fragsRes1.body.collected, 1);
        assert.strictEqual(fragsRes1.body.enough, true);
        assert.strictEqual(fragsRes1.body.fragments.length, 1);
        const frag = fragsRes1.body.fragments[0];
        assert.strictEqual(frag.holderType, 'sso');
        assert(isSingleBlobSso(frag.kdfParams));
    });

    // Decrypt directly without hub
    const frag1 = fragsRes1.body.fragments[0];
    const recoveredSeed1 = await openShareFromSso(
        {
            encryptedShare: frag1.payload,
            shareIv: frag1.payloadIv,
            shareTag: frag1.payloadTag,
            kdfParams: frag1.kdfParams,
        },
        'google',
        GOOGLE_SUB,
    );
    await test('1.7 decrypted seed and derived public key match original member', () => {
        assert.deepStrictEqual(recoveredSeed1, new Uint8Array(m1.seed));
        assert.strictEqual(derivePubHex(recoveredSeed1), m1.pubHex);
    });

    // =========================================================================
    // 2. Old-format round trip still working
    // =========================================================================
    console.log('\n--- 2. Legacy Two-Layer Split (Hub + SSO) Round Trip ---');
    const m2 = createTestMember('LegacyTwoLayer');
    const { hubShare: hubShare2, otherHalf: otherHalf2 } = await splitHubAndWhole(m2.seed);
    const ssoSealed2 = await sealShareToSso(otherHalf2, 'google', GOOGLE_SUB);

    const nonceRes2 = await signedCall('/api/recovery/sso-nonce', m2.pubHex, {});
    assert.strictEqual(nonceRes2.status, 200);
    const token2 = mintGoogleToken(GOOGLE_SUB, nonceRes2.body.nonce);

    const depositRes2 = await signedCall('/api/recovery/shares/sso', m2.pubHex, {
        provider: 'google',
        idToken: token2,
        nonce: nonceRes2.body.nonce,
        shares: [
            { holderType: 'hub', holderRef: 'node', shareIndex: 1, ...recordShareForHub(hubShare2) },
            { holderType: 'sso', holderRef: 'google', shareIndex: 2, ...ssoSealed2 },
        ],
    });

    await test('2.1 legacy deposit succeeds with 2 shares, threshold 2, generation 1', () => {
        assert.strictEqual(depositRes2.status, 200);
        assert.strictEqual(depositRes2.body.generation, 1);
        assert.strictEqual(depositRes2.body.threshold, TWO_LAYER_THRESHOLD);
        assert.strictEqual(depositRes2.body.shareCount, 2);
    });

    await test('2.2 legacy storage holds both hub and sso rows', () => {
        const shares = getCurrentShares(m2.pubHex);
        assert.strictEqual(shares.length, 2);
        assert(shares.some(s => s.holderType === 'hub'));
        assert(shares.some(s => s.holderType === 'sso'));
    });

    const statusRes2 = await signedCall('/api/recovery/shares/status', m2.pubHex, {});
    await test('2.3 legacy status route reports threshold 2, recoverable true, canRemoveKeeper false', () => {
        assert.strictEqual(statusRes2.status, 200);
        assert.strictEqual(statusRes2.body.threshold, TWO_LAYER_THRESHOLD);
        assert.strictEqual(statusRes2.body.total, 2);
        assert.strictEqual(statusRes2.body.recoverable, true);
        assert.strictEqual(statusRes2.body.canRemoveKeeper, false);
    });

    // Recovery collection
    const ephPubHex2 = crypto.randomBytes(32).toString('hex');
    const openRes2 = await signedCall('/api/recovery/collect', ephPubHex2, { callsign: m2.callsign });
    assert.strictEqual(openRes2.status, 200);
    assert.strictEqual(openRes2.body.threshold, TWO_LAYER_THRESHOLD);
    const collId2 = openRes2.body.collectionId;

    const collectNonceRes2 = await signedCall('/api/recovery/collect/sso-nonce', ephPubHex2, { collectionId: collId2 });
    assert.strictEqual(collectNonceRes2.status, 200);
    const collectToken2 = mintGoogleToken(GOOGLE_SUB, collectNonceRes2.body.nonce);

    const collectSsoRes2 = await signedCall('/api/recovery/collect/sso', ephPubHex2, {
        collectionId: collId2,
        provider: 'google',
        idToken: collectToken2,
        nonce: collectNonceRes2.body.nonce,
    });
    await test('2.4 collect sso releases sso fragment with enough=false (waiting for hub)', () => {
        assert.strictEqual(collectSsoRes2.status, 200);
        assert.strictEqual(collectSsoRes2.body.collected, 1);
        assert.strictEqual(collectSsoRes2.body.threshold, TWO_LAYER_THRESHOLD);
        assert.strictEqual(collectSsoRes2.body.enough, false);
    });

    const collectHubRes2 = await signedCall('/api/recovery/collect/hub', ephPubHex2, { collectionId: collId2 });
    await test('2.5 hub release succeeds immediately under SSO tier and reaches enough=true', () => {
        assert.strictEqual(collectHubRes2.status, 200);
        assert.strictEqual(collectHubRes2.body.collected, 2);
        assert.strictEqual(collectHubRes2.body.enough, true);
    });

    const fragsRes2 = await signedCall('/api/recovery/collect/fragments', ephPubHex2, { collectionId: collId2 });
    const ssoFrag2 = fragsRes2.body.fragments.find((f: any) => f.holderType === 'sso');
    const hubFrag2 = fragsRes2.body.fragments.find((f: any) => f.holderType === 'hub');
    assert(ssoFrag2 && hubFrag2);

    const decryptedOtherHalf2 = await openShareFromSso(
        {
            encryptedShare: ssoFrag2.payload,
            shareIv: ssoFrag2.payloadIv,
            shareTag: ssoFrag2.payloadTag,
            kdfParams: ssoFrag2.kdfParams,
        },
        'google',
        GOOGLE_SUB,
    );
    const decryptedHub2 = readHubShare({
        encryptedShare: hubFrag2.payload,
        shareIv: hubFrag2.payloadIv,
        shareTag: hubFrag2.payloadTag,
        kdfParams: hubFrag2.kdfParams,
    });
    const recoveredSeed2 = combineHubAndWhole(decryptedHub2, decryptedOtherHalf2);

    await test('2.6 legacy combineHubAndWhole restores original seed and public key', () => {
        assert.deepStrictEqual(recoveredSeed2, new Uint8Array(m2.seed));
        assert.strictEqual(derivePubHex(recoveredSeed2), m2.pubHex);
    });

    // =========================================================================
    // 3. Wrong sub failing LOUDLY on both formats + corrupted hub failing with checksum
    // =========================================================================
    console.log('\n--- 3. Wrong Sub & Corrupted Fragment Failure Invariants ---');
    const WRONG_SUB = '999999999999999999999';

    await test('3.1 single-blob format with wrong sub fails loudly via KeeperCryptoError (Poly1305 tag check)', async () => {
        await assert.rejects(
            async () => {
                await openShareFromSso(
                    {
                        encryptedShare: frag1.payload,
                        shareIv: frag1.payloadIv,
                        shareTag: frag1.payloadTag,
                        kdfParams: frag1.kdfParams,
                    },
                    'google',
                    WRONG_SUB,
                );
            },
            (err: any) => err instanceof KeeperCryptoError,
        );
    });

    await test('3.2 legacy format with wrong sub fails loudly via KeeperCryptoError', async () => {
        await assert.rejects(
            async () => {
                await openShareFromSso(
                    {
                        encryptedShare: ssoFrag2.payload,
                        shareIv: ssoFrag2.payloadIv,
                        shareTag: ssoFrag2.payloadTag,
                        kdfParams: ssoFrag2.kdfParams,
                    },
                    'google',
                    WRONG_SUB,
                );
            },
            (err: any) => err instanceof KeeperCryptoError,
        );
    });

    await test('3.3 legacy format with corrupted hub share fails loudly via TwoLayerCombineError when checksum is checked', async () => {
        const testSeed = crypto.randomBytes(32);
        const { hubShare, otherHalf } = await splitHubAndWhole(testSeed);
        const checksum = seedChecksum(testSeed);

        // Corrupted hub share
        const corruptedHub = new Uint8Array(hubShare);
        corruptedHub[0] ^= 0xff;

        // Uncorrupted combine succeeds
        const uncorrupted = combineHubAndWhole(hubShare, otherHalf, checksum);
        assert.deepStrictEqual(uncorrupted, new Uint8Array(testSeed));

        // Corrupted combine throws TwoLayerCombineError
        assert.throws(
            () => combineHubAndWhole(corruptedHub, otherHalf, checksum),
            (err: any) => err instanceof TwoLayerCombineError,
        );
    });

    // =========================================================================
    // 4. Multi-provider enrol and disconnect
    // =========================================================================
    console.log('\n--- 4. Multi-Provider (Google + Apple) Enrol & Disconnect ---');
    const m4 = createTestMember('MultiProvider');

    // 4.1 Enrol Google (single-blob)
    const ssoGoogle4 = await sealSeedToSso(m4.seed, 'google', GOOGLE_SUB);
    const nonceGoogle4 = (await signedCall('/api/recovery/sso-nonce', m4.pubHex, {})).body.nonce;
    const tokenGoogle4 = mintGoogleToken(GOOGLE_SUB, nonceGoogle4);
    const depGoogle4 = await signedCall('/api/recovery/shares/sso', m4.pubHex, {
        provider: 'google',
        idToken: tokenGoogle4,
        nonce: nonceGoogle4,
        shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...ssoGoogle4 }],
    });
    assert.strictEqual(depGoogle4.status, 200);
    assert.strictEqual(depGoogle4.body.generation, 1);

    // 4.2 Enrol Apple (single-blob)
    const ssoApple4 = await sealSeedToSso(m4.seed, 'apple', APPLE_SUB);
    const nonceApple4 = (await signedCall('/api/recovery/sso-nonce', m4.pubHex, {})).body.nonce;
    const tokenApple4 = mintAppleToken(APPLE_SUB, nonceApple4);
    const depApple4 = await signedCall('/api/recovery/shares/sso', m4.pubHex, {
        provider: 'apple',
        idToken: tokenApple4,
        nonce: nonceApple4,
        shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...ssoApple4 }],
    });

    await test('4.1 multi-provider enrolment succeeds without hub share, shareCount=2, threshold=1', () => {
        assert.strictEqual(depApple4.status, 200);
        assert.strictEqual(depApple4.body.generation, 2);
        assert.strictEqual(depApple4.body.threshold, 1);
        assert.strictEqual(depApple4.body.shareCount, 2);
        assert.deepStrictEqual(depApple4.body.enrolledSso.sort(), ['apple', 'google']);
    });

    await test('4.2 database holds 2 sso rows (Google & Apple) and 0 hub rows', () => {
        const shares = getCurrentShares(m4.pubHex);
        assert.strictEqual(shares.length, 2);
        assert(shares.every(s => s.holderType === 'sso'));
        assert(shares.every(s => isSingleBlobSso(s.kdfParams)));
    });

    const statusRes4 = await signedCall('/api/recovery/shares/status', m4.pubHex, {});
    await test('4.3 status reports threshold 1, total 2, canRemoveKeeper true', () => {
        assert.strictEqual(statusRes4.status, 200);
        assert.strictEqual(statusRes4.body.threshold, 1);
        assert.strictEqual(statusRes4.body.total, 2);
        assert.strictEqual(statusRes4.body.canRemoveKeeper, true);
    });

function toSealedShare(frag: any) {
    return {
        encryptedShare: frag.payload,
        shareIv: frag.payloadIv,
        shareTag: frag.payloadTag,
        kdfParams: frag.kdfParams,
    };
}

    // 4.4 Verify Google independently recovers seed
    const ephGoogle = crypto.randomBytes(32).toString('hex');
    const openGoogle = await signedCall('/api/recovery/collect', ephGoogle, { callsign: m4.callsign });
    const collIdGoogle = openGoogle.body.collectionId;
    const nonceCollGoogle = (await signedCall('/api/recovery/collect/sso-nonce', ephGoogle, { collectionId: collIdGoogle })).body.nonce;
    await signedCall('/api/recovery/collect/sso', ephGoogle, {
        collectionId: collIdGoogle, provider: 'google', idToken: mintGoogleToken(GOOGLE_SUB, nonceCollGoogle), nonce: nonceCollGoogle,
    });
    const fragsGoogle = (await signedCall('/api/recovery/collect/fragments', ephGoogle, { collectionId: collIdGoogle })).body.fragments;
    const recSeedGoogle = await openShareFromSso(toSealedShare(fragsGoogle[0]), 'google', GOOGLE_SUB);
    await test('4.4 Google recovers full seed independently without hub', () => {
        assert.deepStrictEqual(recSeedGoogle, new Uint8Array(m4.seed));
    });

    // 4.5 Verify Apple independently recovers seed
    const ephApple = crypto.randomBytes(32).toString('hex');
    const openApple = await signedCall('/api/recovery/collect', ephApple, { callsign: m4.callsign });
    const collIdApple = openApple.body.collectionId;
    const nonceCollApple = (await signedCall('/api/recovery/collect/sso-nonce', ephApple, { collectionId: collIdApple })).body.nonce;
    await signedCall('/api/recovery/collect/sso', ephApple, {
        collectionId: collIdApple, provider: 'apple', idToken: mintAppleToken(APPLE_SUB, nonceCollApple), nonce: nonceCollApple,
    });
    const fragsApple = (await signedCall('/api/recovery/collect/fragments', ephApple, { collectionId: collIdApple })).body.fragments;
    const recSeedApple = await openShareFromSso(toSealedShare(fragsApple[0]), 'apple', APPLE_SUB);
    await test('4.5 Apple recovers full seed independently without hub', () => {
        assert.deepStrictEqual(recSeedApple, new Uint8Array(m4.seed));
    });

    // 4.6 Disconnect Google
    const discGoogle = await signedCall(
        '/api/recovery/shares/sso/:provider',
        m4.pubHex,
        {},
        'DELETE',
        { provider: 'google' },
    );
    await test('4.6 disconnecting Google leaves Apple intact with threshold 1 and 1 share', () => {
        assert.strictEqual(discGoogle.status, 200);
        assert.strictEqual(discGoogle.body.removed, 'google');
        assert.strictEqual(discGoogle.body.generation, 3);
        assert.deepStrictEqual(discGoogle.body.enrolledSso, ['apple']);

        const remaining = getCurrentShares(m4.pubHex);
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0].holderRef, 'apple');
    });

    // 4.7 Verify Apple still recovers after Google disconnect
    const ephApplePost = crypto.randomBytes(32).toString('hex');
    const openApplePost = await signedCall('/api/recovery/collect', ephApplePost, { callsign: m4.callsign });
    const collIdApplePost = openApplePost.body.collectionId;
    const nonceCollApplePost = (await signedCall('/api/recovery/collect/sso-nonce', ephApplePost, { collectionId: collIdApplePost })).body.nonce;
    await signedCall('/api/recovery/collect/sso', ephApplePost, {
        collectionId: collIdApplePost, provider: 'apple', idToken: mintAppleToken(APPLE_SUB, nonceCollApplePost), nonce: nonceCollApplePost,
    });
    const fragsApplePost = (await signedCall('/api/recovery/collect/fragments', ephApplePost, { collectionId: collIdApplePost })).body.fragments;
    const recSeedApplePost = await openShareFromSso(toSealedShare(fragsApplePost[0]), 'apple', APPLE_SUB);
    await test('4.7 Apple still recovers seed after Google was disconnected', () => {
        assert.deepStrictEqual(recSeedApplePost, new Uint8Array(m4.seed));
    });

    // 4.8 Disconnect Apple (last provider)
    const discApple = await signedCall(
        '/api/recovery/shares/sso/:provider',
        m4.pubHex,
        {},
        'DELETE',
        { provider: 'apple' },
    );
    await test('4.8 disconnecting Apple clears all shares and resets generation to 0', () => {
        assert.strictEqual(discApple.status, 200);
        assert.strictEqual(discApple.body.removed, 'apple');
        assert.strictEqual(discApple.body.generation, 0);
        assert.deepStrictEqual(discApple.body.enrolledSso, []);

        const remaining = getCurrentShares(m4.pubHex);
        assert.strictEqual(remaining.length, 0);
    });

    // =========================================================================
    // 5. Member who enrolled old-format then re-enrols becoming new-format
    // =========================================================================
    console.log('\n--- 5. Old-Format to New-Format Migration Without Stranding ---');
    const m5 = createTestMember('MigratingMember');

    // 5.1 Enrol old-format (hub + Google)
    const { hubShare: hs5, otherHalf: oh5 } = await splitHubAndWhole(m5.seed);
    const ssoOld5 = await sealShareToSso(oh5, 'google', GOOGLE_SUB);
    const nonceOld5 = (await signedCall('/api/recovery/sso-nonce', m5.pubHex, {})).body.nonce;
    const depOld5 = await signedCall('/api/recovery/shares/sso', m5.pubHex, {
        provider: 'google',
        idToken: mintGoogleToken(GOOGLE_SUB, nonceOld5),
        nonce: nonceOld5,
        shares: [
            { holderType: 'hub', holderRef: 'node', shareIndex: 1, ...recordShareForHub(hs5) },
            { holderType: 'sso', holderRef: 'google', shareIndex: 2, ...ssoOld5 },
        ],
    });
    assert.strictEqual(depOld5.status, 200);
    assert.strictEqual(depOld5.body.generation, 1);
    assert.strictEqual(depOld5.body.threshold, TWO_LAYER_THRESHOLD);

    // Verify old format recoverability
    const eph5Old = crypto.randomBytes(32).toString('hex');
    const open5Old = await signedCall('/api/recovery/collect', eph5Old, { callsign: m5.callsign });
    const collId5Old = open5Old.body.collectionId;
    const n5Old = (await signedCall('/api/recovery/collect/sso-nonce', eph5Old, { collectionId: collId5Old })).body.nonce;
    await signedCall('/api/recovery/collect/sso', eph5Old, {
        collectionId: collId5Old, provider: 'google', idToken: mintGoogleToken(GOOGLE_SUB, n5Old), nonce: n5Old,
    });
    await signedCall('/api/recovery/collect/hub', eph5Old, { collectionId: collId5Old });
    const frags5Old = (await signedCall('/api/recovery/collect/fragments', eph5Old, { collectionId: collId5Old })).body.fragments;
    const ssoF5 = frags5Old.find((f: any) => f.holderType === 'sso');
    const hubF5 = frags5Old.find((f: any) => f.holderType === 'hub');
    const recOldSeed5 = combineHubAndWhole(
        readHubShare({ encryptedShare: hubF5.payload, shareIv: hubF5.payloadIv, shareTag: hubF5.payloadTag, kdfParams: hubF5.kdfParams }),
        await openShareFromSso({ encryptedShare: ssoF5.payload, shareIv: ssoF5.payloadIv, shareTag: ssoF5.payloadTag, kdfParams: ssoF5.kdfParams }, 'google', GOOGLE_SUB),
    );
    await test('5.1 member is recoverable under legacy format before migration', () => {
        assert.deepStrictEqual(recOldSeed5, new Uint8Array(m5.seed));
    });

    // 5.2 Member re-enrols with single-blob format (lazy migration)
    const ssoNew5 = await sealSeedToSso(m5.seed, 'google', GOOGLE_SUB);
    const nonceNew5 = (await signedCall('/api/recovery/sso-nonce', m5.pubHex, {})).body.nonce;
    const depNew5 = await signedCall('/api/recovery/shares/sso', m5.pubHex, {
        provider: 'google',
        idToken: mintGoogleToken(GOOGLE_SUB, nonceNew5),
        nonce: nonceNew5,
        shares: [
            { holderType: 'sso', holderRef: 'google', shareIndex: 1, ...ssoNew5 },
        ],
    });

    await test('5.2 re-enrolment succeeds with new single-blob format (generation 2, threshold 1)', () => {
        assert.strictEqual(depNew5.status, 200);
        assert.strictEqual(depNew5.body.generation, 2);
        assert.strictEqual(depNew5.body.threshold, 1);
        assert.strictEqual(depNew5.body.shareCount, 1);
    });

    await test('5.3 old hub row is purged and current generation holds only single-blob SSO share', () => {
        const currentShares = getCurrentShares(m5.pubHex);
        assert.strictEqual(currentShares.length, 1);
        assert.strictEqual(currentShares[0].holderType, 'sso');
        assert.strictEqual(currentShares[0].holderRef, 'google');
        assert(isSingleBlobSso(currentShares[0].kdfParams));
    });

    // 5.4 Verify member is now seamlessly recoverable under new format without hub
    const eph5New = crypto.randomBytes(32).toString('hex');
    const open5New = await signedCall('/api/recovery/collect', eph5New, { callsign: m5.callsign });
    assert.strictEqual(open5New.body.threshold, 1);
    const collId5New = open5New.body.collectionId;
    const n5New = (await signedCall('/api/recovery/collect/sso-nonce', eph5New, { collectionId: collId5New })).body.nonce;
    const colSso5New = await signedCall('/api/recovery/collect/sso', eph5New, {
        collectionId: collId5New, provider: 'google', idToken: mintGoogleToken(GOOGLE_SUB, n5New), nonce: n5New,
    });
    assert.strictEqual(colSso5New.body.enough, true);
    assert.strictEqual(colSso5New.body.collected, 1);

    const frags5New = (await signedCall('/api/recovery/collect/fragments', eph5New, { collectionId: collId5New })).body.fragments;
    assert.strictEqual(frags5New.length, 1);
    const recNewSeed5 = await openShareFromSso(toSealedShare(frags5New[0]), 'google', GOOGLE_SUB);

    await test('5.4 member recovers original seed via new single-blob format without hub interaction', () => {
        assert.deepStrictEqual(recNewSeed5, new Uint8Array(m5.seed));
        assert.strictEqual(derivePubHex(recNewSeed5), m5.pubHex);
    });

    console.log(`\n⭐️ ALL ${passed}/${passed} SSO RECOVERY TESTS PASSED!\n`);
}

main().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('❌ SSO Recovery Round-Trip Suite FAILED:', e);
    process.exit(1);
});
