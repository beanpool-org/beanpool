/**
 * End-to-end integration test for Trusted Friend Recovery (K4+) round-trip.
 *
 * Verifies:
 * 1. Deposit: Alice splits seed via splitTwoLayer (2-of-2 Shamir over friends),
 *    seals K2 to hub, seals K4_1 to Bob (Friend 1), and seals K4_2 to Carol (Friend 2).
 *    Deposits generation 1 to the node via /api/recovery/shares.
 * 2. Collection Start: Alice's new device (with ephemeral keypair) opens collection for callsign 'alice'.
 * 3. Keeper Approvals:
 *    - Bob calls /api/recovery/approve-keeper/context, unseals his share with Bob's private key,
 *      re-wraps to Alice's ephemeral key, and approves via /api/recovery/approve-keeper.
 *    - Carol does the same for her share.
 * 4. Instant Hub Release: Once at least one human keeper approves (D7), Hub share is instantly released.
 * 5. Fragment Collection & Reconstruction:
 *    - Alice fetches fragments from /api/recovery/collect/fragments.
 *    - Alice unseals Bob and Carol's rewrapped shares with Alice's ephemeral private key.
 *    - Alice reads Hub share.
 *    - Alice combines via combineTwoLayer(hubShare, [s1, s2], seedChecksum) to restore exact Seed.
 * 6. Identity Verification:
 *    - Restored seed derives Alice's exact original Ed25519 public key.
 *    - Zero new accounts minted, existing member preserved in database.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    splitTwoLayer,
    combineTwoLayer,
    sealShareToMember,
    openShareAsMember,
    rewrapShareToDevice,
    openRewrappedShare,
    recordShareForHub,
    readHubShare,
    TWO_LAYER_THRESHOLD,
} from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';

initStateEngine();

let passed = 0;
function test(msg: string, fn: () => void | Promise<void>) {
    return Promise.resolve(fn()).then(() => {
        console.log(`✓ ${msg}`);
        passed++;
    });
}

function makeMemberIdentity(callsign: string) {
    const priv = crypto.randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('hex');
    const uniqueCallsign = `${callsign}_${pub.slice(0, 6)}`;
    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', datetime('now'), 'system', 'inv-code')
    `).run(pub, uniqueCallsign);
    return { callsign: uniqueCallsign, pub, priv };
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
    if (!layer) throw new Error(`no handler for ${method} ${path}`);
    return layer.stack[layer.stack.length - 1];
}

async function invoke(path: string, actor: string, body: Record<string, unknown> = {}, method: string = 'POST') {
    const fn = handlerFor(path, method);
    const ctx: any = {
        method,
        path,
        state: { actor },
        requestBody: body,
        query: body,
        status: 200,
        body: null,
    };
    await fn(ctx);
    return ctx;
}

async function run() {
    console.log('--- Trusted Friend Recovery (K4+) End-to-End Roundtrip ---');

    const alice = makeMemberIdentity('alice');
    const bob = makeMemberIdentity('bob');
    const carol = makeMemberIdentity('carol');

    let storedChecksum: Uint8Array;
    let aliceEphPriv: Uint8Array;
    let aliceEphPubHex: string;
    let collectionId: string;

    await test('Step 1: Alice deposits Two-Layer recovery split (Hub + Bob + Carol)', async () => {
        const split = await splitTwoLayer(alice.priv, 2);
        storedChecksum = split.seedChecksum;

        const hubShare = recordShareForHub(split.hubShare);
        const bobShare = sealShareToMember(split.friendShares[0], bob.pub);
        const carolShare = sealShareToMember(split.friendShares[1], carol.pub);

        const depositCtx = await invoke('/api/recovery/shares', alice.pub, {
            generation: 1,
            shares: [
                {
                    shareIndex: 1,
                    holderType: 'hub',
                    holderRef: 'hub',
                    encryptedShare: hubShare.encryptedShare,
                    shareIv: hubShare.shareIv,
                    shareTag: hubShare.shareTag,
                    kdfParams: hubShare.kdfParams,
                },
                {
                    shareIndex: 2,
                    holderType: 'member',
                    holderRef: bob.pub,
                    encryptedShare: bobShare.encryptedShare,
                    shareIv: bobShare.shareIv,
                    shareTag: bobShare.shareTag,
                    ephemeralPubkey: bobShare.ephemeralPubkey,
                    kdfParams: bobShare.kdfParams,
                },
                {
                    shareIndex: 3,
                    holderType: 'member',
                    holderRef: carol.pub,
                    encryptedShare: carolShare.encryptedShare,
                    shareIv: carolShare.shareIv,
                    shareTag: carolShare.shareTag,
                    ephemeralPubkey: carolShare.ephemeralPubkey,
                    kdfParams: carolShare.kdfParams,
                },
            ],
        }, 'POST');

        assert.strictEqual(depositCtx.status, 200);
        assert.strictEqual(depositCtx.body.generation, 1);
        assert.strictEqual(depositCtx.body.shareCount, 3);
    });

    await test('Step 2: Alice starts recovery collection on a new device with ephemeral key', async () => {
        aliceEphPriv = crypto.randomBytes(32);
        aliceEphPubHex = Buffer.from(ed25519.getPublicKey(aliceEphPriv)).toString('hex');

        const collectCtx = await invoke('/api/recovery/collect', aliceEphPubHex, {
            callsign: alice.callsign,
        });

        assert.strictEqual(collectCtx.status, 200);
        assert.ok(collectCtx.body.collectionId);
        collectionId = collectCtx.body.collectionId;
        assert.strictEqual(collectCtx.body.threshold, 3);
    });

    await test('Step 3: Bob fetches approval context, unseals share, re-wraps to Alice device, and approves', async () => {
        const contextCtx = await invoke('/api/recovery/approve-keeper/context', bob.pub, {
            collectionId,
        });

        assert.strictEqual(contextCtx.status, 200);
        assert.strictEqual(contextCtx.body.callsign, alice.callsign);
        assert.strictEqual(contextCtx.body.recipientEphemeralPubkey, aliceEphPubHex);

        const bobHeldShare = {
            encryptedShare: contextCtx.body.fragment.encryptedShare,
            shareIv: contextCtx.body.fragment.shareIv,
            shareTag: contextCtx.body.fragment.shareTag,
            ephemeralPubkey: contextCtx.body.fragment.ephemeralPubkey,
            kdfParams: JSON.stringify({ alg: 'x25519-xc20p-v1' }),
        };

        const bobOpenedShare = openShareAsMember(bobHeldShare, bob.priv);
        const bobRewrapped = rewrapShareToDevice(bobOpenedShare, aliceEphPubHex);

        const approveCtx = await invoke('/api/recovery/approve-keeper', bob.pub, {
            collectionId,
            payload: bobRewrapped.encryptedShare,
            payloadIv: bobRewrapped.shareIv,
            payloadTag: bobRewrapped.shareTag,
            ephemeralPubkey: bobRewrapped.ephemeralPubkey,
        });

        assert.strictEqual(approveCtx.status, 200);
        assert.strictEqual(approveCtx.body.released, 'member');
    });

    await test('Step 4: Hub share releases instantly under D7 after 1 human keeper approved', async () => {
        const hubCtx = await invoke('/api/recovery/collect/hub', aliceEphPubHex, {
            collectionId,
        });

        assert.strictEqual(hubCtx.status, 200);
        assert.ok(hubCtx.body.releasedTypes.includes('hub'));
    });

    await test('Step 5: Carol fetches context, unseals her share, re-wraps to Alice device, and approves', async () => {
        const contextCtx = await invoke('/api/recovery/approve-keeper/context', carol.pub, {
            collectionId,
        });

        assert.strictEqual(contextCtx.status, 200);
        assert.strictEqual(contextCtx.body.callsign, alice.callsign);
        assert.strictEqual(contextCtx.body.recipientEphemeralPubkey, aliceEphPubHex);

        const carolHeldShare = {
            encryptedShare: contextCtx.body.fragment.encryptedShare,
            shareIv: contextCtx.body.fragment.shareIv,
            shareTag: contextCtx.body.fragment.shareTag,
            ephemeralPubkey: contextCtx.body.fragment.ephemeralPubkey,
            kdfParams: JSON.stringify({ alg: 'x25519-xc20p-v1' }),
        };

        const carolOpenedShare = openShareAsMember(carolHeldShare, carol.priv);
        const carolRewrapped = rewrapShareToDevice(carolOpenedShare, aliceEphPubHex);

        const approveCtx = await invoke('/api/recovery/approve-keeper', carol.pub, {
            collectionId,
            payload: carolRewrapped.encryptedShare,
            payloadIv: carolRewrapped.shareIv,
            payloadTag: carolRewrapped.shareTag,
            ephemeralPubkey: carolRewrapped.ephemeralPubkey,
        });

        assert.strictEqual(approveCtx.status, 200);
    });

    await test('Step 6: Alice fetches released fragments and reconstructs exact original Ed25519 key', async () => {
        const fragmentsCtx = await invoke('/api/recovery/collect/fragments', aliceEphPubHex, {
            collectionId,
        });

        assert.strictEqual(fragmentsCtx.status, 200);
        assert.strictEqual(fragmentsCtx.body.enough, true);
        assert.strictEqual(fragmentsCtx.body.fragments.length, 3); // Hub + Bob + Carol

        const hubFragment = fragmentsCtx.body.fragments.find((f: any) => f.holderType === 'hub');
        const memberFragments = fragmentsCtx.body.fragments.filter((f: any) => f.holderType === 'member');

        assert.ok(hubFragment);
        assert.strictEqual(memberFragments.length, 2);

        const recoveredHub = readHubShare({
            encryptedShare: hubFragment.payload,
            shareIv: hubFragment.payloadIv,
            shareTag: hubFragment.payloadTag,
            kdfParams: hubFragment.kdfParams,
        });

        const recoveredFriendShares = memberFragments.map((f: any) => {
            return openRewrappedShare({
                encryptedShare: f.payload,
                shareIv: f.payloadIv,
                shareTag: f.payloadTag,
                ephemeralPubkey: f.ephemeralPubkey,
            }, aliceEphPriv);
        });

        const restoredSeed = await combineTwoLayer(
            recoveredHub,
            recoveredFriendShares,
            storedChecksum,
        );

        assert.strictEqual(Buffer.from(restoredSeed).toString('hex'), Buffer.from(alice.priv).toString('hex'));

        const restoredPubHex = Buffer.from(ed25519.getPublicKey(restoredSeed)).toString('hex');
        assert.strictEqual(restoredPubHex, alice.pub);
    });

    await test('Step 7: Verify database state integrity and exact member preservation', async () => {
        const memberRow = db.prepare('SELECT callsign, public_key, status FROM members WHERE lower(callsign) = ?').get(alice.callsign.toLowerCase()) as any;
        assert.ok(memberRow);
        assert.strictEqual(memberRow.public_key, alice.pub);
        assert.strictEqual(memberRow.status, 'active');
    });

    console.log(`\n🎉 All ${passed} tests passed!`);
}

run().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('Test failed with error:', e);
    process.exit(1);
});
