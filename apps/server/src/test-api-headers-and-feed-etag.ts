/**
 * Test Suite: API Header Optimization & Activity Feed ETag Short-Circuiting
 *
 * Verifies:
 * 1. Document-only security headers (Content-Security-Policy, X-Frame-Options, X-XSS-Protection)
 *    are NOT present on API responses (/api/*) or WebSocket paths (/ws/*).
 * 2. The HTML document (/app, /settings, /) and static assets still receive the full set of security headers.
 * 3. X-Content-Type-Options: nosniff and Strict-Transport-Security remain present on all responses,
 *    including API endpoints and /api/avatar/:pubkey.
 * 4. GET /api/activity/feed emits a weak ETag and Cache-Control: public, max-age=0, must-revalidate.
 * 5. Conditional GET /api/activity/feed with matching If-None-Match returns 304 without querying SQLite.
 * 6. Every enumerated write path to the activity feed bumps activityVersion:
 *    - recordActivity('member_joined')
 *    - recordActivity('post_created')
 *    - recordActivity('trade_completed')
 *    - recordActivity('rating_given')
 *    - pruneOldActivity()
 *    - broadcast('new_post')
 *    - broadcast('transaction_completed')
 *    - broadcast('member_joined')
 *    - broadcast('profile_updated')
 *    - broadcast('state_synced')
 *    - broadcast('user_pruned')
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine,
    broadcast,
    getActivityVersion,
    bumpActivityVersion
} from './state-engine.js';
import { db } from './db/db.js';
import { recordActivity, pruneOldActivity } from './db/activity-feed-db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8561;
const BASE = `https://localhost:${PORT}`;

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

async function main(): Promise<void> {
    console.log('=== API Header Optimization & Activity Feed ETag Test Suite ===\n');

    await initTls();
    initStateEngine();

    // Setup a test member author with an avatar
    const authorPk = crypto.randomBytes(32).toString('hex');
    const authorCallsign = 'HeaderTester_' + crypto.randomBytes(4).toString('hex');
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, avatar_url)
        VALUES (?, ?, ?, ?)
    `).run(authorPk, authorCallsign, new Date().toISOString(), 'bundled://seed');

    // Start real HTTPS server
    await startHttpsServer(PORT);

    // =========================================================================
    // SECTION 1: Security Headers on API vs Document/Static Paths
    // =========================================================================
    console.log('--- Section 1: Security Headers Verification ---');

    // 1.1 /api/activity/feed
    const feedRes = await fetch(`${BASE}/api/activity/feed`);
    assert(feedRes.status === 200, 'GET /api/activity/feed returns 200');
    assert(!feedRes.headers.has('content-security-policy'),
        'API route (/api/activity/feed) does NOT include Content-Security-Policy');
    assert(!feedRes.headers.has('x-frame-options'),
        'API route (/api/activity/feed) does NOT include X-Frame-Options');
    assert(!feedRes.headers.has('x-xss-protection'),
        'API route (/api/activity/feed) does NOT include X-XSS-Protection');
    assert(feedRes.headers.get('x-content-type-options') === 'nosniff',
        'API route preserves X-Content-Type-Options: nosniff');
    assert(feedRes.headers.has('strict-transport-security'),
        'API route preserves Strict-Transport-Security');

    // 1.2 /api/avatar/:pubkey
    const avatarRes = await fetch(`${BASE}/api/avatar/${authorPk}`);
    assert(!avatarRes.headers.has('content-security-policy'),
        'Avatar route (/api/avatar/:pubkey) does NOT include Content-Security-Policy');
    assert(!avatarRes.headers.has('x-frame-options'),
        'Avatar route does NOT include X-Frame-Options');
    assert(!avatarRes.headers.has('x-xss-protection'),
        'Avatar route does NOT include X-XSS-Protection');
    assert(avatarRes.headers.get('x-content-type-options') === 'nosniff',
        'Avatar route preserves X-Content-Type-Options: nosniff');
    assert(avatarRes.headers.has('strict-transport-security'),
        'Avatar route preserves Strict-Transport-Security');

    // 1.3 /api/community/members
    const membersRes = await fetch(`${BASE}/api/community/members`);
    assert(!membersRes.headers.has('content-security-policy'),
        'Directory route (/api/community/members) does NOT include Content-Security-Policy');
    assert(membersRes.headers.get('x-content-type-options') === 'nosniff',
        'Directory route preserves X-Content-Type-Options: nosniff');

    // 1.4 HTML Document (/app and /settings) MUST still receive full security headers
    const appDocRes = await fetch(`${BASE}/app`);
    assert(appDocRes.headers.has('content-security-policy'),
        'HTML document (/app) DOES receive Content-Security-Policy');
    assert(appDocRes.headers.get('x-frame-options') === 'DENY',
        'HTML document (/app) receives X-Frame-Options: DENY');
    assert(appDocRes.headers.get('x-xss-protection') === '1; mode=block',
        'HTML document (/app) receives X-XSS-Protection: 1; mode=block');
    assert(appDocRes.headers.get('x-content-type-options') === 'nosniff',
        'HTML document (/app) receives X-Content-Type-Options: nosniff');
    assert(appDocRes.headers.has('strict-transport-security'),
        'HTML document (/app) receives Strict-Transport-Security');

    const settingsDocRes = await fetch(`${BASE}/settings`);
    assert(settingsDocRes.headers.has('content-security-policy'),
        'HTML document (/settings) DOES receive Content-Security-Policy');
    assert(settingsDocRes.headers.get('x-frame-options') === 'DENY',
        'HTML document (/settings) receives X-Frame-Options: DENY');

    // =========================================================================
    // SECTION 2: Activity Feed ETag and 304 Short-Circuiting (Zero SQLite Queries)
    // =========================================================================
    console.log('\n--- Section 2: Activity Feed ETag & 304 Short-Circuiting ---');

    // Intercept db.prepare to count queries on activity_feed
    let activityQueries = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = function (sql: string) {
        if (sql.includes('FROM activity_feed')) {
            activityQueries++;
        }
        return realPrepare(sql);
    } as any;

    activityQueries = 0;
    const initialFeed = await fetch(`${BASE}/api/activity/feed`);
    assert(initialFeed.status === 200, 'Initial feed fetch returned 200');
    assert(activityQueries > 0, `Initial feed fetch queried SQLite activity_feed (${activityQueries} query)`);
    const initialEtag = initialFeed.headers.get('etag');
    assert(!!initialEtag && initialEtag.startsWith('W/"activity-feed-'),
        `Emitted weak ETag with proper prefix: ${initialEtag}`);
    assert(initialFeed.headers.get('cache-control') === 'public, max-age=0, must-revalidate',
        `Cache-Control is public, max-age=0, must-revalidate (got: ${initialFeed.headers.get('cache-control')})`);

    // Conditional GET with matching If-None-Match
    activityQueries = 0;
    const conditionalRes = await fetch(`${BASE}/api/activity/feed`, {
        headers: { 'If-None-Match': initialEtag! },
    });
    assert(conditionalRes.status === 304, 'Conditional GET with matching ETag returns 304');
    const textBody = await conditionalRes.text();
    assert(textBody === '', '304 response body is completely empty (0 bytes)');
    assert(conditionalRes.headers.get('cache-control') === 'public, max-age=0, must-revalidate',
        '304 response preserves Cache-Control');
    assert(conditionalRes.headers.get('etag') === initialEtag,
        '304 response preserves ETag');
    assert(activityQueries === 0,
        `304 short-circuit executed ZERO SQLite queries on activity_feed (actual: ${activityQueries})`);

    // Varying query parameters create distinct ETags
    const limitFeed = await fetch(`${BASE}/api/activity/feed?limit=10&offset=0`);
    const limitEtag = limitFeed.headers.get('etag');
    assert(limitEtag !== initialEtag, `Limit parameter partitioned ETag (${initialEtag} !== ${limitEtag})`);

    const offsetFeed = await fetch(`${BASE}/api/activity/feed?limit=10&offset=5`);
    const offsetEtag = offsetFeed.headers.get('etag');
    assert(offsetEtag !== limitEtag, `Offset parameter partitioned ETag (${limitEtag} !== ${offsetEtag})`);

    // =========================================================================
    // SECTION 3: Enumerated Write Paths & Version Bumping
    // =========================================================================
    console.log('\n--- Section 3: Write Path Enumeration & Version Bumping ---');

    // 3.1 recordActivity write paths
    const v0 = getActivityVersion();
    recordActivity('member_joined', authorPk, null, { callsign: authorCallsign });
    const v1 = getActivityVersion();
    assert(v1 > v0, `recordActivity('member_joined') bumped activityVersion (${v0} -> ${v1})`);

    recordActivity('post_created', authorPk, null, { title: 'Test Post', credits: 10 });
    const v2 = getActivityVersion();
    assert(v2 > v1, `recordActivity('post_created') bumped activityVersion (${v1} -> ${v2})`);

    const peerPk = crypto.randomBytes(32).toString('hex');
    recordActivity('trade_completed', authorPk, peerPk, { amount: 5 });
    const v3 = getActivityVersion();
    assert(v3 > v2, `recordActivity('trade_completed') bumped activityVersion (${v2} -> ${v3})`);

    recordActivity('rating_given', authorPk, peerPk, { stars: 5 });
    const v4 = getActivityVersion();
    assert(v4 > v3, `recordActivity('rating_given') bumped activityVersion (${v3} -> ${v4})`);

    // 3.2 pruneOldActivity write path
    db.prepare(`
        INSERT INTO activity_feed (event_type, actor_pubkey, created_at)
        VALUES ('member_joined', ?, '2020-01-01T00:00:00.000Z')
    `).run(authorPk);
    const vBeforePrune = getActivityVersion();
    const pruned = pruneOldActivity(30);
    assert(pruned > 0, `pruneOldActivity pruned test rows (${pruned})`);
    const vAfterPrune = getActivityVersion();
    assert(vAfterPrune > vBeforePrune, `pruneOldActivity bumped activityVersion (${vBeforePrune} -> ${vAfterPrune})`);

    // 3.3 Central broadcast() write paths
    const vBeforeNewPost = getActivityVersion();
    broadcast({ type: 'new_post', post: { id: 'post-1' } });
    assert(getActivityVersion() > vBeforeNewPost, 'broadcast(new_post) bumped activityVersion');

    const vBeforeTxComp = getActivityVersion();
    broadcast({ type: 'transaction_completed', transaction: { id: 'tx-1' } });
    assert(getActivityVersion() > vBeforeTxComp, 'broadcast(transaction_completed) bumped activityVersion');

    const vBeforeMemJoin = getActivityVersion();
    broadcast({ type: 'member_joined', member: { public_key: peerPk } });
    assert(getActivityVersion() > vBeforeMemJoin, 'broadcast(member_joined) bumped activityVersion');

    const vBeforeProfUp = getActivityVersion();
    broadcast({ type: 'profile_updated', publicKey: authorPk });
    assert(getActivityVersion() > vBeforeProfUp, 'broadcast(profile_updated) bumped activityVersion');

    const vBeforeStateSync = getActivityVersion();
    broadcast({ type: 'state_synced' });
    assert(getActivityVersion() > vBeforeStateSync, 'broadcast(state_synced) bumped activityVersion');

    const vBeforeUserPrune = getActivityVersion();
    broadcast({ type: 'user_pruned', publicKey: peerPk });
    assert(getActivityVersion() > vBeforeUserPrune, 'broadcast(user_pruned) bumped activityVersion');

    // 3.4 After mutation, old ETag now invalidates (returns 200 with new ETag)
    activityQueries = 0;
    const invalidatedFeed = await fetch(`${BASE}/api/activity/feed`, {
        headers: { 'If-None-Match': initialEtag! },
    });
    assert(invalidatedFeed.status === 200, 'GET /api/activity/feed with stale ETag returns 200 OK');
    assert(activityQueries > 0, `Stale ETag re-queried SQLite (${activityQueries} query)`);
    const newEtag = invalidatedFeed.headers.get('etag');
    assert(newEtag !== initialEtag, `Fresh response has distinct ETag (${initialEtag} !== ${newEtag})`);

    console.log(`\nAll API header & feed ETag tests passed: ${passed}/${run} assertions.\n`);
    if (passed < run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
