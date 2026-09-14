/**
 * Regression test for Priority Item 1:
 * Enforce verified actor session authorization on all marketplace routes.
 *
 * Verifies that:
 * 1. Unauthenticated callers (missing ctx.state.actor) receive 401.
 * 2. Authenticated callers attempting to act for another member receive 403.
 * 3. Authenticated callers attempting to act for an enterprise they do NOT keep receive 403.
 * 4. Legitimate actors acting for themselves succeed.
 * 5. Legitimate keepers acting for their enterprise succeed.
 * 6. Critical routes (/transactions/approve, /transactions/complete) fail closed on identity spoofing.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator,
    createPost, requestPost, transfer
} from './state-engine.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string) {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const pubkey = crypto.randomBytes(16).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pubkey, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(pubkey);
    return pubkey;
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    const fn = layer.stack[layer.stack.length - 1];
    await fn(ctx);
    return ctx;
}

async function testMarketplaceActorAuth() {
    console.log('Testing Marketplace Actor Session Authorization...\n');
    initStateEngine();

    const router = createMarketplaceRoutes({
        clampLimit: (n) => Number(n) || 50,
        clampOffset: (n) => Number(n) || 0,
        enforceReadAuth: false,
    } as any);

    const alice = makeMember('alice');
    const bob = makeMember('bob');
    const eve = makeMember('eve');

    transfer('genesis', alice, 100, 'seed', 'direct', true);
    transfer('genesis', bob, 100, 'seed', 'direct', true);
    transfer('genesis', eve, 100, 'seed', 'direct', true);

    // Create an enterprise and assign Bob as keeper
    const treasury = createTreasury('CommunityFarm', 'data:image/png;base64,iVBORw0KGgo=', 500).publicKey;
    adminAssignTreasuryOperator(treasury, bob, 'admin');

    // Bob lists an offer to satisfy CONTRIBUTION_REQUIRED
    createPost('offer', 'services', 'Bob repairs', 'Fixing tools', 5, 'fixed', bob);

    // Alice creates an offer post
    const offer = createPost('offer', 'food', 'Fresh Carrots', 'Organic carrots', 10, 'fixed', alice)!;

    // Bob requests the offer
    const tx = requestPost(offer.id, bob);

    // ── 1. Unauthenticated requests (no ctx.state.actor) receive 401 ──
    {
        const ctx: any = { requestBody: { transactionId: tx.id, authorPublicKey: alice }, state: {} };
        await dispatch(router, 'POST', '/api/marketplace/transactions/approve', ctx);
        check(ctx.status === 401, 'Unauthenticated /transactions/approve returns 401');
    }
    {
        const ctx: any = { requestBody: { transactionId: tx.id, confirmerPublicKey: bob }, state: {} };
        await dispatch(router, 'POST', '/api/marketplace/transactions/complete', ctx);
        check(ctx.status === 401, 'Unauthenticated /transactions/complete returns 401');
    }
    {
        const ctx: any = { requestBody: { type: 'offer', title: 'Spoofed', authorPublicKey: alice }, state: {} };
        await dispatch(router, 'POST', '/api/marketplace/posts', ctx);
        check(ctx.status === 401, 'Unauthenticated /posts returns 401');
    }

    // ── 2. Authenticated attacker spoofing another member receives 403 ──
    {
        // Eve tries to approve Alice's transaction by specifying authorPublicKey: alice
        const ctx: any = {
            requestBody: { transactionId: tx.id, authorPublicKey: alice },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/transactions/approve', ctx);
        check(ctx.status === 403, 'Attacker cannot approve transaction for another member (403)');
        check(ctx.body?.error === 'Not authorized to act on behalf of this identity', 'Returns not authorized error');
    }
    {
        // Eve tries to complete Bob's transaction by specifying confirmerPublicKey: bob
        const ctx: any = {
            requestBody: { transactionId: tx.id, confirmerPublicKey: bob },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/transactions/complete', ctx);
        check(ctx.status === 403, 'Attacker cannot complete transaction for another member (403)');
        check(ctx.body?.error === 'Not authorized to act on behalf of this identity', 'Returns not authorized error');
    }
    {
        // Eve tries to create a post as Alice
        const ctx: any = {
            requestBody: { type: 'offer', title: 'Spoofed post', authorPublicKey: alice },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts', ctx);
        check(ctx.status === 403, 'Attacker cannot create post for another member (403)');
    }
    {
        // Eve tries to pause Alice's post
        const ctx: any = {
            requestBody: { postId: offer.id, authorPublicKey: alice },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/pause', ctx);
        check(ctx.status === 403, 'Attacker cannot pause post for another member (403)');
    }

    // ── 3. Authenticated attacker spoofing an enterprise without keepership receives 403 ──
    {
        // Eve tries to post on behalf of CommunityFarm without being a keeper
        const ctx: any = {
            requestBody: { type: 'offer', title: 'Fake farm offer', authorPublicKey: treasury },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts', ctx);
        check(ctx.status === 403, 'Non-keeper cannot post for enterprise (403)');
        check(ctx.body?.error === 'You are not an authorized keeper of this enterprise', 'Enterprise keeper error message');
    }

    // ── 4. Authorized keeper CAN act for enterprise ──
    {
        // Bob is keeper of CommunityFarm and posts an offer
        const ctx: any = {
            requestBody: { type: 'offer', title: 'Farm tomatoes', authorPublicKey: treasury, credits: 5 },
            state: { actor: bob }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts', ctx);
        check(ctx.body?.success === true, 'Authorized keeper Bob can create post for CommunityFarm');
        check(ctx.body?.post?.authorPublicKey === treasury, 'Post author is the enterprise');
    }

    // ── 5. Legitimate author can approve transaction ──
    {
        const ctx: any = {
            requestBody: { transactionId: tx.id, authorPublicKey: alice },
            state: { actor: alice }
        };
        await dispatch(router, 'POST', '/api/marketplace/transactions/approve', ctx);
        check(ctx.status === undefined || ctx.status === 200, 'Alice can approve her own deal');
        check(ctx.body?.success === true, 'Approval succeeded');
    }

    // ── 6. Legitimate buyer can complete transaction ──
    {
        const ctx: any = {
            requestBody: { transactionId: tx.id, confirmerPublicKey: bob },
            state: { actor: bob }
        };
        await dispatch(router, 'POST', '/api/marketplace/transactions/complete', ctx);
        check(ctx.body?.success === true, 'Bob can complete his own deal');
    }

    console.log(`\nAll ${passed}/${run} checks passed.`);
    process.exit(0);
}

testMarketplaceActorAuth().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
