/**
 * End-to-end integration test for the Google SSO recovery round-trip.
 *
 * Verifies:
 * 1. Deposit: Member splits seed via splitHubAndWhole, seals SSO share to provider:sub, and deposits to node.
 * 2. Collection: Recovering device (with throwaway ephemeral keypair) opens collection for callsign.
 * 3. Nonce: Recovering device gets node-issued SSO nonce bound to its ephemeral key.
 * 4. SSO verification: Node verifies Google id_token, matches ssoLookupHash, and releases SSO share with kdfParams.
 * 5. Instant Hub release: Node immediately releases Hub share for SSO tier (D7 24h delay bypassed).
 * 6. Reconstruction: Recovering device decrypts SSO share with openShareFromSso, reads hub share with readHubShare,
 *    combines via combineHubAndWhole, and verifies restored seed & public key match the original member.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {
    splitHubAndWhole,
    combineHubAndWhole,
    sealShareToSso,
    recordShareForHub,
    openShareFromSso,
    readHubShare,
    TWO_LAYER_THRESHOLD,
} from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';

initStateEngine();

let passed = 0;
function test(msg: string, fn: () => void | Promise<void>) {
    return Promise.resolve(fn()).then(() => {
        console.log(`✓ ${msg}`);
        passed++;
    });
}

const KID = 'test-sso-roundtrip-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
const GOOGLE_EMAIL = 'monnunit@gmail.com';

const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GOOGLE_JWK = { ...rsaPub.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;

function mintGoogleToken(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
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
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), rsaPriv).toString('base64url');
    return `${header}.${payload}.${sig}`;
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

async function signedCall(path: string, actorPubkey: string, body: unknown) {
    const ctx: any = {
        state: { actor: actorPubkey },
        requestBody: body,
        params: {},
        status: 200,
        body: undefined,
    };
    await handlerFor(path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

async function main() {
    console.log('\n── Google SSO Recovery Round-Trip End-to-End Test ──\n');

    _resetJwksCacheForTests('google', { keys: [GOOGLE_JWK], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();

    // 1. Generate original member keypair from seed
    const originalSeed = crypto.randomBytes(32);
    const memberEdKey = crypto.createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            Buffer.from(originalSeed),
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const memberEdPub = crypto.createPublicKey(memberEdKey);
    const memberPubHex = (memberEdPub.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const memberCallsign = `Monnunit-${memberPubHex.slice(0, 6)}`;

    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'genesis', 'genesis')
    `).run(memberPubHex, memberCallsign);

    await test('member exists in active status', () => {
        const row = db.prepare('SELECT * FROM members WHERE public_key = ?').get(memberPubHex) as any;
        assert(row && row.callsign === memberCallsign);
    });

    // 2. Member splits seed into hub + SSO and deposits
    const { hubShare, otherHalf } = await splitHubAndWhole(originalSeed);
    const ssoSealed = await sealShareToSso(otherHalf, 'google', GOOGLE_SUB);

    const depositNonceRes = await signedCall('/api/recovery/sso-nonce', memberPubHex, {});
    assert.strictEqual(depositNonceRes.status, 200);
    const depositNonce = depositNonceRes.body.nonce;

    const depositToken = mintGoogleToken(GOOGLE_SUB, depositNonce);

    const depositRes = await signedCall('/api/recovery/shares/sso', memberPubHex, {
        provider: 'google',
        idToken: depositToken,
        nonce: depositNonce,
        shares: [
            { holderType: 'hub', holderRef: 'node', shareIndex: 1, ...recordShareForHub(hubShare) },
            { holderType: 'sso', holderRef: 'google', shareIndex: 2, ...ssoSealed },
        ],
    });

    await test('enrolment deposit succeeds with 2 shares (generation 1)', () => {
        assert.strictEqual(depositRes.status, 200);
        assert.strictEqual(depositRes.body.generation, 1);
        assert.strictEqual(depositRes.body.threshold, TWO_LAYER_THRESHOLD);
    });

    // 3. Recovering device opens collection
    const recoveringDevicePubHex = crypto.randomBytes(32).toString('hex');
    const openRes = await signedCall('/api/recovery/collect', recoveringDevicePubHex, {
        callsign: memberCallsign,
    });

    await test('recovering device opens collection for callsign', () => {
        assert.strictEqual(openRes.status, 200);
        assert(typeof openRes.body.collectionId === 'string');
        assert.strictEqual(openRes.body.generation, 1);
        assert.strictEqual(openRes.body.threshold, TWO_LAYER_THRESHOLD);
    });
    const collectionId = openRes.body.collectionId;

    // 4. Recovering device gets SSO nonce
    const collectNonceRes = await signedCall('/api/recovery/collect/sso-nonce', recoveringDevicePubHex, {
        collectionId,
    });

    await test('recovering device gets collection-bound SSO nonce', () => {
        assert.strictEqual(collectNonceRes.status, 200);
        assert(typeof collectNonceRes.body.nonce === 'string');
    });
    const collectNonce = collectNonceRes.body.nonce;

    // 5. Recovering device presents fresh Google token
    const recoverGoogleToken = mintGoogleToken(GOOGLE_SUB, collectNonce);
    const collectSsoRes = await signedCall('/api/recovery/collect/sso', recoveringDevicePubHex, {
        collectionId,
        provider: 'google',
        idToken: recoverGoogleToken,
        nonce: collectNonce,
    });

    await test('node verifies Google token and releases SSO fragment', () => {
        assert.strictEqual(collectSsoRes.status, 200);
        assert.strictEqual(collectSsoRes.body.collected, 1);
        assert.deepStrictEqual(collectSsoRes.body.releasedTypes, ['sso']);
    });

    // 6. Recovering device requests hub fragment (instant release under SSO tier)
    const collectHubRes = await signedCall('/api/recovery/collect/hub', recoveringDevicePubHex, {
        collectionId,
    });

    await test('node releases Hub fragment immediately without 24h delay (D7 bypassed for SSO)', () => {
        assert.strictEqual(collectHubRes.status, 200);
        assert.strictEqual(collectHubRes.body.collected, 2);
        assert.strictEqual(collectHubRes.body.enough, true);
        assert(collectHubRes.body.releasedTypes.includes('hub'));
    });

    // 7. Recovering device retrieves released fragments
    const fragsRes = await signedCall('/api/recovery/collect/fragments', recoveringDevicePubHex, {
        collectionId,
    });

    await test('fragments route returns both released fragments with kdfParams', () => {
        assert.strictEqual(fragsRes.status, 200);
        assert.strictEqual(fragsRes.body.collected, 2);
        assert.strictEqual(fragsRes.body.enough, true);
        const frags = fragsRes.body.fragments;
        assert.strictEqual(frags.length, 2);

        const ssoFrag = frags.find((f: any) => f.holderType === 'sso');
        const hubFrag = frags.find((f: any) => f.holderType === 'hub');
        assert(ssoFrag, 'sso fragment must be present');
        assert(hubFrag, 'hub fragment must be present');
        assert(ssoFrag.kdfParams, 'sso fragment must carry kdfParams');
    });

    const ssoFrag = fragsRes.body.fragments.find((f: any) => f.holderType === 'sso');
    const hubFrag = fragsRes.body.fragments.find((f: any) => f.holderType === 'hub');

    // 8. Reconstruct seed on the recovering device
    const decryptedOtherHalf = await openShareFromSso(
        {
            encryptedShare: ssoFrag.payload,
            shareIv: ssoFrag.payloadIv,
            shareTag: ssoFrag.payloadTag,
            kdfParams: ssoFrag.kdfParams,
        },
        'google',
        GOOGLE_SUB,
    );

    const decryptedHubShare = readHubShare({
        encryptedShare: hubFrag.payload,
        shareIv: hubFrag.payloadIv,
        shareTag: hubFrag.payloadTag,
        kdfParams: hubFrag.kdfParams,
    });

    const reconstructedSeed = combineHubAndWhole(decryptedHubShare, decryptedOtherHalf);

    await test('reconstructed seed exactly matches original seed bytes', () => {
        assert.deepStrictEqual(reconstructedSeed, new Uint8Array(originalSeed));
    });

    // 9. Verify derived Ed25519 identity matches member public key
    const reconstructedEdKey = crypto.createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            Buffer.from(reconstructedSeed),
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const reconstructedEdPub = crypto.createPublicKey(reconstructedEdKey);
    const reconstructedPubHex = (reconstructedEdPub.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');

    await test('reconstructed Ed25519 public key matches member public key', () => {
        assert.strictEqual(reconstructedPubHex, memberPubHex);
    });

    console.log(`\n⭐️ ALL ${passed}/${passed} SSO RECOVERY ROUND-TRIP CHECKS PASSED!\n`);
}

main().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('❌ SSO Recovery Round-Trip Test FAILED:', e);
    process.exit(1);
});
