/**
 * Regression test for Priority Item 1:
 * Enforce verified actor session authorization on all marketplace routes.
 *
 * Verifies that:
 * 1. Unauthenticated callers (missing ctx.state.actor) receive 401.
 * 2. Authenticated callers attempting to act for another member receive 403.
 * 3. Authenticated callers attempting to act for an enterprise they do NOT keep receive 403.
 * 4. Legitimate actors acting for themselves succeed.
 * 5. Nobody posts AS an enterprise here, keeper or not: that goes through the enterprise's own routes,
 *    POST /api/treasury/:treasury/{offer,need,event}, where the enterprise is in the URL path (2026-09-23).
 * 6. Critical routes (/transactions/approve, /transactions/complete) fail closed on identity spoofing.
 * 7. A keeper suspended by a community Decision (status 'disabled', operator switch untouched) can no
 *    longer list, edit, pause or remove offers as the enterprise; an unsuspended keeper still can.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator,
    createPost, requestPost, transfer, setUserStatusRow, canOperateTreasury,
} from './state-engine.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createTreasuryRoutes } from './routes/treasury.js';

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
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        enforceReadAuth: false,
    } as any);

    // The enterprise's OWN routes, where a keeper acts for it: the enterprise rides the URL path, which is
    // the only way past the signature middleware's spoof check (see section 4).
    const entRouter = createTreasuryRoutes({ checkAdminAuth: async () => false } as any);

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
    {
        const ctx: any = { requestBody: { id: offer.id, authorPublicKey: alice }, state: {} };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', ctx);
        check(ctx.status === 401, 'Unauthenticated /posts/remove returns 401');
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
    {
        // Eve tries to remove Alice's post
        const ctx: any = {
            requestBody: { id: offer.id, authorPublicKey: alice },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', ctx);
        check(ctx.status === 403, 'Attacker cannot remove post for another member (403)');
    }
    {
        // Eve tries to remove Alice's post by claiming authorPublicKey is Eve (spoofed author pubkey in body)
        const ctx: any = {
            requestBody: { id: offer.id, authorPublicKey: eve },
            state: { actor: eve }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', ctx);
        check(ctx.status === 403, 'Attacker cannot remove post by claiming own pubkey on another member post (403)');
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

    // ── 4. Even an authorized keeper posts for the enterprise through the ENTERPRISE's route ──
    // This route posts as the signer and nobody else (2026-09-23). It used to accept a keeper naming their
    // enterprise here, and this check asserted that it worked — but over HTTP it never could: the signature
    // middleware refuses any body field ending in `publickey` that is not the signer, so the request was
    // answered with 403 "Signature validation failed" before the handler ran, and only a router-level test
    // like this one ever saw it succeed. The enterprise's own routes put it in the URL path instead:
    // POST /api/treasury/:treasury/{offer,need,event}. See test-enterprise-event-http.ts, which goes over
    // the wire.
    {
        // Bob is keeper of CommunityFarm and tries to post an offer in its name from here
        const ctx: any = {
            requestBody: { type: 'offer', title: 'Farm tomatoes', authorPublicKey: treasury, credits: 5 },
            state: { actor: bob }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts', ctx);
        check(ctx.status === 403, 'Even a keeper cannot post for the enterprise through this route (403)');
        check(/treasury/.test(ctx.body?.error ?? ''), 'The refusal names the enterprise route to use instead');
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

    // ── 7. Legitimate author and keeper can remove their own posts ──
    {
        // Alice removes her own post
        const alicePostToRemove = createPost('offer', 'food', 'Extra Carrots', 'More carrots', 10, 'fixed', alice)!;
        const ctx: any = {
            requestBody: { id: alicePostToRemove.id, authorPublicKey: alice },
            state: { actor: alice }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', ctx);
        check(ctx.body?.success === true, 'Alice can remove her own post');
    }
    {
        // Bob is keeper of CommunityFarm and removes the enterprise post
        const farmPost = createPost('offer', 'food', 'Farm Basil', 'Organic herbs', 5, 'fixed', treasury)!;
        const ctx: any = {
            requestBody: { id: farmPost.id, authorPublicKey: treasury },
            state: { actor: bob }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', ctx);
        check(ctx.body?.success === true, 'Authorized keeper Bob can remove post for CommunityFarm');
    }

    // ── 8. A keeper suspended by a community Decision no longer acts as the enterprise ──
    // A suspend_member Decision sets members.status = 'disabled' through setUserStatusRow and leaves
    // can_operate and the treasury_operators binding in place. Acting as the enterprise must still stop.
    {
        const carol = makeMember('carol');
        transfer('genesis', carol, 100, 'seed', 'direct', true);
        adminAssignTreasuryOperator(treasury, carol, 'admin');

        // Listing AS the enterprise goes through the enterprise's own route (the marketplace route posts as
        // the signer and nobody else). Everything else in this section still drives the marketplace route,
        // because edit / pause / remove name the enterprise as the post's author, not as the actor.
        const offerCtx = (actor: string, title: string): any => ({
            params: { treasury }, state: { actor }, get: () => '', set: () => { },
            requestBody: { category: 'food', title, credits: 5 },
        });
        const beforeCtx = await dispatch(entRouter, 'POST', `/api/treasury/${treasury}/offer`, offerCtx(carol, 'Farm eggs'));
        check(beforeCtx.body?.success === true, 'Unsuspended keeper Carol can list an offer for CommunityFarm');
        const farmOffer = beforeCtx.body.post.id as string;

        setUserStatusRow(carol, 'disabled');
        const carolRow = db.prepare('SELECT status, can_operate FROM members WHERE public_key = ?').get(carol) as any;
        check(carolRow.status === 'disabled' && carolRow.can_operate === 1, 'Decision-suspended Carol is disabled with her operator switch still on');

        const listCtx = await dispatch(entRouter, 'POST', `/api/treasury/${treasury}/offer`, offerCtx(carol, 'Suspended farm offer'));
        check(listCtx.status === 403, `Decision-suspended keeper cannot list an offer for the enterprise (got ${listCtx.status})`);

        const editCtx: any = {
            requestBody: { id: farmOffer, authorPublicKey: treasury, title: 'Hijacked eggs' },
            state: { actor: carol }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/update', editCtx);
        check(editCtx.status === 403, `Decision-suspended keeper cannot edit the enterprise offer (got ${editCtx.status})`);
        const titleNow = (db.prepare('SELECT title FROM posts WHERE id = ?').get(farmOffer) as any).title;
        check(titleNow === 'Farm eggs', 'Enterprise offer title is unchanged');

        const pauseCtx: any = {
            requestBody: { postId: farmOffer, authorPublicKey: treasury },
            state: { actor: carol }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/pause', pauseCtx);
        check(pauseCtx.status === 403, `Decision-suspended keeper cannot pause the enterprise offer (got ${pauseCtx.status})`);

        const removeCtx: any = {
            requestBody: { id: farmOffer, authorPublicKey: treasury },
            state: { actor: carol }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/remove', removeCtx);
        check(removeCtx.status === 403, `Decision-suspended keeper cannot remove the enterprise offer (got ${removeCtx.status})`);

        check(canOperateTreasury(carol, treasury) === false, 'Decision-suspended Carol cannot operate CommunityFarm');

        // Bob, an ordinary keeper of the same enterprise, is unaffected.
        const bobEditCtx: any = {
            requestBody: { id: farmOffer, authorPublicKey: treasury, title: 'Farm eggs (dozen)' },
            state: { actor: bob }
        };
        await dispatch(router, 'POST', '/api/marketplace/posts/update', bobEditCtx);
        check(bobEditCtx.body?.success === true, `Unsuspended keeper Bob can still edit the enterprise offer (got ${bobEditCtx.status} ${bobEditCtx.body?.error})`);
        const bobListCtx = await dispatch(entRouter, 'POST', `/api/treasury/${treasury}/offer`, offerCtx(bob, 'Farm honey'));
        check(bobListCtx.body?.success === true, 'Unsuspended keeper Bob can still list an offer for CommunityFarm');

        // Lifting the suspension restores the existing binding.
        setUserStatusRow(carol, 'active');
        check(canOperateTreasury(carol, treasury) === true, 'Unsuspending Carol restores her authority over CommunityFarm');
    }

    console.log(`\nAll ${passed}/${run} checks passed.`);
    process.exit(0);
}

testMarketplaceActorAuth().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
