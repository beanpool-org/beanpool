/**
 * Automated Test Suite: Pulse OAuth Ingest & Batch Endpoint Bounds.
 *
 * Verifies that:
 * 1. Normal batch ingest (20 items matching TikTok Display API page size) succeeds with HTTP 200.
 * 2. Over-limit batch count (> MAX_OAUTH_INGEST_ITEMS = 50) is rejected with HTTP 400 (too_many_items),
 *    never truncated silently.
 * 3. Total payload exceeding MAX_OAUTH_INGEST_PAYLOAD_BYTES (512 KB) is rejected with HTTP 413 (payload_too_large).
 * 4. Per-item field bounds cost the ITEM, never the batch, because these fields come from
 *    TikTok and Instagram verbatim rather than from the client:
 *    - Title > MAX_ITEM_TITLE_LENGTH (500) is truncated and still ingested
 *    - URL (2048), thumbnailUrl (4096), externalId (512), publishedAt (64) and
 *      category (50) over their bound drop that one item and report it in skippedCount
 * 5. The request SHAPE is the client's own doing, so a non-array `items` is a hard 400.
 * 6. Single submit caps its own URL at 400 but truncates the preview-resolved title.
 * 7. Sibling batch endpoints enforce bounds:
 *    - Group conversation > 50 participants -> 400
 *    - A conversation type outside dm/group -> 400 (it bypassed both caps)
 *    - Repeated participants are de-duplicated instead of hitting a UNIQUE constraint
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

    console.log('\n--- 4. Per-Item Field Bounds Skip or Truncate the Item, Never the Batch ---');
    // These items come from TikTok's and Instagram's APIs verbatim, not from the client,
    // so one upstream anomaly must not cost the member the rest of the batch.

    // 4a: an over-long URL drops that item; its siblings still land.
    const longUrl = 'https://www.tiktok.com/@alice_creator/video/' + 'a'.repeat(MAX_ITEM_URL_LENGTH + 1);
    const longUrlRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [
                { url: longUrl, title: 'Long URL item' },
                { url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000010', title: 'Good sibling', externalId: '7500000000000000010' },
            ],
        },
    });
    assert(longUrlRes.status === 200, 'A batch containing an over-long URL still returns 200');
    assert(longUrlRes.body.count === 1, 'The good sibling was ingested');
    assert(longUrlRes.body.skippedCount === 1, 'The over-long URL item was skipped, not fatal');

    // 4b: an over-long title is truncated, not rejected — TikTok captions run to 2,200 chars.
    const longTitle = 'T'.repeat(MAX_ITEM_TITLE_LENGTH + 1);
    const longTitleRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: [{ url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000001', title: longTitle, externalId: '7500000000000000001' }],
        },
    });
    assert(longTitleRes.status === 200, 'Item title > 500 chars is accepted');
    assert(longTitleRes.body.count === 1, 'The long-title item was ingested, not dropped');
    assert(longTitleRes.body.items[0].title.length === MAX_ITEM_TITLE_LENGTH, `Title truncated to ${MAX_ITEM_TITLE_LENGTH} chars`);

    // 4c: a title of exactly the limit is stored whole.
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

    // 4d-4g: every other over-long field drops just that item.
    const oversizedFieldCases: Array<{ label: string; item: Record<string, unknown> }> = [
        {
            label: 'thumbnail URL > 4096 chars',
            item: {
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000003',
                title: 'Huge thumb item',
                thumbnailUrl: 'https://p16-sign.tiktokcdn.com/' + 'a'.repeat(MAX_ITEM_THUMBNAIL_URL_LENGTH + 1) + '.jpg',
            },
        },
        {
            label: 'externalId > 512 chars',
            item: {
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000004',
                externalId: 'e'.repeat(MAX_ITEM_EXTERNAL_ID_LENGTH + 1),
            },
        },
        {
            label: 'publishedAt > 64 chars',
            item: {
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000005',
                publishedAt: '2026-08-01T12:00:00Z' + '0'.repeat(MAX_ITEM_PUBLISHED_AT_LENGTH),
            },
        },
        {
            label: 'category > 50 chars',
            item: {
                url: 'https://www.tiktok.com/@alice_creator/video/7500000000000000006',
                category: 'c'.repeat(MAX_ITEM_CATEGORY_LENGTH + 1),
            },
        },
        { label: 'item that is a primitive', item: 'primitive string' as any },
        { label: 'item that is an array', item: [] as any },
        { label: 'item that is null', item: null as any },
    ];

    for (const { label, item } of oversizedFieldCases) {
        const res = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
            actor: alice,
            body: { channelId: aliceChannel.id, items: [item] },
        });
        assert(res.status === 200, `An item with ${label} does not fail the request`);
        assert(res.body.count === 0, `An item with ${label} is not ingested`);
        assert(res.body.skippedCount === 1, `An item with ${label} is reported as skipped`);
    }

    // A batch of 20 real items where one has a 2,200-char TikTok caption and one has a
    // broken thumbnail still ingests the other 19 — the scenario that would otherwise have
    // wedged every future sync, because the client swallows a non-2xx and reports success.
    const realisticBatch = Array.from({ length: 20 }, (_, i) => ({
        url: `https://www.tiktok.com/@alice_creator/video/76100000000000000${String(i).padStart(2, '0')}`,
        title: i === 3 ? 'C'.repeat(2200) : `Video ${i}`,
        thumbnailUrl: i === 7 ? 'https://cdn.example.com/' + 'z'.repeat(MAX_ITEM_THUMBNAIL_URL_LENGTH + 1) : undefined,
        externalId: `76100000000000000${String(i).padStart(2, '0')}`,
    }));
    const realisticRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: { channelId: aliceChannel.id, items: realisticBatch },
    });
    assert(realisticRes.status === 200, 'A realistic 20-item sync with two anomalies returns 200');
    assert(realisticRes.body.count === 19, 'The other 19 videos were ingested');
    assert(realisticRes.body.skippedCount === 1, 'Only the broken-thumbnail item was dropped');

    console.log('\n--- 5. Malformed Items Structure Rejection ---');
    // The shape of the request IS the client's own doing, so this stays a hard 400.
    const notArrayRes = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceChannel.id,
            items: 'not an array' as any,
        },
    });
    assert(notArrayRes.status === 400, 'Non-array items is rejected with HTTP 400');
    assert(notArrayRes.body.error === 'invalid_items', 'Error code is invalid_items');

    console.log('\n--- 6. Single Submit & Preview Route Bounds ---');
    // The title the PWA posts here is the one our own /preview resolved, and the intake
    // page gives the user no way to shorten it — so it truncates rather than locking them
    // out of a link they cannot edit. The URL below is theirs, and still 400s.
    const submitLongTitle = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/submit', {
        actor: alice,
        body: {
            url: 'https://www.tiktok.com/@alice_creator/video/7600000000000000001',
            channelId: aliceChannel.id,
            title: 'T'.repeat(MAX_ITEM_TITLE_LENGTH + 1),
        },
    });
    assert(submitLongTitle.status === 200, 'Submit with a title > 500 chars succeeds');
    assert(submitLongTitle.body.item.title.length === MAX_ITEM_TITLE_LENGTH, `Submitted title truncated to ${MAX_ITEM_TITLE_LENGTH} chars`);

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

    // An unrecognised `type` used to slip past both length rules, because the dm rule only
    // fires on 'dm' and the group cap only on 'group' — so type "bulk" with 5,000
    // participants took the write lock for 5,000 INSERTs and bypassed the cap entirely.
    const bogusTypeRes = await callRouter(messagingRouter, 'POST', '/api/messages/conversation', {
        actor: alice,
        body: {
            type: 'bulk',
            createdBy: alice,
            participants: [alice, ...tooManyParticipants.slice(0, 60)],
            name: 'Cap bypass attempt',
        },
    });
    assert(bogusTypeRes.status === 400, 'A conversation type other than dm/group is rejected');
    assert(String(bogusTypeRes.body.error).includes('dm'), 'The error names the allowed types');

    // conversation_participants is keyed on (conversation_id, public_key), so a repeated
    // participant used to surface a raw SQLite UNIQUE constraint error.
    const dupDmRes = await callRouter(messagingRouter, 'POST', '/api/messages/conversation', {
        actor: alice,
        body: { type: 'dm', createdBy: alice, participants: [alice, alice] },
    });
    assert(dupDmRes.status === 400, 'A DM with the same person twice is rejected');
    assert(String(dupDmRes.body.error).includes('distinct'), 'The error explains it needs 2 distinct people');

    const dupGroupRes = await callRouter(messagingRouter, 'POST', '/api/messages/conversation', {
        actor: alice,
        body: {
            type: 'group',
            createdBy: alice,
            participants: [alice, bob, bob, tooManyParticipants[2]],
            name: 'Group with a duplicate',
        },
    });
    assert(dupGroupRes.status === 200, 'A group with a repeated participant is de-duplicated, not an error');
    assert(dupGroupRes.body.success === true, 'The de-duplicated group was created');

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
