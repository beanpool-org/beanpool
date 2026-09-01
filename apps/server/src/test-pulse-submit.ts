/**
 * Automated Test Suite: Manual Pulse Ingestion Routes (Package 05).
 *
 * Covers:
 * 1. Member cannot submit an item onto another member's channel (refused with 400/403).
 * 2. URL matching no owned channel is refused (refused with 400/403).
 * 3. The same post submitted twice dedupes (returns deduplicated: true, same row).
 * 4. The post-count watermark advances on dismissal (updates creator_channels.post_count_seen).
 * 5. SSRF protection: private IP addresses / cloud metadata are blocked on preview & submit.
 * 6. Deletion via scrubPulseItems properly tombstones the pulse item (deleted_at set, url, title, thumbnail_url NULLed).
 * 7. Resubmission of a tombstoned row restores the item (deleted_at set to NULL, fields populated).
 * 8. Preview endpoint extraction and alreadyImported detection.
 * 9. Nudges endpoint returns active channel nudge watermarks.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-submit.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { addChannel } from './engine/creator-channels.js';
import { createPulseSubmitRoutes, identifyPlatformAndExternalId } from './routes/pulse-submit.js';
import type { RouteDeps } from './routes/types.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const deps: RouteDeps = {
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

let router: any;

async function call(
    method: string,
    path: string,
    opts: { actor?: string; body?: Record<string, unknown>; params?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in pulse-submit router`);

    const params: Record<string, string> = { ...(opts.params || {}) };
    if (layer.paramNames && layer.paramNames.length > 0) {
        const match = layer.regexp.exec(path);
        if (match) {
            layer.paramNames.forEach((param: any, idx: number) => {
                if (match[idx + 1] !== undefined) {
                    params[param.name] = match[idx + 1];
                }
            });
        }
    }

    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        params,
        status: 200,
        body: undefined,
    };
    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string, status = 'active'): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign, status);
    return pubkey;
}

async function main(): Promise<void> {
    console.log('=== Manual Ingestion (Pulse Submit) Test Suite ===\n');

    initStateEngine();
    router = createPulseSubmitRoutes(deps);

    const kayla = makeMember('Kayla');
    const marty = makeMember('Marty');
    const alice = makeMember('Alice'); // No channels

    // ── 0. URL Identification Helper ───────────────────────────────────────────
    console.log('--- 0. URL Identification & ID Extraction ---');
    const igPost = identifyPlatformAndExternalId('https://www.instagram.com/p/DB12345/');
    assert(igPost.platform === 'instagram', 'Instagram post platform detected');
    assert(igPost.externalId === 'DB12345', 'Instagram post external ID extracted');

    const igReel = identifyPlatformAndExternalId('https://instagram.com/reel/C_abc456/');
    assert(igReel.platform === 'instagram', 'Instagram reel platform detected');
    assert(igReel.externalId === 'C_abc456', 'Instagram reel external ID extracted');

    const ttVideo = identifyPlatformAndExternalId('https://www.tiktok.com/@alice/video/9876543210');
    assert(ttVideo.platform === 'tiktok', 'TikTok video platform detected');
    assert(ttVideo.externalId === '9876543210', 'TikTok video external ID extracted');
    assert(ttVideo.accountHandle === '@alice', 'TikTok account handle extracted');

    const ytWatch = identifyPlatformAndExternalId('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert(ytWatch.platform === 'youtube', 'YouTube watch platform detected');
    assert(ytWatch.externalId === 'dQw4w9WgXcQ', 'YouTube video ID extracted');

    const blogPost = identifyPlatformAndExternalId('https://alice-pottery.org/blog/new-glazes');
    assert(blogPost.platform === 'website', 'Generic website platform detected');

    const scTrack = identifyPlatformAndExternalId('https://soundcloud.com/djcool/summer-mix-2026');
    assert(scTrack.platform === 'soundcloud', 'SoundCloud track platform detected');
    assert(scTrack.accountHandle === '@djcool', 'SoundCloud account handle extracted');

    // Setup channels
    const chKaylaYt = addChannel({
        ownerPubkey: kayla,
        platform: 'youtube',
        raw: 'https://www.youtube.com/@kayla_crafts',
        category: 'craft',
    });

    const chKaylaIg = addChannel({
        ownerPubkey: kayla,
        platform: 'instagram',
        raw: '@kayla_pottery',
        category: 'art',
    });

    const chKaylaSc = addChannel({
        ownerPubkey: kayla,
        platform: 'soundcloud',
        raw: '@djcool',
        category: 'art',
    });

    const chMartyTt = addChannel({
        ownerPubkey: marty,
        platform: 'tiktok',
        raw: '@marty_food',
        category: 'food',
    });

    // ── 1. Unauthenticated & Ownership Gating ──────────────────────────────────
    console.log('\n--- 1. Authentication & Ownership Gating ---');

    // Missing signature -> 401
    const unauthPreview = await call('POST', '/api/member/pulse/preview', {
        body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert(unauthPreview.status === 401, 'Unsigned preview request rejected with 401');

    const unauthSubmit = await call('POST', '/api/member/pulse/submit', {
        body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert(unauthSubmit.status === 401, 'Unsigned submit request rejected with 401');

    // Member with no channels -> 403
    const alicePreview = await call('POST', '/api/member/pulse/preview', {
        actor: alice,
        body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert(alicePreview.status === 403, 'Member with no channels cannot preview (403)');

    const aliceSubmit = await call('POST', '/api/member/pulse/submit', {
        actor: alice,
        body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert(aliceSubmit.status === 403, 'Member with no channels cannot submit (403)');

    // Marty tries to submit with Kayla channelId -> 403
    const martyStealChannel = await call('POST', '/api/member/pulse/submit', {
        actor: marty,
        body: {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            channelId: chKaylaYt.id,
        },
    });
    assert(martyStealChannel.status === 403, 'Member cannot submit to another member channelId (403 NOT_YOURS)');

    // Marty tries to preview with Kayla channelId -> 403
    const martyStealPreview = await call('POST', '/api/member/pulse/preview', {
        actor: marty,
        body: {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            channelId: chKaylaYt.id,
        },
    });
    assert(martyStealPreview.status === 403, 'Member cannot preview another member channelId (403 NOT_YOURS)');

    // ── 2. URL Matching No Owned Channel ───────────────────────────────────────
    console.log('\n--- 2. Unmatched URL Refusal ---');

    // Marty only has TikTok channel, tries to submit YouTube URL
    const martyNoYtChannel = await call('POST', '/api/member/pulse/submit', {
        actor: marty,
        body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert(martyNoYtChannel.status === 403, 'URL with no matching owned platform channel is refused (403)');

    // Kayla has YouTube and Instagram, tries to submit a TikTok URL
    const kaylaNoTtChannel = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: { url: 'https://www.tiktok.com/@some_creator/video/1234567890' },
    });
    assert(kaylaNoTtChannel.status === 403, 'TikTok URL refused when member has no TikTok channel (403)');

    // Marty has TikTok @marty_food, tries to submit someone else's TikTok (@stranger)
    const martyStrangerTt = await call('POST', '/api/member/pulse/submit', {
        actor: marty,
        body: { url: 'https://www.tiktok.com/@stranger_account/video/9876543210' },
    });
    assert(martyStrangerTt.status === 403, 'TikTok URL belonging to a stranger is refused (403)');

    // ── 3. Preview Endpoint & Metadata Extraction ─────────────────────────────
    console.log('\n--- 3. Preview Endpoint ---');

    const ytUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const previewRes = await call('POST', '/api/member/pulse/preview', {
        actor: kayla,
        body: { url: ytUrl },
    });
    assert(previewRes.status === 200, 'Preview endpoint returns 200 for valid owned channel URL');
    assert(previewRes.body.success === true, 'Preview response has success: true');
    assert(previewRes.body.preview.platform === 'youtube', 'Platform detected as youtube');
    assert(previewRes.body.preview.externalId === 'dQw4w9WgXcQ', 'Video ID extracted as externalId');
    assert(previewRes.body.preview.channelId === chKaylaYt.id, 'Mapped to Kayla YouTube channel');
    assert(previewRes.body.preview.alreadyImported === false, 'alreadyImported is false before submit');
    assert(typeof previewRes.body.preview.thumbnailUrl === 'string', 'Thumbnail URL extracted');

    // ── 4. Submission & Deduplication ──────────────────────────────────────────
    console.log('\n--- 4. Submission & Deduplication ---');

    const submitRes1 = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: ytUrl,
            title: 'Kayla Great Pottery Demonstration',
            category: 'craft',
        },
    });
    assert(submitRes1.status === 200, 'First submit returns 200');
    assert(submitRes1.body.success === true, 'First submit returns success: true');
    assert(submitRes1.body.deduplicated === false, 'First submit returns deduplicated: false');
    const itemId = submitRes1.body.item?.id;
    assert(typeof itemId === 'string' && itemId.startsWith('item_'), 'Generated valid pulse item id');
    assert(submitRes1.body.item.title === 'Kayla Great Pottery Demonstration', 'Title matches submission');
    assert(submitRes1.body.item.source === 'manual', 'Source is set to manual');
    assert(submitRes1.body.item.ownerPubkey === kayla, 'Owner matches actor pubkey');
    assert(submitRes1.body.item.publishedAt !== null, 'publishedAt is populated');

    // Preview now shows alreadyImported: true
    const previewAfterSubmit = await call('POST', '/api/member/pulse/preview', {
        actor: kayla,
        body: { url: ytUrl },
    });
    assert(previewAfterSubmit.body.preview.alreadyImported === true, 'Preview detects item is alreadyImported');
    assert(previewAfterSubmit.body.preview.existingItemId === itemId, 'Preview returns existingItemId');

    // Submit the exact same URL again -> deduplicated: true, same row id
    const submitRes2 = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: ytUrl,
            title: 'Updated Title for Pottery Demonstration',
            category: 'craft',
        },
    });
    assert(submitRes2.status === 200, 'Second submit returns 200');
    assert(submitRes2.body.deduplicated === true, 'Second submit returns deduplicated: true');
    assert(submitRes2.body.item.id === itemId, 'Deduplicated submission returns the exact same item id');
    assert(submitRes2.body.item.title === 'Updated Title for Pottery Demonstration', 'Deduplicated submit updates title');

    // Check DB row count: exactly 1 row
    const countRows = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND external_id = ?').get(chKaylaYt.id, 'dQw4w9WgXcQ') as any).c;
    assert(countRows === 1, 'Database contains exactly 1 row for the deduplicated post');

    // Submit SoundCloud track
    const scUrl = 'https://soundcloud.com/djcool/summer-mix-2026';
    const scSubmit = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: scUrl,
            title: 'Summer Mix 2026',
            category: 'art',
        },
    });
    assert(scSubmit.status === 200, 'SoundCloud submit returns 200');
    assert(scSubmit.body.item.platform === 'soundcloud', 'Item platform is soundcloud');
    assert(scSubmit.body.item.title === 'Summer Mix 2026', 'SoundCloud item title preserved');
    const scDbRow = db.prepare('SELECT channel_id FROM pulse_items WHERE id = ?').get(scSubmit.body.item.id) as any;
    assert(scDbRow.channel_id === chKaylaSc.id, 'SoundCloud item assigned to Kayla soundcloud channel');

    // ── 5. Watermark Dismissal (dismiss-nudge) ─────────────────────────────────
    console.log('\n--- 5. Watermark Dismissal (dismiss-nudge) ---');

    // Dismiss with valid count
    const dismissRes = await call('POST', `/api/member/pulse/channels/${chKaylaIg.id}/dismiss-nudge`, {
        actor: kayla,
        body: { seenCount: 15 },
        params: { id: chKaylaIg.id },
    });
    assert(dismissRes.status === 200, 'dismiss-nudge returns 200');
    assert(dismissRes.body.success === true, 'dismiss-nudge returns success: true');
    assert(dismissRes.body.postCountSeen === 15, 'dismiss-nudge returned postCountSeen: 15');

    const dbChannel = db.prepare('SELECT post_count_seen FROM creator_channels WHERE id = ?').get(chKaylaIg.id) as any;
    assert(dbChannel.post_count_seen === 15, 'creator_channels.post_count_seen updated in DB to 15');

    // Watermark cannot regress to a lower number
    const regressRes = await call('POST', `/api/member/pulse/channels/${chKaylaIg.id}/dismiss-nudge`, {
        actor: kayla,
        body: { seenCount: 10 },
        params: { id: chKaylaIg.id },
    });
    assert(regressRes.status === 200, 'dismiss-nudge with lower number returns 200');
    assert(regressRes.body.postCountSeen === 15, 'watermark does not regress to lower count (stays 15)');

    // Non-owner cannot dismiss nudge
    const martyDismissKayla = await call('POST', `/api/member/pulse/channels/${chKaylaIg.id}/dismiss-nudge`, {
        actor: marty,
        body: { seenCount: 20 },
        params: { id: chKaylaIg.id },
    });
    assert(martyDismissKayla.status === 403, 'Non-owner cannot dismiss nudge on channel (403 NOT_YOURS)');

    // Dismiss non-existent channel -> 404
    const dismissNonExistent = await call('POST', '/api/member/pulse/channels/chan_nonexistent/dismiss-nudge', {
        actor: kayla,
        params: { id: 'chan_nonexistent' },
    });
    assert(dismissNonExistent.status === 404, 'dismiss-nudge on non-existent channel returns 404');

    // ── 5b. Platform & Domain Mismatch Gating & Custom Validation ──────────────
    console.log('\n--- 5b. Platform & Domain Mismatch & Validation ---');

    // Mismatched channelId platform (Instagram channel for YouTube URL) -> 403 NO_CHANNEL_MATCH
    const mismatchedChannelPreview = await call('POST', '/api/member/pulse/preview', {
        actor: kayla,
        body: {
            url: ytUrl,
            channelId: chKaylaIg.id,
        },
    });
    assert(mismatchedChannelPreview.status === 403, 'Mismatched channelId platform in preview rejected with 403');
    assert(mismatchedChannelPreview.body.error === 'no_channel_match', 'Error code is no_channel_match');

    const mismatchedChannelSubmit = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: ytUrl,
            channelId: chKaylaIg.id,
        },
    });
    assert(mismatchedChannelSubmit.status === 403, 'Mismatched channelId platform in submit rejected with 403');

    // Website channel domain validation
    const chKaylaWeb = addChannel({
        ownerPubkey: kayla,
        platform: 'website',
        raw: 'https://kaylapottery.org/blog',
        category: 'craft',
    });

    const foreignDomainSubmit = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: 'https://strangers-pottery.com/posts/1',
        },
    });
    assert(foreignDomainSubmit.status === 403, 'Foreign website domain not matching owned channel is refused (403 NOT_YOURS)');

    // Invalid thumbnail URL validation (non-http scheme)
    const invalidThumbSubmit = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: ytUrl,
            thumbnailUrl: 'javascript:alert(1)',
        },
    });
    assert(invalidThumbSubmit.status === 400, 'Invalid thumbnail scheme rejected with 400');
    assert(invalidThumbSubmit.body.error === 'invalid_thumbnail_url', 'Error code is invalid_thumbnail_url');

    // ── 6. SSRF Protection ─────────────────────────────────────────────────────
    console.log('\n--- 6. SSRF Protection ---');

    const ssrfUrls = [
        'http://127.0.0.1:8080/admin',
        'http://localhost:3000/',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/internal',
        'http://192.168.1.1/router',
        'http://[::1]/',
        'http://metadata.google.internal/computeMetadata/v1/',
    ];

    for (const ssrfUrl of ssrfUrls) {
        const prevSsrf = await call('POST', '/api/member/pulse/preview', {
            actor: kayla,
            body: { url: ssrfUrl },
        });
        assert(prevSsrf.status === 400 && prevSsrf.body.error === 'ssrf_blocked', `Preview blocked SSRF target: ${ssrfUrl}`);

        const submitSsrf = await call('POST', '/api/member/pulse/submit', {
            actor: kayla,
            body: { url: ssrfUrl },
        });
        assert(submitSsrf.status === 400 && submitSsrf.body.error === 'ssrf_blocked', `Submit blocked SSRF target: ${ssrfUrl}`);
    }

    // ── 7. Item Deletion (scrubPulseItems) ─────────────────────────────────────
    console.log('\n--- 7. Item Deletion via scrubPulseItems ---');

    // Marty tries to delete Kayla's item -> 403
    const martyDeleteKayla = await call('POST', `/api/member/pulse/items/${itemId}/delete`, {
        actor: marty,
        params: { id: itemId },
    });
    assert(martyDeleteKayla.status === 403, 'Non-owner cannot delete item (403 NOT_YOURS)');

    // Kayla deletes her own item
    const kaylaDelete = await call('POST', `/api/member/pulse/items/${itemId}/delete`, {
        actor: kayla,
        params: { id: itemId },
    });
    assert(kaylaDelete.status === 200, 'Owner item delete returns 200');
    assert(kaylaDelete.body.success === true, 'Delete returns success: true');

    // Verify DB row is tombstoned
    const tombstonedRow = db.prepare('SELECT deleted_at, url, title, thumbnail_url FROM pulse_items WHERE id = ?').get(itemId) as any;
    assert(tombstonedRow.deleted_at !== null, 'Tombstoned item has deleted_at set');
    assert(tombstonedRow.url === null, 'Tombstoned item has url NULLed');
    assert(tombstonedRow.title === null, 'Tombstoned item has title NULLed');
    assert(tombstonedRow.thumbnail_url === null, 'Tombstoned item has thumbnail_url NULLed');

    // Delete already deleted item -> 404
    const deleteAgain = await call('POST', `/api/member/pulse/items/${itemId}/delete`, {
        actor: kayla,
        params: { id: itemId },
    });
    assert(deleteAgain.status === 404, 'Deleting already deleted item returns 404');

    // ── 8. Resubmission of Tombstoned Row Restores It ──────────────────────────────
    console.log('\n--- 8. Resubmission of Tombstoned Row ---');

    const restoreRes = await call('POST', '/api/member/pulse/submit', {
        actor: kayla,
        body: {
            url: ytUrl,
            title: 'Resurrected Pottery Video',
            category: 'craft',
        },
    });
    assert(restoreRes.status === 200, 'Resubmitting deleted item returns 200');
    assert(restoreRes.body.success === true, 'Resubmit returns success: true');
    assert(restoreRes.body.deduplicated === false, 'Resubmit returns deduplicated: false (restored)');
    assert(restoreRes.body.item.id === itemId, 'Resubmitted item reuses the original row id');
    assert(restoreRes.body.item.title === 'Resurrected Pottery Video', 'Restored item title is updated');
    assert(restoreRes.body.item.url !== null, 'Restored item url is restored from NULL');

    const restoredRow = db.prepare('SELECT deleted_at, url, title FROM pulse_items WHERE id = ?').get(itemId) as any;
    assert(restoredRow.deleted_at === null, 'Restored DB row has deleted_at set back to NULL');
    assert(restoredRow.url !== null && restoredRow.title === 'Resurrected Pottery Video', 'Restored DB row has content populated');

    // ── 9. Nudges Endpoint ─────────────────────────────────────────────────────
    console.log('\n--- 9. Nudges Endpoint ---');

    const nudgesRes = await call('POST', '/api/member/pulse/nudges', {
        actor: kayla,
    });
    assert(nudgesRes.status === 200, 'Nudges endpoint returns 200');
    assert(Array.isArray(nudgesRes.body.nudges), 'Nudges response contains nudges array');

    console.log(`\nResults: ${passed}/${run} tests passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
