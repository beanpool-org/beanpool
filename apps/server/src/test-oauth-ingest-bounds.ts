/**
 * Automated Test Suite: Pulse OAuth Ingest & Batch Endpoint Bounds.
 *
 * Verifies that:
 * 1. Normal batch ingest (20 items matching TikTok Display API page size) succeeds with HTTP 200.
 * 2. Over-limit batch count (> MAX_OAUTH_INGEST_ITEMS = 50) is rejected with HTTP 400 (too_many_items),
 *    never truncated silently.
 * 3. Total payload exceeding MAX_OAUTH_INGEST_PAYLOAD_BYTES (512 KB) is rejected with HTTP 413 (payload_too_large).
 * 4. Per-item field over-limit checks reject with HTTP 400 rather than silently truncating:
 *    - URL > MAX_ITEM_URL_LENGTH (2048 chars) -> 400 item_url_too_long
 *    - Title > MAX_ITEM_TITLE_LENGTH (500 chars) -> 400 title_too_long
 *    - Thumbnail URL > MAX_ITEM_THUMBNAIL_URL_LENGTH (4096 chars) -> 400 thumbnail_url_too_long
 *    - External ID > MAX_ITEM_EXTERNAL_ID_LENGTH (512 chars) -> 400 external_id_too_long
 *    - PublishedAt > MAX_ITEM_PUBLISHED_AT_LENGTH (64 chars) -> 400 published_at_too_long
 *    - Category > MAX_ITEM_CATEGORY_LENGTH (50 chars) -> 400 category_too_long
 * 5. Malformed items payload (non-array, non-object item) is rejected with HTTP 400.
 * 6. Single submit/preview endpoints enforce URL and title caps without silent truncation.
 * 7. Sibling batch endpoints enforce bounds:
 *    - Group conversation > 50 participants -> 400
 *    - Crowdfund project > 10 photos -> 400
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-oauth-ingest-bounds.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { addChannel } from './engine/creator-channels.js';
import {
    createPulseSubmitRoutes,
    MAX_OAUTH_INGEST_ITEMS,
    MAX_OAUTH_INGEST_PAYLOAD_BYTES,
    MAX_ITEM_URL_LENGTH,
    MAX_ITEM_TITLE_LENGTH,
    MAX_ITEM_THUMBNAIL_URL_LENGTH,
    MAX_ITEM_EXTERNAL_ID_LENGTH,
    MAX_ITEM_PUBLISHED_AT_LENGTH,
    MAX_ITEM_CATEGORY_LENGTH,
} from './routes/pulse-submit.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createCommonsRoutes } from './routes/commons.js';
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

let pulseSubmitRouter: any;
let messagingRouter: any;
let commonsRouter: any;

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: { actor?: string; body?: Record<string, unknown>; rawBody?: string; params?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in router`);

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
        rawBody: opts.rawBody,
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
    initStateEngine();
    pulseSubmitRouter = createPulseSubmitRoutes(deps);
    messagingRouter = createMessagingRoutes(deps);
    commonsRouter = createCommonsRoutes(deps);

    const alice = makeMember('Alice');
    const bob = makeMember('Bob');

    const aliceChannel = addChannel({
        ownerPubkey: alice,
        platform: 'tiktok',
        raw: '@alice_creator',
        category: 'craft',
    });

    console.log('\n--- 1. Normal Batch Ingest Matches Client Usage (20 items) ---');
    const normalItems = Array.from({ length: 20 }, (_, i) => ({
        url: `https://www.tiktok.com/@alice_creator/video/710000000000000${String(i).padStart(4, '0')}`,
        title: `Video ${i + 1}`,
        thumbnailUrl: `https://p16-sign.tiktokcdn.com/thumb_${i}.jpg`,
        publishedAt: '2026-08-01T12:00:00Z',
        externalId: `710000000000000${String(i).padStart(4, '0')}`,
    }));

    const normalRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: normalItems,
        },
    });
    assert(normalRes.status === 200, 'Normal 20-item batch returns 200 OK');
    assert(normalRes.body.success === true, 'Response indicates success');
    assert(normalRes.body.count === 20, 'All 20 items ingested');

    console.log('\n--- 2. Batch Item Count Bounds (Cap at 50) ---');
    // 2a: Exactly 50 items (at limit) succeeds
    const maxItems = Array.from({ length: MAX_OAUTH_INGEST_ITEMS }, (_, i) => ({
        url: `https://www.tiktok.com/@alice_creator/video/720000000000000${String(i).padStart(4, '0')}`,
        title: `Batch Item ${i + 1}`,
        externalId: `720000000000000${String(i).padStart(4, '0')}`,
    }));
    const atLimitRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: maxItems,
        },
    });
    assert(atLimitRes.status === 200, `Batch of exactly ${MAX_OAUTH_INGEST_ITEMS} items returns 200 OK`);
    assert(atLimitRes.body.count === MAX_OAUTH_INGEST_ITEMS, `Count is ${MAX_OAUTH_INGEST_ITEMS}`);

    // 2b: 51 items (> MAX_OAUTH_INGEST_ITEMS) is rejected with 400, NOT truncated
    const overLimitItems = Array.from({ length: MAX_OAUTH_INGEST_ITEMS + 1 }, (_, i) => ({
        url: `https://www.tiktok.com/@alice_creator/video/730000000000000${String(i).padStart(4, '0')}`,
        title: `Excess Item ${i + 1}`,
        externalId: `730000000000000${String(i).padStart(4, '0')}`,
    }));
    const overLimitRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: overLimitItems,
        },
    });
    assert(overLimitRes.status === 400, 'Batch of 51 items (> 50) is rejected with HTTP 400');
    assert(overLimitRes.body.error === 'too_many_items', 'Error code is too_many_items');
    assert(overLimitRes.body.message.includes('50'), 'Error message cites the 50 item limit');

    console.log('\n--- 3. Total Payload Size Bounds ---');
    // Payload exceeding MAX_OAUTH_INGEST_PAYLOAD_BYTES (512 KB) is rejected with 413
    const bigPayload = 'x'.repeat(MAX_OAUTH_INGEST_PAYLOAD_BYTES + 1024);
    const payloadRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{ url: 'https://www.tiktok.com/@alice_creator/video/7400000000000000001', title: 'test' }],
            extra: bigPayload,
        },
    });
    assert(payloadRes.status === 413, 'Payload exceeding 512 KB is rejected with HTTP 413');
    assert(payloadRes.body.error === 'payload_too_large', 'Error code is payload_too_large');

    console.log('\n--- 4. Per-Item Field Size Bounds (Reject instead of Silent Truncation) ---');
    // 4a: URL > 2048 chars rejected with 400
    const longUrl = 'https://www.tiktok.com/@alice_creator/video/' + 'a'.repeat(MAX_ITEM_URL_LENGTH + 1);
    const longUrlRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{ url: longUrl, title: 'Long URL item' }],
        },
    });
    assert(longUrlRes.status === 400, 'Item URL > 2048 chars is rejected with HTTP 400');
    assert(longUrlRes.body.error === 'item_url_too_long', 'Error code is item_url_too_long');

    // 4b: Title > 500 chars rejected with 400 (not truncated silently)
    const longTitle = 'T'.repeat(MAX_ITEM_TITLE_LENGTH + 1);
    const longTitleRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{ url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000001', title: longTitle }],
        },
    });
    assert(longTitleRes.status === 400, 'Item title > 500 chars is rejected with HTTP 400');
    assert(longTitleRes.body.error === 'title_too_long', 'Error code is title_too_long');

    // 4c: Valid 500-char title succeeds without truncation
    const maxTitle = 'T'.repeat(MAX_ITEM_TITLE_LENGTH);
    const maxTitleRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000002',
                title: maxTitle,
                externalId: '7500000000000000002',
            }],
        },
    });
    assert(maxTitleRes.status === 200, 'Item title of exactly 500 chars returns 200 OK');
    assert(maxTitleRes.body.items[0].title === maxTitle, 'Item title was preserved completely without truncation');

    // 4d: Thumbnail URL > 4096 chars rejected with 400
    const hugeThumb = 'https://p16-sign.tiktokcdn.com/' + 'a'.repeat(MAX_ITEM_THUMBNAIL_URL_LENGTH + 1) + '.jpg';
    const hugeThumbRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000003',
                title: 'Huge thumb item',
                thumbnailUrl: hugeThumb,
            }],
        },
    });
    assert(hugeThumbRes.status === 400, 'Thumbnail URL > 4096 chars is rejected with HTTP 400');
    assert(hugeThumbRes.body.error === 'thumbnail_url_too_long', 'Error code is thumbnail_url_too_long');

    // 4e: ExternalId > 512 chars rejected with 400
    const longExtId = 'e'.repeat(MAX_ITEM_EXTERNAL_ID_LENGTH + 1);
    const longExtIdRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000004',
                externalId: longExtId,
            }],
        },
    });
    assert(longExtIdRes.status === 400, 'External ID > 512 chars is rejected with HTTP 400');
    assert(longExtIdRes.body.error === 'external_id_too_long', 'Error code is external_id_too_long');

    // 4f: PublishedAt > 64 chars rejected with 400
    const longDate = '2026-08-01T12:00:00Z' + '0'.repeat(MAX_ITEM_PUBLISHED_AT_LENGTH);
    const longDateRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000005',
                publishedAt: longDate,
            }],
        },
    });
    assert(longDateRes.status === 400, 'PublishedAt > 64 chars is rejected with HTTP 400');
    assert(longDateRes.body.error === 'published_at_too_long', 'Error code is published_at_too_long');

    // 4g: Category > 50 chars rejected with 400
    const longCat = 'c'.repeat(MAX_ITEM_CATEGORY_LENGTH + 1);
    const longCatRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000006',
                category: longCat,
            }],
        },
    });
    assert(longCatRes.status === 400, 'Category > 50 chars is rejected with HTTP 400');
    assert(longCatRes.body.error === 'category_too_long', 'Error code is category_too_long');

    console.log('\n--- 5. Malformed Items Structure Rejection ---');
    // Non-array items rejected with 400
    const notArrayRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: 'not an array' as any,
        },
    });
    assert(notArrayRes.status === 400, 'Non-array items is rejected with HTTP 400');
    assert(notArrayRes.body.error === 'invalid_items', 'Error code is invalid_items');

    // Array containing non-object rejected with 400
    const nonObjectItemRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: ['primitive string' as any],
        },
    });
    assert(nonObjectItemRes.status === 400, 'Item that is not an object is rejected with HTTP 400');
    assert(nonObjectItemRes.body.error === 'invalid_item', 'Error code is invalid_item');

    // Array containing nested array rejected with 400
    const nestedArrayItemRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [[] as any],
        },
    });
    assert(nestedArrayItemRes.status === 400, 'Item that is an array is rejected with HTTP 400');
    assert(nestedArrayItemRes.body.error === 'invalid_item', 'Error code is invalid_item');

    console.log('\n--- 6. Single Submit & Preview Route Bounds ---');
    // Submit with title > 500 chars rejected with 400 (not truncated)
    const submitLongTitle = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/submit', {
        actor: alice,
        body: {
            url: 'https://www.tiktok.com/@alice_creator/video/7600000000000000001',
            channelId: aliceChannel.id,
            title: 'T'.repeat(MAX_ITEM_TITLE_LENGTH + 1),
        },
    });
    assert(submitLongTitle.status === 400, 'Submit title > 500 chars rejected with HTTP 400');
    assert(submitLongTitle.body.error === 'title_too_long', 'Error code is title_too_long');

    // Submit with URL > 2048 chars rejected with 400
    const submitLongUrl = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/submit', {
        actor: alice,
        body: {
            url: 'https://www.tiktok.com/@alice_creator/video/' + 'u'.repeat(MAX_ITEM_URL_LENGTH + 1),
            channelId: aliceChannel.id,
        },
    });
    assert(submitLongUrl.status === 400, 'Submit URL > 2048 chars rejected with HTTP 400');
    assert(submitLongUrl.body.error === 'url_too_long', 'Error code is url_too_long');

    // Preview with URL > 2048 chars rejected with 400
    const previewLongUrl = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/preview', {
        actor: alice,
        body: {
            url: 'https://www.tiktok.com/@alice_creator/video/' + 'u'.repeat(MAX_ITEM_URL_LENGTH + 1),
        },
    });
    assert(previewLongUrl.status === 400, 'Preview URL > 2048 chars rejected with HTTP 400');
    assert(previewLongUrl.body.error === 'url_too_long', 'Error code is url_too_long');

    console.log('\n--- 7. Sibling Batch Endpoints Bounds ---');
    // Group conversation with > 50 participants is rejected with 400
    const tooManyParticipants = Array.from({ length: 51 }, (_, i) => makeMember(`Member_${i}`));
    tooManyParticipants[0] = alice; // Alice is creator
    const bigGroupRes = await callRouter(messagingRouter, 'POST', '/api/messages/conversation', {
        actor: alice,
        body: {
            type: 'group',
            createdBy: alice,
            participants: tooManyParticipants,
            name: 'Over-limit group',
        },
    });
    assert(bigGroupRes.status === 400, 'Group conversation > 50 participants rejected with HTTP 400');
    assert(bigGroupRes.body.error.includes('50 participants'), 'Error message cites 50 participants');

    // Group conversation with normal participant count (3) succeeds
    const legitGroupRes = await callRouter(messagingRouter, 'POST', '/api/messages/conversation', {
        actor: alice,
        body: {
            type: 'group',
            createdBy: alice,
            participants: [alice, bob, tooManyParticipants[1]],
            name: 'Legit small group',
        },
    });
    assert(legitGroupRes.status === 200, 'Legit 3-person group conversation returns 200 OK');
    assert(legitGroupRes.body.success === true, 'Group created successfully');

    // Crowdfund project with > 10 photos is rejected with 400
    const excessPhotos = Array.from({ length: 11 }, (_, i) => `photo_${i}`);
    const bigCrowdfundRes = await callRouter(commonsRouter, 'POST', '/api/crowdfund/projects', {
        actor: alice,
        body: {
            creatorPubkey: alice,
            title: 'Project with too many photos',
            goalAmount: 500,
            photos: excessPhotos,
        },
    });
    assert(bigCrowdfundRes.status === 400, 'Crowdfund project with > 10 photos rejected with HTTP 400');
    assert(bigCrowdfundRes.body.error.includes('10 photos'), 'Error cites 10 photos limit');

    console.log(`\n========================================`);
    console.log(`OAuth Ingest Bounds Suite: ${passed}/${run} tests passed.`);
    console.log(`========================================\n`);

    if (passed !== run) {
        throw new Error(`${run - passed} test(s) failed`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
