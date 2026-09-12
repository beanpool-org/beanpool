/**
 * Automated Test Suite: Avatar Endpoint & List Payload Optimization.
 *
 * Requirements & Assertions:
 * 1. GET /api/community/members does NOT inline base64 data:image URIs.
 * 2. GET /api/marketplace/posts does NOT inline base64 data:image URIs.
 * 3. Both list endpoints return strong ETag and honor If-None-Match with 304 and empty body.
 * 4. GET /api/avatar/:pubkey serves binary image bytes with image/jpeg and strong ETag.
 * 5. GET /api/avatar/:pubkey?size=thumb serves full image bytes (reserved thumb param).
 * 6. Avatar endpoint returns 304 for matching If-None-Match.
 * 7. Bundled avatars (bundled://) are passed through unchanged in both lists.
 * 8. In-memory LRU cache functions correctly.
 * 9. Measure and report before vs after byte sizes of BOTH /api/community/members and /api/marketplace/posts.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db/db.js';
import { initStateEngine, createPost } from './state-engine.js';
import { createAvatarRoutes } from './routes/avatar.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createCommunityRoutes } from './routes/community.js';
import { getAvatarService, AvatarService, AvatarCache } from './engine/avatar.js';
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
    // Same shape as test-keeper-pending-route.ts — RouteDeps requires these two.
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

/**
 * Creates a valid minimal JPEG byte buffer padded out to approximately targetSize bytes
 * to simulate realistic member avatar photographic payloads without native image libraries.
 */
function createTestJpegBuffer(targetSize = 47000): Buffer {
    // Standard minimal JPEG structure
    const jpegHeader = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, // APP0 JFIF
        0xff, 0xdb, 0x00, 0x43, 0x00, // DQT
        ...Array(64).fill(0x08),
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00, // SOF0 (512x512)
        0xff, 0xc4, 0x00, 0x1f, 0x00, // DHT
        0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array(12).fill(0x01),
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00 // SOS
    ]);
    const jpegTrailer = Buffer.from([0xff, 0xd9]); // EOI

    const paddingLength = Math.max(0, targetSize - jpegHeader.length - jpegTrailer.length);
    // Fill padding with pseudo-entropy that doesn't contain 0xFF
    const padding = Buffer.alloc(paddingLength);
    for (let i = 0; i < paddingLength; i++) {
        padding[i] = (i % 254) + 1;
    }

    return Buffer.concat([jpegHeader, padding, jpegTrailer]);
}

