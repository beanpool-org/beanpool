/**
 * Test Suite: In-Memory ETag Short-Circuiting and Invalidation
 *
 * Verifies that:
 * 1. GET /api/marketplace/posts, GET /api/community/members, and GET /api/members
 *    emit weak ETags and a max-age=0, must-revalidate Cache-Control — `private` for
 *    /api/marketplace/posts, which varies by viewer, `public` for the members lists, which
 *    do not.
 * 2. When If-None-Match matches, all three endpoints return 304 Not Modified immediately
 *    WITHOUT executing SQLite queries against posts or members tables and without serializing JSON.
 * 3. Any mutation (createPost, updatePost, pausePost, resumePost, removePost,
 *    registerMember, updateProfile) bumps the respective version counter.
 * 4. After a mutation, a conditional GET with the previous ETag receives 200 OK
 *    with fresh data and an updated ETag.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createPost, updatePost, pausePost, resumePost, removePost,
    generateInvite, redeemInvite, updateProfile, getPostsVersion, getMembersVersion,
    bumpPostsVersion, bumpMembersVersion
} from './state-engine.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createCommunityRoutes } from './routes/community.js';
import type { RouteDeps } from './routes/types.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

const deps: RouteDeps = {
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (v: unknown, def = 20) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : def;
    },
    clampOffset: (v: unknown, def = 0) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : def;
    },
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

async function dispatchRoute(
    router: any,
    method: string,
    url: string,
    ctxProps: Record<string, any> = {}
): Promise<{ status: number; body: any; headers: Record<string, string>; type?: string }> {
    const urlObj = new URL(url, 'http://localhost');
    const headers: Record<string, string> = { ...(ctxProps.headers || {}) };
    const query: Record<string, string> = {};
    urlObj.searchParams.forEach((v, k) => { query[k] = v; });

    const ctx: any = {
        method,
        path: urlObj.pathname,
        url,
        querystring: urlObj.search ? urlObj.search.slice(1) : '',
        query,
        params: {},
        headers,
        status: 200,
        body: undefined,
        type: undefined,
        state: ctxProps.state || {},
        requestBody: ctxProps.requestBody || {},
        get: (h: string) => headers[h.toLowerCase()] || undefined,
        set: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
        ...ctxProps,
    };

    const routes = router.stack || [];
    for (const r of routes) {
        if (r.methods.includes(method.toUpperCase())) {
            const match = r.regexp.exec(urlObj.pathname);
            if (match) {
                const params: Record<string, string> = {};
                if (r.paramNames && Array.isArray(r.paramNames)) {
                    r.paramNames.forEach((p: any, i: number) => {
                        params[p.name] = match[i + 1];
                    });
                }
                ctx.params = params;
                const fns = r.stack || [];
                let idx = 0;
                const next = async () => {
                    if (idx < fns.length) {
                        const fn = fns[idx++];
                        await fn(ctx, next);
                    }
                };
                await next();
                break;
            }
        }
    }

    return {
        status: ctx.status,
        body: ctx.body,
        headers,
        type: ctx.type,
    };
}

async function main() {
    console.log('=== ETag Short-Circuit & Mutation Invalidation Test Suite ===\n');

    initStateEngine();
    const marketplaceRouter = createMarketplaceRoutes(deps);
    const communityRouter = createCommunityRoutes(deps);

    // Setup a test member author with a fresh random pubkey and unique callsign
    const authorPk = crypto.randomBytes(32).toString('hex');
    const authorCallsign = 'EtagTester_' + crypto.randomBytes(4).toString('hex');
    db.prepare("INSERT INTO members (public_key, callsign, joined_at, avatar_url) VALUES (?, ?, ?, ?)").run(
        authorPk, authorCallsign, new Date().toISOString(), 'bundled://seed'
    );

    // Intercept db.prepare to track SQL queries on 'posts' and 'members'
    let postsQueries = 0;
    let membersQueries = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = function (sql: string) {
        if (sql.includes('FROM posts') || sql.includes('FROM (SELECT * FROM posts')) {
            postsQueries++;
        }
        if (sql.includes('FROM members')) {
            membersQueries++;
        }
        return realPrepare(sql);
    } as any;

    // =========================================================================
    // SECTION 1: GET /api/marketplace/posts
    // =========================================================================
    console.log('--- Section 1: GET /api/marketplace/posts ---');

    postsQueries = 0;
    const res1 = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts');
    assert(res1.status === 200, 'Initial GET /api/marketplace/posts returns 200');
    assert(postsQueries > 0, `Initial 200 touched SQLite posts table (${postsQueries} query)`);
    assert(!!res1.headers['etag'], `Initial response returned ETag: ${res1.headers['etag']}`);
    assert(res1.headers['etag'].startsWith('W/"'), `ETag is weak (starts with W/"): ${res1.headers['etag']}`);
    assert(res1.headers['cache-control'] === 'private, max-age=0, must-revalidate',
        `Cache-Control is private (posts vary by viewer) (got: ${res1.headers['cache-control']})`);

    const etag1 = res1.headers['etag'];

    // 1.2 Matching ETag -> 304 WITHOUT TOUCHING SQLITE
    postsQueries = 0;
    const res304 = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts', {
        headers: { 'if-none-match': etag1 },
    });
    assert(res304.status === 304, 'Conditional GET /api/marketplace/posts with matching ETag returns 304');
    assert(res304.body === undefined, '304 response has empty body');
    assert(res304.headers['cache-control'] === 'private, max-age=0, must-revalidate',
        '304 response preserves Cache-Control header');
    assert(res304.headers['etag'] === etag1, '304 response preserves ETag header');
    assert(postsQueries === 0, `304 short-circuit executed ZERO queries on posts table (actual: ${postsQueries})`);

    // 1.3 Mutation: createPost bumps postsVersion
    const vBeforeCreate = getPostsVersion();
    const newPost = createPost('offer', 'tools', 'Garden Rake', 'Sturdy rake', 5, 'fixed', authorPk);
    assert(!!newPost, 'Created test post successfully');
    const vAfterCreate = getPostsVersion();
    assert(vAfterCreate > vBeforeCreate, `createPost bumped postsVersion (${vBeforeCreate} -> ${vAfterCreate})`);

    // 1.4 Request with old ETag returns 200 with new post
    postsQueries = 0;
    const res2 = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts', {
        headers: { 'if-none-match': etag1 },
    });
    assert(res2.status === 200, 'GET with stale ETag after createPost returns 200');
    assert(postsQueries > 0, `200 response re-queried SQLite (${postsQueries} query)`);
    const etag2 = res2.headers['etag'];
    assert(etag2 !== etag1, `New response has distinct ETag (${etag1} !== ${etag2})`);
    const postsList: any[] = JSON.parse(res2.body);
    assert(postsList.some((p: any) => p.title === 'Garden Rake'), 'Response contains freshly created post');

    // 1.5 Mutation: updatePost bumps postsVersion
    const vBeforeUpdate = getPostsVersion();
    updatePost(newPost!.id, authorPk, { title: 'Heavy Duty Rake' });
    const vAfterUpdate = getPostsVersion();
    assert(vAfterUpdate > vBeforeUpdate, `updatePost bumped postsVersion (${vBeforeUpdate} -> ${vAfterUpdate})`);

    // 1.6 Mutation: pausePost and resumePost bump postsVersion
    const vBeforePause = getPostsVersion();
    pausePost(newPost!.id, authorPk);
    const vAfterPause = getPostsVersion();
    assert(vAfterPause > vBeforePause, `pausePost bumped postsVersion (${vBeforePause} -> ${vAfterPause})`);

    const vBeforeResume = getPostsVersion();
    resumePost(newPost!.id, authorPk);
    const vAfterResume = getPostsVersion();
    assert(vAfterResume > vBeforeResume, `resumePost bumped postsVersion (${vBeforeResume} -> ${vAfterResume})`);

    // 1.7 Mutation: removePost bumps postsVersion
    const vBeforeRemove = getPostsVersion();
    removePost(newPost!.id, authorPk);
    const vAfterRemove = getPostsVersion();
    assert(vAfterRemove > vBeforeRemove, `removePost bumped postsVersion (${vBeforeRemove} -> ${vAfterRemove})`);

    // =========================================================================
    // SECTION 2: GET /api/community/members
    // =========================================================================
    console.log('\n--- Section 2: GET /api/community/members ---');

    membersQueries = 0;
    const mRes1 = await dispatchRoute(communityRouter, 'GET', '/api/community/members');
    assert(mRes1.status === 200, 'Initial GET /api/community/members returns 200');
    assert(membersQueries > 0, `Initial 200 touched SQLite members table (${membersQueries} query)`);
    const mEtag1 = mRes1.headers['etag'];
    assert(!!mEtag1 && mEtag1.startsWith('W/"'), `Returned weak ETag: ${mEtag1}`);
    assert(mRes1.headers['cache-control'] === 'public, max-age=0, must-revalidate',
        `Cache-Control header is public, max-age=0, must-revalidate (got: ${mRes1.headers['cache-control']})`);

    // 2.2 Matching ETag -> 304 WITHOUT TOUCHING SQLITE
    membersQueries = 0;
    const mRes304 = await dispatchRoute(communityRouter, 'GET', '/api/community/members', {
        headers: { 'if-none-match': mEtag1 },
    });
    assert(mRes304.status === 304, 'Conditional GET /api/community/members with matching ETag returns 304');
    assert(mRes304.body === undefined, '304 response has empty body');
    assert(membersQueries === 0, `304 short-circuit executed ZERO queries on members table (actual: ${membersQueries})`);

    // 2.3 Mutation: redeemInvite bumps membersVersion
    const inv = generateInvite(authorPk);
    assert(!!inv, 'Generated invite successfully');
    const vBeforeJoin = getMembersVersion();
    const newMemberPk = crypto.randomBytes(32).toString('hex');
    const joinerCallsign = 'Joiner_' + crypto.randomBytes(4).toString('hex');
    const joinRes = redeemInvite(inv!.code, newMemberPk, joinerCallsign);
    assert(joinRes.success === true, 'Successfully joined via invite');
    const vAfterJoin = getMembersVersion();
    assert(vAfterJoin > vBeforeJoin, `redeemInvite bumped membersVersion (${vBeforeJoin} -> ${vAfterJoin})`);

    // 2.4 Stale ETag -> returns 200 with new member
    membersQueries = 0;
    const mRes2 = await dispatchRoute(communityRouter, 'GET', '/api/community/members', {
        headers: { 'if-none-match': mEtag1 },
    });
    assert(mRes2.status === 200, 'GET /api/community/members with stale ETag returns 200');
    assert(membersQueries > 0, `200 response re-queried SQLite (${membersQueries} query)`);
    const mEtag2 = mRes2.headers['etag'];
    assert(mEtag2 !== mEtag1, `New response has distinct ETag (${mEtag1} !== ${mEtag2})`);
    const membersList: any[] = JSON.parse(mRes2.body);
    assert(membersList.some((m: any) => m.callsign === joinerCallsign), 'Response contains freshly registered member');

    // 2.5 Mutation: updateProfile bumps membersVersion and postsVersion
    const vMemsBeforeProf = getMembersVersion();
    const vPostsBeforeProf = getPostsVersion();
    updateProfile(newMemberPk, { bio: 'A wonderful green thumb' });
    const vMemsAfterProf = getMembersVersion();
    const vPostsAfterProf = getPostsVersion();
    assert(vMemsAfterProf > vMemsBeforeProf, `updateProfile bumped membersVersion (${vMemsBeforeProf} -> ${vMemsAfterProf})`);
    assert(vPostsAfterProf > vPostsBeforeProf, `updateProfile bumped postsVersion (${vPostsBeforeProf} -> ${vPostsAfterProf})`);

    // =========================================================================
    // SECTION 3: GET /api/members
    // =========================================================================
    console.log('\n--- Section 3: GET /api/members ---');

    membersQueries = 0;
    const apiMemRes1 = await dispatchRoute(communityRouter, 'GET', '/api/members');
    assert(apiMemRes1.status === 200, 'Initial GET /api/members returns 200');
    assert(membersQueries > 0, `Initial 200 touched SQLite members table (${membersQueries} query)`);
    const apiMemEtag1 = apiMemRes1.headers['etag'];
    assert(!!apiMemEtag1 && apiMemEtag1.startsWith('W/"'), `Returned weak ETag: ${apiMemEtag1}`);
    assert(apiMemRes1.headers['cache-control'] === 'public, max-age=0, must-revalidate',
        `Cache-Control header is public, max-age=0, must-revalidate (got: ${apiMemRes1.headers['cache-control']})`);

    // 3.2 Matching ETag -> 304 without query
    membersQueries = 0;
    const apiMemRes304 = await dispatchRoute(communityRouter, 'GET', '/api/members', {
        headers: { 'if-none-match': apiMemEtag1 },
    });
    assert(apiMemRes304.status === 304, 'Conditional GET /api/members with matching ETag returns 304');
    assert(apiMemRes304.body === undefined, '304 response has empty body');
    assert(membersQueries === 0, `304 short-circuit executed ZERO queries on members table (actual: ${membersQueries})`);

    // 3.3 Query parameter variation creates distinct ETag
    const apiMemWithParam = await dispatchRoute(communityRouter, 'GET', '/api/members?updatedAfter=2026-01-01T00:00:00.000Z');
    assert(apiMemWithParam.status === 200, 'GET /api/members?updatedAfter=... returns 200');
    const apiMemParamEtag = apiMemWithParam.headers['etag'];
    assert(apiMemParamEtag !== apiMemEtag1, `Query string partitioned ETag (${apiMemEtag1} !== ${apiMemParamEtag})`);

    console.log(`\nETag Short-Circuit Summary: ${passed}/${run} assertions passed.`);
    if (passed < run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
