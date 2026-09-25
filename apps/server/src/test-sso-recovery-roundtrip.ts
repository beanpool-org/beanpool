/**
 * End-to-end integration test suite for SSO recovery (both single-blob and legacy two-layer).
 *
 * Test cases:
 * 1. New-format single-blob round trip (1 share, no hub row, threshold 1, no hub fetch, seed matches).
 * 1b. Enrolments sealed by earlier code (frozen fixtures) still open, and their lookup hashes still match.
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
    openSeedFromSso,
    readHubShare,
    isSingleBlobSso,
    KeeperCryptoError,
    TWO_LAYER_THRESHOLD,
} from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { collectionProgress, listReleases } from './engine/recovery-release.js';
import { _resetJwksCacheForTests, _clearNoncesForTests, ssoLookupHash } from './sso.js';
import {
    getCurrentShares,
    getCurrentGeneration,
    putShareGeneration,
    canRemoveKeeper,
    RecoveryShareError,
} from './engine/recovery-shares.js';

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
    // 1c. A copy that carries the 12 words, through this node's code unchanged
    // =========================================================================
    // The app seals the words in a second box inside kdfParams (keeper-crypto.ts sealSeedToSso). No
    // server code changed for it: this is the node as it runs today, accepting, storing and releasing
    // the copy verbatim, and the recovering app getting the words back out of what it released.
    console.log('\n--- 1c. A Single Blob Carrying the 12 Words ---');
    // A test phrase, not an account. seed = SHA256(SHA256(words)), as both apps derive it.
    const WORDS_1C = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
    const seed1c = crypto.createHash('sha256').update(crypto.createHash('sha256').update(WORDS_1C.join(' ')).digest()).digest();
    const m1c = { seed: seed1c, pubHex: derivePubHex(seed1c), callsign: '' };
    m1c.callsign = `WordsBlob-${m1c.pubHex.slice(0, 6)}`;
    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'genesis', 'genesis')
    `).run(m1c.pubHex, m1c.callsign);
    const sealed1c = await sealSeedToSso(new Uint8Array(seed1c), 'google', GOOGLE_SUB, { words: WORDS_1C });
    const nonceRes1c = await signedCall('/api/recovery/sso-nonce', m1c.pubHex, {});
    const deposit1c = await signedCall('/api/recovery/shares/sso', m1c.pubHex, {
        provider: 'google',
        idToken: mintGoogleToken(GOOGLE_SUB, nonceRes1c.body.nonce),
        nonce: nonceRes1c.body.nonce,
        shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed1c }],
    });
    await test('1c.1 the node accepts the copy as a single blob, and stores its kdfParams verbatim', () => {
        assert.strictEqual(deposit1c.status, 200, JSON.stringify(deposit1c.body));
        assert.strictEqual(deposit1c.body.threshold, 1);
        const stored = getCurrentShares(m1c.pubHex);
        assert.strictEqual(stored.length, 1);
        assert.strictEqual(stored[0].kdfParams, sealed1c.kdfParams);
        assert.strictEqual(stored[0].encryptedShare, sealed1c.encryptedShare);
    });

    const eph1c = crypto.randomBytes(32).toString('hex');
    const open1c = await signedCall('/api/recovery/collect', eph1c, { callsign: m1c.callsign });
    const collectNonce1c = await signedCall('/api/recovery/collect/sso-nonce', eph1c, { collectionId: open1c.body.collectionId });
    await signedCall('/api/recovery/collect/sso', eph1c, {
        collectionId: open1c.body.collectionId,
        provider: 'google',
        idToken: mintGoogleToken(GOOGLE_SUB, collectNonce1c.body.nonce),
        nonce: collectNonce1c.body.nonce,
    });
    const frags1c = await signedCall('/api/recovery/collect/fragments', eph1c, { collectionId: open1c.body.collectionId });
    const frag1c = frags1c.body.fragments?.[0];
    const released1c = {
        encryptedShare: frag1c?.payload, shareIv: frag1c?.payloadIv, shareTag: frag1c?.payloadTag, kdfParams: frag1c?.kdfParams,
    };
    await test('1c.2 the release hands back the same copy, and it opens to the seed and the words', async () => {
        assert.strictEqual(frags1c.status, 200);
        assert.strictEqual(frag1c.kdfParams, sealed1c.kdfParams);
        const opened = await openSeedFromSso(released1c, 'google', GOOGLE_SUB);
        assert.strictEqual(derivePubHex(opened.seed), m1c.pubHex);
        assert.deepStrictEqual(opened.words, WORDS_1C);
        assert.strictEqual(opened.wordsStatus, 'carried');
    });
    await test('1c.3 the opener apps on older code run gets exactly the 32-byte seed from it', async () => {
        const seed = await openShareFromSso(released1c, 'google', GOOGLE_SUB);
        assert.strictEqual(seed.length, 32);
        assert.strictEqual(derivePubHex(seed), m1c.pubHex);
    });

    // =========================================================================
    // 1b. Enrolments sealed by earlier code still open
    // =========================================================================
    // The sign-in hardening (S1 onwards) changes how the node convinces itself of `sub`, never `sub`
    // itself, the seal key or the lookup hash — that is what keeps every existing enrolment
    // recoverable. These blobs and hashes were produced by origin/main's sealSeedToSso and
    // ssoLookupHash at 7f92bd8e (2026-09-24), before S1, and are frozen here: a later change to
    // either derivation that would strand them fails this instead.
    console.log('\n--- 1b. Enrolments Sealed by Earlier Code Still Open ---');
    const OLD_SEED_HEX = 'cdb6f28510570568bd01d9b982312020b785e3847664cbfb6ee753425085de9e';
    const OLD_LOOKUP_SALT = 'S1-old-enrolment-lookup-salt';
    const OLD_ENROLMENTS = [
        {
            provider: 'google',
            sub: '104729384756102938475',
            lookupHash: '-YIm_AtQgZa5zOM4Eh_-j80Ae5R5287GVhyPxMQSpY8',
            sealed: {
                encryptedShare: 'YRS1xq1OhCe0aLFLR06B9MRqj33l+c8QiyE9g7f5SyE=',
                shareIv: 'x8qPfZ/8xacJuwXBtdtOwJC/wUGx3lr0',
                shareTag: 'UJJwcoVHxrysQnywAsoAqg==',
                kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"lCAsfDPf6FmyKHL7tGQT+wPYIrUMUZiDSZQYYHsU7dc=","N":16384,"r":8,"p":1}',
            },
        },
        {
            provider: 'facebook',
            sub: '2718281828459045',
            lookupHash: 'W2ArgJjZyHbXaMlPtZ6HvQe9LEZ13_fbNMJcL4yiXyc',
            sealed: {
                encryptedShare: '1kGt6XHXTzy5EeRlKA3aFysAbX/B8xNinFHcSVaaFDE=',
                shareIv: 'gm0Zee4o8UYUrVSOTbPg2E0hqnWcjfzM',
                shareTag: 'AkyT9x4sncyx30vs2vLCtg==',
                kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"OomrCz8p0MKmpuIHvp2M4Rl/VAeLqqECQCRJe9oXQB4=","N":16384,"r":8,"p":1}',
            },
        },
    ] as const;
    for (const old of OLD_ENROLMENTS) {
        await test(`1b.1 ${old.provider}: a single blob sealed by earlier code opens to the same seed`, async () => {
            assert(isSingleBlobSso(old.sealed.kdfParams));
            const opened = await openShareFromSso(old.sealed, old.provider, old.sub);
            assert.strictEqual(Buffer.from(opened).toString('hex'), OLD_SEED_HEX);
        });
        await test(`1b.2 ${old.provider}: the lookup hash for that sub and salt is unchanged`, async () => {
            assert.strictEqual(await ssoLookupHash(old.provider, old.sub, OLD_LOOKUP_SALT), old.lookupHash);
        });
        await test(`1b.3 ${old.provider}: the opener that reads the 12 words opens it to the seed alone`, async () => {
            const opened = await openSeedFromSso(old.sealed, old.provider, old.sub);
            assert.strictEqual(Buffer.from(opened.seed).toString('hex'), OLD_SEED_HEX);
            assert.strictEqual(opened.words, null);
            assert.strictEqual(opened.wordsStatus, 'absent');
        });
    }

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

    // =========================================================================
    // 6. Mixed-State Account (Single-Blob + Legacy SSO Provider)
    // =========================================================================
    console.log("\n--- 6. Mixed-State Account (Single-Blob + Legacy) ---");
    const m6 = createTestMember("MixedState");

    // 6.1 Enrol Apple as legacy two-layer split (Hub + Apple)
    const { hubShare: hs6, otherHalf: oh6 } = await splitHubAndWhole(m6.seed);
    const ssoApple6 = await sealShareToSso(oh6, "apple", APPLE_SUB, { checksum: seedChecksum(m6.seed) });
    const nonceApple6 = (await signedCall("/api/recovery/sso-nonce", m6.pubHex, {})).body.nonce;
    const depApple6 = await signedCall("/api/recovery/shares/sso", m6.pubHex, {
        provider: "apple",
        idToken: mintAppleToken(APPLE_SUB, nonceApple6),
        nonce: nonceApple6,
        shares: [
            { holderType: "hub", holderRef: "node", shareIndex: 1, ...recordShareForHub(hs6) },
            { holderType: "sso", holderRef: "apple", shareIndex: 2, ...ssoApple6 },
        ],
    });
    assert.strictEqual(depApple6.status, 200);

    // 6.2 Enrol Google as new single-blob format onto the legacy account
    const ssoGoogle6 = await sealSeedToSso(m6.seed, "google", GOOGLE_SUB);
    const nonceGoogle6 = (await signedCall("/api/recovery/sso-nonce", m6.pubHex, {})).body.nonce;
    const depGoogle6 = await signedCall("/api/recovery/shares/sso", m6.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceGoogle6),
        nonce: nonceGoogle6,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoGoogle6 },
        ],
    });

    await test("6.1 single-blob deposit onto legacy account succeeds, carrying legacy provider AND hub", () => {
        assert.strictEqual(depGoogle6.status, 200);
        assert.strictEqual(depGoogle6.body.generation, 2);
        assert.strictEqual(depGoogle6.body.threshold, 1);
        const shares = getCurrentShares(m6.pubHex);
        assert.strictEqual(shares.length, 3);
        const hubRow = shares.find(s => s.holderType === "hub");
        const appleRow = shares.find(s => s.holderRef === "apple");
        const googleRow = shares.find(s => s.holderRef === "google");
        assert(hubRow, "hub row must be carried forward for legacy Apple share");
        assert(appleRow, "legacy Apple share must be carried forward");
        assert(!isSingleBlobSso(appleRow?.kdfParams), "Apple share is legacy");
        assert(googleRow, "new Google share must be present");
        assert(isSingleBlobSso(googleRow?.kdfParams), "Google share is single-blob");
    });

    // 6.3 Mixed account recovery via Google (single-blob)
    const eph6Google = crypto.randomBytes(32).toString("hex");
    const open6Google = await signedCall("/api/recovery/collect", eph6Google, { callsign: m6.callsign });
    const collId6Google = open6Google.body.collectionId;
    const n6Google = (await signedCall("/api/recovery/collect/sso-nonce", eph6Google, { collectionId: collId6Google })).body.nonce;
    const colSso6Google = await signedCall("/api/recovery/collect/sso", eph6Google, {
        collectionId: collId6Google,
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, n6Google),
        nonce: n6Google,
    });

    await test("6.2 recovering via single-blob provider on mixed account reaches enough=true with threshold 1", () => {
        assert.strictEqual(colSso6Google.body.collected, 1);
        assert.strictEqual(colSso6Google.body.threshold, 1);
        assert.strictEqual(colSso6Google.body.enough, true);
    });

    const frags6Google = (await signedCall("/api/recovery/collect/fragments", eph6Google, { collectionId: collId6Google })).body.fragments;
    const recSeed6Google = await openShareFromSso(toSealedShare(frags6Google[0]), "google", GOOGLE_SUB);

    await test("6.3 recovers original seed via single-blob provider independently on mixed account", () => {
        assert.deepStrictEqual(recSeed6Google, new Uint8Array(m6.seed));
        assert.strictEqual(derivePubHex(recSeed6Google), m6.pubHex);
    });

    // 6.4 Mixed account recovery via Apple (legacy) - Finding 1 verification
    const eph6Apple = crypto.randomBytes(32).toString("hex");
    const open6Apple = await signedCall("/api/recovery/collect", eph6Apple, { callsign: m6.callsign });
    const collId6Apple = open6Apple.body.collectionId;
    const n6Apple = (await signedCall("/api/recovery/collect/sso-nonce", eph6Apple, { collectionId: collId6Apple })).body.nonce;
    const colSso6Apple = await signedCall("/api/recovery/collect/sso", eph6Apple, {
        collectionId: collId6Apple,
        provider: "apple",
        idToken: mintAppleToken(APPLE_SUB, n6Apple),
        nonce: n6Apple,
    });

    await test("6.4 recovering via legacy provider on mixed account reports enough=false and threshold 2 (Finding 1 fix)", () => {
        assert.strictEqual(colSso6Apple.body.collected, 1);
        assert.strictEqual(colSso6Apple.body.threshold, 2);
        assert.strictEqual(colSso6Apple.body.enough, false);
    });

    const colHub6Apple = await signedCall("/api/recovery/collect/hub", eph6Apple, { collectionId: collId6Apple });
    await test("6.5 releasing hub completes legacy recovery on mixed account with enough=true", () => {
        assert.strictEqual(colHub6Apple.body.collected, 2);
        assert.strictEqual(colHub6Apple.body.threshold, 2);
        assert.strictEqual(colHub6Apple.body.enough, true);
    });

    const frags6Apple = (await signedCall("/api/recovery/collect/fragments", eph6Apple, { collectionId: collId6Apple })).body.fragments;
    const ssoF6 = frags6Apple.find((f: any) => f.holderType === "sso");
    const hubF6 = frags6Apple.find((f: any) => f.holderType === "hub");
    const recSeed6Apple = combineHubAndWhole(
        readHubShare({ encryptedShare: hubF6.payload, shareIv: hubF6.payloadIv, shareTag: hubF6.payloadTag, kdfParams: hubF6.kdfParams }),
        await openShareFromSso({ encryptedShare: ssoF6.payload, shareIv: ssoF6.payloadIv, shareTag: ssoF6.payloadTag, kdfParams: ssoF6.kdfParams }, "apple", APPLE_SUB),
    );

    await test("6.6 recovers original seed via legacy provider independently on mixed account", () => {
        assert.deepStrictEqual(recSeed6Apple, new Uint8Array(m6.seed));
        assert.strictEqual(derivePubHex(recSeed6Apple), m6.pubHex);
    });

    // =========================================================================
    // 7. Stranded Legacy Provider Prevention (Finding 2)
    // =========================================================================
    console.log("\n--- 7. Stranded Legacy Provider Prevention ---");
    const m7 = createTestMember("StrandedTest");

    // Deposit legacy Apple share and hub
    const { hubShare: hs7, otherHalf: oh7 } = await splitHubAndWhole(m7.seed);
    const ssoApple7 = await sealShareToSso(oh7, "apple", APPLE_SUB);
    const nonceApple7 = (await signedCall("/api/recovery/sso-nonce", m7.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m7.pubHex, {
        provider: "apple",
        idToken: mintAppleToken(APPLE_SUB, nonceApple7),
        nonce: nonceApple7,
        shares: [
            { holderType: "hub", holderRef: "node", shareIndex: 1, ...recordShareForHub(hs7) },
            { holderType: "sso", holderRef: "apple", shareIndex: 2, ...ssoApple7 },
        ],
    });

    // Simulate missing/corrupted hub in DB
    db.prepare("DELETE FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'hub'").run(m7.pubHex);

    // Attempt single-blob deposit with Google
    const ssoGoogle7 = await sealSeedToSso(m7.seed, "google", GOOGLE_SUB);
    const nonceGoogle7 = (await signedCall("/api/recovery/sso-nonce", m7.pubHex, {})).body.nonce;
    const depFail7 = await signedCall("/api/recovery/shares/sso", m7.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceGoogle7),
        nonce: nonceGoogle7,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoGoogle7 },
        ],
    });

    await test("7.1 single-blob deposit is refused when existing hub is missing, preventing stranded legacy share", () => {
        assert.strictEqual(depFail7.status, 400);
        assert(depFail7.body.error.includes("hub fragment is missing"));
    });

    await test("7.2 putShareGeneration directly refuses legacy SSO share without hub fragment", () => {
        assert.throws(() => {
            putShareGeneration(m7.pubHex, [
                { holderType: "sso", holderRef: "google", shareIndex: 1, ssoLookupHash: "dummyHash1", ...ssoGoogle7 },
                { holderType: "sso", holderRef: "apple", shareIndex: 2, ssoLookupHash: "dummyHash2", ...ssoApple7 },
            ]);
        }, (err: any) => err instanceof RecoveryShareError && err.message.includes("must include a hub fragment"));
    });

    // =========================================================================
    // 8. Malformed Single-Blob Deposit Rejected (Findings 3 & 7)
    // =========================================================================
    console.log("\n--- 8. Malformed Single-Blob Deposit Validation ---");
    const m8 = createTestMember("MalformedDeposit");

    // Deposit working generation 1
    const ssoWorking8 = await sealSeedToSso(m8.seed, "google", GOOGLE_SUB);
    const nonceWork8 = (await signedCall("/api/recovery/sso-nonce", m8.pubHex, {})).body.nonce;
    const depWork8 = await signedCall("/api/recovery/shares/sso", m8.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceWork8),
        nonce: nonceWork8,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoWorking8 },
        ],
    });
    assert.strictEqual(depWork8.status, 200);
    assert.strictEqual(getCurrentGeneration(m8.pubHex), 1);

    // 8.1 Missing salt in kdfParams
    const parsedKdf8 = JSON.parse(ssoWorking8.kdfParams);
    delete parsedKdf8.salt;
    const nonceBadSalt = (await signedCall("/api/recovery/sso-nonce", m8.pubHex, {})).body.nonce;
    const depBadSalt = await signedCall("/api/recovery/shares/sso", m8.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceBadSalt),
        nonce: nonceBadSalt,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoWorking8, kdfParams: JSON.stringify(parsedKdf8) },
        ],
    });
    await test("8.1 deposit with missing salt is refused and generation 1 remains intact", () => {
        assert.strictEqual(depBadSalt.status, 400);
        assert.strictEqual(getCurrentGeneration(m8.pubHex), 1);
    });

    // 8.2 Wrong IV length (12 bytes instead of 24)
    const nonceBadIv = (await signedCall("/api/recovery/sso-nonce", m8.pubHex, {})).body.nonce;
    const depBadIv = await signedCall("/api/recovery/shares/sso", m8.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceBadIv),
        nonce: nonceBadIv,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoWorking8, shareIv: Buffer.from(new Uint8Array(12)).toString("base64") },
        ],
    });
    await test("8.2 deposit with wrong IV length is refused and generation 1 remains intact", () => {
        assert.strictEqual(depBadIv.status, 400);
        assert.strictEqual(getCurrentGeneration(m8.pubHex), 1);
    });

    // 8.3 Wrong tag length (8 bytes instead of 16)
    const nonceBadTag = (await signedCall("/api/recovery/sso-nonce", m8.pubHex, {})).body.nonce;
    const depBadTag = await signedCall("/api/recovery/shares/sso", m8.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceBadTag),
        nonce: nonceBadTag,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoWorking8, shareTag: Buffer.from(new Uint8Array(8)).toString("base64") },
        ],
    });
    await test("8.3 deposit with wrong tag length is refused and generation 1 remains intact", () => {
        assert.strictEqual(depBadTag.status, 400);
        assert.strictEqual(getCurrentGeneration(m8.pubHex), 1);
    });

    // 8.4 Wrong seed length (48-byte PKCS8 buffer instead of 32 bytes)
    await test("8.4 sealSeedToSso throws at seal time when passed 48-byte key", async () => {
        const pkcs8Key = new Uint8Array(48).fill(99);
        await assert.rejects(async () => {
            await sealSeedToSso(pkcs8Key, "google", GOOGLE_SUB);
        }, /must be exactly 32 bytes/);
    });

    const nonceBadSeed = (await signedCall("/api/recovery/sso-nonce", m8.pubHex, {})).body.nonce;
    const depBadSeed = await signedCall("/api/recovery/shares/sso", m8.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonceBadSeed),
        nonce: nonceBadSeed,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...ssoWorking8, encryptedShare: Buffer.from(new Uint8Array(48)).toString("base64") },
        ],
    });
    await test("8.5 deposit with 48-byte encryptedShare is refused and generation 1 remains intact", () => {
        assert.strictEqual(depBadSeed.status, 400);
        assert.strictEqual(getCurrentGeneration(m8.pubHex), 1);
    });

    // Verify member still recovers generation 1 seed
    const eph8 = crypto.randomBytes(32).toString("hex");
    const open8 = await signedCall("/api/recovery/collect", eph8, { callsign: m8.callsign });
    const collId8 = open8.body.collectionId;
    const n8 = (await signedCall("/api/recovery/collect/sso-nonce", eph8, { collectionId: collId8 })).body.nonce;
    await signedCall("/api/recovery/collect/sso", eph8, {
        collectionId: collId8, provider: "google", idToken: mintGoogleToken(GOOGLE_SUB, n8), nonce: n8,
    });
    const frags8 = (await signedCall("/api/recovery/collect/fragments", eph8, { collectionId: collId8 })).body.fragments;
    const recSeed8 = await openShareFromSso(toSealedShare(frags8[0]), "google", GOOGLE_SUB);
    await test("8.6 member recovers seed from intact generation 1 after all rejected deposits", () => {
        assert.deepStrictEqual(recSeed8, new Uint8Array(m8.seed));
    });

    // =========================================================================
    // 9. Fallback Threshold Deadlock Prevention (Finding 8)
    // =========================================================================
    console.log("\n--- 9. Fallback Threshold Deadlock Prevention ---");
    const m9 = createTestMember("DeadlockTest");
    const sso9 = await sealSeedToSso(m9.seed, "google", GOOGLE_SUB);
    const nonce9 = (await signedCall("/api/recovery/sso-nonce", m9.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m9.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, nonce9),
        nonce: nonce9,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...sso9 },
        ],
    });

    const eph9 = crypto.randomBytes(32).toString("hex");
    const open9 = await signedCall("/api/recovery/collect", eph9, { callsign: m9.callsign });
    const collId9 = open9.body.collectionId;
    const n9 = (await signedCall("/api/recovery/collect/sso-nonce", eph9, { collectionId: collId9 })).body.nonce;
    await signedCall("/api/recovery/collect/sso", eph9, {
        collectionId: collId9, provider: "google", idToken: mintGoogleToken(GOOGLE_SUB, n9), nonce: n9,
    });

    // Call fragments route: verify threshold 1 and enough=true with 1 collected fragment
    const fragsRes9 = await signedCall("/api/recovery/collect/fragments", eph9, { collectionId: collId9 });
    await test("9.1 fragments route reports threshold 1 and enough=true when 1 single-blob fragment collected (no deadlock)", () => {
        assert.strictEqual(fragsRes9.body.threshold, 1);
        assert.strictEqual(fragsRes9.body.enough, true);
        assert.strictEqual(fragsRes9.body.collected, 1);
    });

    // Verify initial collection threshold for single-blob member is 1
    await test("9.2 collection opening reports threshold 1 for single-blob member", () => {
        assert.strictEqual(open9.body.threshold, 1);
    });

    // Verify fallback calculation logic directly produces threshold 1 and enough=true
    const releases9 = listReleases(collId9);
    const isSingleBlob9 = releases9.some((r: any) => r.holderType === "sso" && isSingleBlobSso(r.kdfParams));
    const defaultThreshold9 = isSingleBlob9 ? 1 : 2;
    await test("9.3 fallback calculation logic produces threshold 1 and enough=true for single-blob", () => {
        assert.strictEqual(defaultThreshold9, 1);
        const fallbackEnough = releases9.length >= defaultThreshold9;
        assert.strictEqual(fallbackEnough, true);
    });

    // =========================================================================
    // 10. Status and Threshold Fields Matrix Verification (Findings 4 & 9)
    // =========================================================================
    console.log("\n--- 10. Status and Threshold Fields Matrix ---");

    // 10.1 Legacy-only account
    const m10Legacy = createTestMember("StatusLegacy");
    const { hubShare: hs10, otherHalf: oh10 } = await splitHubAndWhole(m10Legacy.seed);
    const sso10L = await sealShareToSso(oh10, "google", GOOGLE_SUB);
    const n10L = (await signedCall("/api/recovery/sso-nonce", m10Legacy.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m10Legacy.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, n10L),
        nonce: n10L,
        shares: [
            { holderType: "hub", holderRef: "node", shareIndex: 1, ...recordShareForHub(hs10) },
            { holderType: "sso", holderRef: "google", shareIndex: 2, ...sso10L },
        ],
    });
    const status10L = (await signedCall("/api/recovery/shares/status", m10Legacy.pubHex, {})).body;
    await test("10.1 legacy-only status: threshold 2, total 2, canRemoveKeeper false, canAffordToLose 0", () => {
        assert.strictEqual(status10L.threshold, 2);
        assert.strictEqual(status10L.total, 2);
        assert.strictEqual(status10L.canRemoveKeeper, false);
        assert.strictEqual(status10L.canAffordToLose, 0);
        assert.strictEqual(status10L.recoverable, true);
    });

    // 10.2 Single-only account (clean, no hub)
    const m10Single = createTestMember("StatusSingle");
    const sso10S = await sealSeedToSso(m10Single.seed, "google", GOOGLE_SUB);
    const n10S = (await signedCall("/api/recovery/sso-nonce", m10Single.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m10Single.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, n10S),
        nonce: n10S,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...sso10S },
        ],
    });
    const status10S = (await signedCall("/api/recovery/shares/status", m10Single.pubHex, {})).body;
    await test("10.2 single-only status: threshold 1, total 1, canRemoveKeeper false, canAffordToLose 0", () => {
        assert.strictEqual(status10S.threshold, 1);
        assert.strictEqual(status10S.total, 1);
        assert.strictEqual(status10S.canRemoveKeeper, false);
        assert.strictEqual(status10S.canAffordToLose, 0);
        assert.strictEqual(status10S.recoverable, true);
    });

    // 10.3 Single-only account with orphaned hub (Finding 4)
    const m10Orphan = createTestMember("StatusOrphan");
    const sso10Orphan = await sealSeedToSso(m10Orphan.seed, "google", GOOGLE_SUB);
    putShareGeneration(m10Orphan.pubHex, [
        { holderType: "hub", holderRef: "node", shareIndex: 1, ...recordShareForHub(crypto.randomBytes(32)) },
        { holderType: "sso", holderRef: "google", shareIndex: 2, ssoLookupHash: "hash-orphan", ssoLookupSalt: "salt-orphan", ...sso10Orphan },
    ]);
    const status10Orphan = (await signedCall("/api/recovery/shares/status", m10Orphan.pubHex, {})).body;
    await test("10.3 single-blob with orphaned hub: threshold 1, total 2, canRemoveKeeper false, canAffordToLose 0 (Finding 4 fix)", () => {
        assert.strictEqual(status10Orphan.threshold, 1);
        assert.strictEqual(status10Orphan.total, 2);
        assert.strictEqual(status10Orphan.canRemoveKeeper, false);
        assert.strictEqual(status10Orphan.canAffordToLose, 0);
        assert.strictEqual(canRemoveKeeper(m10Orphan.pubHex), false);
        assert.strictEqual(status10Orphan.recoverable, true);
    });

    // 10.4 Multi-provider single-blob account (Google + Apple)
    const m10Multi = createTestMember("StatusMulti");
    const sso10M1 = await sealSeedToSso(m10Multi.seed, "google", GOOGLE_SUB);
    const n10M1 = (await signedCall("/api/recovery/sso-nonce", m10Multi.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m10Multi.pubHex, {
        provider: "google",
        idToken: mintGoogleToken(GOOGLE_SUB, n10M1),
        nonce: n10M1,
        shares: [
            { holderType: "sso", holderRef: "google", shareIndex: 1, ...sso10M1 },
        ],
    });
    const sso10M2 = await sealSeedToSso(m10Multi.seed, "apple", APPLE_SUB);
    const n10M2 = (await signedCall("/api/recovery/sso-nonce", m10Multi.pubHex, {})).body.nonce;
    await signedCall("/api/recovery/shares/sso", m10Multi.pubHex, {
        provider: "apple",
        idToken: mintAppleToken(APPLE_SUB, n10M2),
        nonce: n10M2,
        shares: [
            { holderType: "sso", holderRef: "apple", shareIndex: 1, ...sso10M2 },
        ],
    });
    const status10Multi = (await signedCall("/api/recovery/shares/status", m10Multi.pubHex, {})).body;
    await test("10.4 multi single-blob status: threshold 1, total 2, canRemoveKeeper true, canAffordToLose 1", () => {
        assert.strictEqual(status10Multi.threshold, 1);
        assert.strictEqual(status10Multi.total, 2);
        assert.strictEqual(status10Multi.canRemoveKeeper, true);
        assert.strictEqual(status10Multi.canAffordToLose, 1);
        assert.strictEqual(canRemoveKeeper(m10Multi.pubHex), true);
    });

    // 10.5 Mixed account (Google single-blob + Apple legacy + hub)
    const status10Mixed = (await signedCall("/api/recovery/shares/status", m6.pubHex, {})).body;
    await test("10.5 mixed account status: threshold 1, total 3, canRemoveKeeper true, canAffordToLose 2", () => {
        assert.strictEqual(status10Mixed.threshold, 1);
        assert.strictEqual(status10Mixed.total, 3);
        assert.strictEqual(status10Mixed.canRemoveKeeper, true);
        assert.strictEqual(status10Mixed.canAffordToLose, 2);
        assert.strictEqual(canRemoveKeeper(m6.pubHex), true);
        assert.strictEqual(status10Mixed.recoverable, true);
    });

    console.log(`\n⭐️ ALL ${passed}/${passed} SSO RECOVERY TESTS PASSED!\n`);
}

main().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('❌ SSO Recovery Round-Trip Suite FAILED:', e);
    process.exit(1);
});