async function main() {
    console.log('=== Avatar Endpoint & List Payload Optimization Test Suite ===\n');

    // 1. Setup temporary database & storage
    const tmpDataDir = path.join(process.cwd(), 'data', 'test-avatars-' + Date.now());
    fs.mkdirSync(tmpDataDir, { recursive: true });
    process.env.BEANPOOL_DATA_DIR = tmpDataDir;

    await initStateEngine();

    const avatarService = new AvatarService();
    const avatarRouter = createAvatarRoutes({ ...deps, avatarService });
    const marketplaceRouter = createMarketplaceRoutes(deps);
    const communityRouter = createCommunityRoutes(deps);

    // 2. Create sample ~47 KB JPEG avatar (simulating 512x512 avatar)
    const sampleJpegBuffer = createTestJpegBuffer(47 * 1024);
    const sampleBase64DataUri = `data:image/jpeg;base64,${sampleJpegBuffer.toString('base64')}`;
    console.log(`[Setup] Sample JPEG avatar: ${sampleJpegBuffer.length} bytes (base64 URI: ${sampleBase64DataUri.length} chars)`);

    // 3. Seed test members:
    const pkPhoto = 'a'.repeat(64);
    const pkBundled = 'b'.repeat(64);
    const pkNone = 'c'.repeat(64);

    // Clean up any test records from prior runs
    db.prepare("DELETE FROM posts WHERE author_pubkey IN (?, ?, ?)").run(pkPhoto, pkBundled, pkNone);
    db.prepare("DELETE FROM members WHERE public_key IN (?, ?, ?)").run(pkPhoto, pkBundled, pkNone);

    // Member 1: Photographic JPEG data URI
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
        VALUES (?, 'AlicePhoto', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(pkPhoto, sampleBase64DataUri);

    // Member 2: Bundled avatar
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
        VALUES (?, 'BobBundled', 'bundled://leaf', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(pkBundled);

    // Member 3: No avatar
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
        VALUES (?, 'CharlieNone', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(pkNone);

    // Seed marketplace posts for these members
    createPost('offer', 'tools', 'Shovel for lending', 'Good garden shovel', 10, 'fixed', pkPhoto);
    createPost('offer', 'food', 'Fresh apples', '5kg organic apples', 5, 'fixed', pkBundled);
    db.prepare(`INSERT OR REPLACE INTO posts (
        id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status
    ) VALUES ('test-post-none-1', 'offer', 'transport', 'Ride to market', 'Saturday morning', 15, 'fixed', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, 'active')`).run(pkNone);

    // =========================================================================
    // SECTION 1: GET /api/community/members List Optimization & ETag
    // =========================================================================
    console.log('\n--- Section 1: GET /api/community/members ---');

    const membersRes = await dispatchRoute(communityRouter, 'GET', '/api/community/members');
    assert(membersRes.status === 200, 'GET /api/community/members returns 200');

    const membersJson = typeof membersRes.body === 'string' ? membersRes.body : JSON.stringify(membersRes.body);
    assert(!membersJson.includes('data:image'), 'GET /api/community/members does NOT contain "data:image"');

    const parsedMembers = JSON.parse(membersJson);
    const photoMember = parsedMembers.find((m: any) => m.publicKey === pkPhoto);
    const bundledMember = parsedMembers.find((m: any) => m.publicKey === pkBundled);
    const noneMember = parsedMembers.find((m: any) => m.publicKey === pkNone);

    assert(photoMember && photoMember.avatarUrl === `/api/avatar/${pkPhoto}?size=thumb`,
        `Member with photo avatar gets URL: /api/avatar/${pkPhoto}?size=thumb (got: ${photoMember?.avatarUrl})`);
    assert(bundledMember && bundledMember.avatarUrl === 'bundled://leaf',
        `Member with bundled avatar preserves bundled:// reference: ${bundledMember?.avatarUrl}`);
    assert(noneMember && noneMember.avatarUrl === null,
        `Member without avatar has null avatarUrl: ${noneMember?.avatarUrl}`);

    const membersEtag = membersRes.headers['etag'];
    assert(!!membersEtag && (membersEtag.startsWith('"') || membersEtag.startsWith('W/"')), `GET /api/community/members returns ETag: ${membersEtag}`);

    // Test ETag conditional 304 on /api/community/members
    const conditionalMembersRes = await dispatchRoute(communityRouter, 'GET', '/api/community/members', {
        headers: { 'if-none-match': membersEtag },
    });
    assert(conditionalMembersRes.status === 304, 'Conditional GET /api/community/members with matching ETag returns 304');
    assert(conditionalMembersRes.body === undefined, '304 response has empty body');

    // =========================================================================
    // SECTION 2: GET /api/marketplace/posts List Optimization & ETag
    // =========================================================================
    console.log('\n--- Section 2: GET /api/marketplace/posts ---');

    const postsRes = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts');
    assert(postsRes.status === 200, 'GET /api/marketplace/posts returns 200');

    const postsJson = typeof postsRes.body === 'string' ? postsRes.body : JSON.stringify(postsRes.body);
    assert(!postsJson.includes('data:image'), 'GET /api/marketplace/posts does NOT contain "data:image"');

    const parsedPosts = JSON.parse(postsJson);
    const photoPost = parsedPosts.find((p: any) => p.authorPublicKey === pkPhoto);
    const bundledPost = parsedPosts.find((p: any) => p.authorPublicKey === pkBundled);
    const nonePost = parsedPosts.find((p: any) => p.authorPublicKey === pkNone);

    assert(photoPost && photoPost.authorAvatarUrl === `/api/avatar/${pkPhoto}?size=thumb`,
        `Author with photo avatar gets URL: /api/avatar/${pkPhoto}?size=thumb (got: ${photoPost?.authorAvatarUrl})`);
    assert(bundledPost && bundledPost.authorAvatarUrl === 'bundled://leaf',
        `Author with bundled avatar preserves bundled:// reference: ${bundledPost?.authorAvatarUrl}`);
    assert(nonePost && nonePost.authorAvatarUrl === null,
        `Author without avatar has null authorAvatarUrl: ${nonePost?.authorAvatarUrl}`);

    const feedEtag = postsRes.headers['etag'];
    assert(!!feedEtag && (feedEtag.startsWith('"') || feedEtag.startsWith('W/"')), `GET /api/marketplace/posts returns ETag: ${feedEtag}`);

    // Test ETag conditional 304 on /api/marketplace/posts
    const conditionalPostsRes = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts', {
        headers: { 'if-none-match': feedEtag },
    });
    assert(conditionalPostsRes.status === 304, 'Conditional GET /api/marketplace/posts with matching ETag returns 304');
    assert(conditionalPostsRes.body === undefined, '304 response has empty body');

    // =========================================================================
    // SECTION 3: GET /api/avatar/:pubkey Endpoint (Full and Thumb)
    // =========================================================================
    console.log('\n--- Section 3: GET /api/avatar/:pubkey ---');

    // 3.1 Full size
    const fullRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=full`);
    assert(fullRes.status === 200, 'GET /api/avatar/:pubkey?size=full returns 200');
    assert(Buffer.isBuffer(fullRes.body), 'Body is binary Buffer');
    assert(fullRes.body.length === sampleJpegBuffer.length, `Full size matches stored bytes (${fullRes.body.length}B)`);
    assert(fullRes.type === 'image/jpeg', `Content-Type is image/jpeg (got: ${fullRes.type})`);
    // Deliberately NOT `immutable`: the emitted avatar URL carries no version, so an
    // immutable year-long cache would freeze a changed avatar in every client.
    assert(fullRes.headers['cache-control']?.includes('must-revalidate'), 'Cache-Control revalidates');
    assert(!fullRes.headers['cache-control']?.includes('immutable'), 'Cache-Control is not immutable');
    assert(fullRes.headers['x-content-type-options'] === 'nosniff', 'nosniff is set on the public avatar route');
    const fullEtag = fullRes.headers['etag'];
    assert(!!fullEtag && fullEtag.startsWith('"'), `Full avatar returns strong ETag: ${fullEtag}`);

    // Full size 304
    const full304 = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=full`, {
        headers: { 'if-none-match': fullEtag },
    });
    assert(full304.status === 304, 'Conditional GET full avatar with matching ETag returns 304');

    // 3.2 Thumb size (reserved parameter, serves full bytes without sharp)
    const thumbRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`);
    assert(thumbRes.status === 200, 'GET /api/avatar/:pubkey?size=thumb returns 200');
    assert(Buffer.isBuffer(thumbRes.body), 'Thumb body is binary Buffer');
    assert(thumbRes.type === 'image/jpeg', 'Thumb Content-Type is image/jpeg');
    assert(thumbRes.body.length === sampleJpegBuffer.length, 'Thumb serves stored avatar bytes without sharp');

    const thumbEtag = thumbRes.headers['etag'];
    assert(thumbEtag === fullEtag, `Thumb ETag (${thumbEtag}) matches full ETag (${fullEtag})`);

    // Thumb size 304
    const thumb304 = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`, {
        headers: { 'if-none-match': thumbEtag },
    });
    assert(thumb304.status === 304, 'Conditional GET thumb avatar with matching ETag returns 304');

    // =========================================================================
    // SECTION 4: In-Memory LRU Cache Verification
    // =========================================================================
    console.log('\n--- Section 4: In-Memory LRU Cache ---');

    const l1StatsBefore = avatarService.cache.getStats();
    assert(l1StatsBefore.count > 0, `L1 memory cache contains ${l1StatsBefore.count} entries`);

    const l1HitRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`);
    assert(l1HitRes.status === 200 && l1HitRes.body.equals(thumbRes.body), 'L1 cache hit returns exact bytes');

    avatarService.cache.clear();
    assert(avatarService.cache.getStats().count === 0, 'L1 memory cache clear() empties cache');

    const afterClearRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`);
    assert(afterClearRes.status === 200, 'Request after clear() re-fetches from DB and succeeds with 200');
    assert(avatarService.cache.getStats().count === 1, 'Cache re-populated after retrieval');

    // =========================================================================
    // SECTION 5: Error Handling & Edge Cases
    // =========================================================================
    console.log('\n--- Section 5: Error Handling & Edge Cases ---');

    // Unknown member
    const unknownRes = await dispatchRoute(avatarRouter, 'GET', '/api/avatar/nonexistent_pubkey');
    assert(unknownRes.status === 404, 'Unknown pubkey returns 404');

    // Member with no avatar
    const noAvatarRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkNone}`);
    assert(noAvatarRes.status === 404, 'Member with no avatar returns 404');

    // Stored XSS regression. `POST /api/profile/update` does not validate the avatar format,
    // so the stored MIME type is member-controlled. This route is public and unauthenticated:
    // serving a stored text/html or SVG would run attacker script on the node's own origin and
    // could read the Ed25519 identity out of localStorage. Refuse anything not a raster image.
    const hostileTypes = [
        'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'),
        'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
        'data:application/javascript;base64,' + Buffer.from('alert(1)').toString('base64'),
    ];
    for (const hostile of hostileTypes) {
        db.prepare(`UPDATE members SET avatar_url = ? WHERE public_key = ?`).run(hostile, pkPhoto);
        avatarService.cache.clear();
        const res = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}`);
        const label = hostile.slice(5, hostile.indexOf(';'));
        assert(res.status === 400, `Hostile avatar MIME ${label} is refused, not served`);
        assert(!String(res.headers['content-type'] || '').includes(label), `${label} is never echoed as Content-Type`);
    }

    // A bundled id must not be able to walk out of the avatars directory.
    db.prepare(`UPDATE members SET avatar_url = ? WHERE public_key = ?`).run('bundled://../../../../etc/passwd', pkPhoto);
    avatarService.cache.clear();
    const traversalRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}`);
    assert(traversalRes.status === 404, 'Bundled avatar path traversal is refused');

    // Avatar update busts cache and changes ETag
    const newSampleBuffer = createTestJpegBuffer(35 * 1024);
    const newBase64 = `data:image/jpeg;base64,${newSampleBuffer.toString('base64')}`;

    db.prepare(`UPDATE members SET avatar_url = ? WHERE public_key = ?`).run(newBase64, pkPhoto);
    avatarService.delete(pkPhoto);

    const updatedRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`);
    assert(updatedRes.status === 200, 'Updated avatar returns 200');
    assert(!updatedRes.body.equals(thumbRes.body), 'Updated thumbnail bytes differ from old thumbnail');
    assert(updatedRes.headers['etag'] !== thumbEtag, 'Updated avatar produces a NEW ETag');

    // Old ETag now returns 200, not 304
    const staleEtagRes = await dispatchRoute(avatarRouter, 'GET', `/api/avatar/${pkPhoto}?size=thumb`, {
        headers: { 'if-none-match': thumbEtag },
    });
    assert(staleEtagRes.status === 200, 'Stale ETag does NOT return 304; receives updated bytes');

    // =========================================================================
    // SECTION 6: Benchmark Before & After: BOTH members and posts
    // =========================================================================
    console.log('\n--- Section 6: Benchmark Before vs After Payloads ---');

    // Fixture matching mullum live data: 32 members (10 photographic 512x512 avatars, 21 bundled, 1 none)
    db.prepare(`DELETE FROM posts`).run();
    db.prepare(`DELETE FROM members`).run();

    const photoMembers: string[] = [];
    for (let i = 0; i < 10; i++) {
        const pk = 'p' + i.toString().padStart(63, '0');
        photoMembers.push(pk);
        db.prepare(`
            INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
        `).run(pk, `PhotoUser${i}`, sampleBase64DataUri);
    }

    const bundledMembers: string[] = [];
    for (let i = 0; i < 21; i++) {
        const pk = 'b' + i.toString().padStart(63, '0');
        bundledMembers.push(pk);
        db.prepare(`
            INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
            VALUES (?, ?, 'bundled://leaf', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
        `).run(pk, `BundledUser${i}`);
    }

    // 1 member without avatar
    const pkEmpty = 'e' + '0'.repeat(63);
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, joined_at, status)
        VALUES (?, 'NoAvatarUser', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(pkEmpty);

    // 49 posts across these members
    for (let i = 0; i < 49; i++) {
        const author = i < 35 ? photoMembers[i % photoMembers.length] : bundledMembers[i % bundledMembers.length];
        createPost('offer', 'goods', `Listing Item #${i + 1}`, `Description for item ${i + 1}`, 10 + i, 'fixed', author);
    }

    // 6.1 /api/community/members Benchmark
    const membersAfterRes = await dispatchRoute(communityRouter, 'GET', '/api/community/members');
    const membersAfterPayload = typeof membersAfterRes.body === 'string' ? membersAfterRes.body : JSON.stringify(membersAfterRes.body);
    const membersAfterBytes = Buffer.byteLength(membersAfterPayload, 'utf8');

    // Simulate before: members list inlined the full raw base64 data URIs
    const rawMembers = db.prepare("SELECT * FROM members WHERE status != 'pruned' AND is_treasury = 0").all() as any[];
    const simulatedBeforeMembers = rawMembers.map(m => ({
        publicKey: m.public_key,
        callsign: m.callsign,
        joinedAt: m.joined_at,
        avatarUrl: m.avatar_url || null,
        status: m.status,
    }));
    const membersBeforePayload = JSON.stringify(simulatedBeforeMembers);
    const membersBeforeBytes = Buffer.byteLength(membersBeforePayload, 'utf8');

    const membersSaved = membersBeforeBytes - membersAfterBytes;
    const membersPct = ((membersSaved / membersBeforeBytes) * 100).toFixed(1);

    // 6.2 /api/marketplace/posts Benchmark
    const postsAfterRes = await dispatchRoute(marketplaceRouter, 'GET', '/api/marketplace/posts?limit=100');
    const postsAfterPayload = typeof postsAfterRes.body === 'string' ? postsAfterRes.body : JSON.stringify(postsAfterRes.body);
    const postsAfterBytes = Buffer.byteLength(postsAfterPayload, 'utf8');

    // Simulate before: posts inlined the full raw base64 author avatar
    const simulatedBeforePosts = JSON.parse(postsAfterPayload).map((p: any) => {
        if (p.authorAvatarUrl?.startsWith('/api/avatar/')) {
            return { ...p, authorAvatarUrl: sampleBase64DataUri };
        }
        return p;
    });
    const postsBeforePayload = JSON.stringify(simulatedBeforePosts);
    const postsBeforeBytes = Buffer.byteLength(postsBeforePayload, 'utf8');

    const postsSaved = postsBeforeBytes - postsAfterBytes;
    const postsPct = ((postsSaved / postsBeforeBytes) * 100).toFixed(1);

    console.log(`\n======================================================================`);
    console.log(`  BENCHMARK: /api/community/members (32 members, 10 photographic avatars)`);
    console.log(`    Before: ${membersBeforeBytes.toLocaleString()} bytes (~${(membersBeforeBytes / 1024).toFixed(1)} KB)`);
    console.log(`    After:  ${membersAfterBytes.toLocaleString()} bytes (~${(membersAfterBytes / 1024).toFixed(1)} KB)`);
    console.log(`    Saved:  ${membersSaved.toLocaleString()} bytes (${membersPct}% reduction)`);
    console.log(`----------------------------------------------------------------------`);
    console.log(`  BENCHMARK: /api/marketplace/posts (49 posts, 35 photo authors)`);
    console.log(`    Before: ${postsBeforeBytes.toLocaleString()} bytes (~${(postsBeforeBytes / 1024).toFixed(1)} KB)`);
    console.log(`    After:  ${postsAfterBytes.toLocaleString()} bytes (~${(postsAfterBytes / 1024).toFixed(1)} KB)`);
    console.log(`    Saved:  ${postsSaved.toLocaleString()} bytes (${postsPct}% reduction)`);
    console.log(`======================================================================\n`);

    assert(membersAfterBytes < 15 * 1024, `Members list payload is under 15 KB (actual: ${(membersAfterBytes / 1024).toFixed(1)} KB)`);
    assert(membersSaved > 500 * 1024, `Saved over 500 KB on members list (actual saved: ${(membersSaved / 1024).toFixed(1)} KB)`);
    assert(postsAfterBytes < 40 * 1024, `Posts list payload is under 40 KB (actual: ${(postsAfterBytes / 1024).toFixed(1)} KB)`);
    assert(postsSaved > 1000 * 1024, `Saved over 1 MB on posts list (actual saved: ${(postsSaved / 1024).toFixed(1)} KB)`);

    // Clean up test data directory
    try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}

    console.log(`\nAvatar Test Summary: ${passed}/${run} assertions passed.`);
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});
