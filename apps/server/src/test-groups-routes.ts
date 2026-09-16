/**
 * Test Suite: Groups and Convenor Moderation Route Handlers
 *
 * Verifies HTTP routing, parameter extraction, and authorization for /api/groups/* routes.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db, initSchema } from './db/db.js';
import { createPost } from './state-engine.js';
import { createGroupRoutes } from './routes/groups.js';

let passed = 0;
let run = 0;

function check(cond: boolean, msg: string) {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const pubkey = crypto.randomBytes(32).toString('hex');
    const uniqueCallsign = `${callsign}_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, earned_credit)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'bundled://sprout', 'active', 50)
    `).run(pubkey, uniqueCallsign);
    // Give member initial offer to satisfy covenant
    createPost('offer', 'other', `${callsign}'s Seed Offer`, 'Offer for covenant', 10, 'fixed', pubkey, undefined, undefined, [], false);
    return pubkey;
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    ctx.method = method;
    ctx.path = path;
    ctx.url = path;
    ctx.request = ctx.request || {};
    const middleware = router.routes();
    await middleware(ctx, async () => {});
    return ctx;
}

async function runRouteTests() {
    console.log('🧪 Starting Groups HTTP Routes Test Suite...\n');
    initSchema();

    const router = createGroupRoutes({
        checkAdminAuth: async () => true,
        rateLimit: () => true,
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });

    const alice = makeMember('AliceRoutes');
    const bob = makeMember('BobRoutes');
    const carol = makeMember('CarolRoutes');

    // 1. POST /api/groups - Unauthenticated request fails (401)
    {
        const ctx: any = {
            state: {},
            requestBody: { name: 'Test Group' }
        };
        await dispatch(router, 'POST', '/api/groups', ctx);
        check(ctx.status === 401, '1. Unauthenticated POST /api/groups returns 401');
    }

    // 2. POST /api/groups - Authenticated request succeeds (201)
    let groupId: string = '';
    {
        const ctx: any = {
            state: { actor: alice },
            requestBody: {
                name: 'Byron Guild',
                description: 'Local makers',
                category: 'guild',
                joinPolicy: 'request_to_join'
            }
        };
        await dispatch(router, 'POST', '/api/groups', ctx);
        check(ctx.status === 201, '2a. Authenticated POST /api/groups returns 201');
        check(ctx.body?.name === 'Byron Guild', '2b. Response body has group name');
        check(ctx.body?.createdBy === alice, '2c. Group creator is alice');
        check(ctx.body?.memberCount === 1, '2d. Creator is automatically member count 1');
        groupId = ctx.body.id;
    }

    // 3. GET /api/groups - Public listing & ETag handling
    let listingEtag = '';
    {
        const headers: Record<string, string> = {};
        const ctx: any = {
            query: { category: 'guild' },
            state: {},
            set: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
            get: (k: string) => headers[k.toLowerCase()]
        };
        await dispatch(router, 'GET', '/api/groups', ctx);
        check(ctx.status === 200, '3a. GET /api/groups returns 200');
        check(Array.isArray(ctx.body) && ctx.body.some((g: any) => g.id === groupId), '3b. Listing contains created group');
        listingEtag = headers['etag'];
        check(!!listingEtag, '3c. GET /api/groups emits ETag');
    }

    // 3d. Conditional GET with matching ETag returns 304
    {
        const ctx: any = {
            query: { category: 'guild' },
            state: {},
            set: () => {},
            get: (k: string) => k.toLowerCase() === 'if-none-match' ? listingEtag : undefined
        };
        await dispatch(router, 'GET', '/api/groups', ctx);
        check(ctx.status === 304, '3d. GET /api/groups with matching ETag returns 304');
    }

    // 3e. Conditional GET with multi-value If-None-Match returns 304
    {
        const ctx: any = {
            query: { category: 'guild' },
            state: {},
            set: () => {},
            get: (k: string) => k.toLowerCase() === 'if-none-match' ? `"dummy-1", ${listingEtag}, "dummy-2"` : undefined
        };
        await dispatch(router, 'GET', '/api/groups', ctx);
        check(ctx.status === 304, '3e. GET /api/groups with multi-value If-None-Match returns 304');
    }

    // 3f. Conditional GET with partial substring does not match (returns 200)
    {
        const partial = listingEtag.slice(3, -3);
        const ctx: any = {
            query: { category: 'guild' },
            state: {},
            set: () => {},
            get: (k: string) => k.toLowerCase() === 'if-none-match' ? `"${partial}"` : undefined
        };
        await dispatch(router, 'GET', '/api/groups', ctx);
        check(ctx.status === 200, '3f. GET /api/groups with partial substring does not match (returns 200)');
    }

    // 4. GET /api/groups/:id - Single group lookup
    {
        const ctx: any = {
            state: { actor: alice }
        };
        await dispatch(router, 'GET', `/api/groups/${groupId}`, ctx);
        check(ctx.status === 200, '4a. GET /api/groups/:id returns 200');
        check(ctx.body?.id === groupId, '4b. Correct group returned');
        check(ctx.body?.viewerRole === 'convenor', '4c. Viewer role is convenor for alice');
    }

    // 5. POST /api/groups/:id/join - Bob requests to join (request_to_join policy)
    {
        const ctx: any = {
            state: { actor: bob }
        };
        await dispatch(router, 'POST', `/api/groups/${groupId}/join`, ctx);
        check(ctx.status === 200, '5a. POST /api/groups/:id/join returns 200');
        check(ctx.body?.member?.status === 'pending_approval', '5b. Bob status is pending_approval');
    }

    // 6. POST /api/groups/:id/members - Convenor Alice approves Bob
    {
        // Stranger Carol attempts to approve -> 403
        const ctxCarol: any = {
            state: { actor: carol },
            requestBody: { memberPubkey: bob, action: 'approve' }
        };
        await dispatch(router, 'POST', `/api/groups/${groupId}/members`, ctxCarol);
        check(ctxCarol.status === 403, '6a. Non-convenor cannot approve member (403)');

        // Convenor Alice approves
        const ctxAlice: any = {
            state: { actor: alice },
            requestBody: { memberPubkey: bob, action: 'approve' }
        };
        await dispatch(router, 'POST', `/api/groups/${groupId}/members`, ctxAlice);
        check(ctxAlice.status === 200, '6b. Convenor approves member (200)');
        check(ctxAlice.body?.member?.status === 'active', '6c. Bob status is now active');
    }

    // 7. GET /api/groups/:id/members - List members
    {
        const ctx: any = {
            query: {}
        };
        await dispatch(router, 'GET', `/api/groups/${groupId}/members`, ctx);
        check(ctx.status === 200, '7a. GET /api/groups/:id/members returns 200');
        check(ctx.body.length === 2, '7b. Two active members returned');
    }

    // 8. PATCH /api/groups/:id/members/:pubkey - Change member role
    {
        // Non-convenor Carol tries to promote -> 403
        const ctxCarol: any = {
            state: { actor: carol },
            requestBody: { role: 'convenor' }
        };
        await dispatch(router, 'PATCH', `/api/groups/${groupId}/members/${bob}`, ctxCarol);
        check(ctxCarol.status === 403, '8a. Non-convenor cannot change roles (403)');

        // Convenor Alice promotes Bob to convenor
        const ctxAlice: any = {
            state: { actor: alice },
            requestBody: { role: 'convenor' }
        };
        await dispatch(router, 'PATCH', `/api/groups/${groupId}/members/${bob}`, ctxAlice);
        check(ctxAlice.status === 200, '8b. Convenor promotes Bob to convenor (200)');
        check(ctxAlice.body?.member?.role === 'convenor', '8c. Bob is now convenor');
    }

    // 9. PATCH /api/groups/:id - Update group details
    {
        const ctx: any = {
            state: { actor: alice },
            requestBody: { description: 'Updated description by convenor' }
        };
        await dispatch(router, 'PATCH', `/api/groups/${groupId}`, ctx);
        check(ctx.status === 200, '9a. Convenor updates group details (200)');
        check(ctx.body?.group?.description === 'Updated description by convenor', '9b. Description updated');
    }

    // 10. DELETE /api/groups/:id/posts/:postId - Convenor deletes post in group
    {
        const post = createPost('offer', 'tools', 'Guild Chisel', 'Fine woodworking chisel', 5, 'fixed', bob, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: groupId });
        check(!!post, '10a. Group post created for moderation test');

        // Stranger Carol tries to delete post in group -> 403
        const ctxCarol: any = {
            state: { actor: carol }
        };
        await dispatch(router, 'DELETE', `/api/groups/${groupId}/posts/${post!.id}`, ctxCarol);
        check(ctxCarol.status === 403, '10b. Non-convenor cannot delete group post (403)');

        // Convenor Alice deletes Bob's post in group
        const ctxAlice: any = {
            state: { actor: alice }
        };
        await dispatch(router, 'DELETE', `/api/groups/${groupId}/posts/${post!.id}`, ctxAlice);
        check(ctxAlice.status === 200, '10c. Convenor deletes group post (200)');
        check(ctxAlice.body?.success === true, '10d. Success is true');
    }

    // 11. DELETE /api/groups/:id/members/:pubkey - Member leaves group
    {
        const ctxBob: any = {
            state: { actor: bob }
        };
        await dispatch(router, 'DELETE', `/api/groups/${groupId}/members/${bob}`, ctxBob);
        check(ctxBob.status === 200, '11a. Member can remove themselves / leave group (200)');
        check(ctxBob.body?.success === true, '11b. Success is true');
    }

    console.log(`\n🎉 All ${passed}/${run} route tests passed successfully!`);
}

runRouteTests().catch(err => {
    console.error('Route test runner failed:', err);
    process.exit(1);
});
