/**
 * Automated Test Suite: The Pulse Phase 5 — OAuth Upgrade Path & Ingestion.
 *
 * Covers:
 * 1. Member cannot attach OAuth verification to a channel they do not own (refused with 403 NOT_YOURS).
 * 2. Mismatched platform account is refused (refused with 400 ACCOUNT_MISMATCH).
 * 3. Matching account sets oauth_verified_at and enables supports_autolist.
 * 4. Disconnect clears oauth_verified_at and resets autolist status.
 * 5. Disconnect preserves previously ingested feed items.
 * 6. OAuth config endpoint reports platform availability cleanly without errors when unset.
 * 7. Non-owner cannot ingest OAuth items for another member's channel (403 NOT_YOURS).
 * 8. An OAuth-ingested item dedupes against the same item ingested manually earlier.
 * 9. Resubmission / tombstone restoration through OAuth ingestion.
 * 10. Public channel serialization (isVerified) accurately reflects verification state.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-oauth.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { addChannel, listPublicChannels } from './engine/creator-channels.js';
import { scrubPulseItems } from './engine/pulse-resolver.js';
import { createChannelRoutes } from './routes/channels.js';
import { createPulseSubmitRoutes, rowToPulseFeedCard } from './routes/pulse-submit.js';
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

let channelRouter: any;
let pulseSubmitRouter: any;

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: { actor?: string; body?: Record<string, unknown>; params?: Record<string, string> } = {}
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
    channelRouter = createChannelRoutes(deps);
    pulseSubmitRouter = createPulseSubmitRoutes(deps);

    const alice = makeMember('Alice');
    const bob = makeMember('Bob');

    console.log('\n--- 1. OAuth Platform Configuration Endpoint ---');
    // Ensure clean env for baseline check
    const origTiktok = process.env.TIKTOK_CLIENT_KEY;
    const origIg = process.env.INSTAGRAM_APP_ID;
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_ID;
    delete process.env.INSTAGRAM_APP_ID;

    const unconfigured = await callRouter(pulseSubmitRouter, 'GET', '/api/pulse/oauth/config');
    assert(unconfigured.status === 200, 'GET /api/pulse/oauth/config returns 200');
    assert(unconfigured.body.tiktok.enabled === false, 'TikTok is disabled when TIKTOK_CLIENT_KEY is unset');
    assert(unconfigured.body.instagram.enabled === false, 'Instagram is disabled when INSTAGRAM_APP_ID is unset');

    const optionsRes = await callRouter(channelRouter, 'GET', '/api/channels/options');
    assert(optionsRes.status === 200 && optionsRes.body.oauth !== undefined, 'GET /api/channels/options includes oauth config');
    assert(optionsRes.body.oauth.tiktok.enabled === false, 'Options oauth reflects disabled TikTok');

    // Test with configured key
    process.env.TIKTOK_CLIENT_KEY = 'test_tiktok_client_key_123';
    process.env.TIKTOK_CLIENT_SECRET = 'test_tiktok_secret_456';
    const configured = await callRouter(pulseSubmitRouter, 'GET', '/api/pulse/oauth/config');
    assert(configured.body.tiktok.enabled === true, 'TikTok is enabled when client key is provided');
    assert(configured.body.tiktok.clientKey === 'test_tiktok_client_key_123', 'TikTok clientKey is returned');

    // 1b: Test redirect_uri whitelist rejection in oauth-exchange
    const badRedirectExchange = await callRouter(channelRouter, 'POST', '/api/member/pulse/oauth-exchange', {
        actor: alice,
        body: {
            platform: 'tiktok',
            grantType: 'authorization_code',
            code: 'test_code',
            redirectUri: 'https://evil-attacker.com/oauth/callback',
        },
    });
    assert(badRedirectExchange.status === 400, 'Unauthorized redirectUri rejected with 400');
    assert(badRedirectExchange.body.error.includes('Unauthorized redirect URI'), 'Error names unauthorized redirect URI');

    console.log('\n--- 2. Channel Ownership & Verification Enforcement ---');
    const aliceTikTok = addChannel({
        ownerPubkey: alice,
        platform: 'tiktok',
        raw: '@alice_pottery',
        category: 'craft',
    });
    assert(aliceTikTok.id.startsWith('chan_'), 'Created TikTok channel for Alice');
    assert(aliceTikTok.oauthVerifiedAt === null, 'Newly added channel has oauthVerifiedAt = null');
    assert(aliceTikTok.supportsAutolist === false, 'Newly added TikTok channel has supportsAutolist = false');

    // 2a: Unsigned request is rejected
    const unauthVerify = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/verify-oauth`, {
        body: { platform: 'tiktok', platformUsername: 'alice_pottery' },
    });
    assert(unauthVerify.status === 401, 'Unsigned verify request is rejected with 401');

    // 2b: Bob cannot verify Alice's channel
    const bobVerifyAlice = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/verify-oauth`, {
        actor: bob,
        body: { platform: 'tiktok', platformUsername: 'alice_pottery' },
    });
    assert(bobVerifyAlice.status === 403, 'Bob cannot verify Alice channel (403 NOT_YOURS)');

    // 2c: Platform mismatch
    const badPlatform = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/verify-oauth`, {
        actor: alice,
        body: { platform: 'instagram', platformUsername: 'alice_pottery' },
    });
    assert(badPlatform.status === 400, 'Platform mismatch is rejected with 400');

    // 2d: Account handle mismatch is refused
    const mismatchedVerify = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/verify-oauth`, {
        actor: alice,
        body: { platform: 'tiktok', platformUsername: 'carol_ceramics' },
    });
    assert(mismatchedVerify.status === 400, 'Mismatched account handle is refused with 400 ACCOUNT_MISMATCH');
    assert(mismatchedVerify.body.error === 'account_mismatch', 'Error code is account_mismatch');

    // 2e: Matching handle succeeds and verifies channel
    const validVerify = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/verify-oauth`, {
        actor: alice,
        body: { platform: 'tiktok', platformUsername: 'alice_pottery' },
    });
    assert(validVerify.status === 200, 'Valid verification returns 200');
    assert(typeof validVerify.body.channel.oauthVerifiedAt === 'string', 'channel.oauthVerifiedAt is now populated');
    assert(validVerify.body.channel.supportsAutolist === true, 'channel.supportsAutolist is flipped to true');

    // Verify public view shows verified
    const publicChips = listPublicChannels(alice);
    const alicePubChan = publicChips.find(c => c.id === aliceTikTok.id);
    assert(alicePubChan?.isVerified === true, 'listPublicChannels returns isVerified: true for verified channel');

    // 2f: Channel URL with query params / tracking still verifies for rightful owner (Fix 2)
    const chanWithQuery = addChannel({
        ownerPubkey: alice,
        platform: 'instagram',
        raw: 'https://www.instagram.com/alice_pottery?igshid=abc123tracking&utm_source=feed#bio',
        category: 'craft',
    });
    // Explicitly null the handle to ensure URL pattern matching logic is exercising matchesUrl
    db.prepare('UPDATE creator_channels SET handle = NULL, url = ? WHERE id = ?')
        .run('https://www.instagram.com/alice_pottery?igshid=abc123tracking&utm_source=feed#bio', chanWithQuery.id);

    const verifyChanWithQuery = await callRouter(channelRouter, 'POST', `/api/member/channels/${chanWithQuery.id}/verify-oauth`, {
        actor: alice,
        body: { platform: 'instagram', platformUsername: 'alice_pottery' },
    });
    assert(verifyChanWithQuery.status === 200, 'Channel URL carrying query string verifies for rightful owner (Fix 2)');
    assert(typeof verifyChanWithQuery.body.channel.oauthVerifiedAt === 'string', 'Channel with query string is marked oauthVerifiedAt');

    console.log('\n--- 3. OAuth Ingestion & Deduplication Against Manual Submission ---');
    const testVideoUrl = 'https://www.tiktok.com/@alice_pottery/video/7100000000000000001';

    // 3a: Non-owner cannot ingest OAuth items for another member's channel
    const bobOauthIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: bob,
        body: {
            channelId: aliceTikTok.id,
            items: [{ url: testVideoUrl, title: 'Handmade bowl' }],
        },
    });
    assert(bobOauthIngest.status === 403, 'Bob cannot ingest OAuth items for Alice channel (403 NOT_YOURS)');

    // 3b: First submit item manually via Phase 4 endpoint
    const manualSubmit = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/submit', {
        actor: alice,
        body: {
            url: testVideoUrl,
            title: 'Handmade bowl manual',
        },
    });
    assert(manualSubmit.status === 200, 'Manual submission succeeded');
    const manualItem = manualSubmit.body.item;
    assert(manualItem.source === 'manual', 'Manual item has source = manual');

    // Check DB row
    const dbItem1 = db.prepare('SELECT * FROM pulse_items WHERE id = ?').get(manualItem.id) as any;
    assert(dbItem1.source === 'manual', 'DB row has source = manual');

    // 3c: Ingest same video via OAuth batch ingest endpoint
    const oauthIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceTikTok.id,
            items: [
                {
                    url: testVideoUrl,
                    title: 'Handmade bowl updated from OAuth',
                    thumbnailUrl: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
                    publishedAt: '2026-08-15T10:00:00Z',
                    externalId: '7100000000000000001',
                },
            ],
        },
    });
    assert(oauthIngest.status === 200, 'OAuth ingestion endpoint returns 200');
    assert(oauthIngest.body.count === 1, 'Ingested 1 item');
    assert(oauthIngest.body.deduplicatedCount === 1, 'Item was detected as existing and deduplicated');

    // Ensure no duplicate row was created
    const countItems = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL')
        .get(aliceTikTok.id) as any).c;
    assert(countItems === 1, 'Only 1 active pulse item exists in DB (no duplicates)');

    // Verify card rendering has verified tick
    const feedCard = rowToPulseFeedCard(manualItem.id);
    assert(feedCard.isVerified === true, 'rowToPulseFeedCard returns isVerified: true for item on verified channel');

    // 3d: Non-http(s) itemUrl (e.g. javascript: or data:) is refused rather than stored (Fix 3)
    const jsItemIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceTikTok.id,
            items: [
                {
                    url: 'javascript:alert(1)',
                    title: 'XSS attempt',
                },
                {
                    url: 'data:text/html,<script>alert(1)</script>',
                    title: 'Data URL attempt',
                },
            ],
        },
    });
    assert(jsItemIngest.status === 200, 'OAuth ingest returned 200');
    assert(jsItemIngest.body.count === 0, 'Non-http(s) itemUrls are refused (count = 0) (Fix 3)');

    // 3e: Non-http(s) thumbnailUrl (e.g. javascript: or data:) is refused rather than stored (Fix 3)
    const jsThumbIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceTikTok.id,
            items: [
                {
                    url: 'https://www.tiktok.com/@alice_pottery/video/7100000000000000002',
                    title: 'Bad thumb item',
                    thumbnailUrl: 'javascript:alert(1)',
                },
                {
                    url: 'https://www.tiktok.com/@alice_pottery/video/7100000000000000003',
                    title: 'Data thumb item',
                    thumbnailUrl: 'data:image/png;base64,bad',
                },
            ],
        },
    });
    assert(jsThumbIngest.status === 200, 'OAuth ingest returned 200');
    assert(jsThumbIngest.body.count === 0, 'Items with non-http(s) thumbnailUrl are refused (count = 0) (Fix 3)');

    // 3f: Valid thumbnail up to 4096 characters is accepted (Fix 3)
    const longThumbUrl = 'https://p16-sign.tiktokcdn.com/' + 'a'.repeat(3000) + '.jpg';
    const longThumbIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceTikTok.id,
            items: [
                {
                    url: 'https://www.tiktok.com/@alice_pottery/video/7100000000000000004',
                    title: 'Long thumbnail video',
                    thumbnailUrl: longThumbUrl,
                },
            ],
        },
    });
    assert(longThumbIngest.status === 200, 'Long thumbnail ingest returned 200');
    assert(longThumbIngest.body.count === 1, 'Long thumbnail URL up to 4096 chars is accepted (Fix 3)');

    console.log('\n--- 4. Resubmission & Tombstone Restoration via OAuth ---');
    const now = new Date().toISOString();
    scrubPulseItems({ channelId: aliceTikTok.id }, now);

    const tombstonedRow = db.prepare('SELECT * FROM pulse_items WHERE id = ?').get(manualItem.id) as any;
    assert(tombstonedRow.deleted_at !== null, 'Item is tombstoned');

    // Re-ingesting restored the tombstone
    const restoreIngest = await callRouter(pulseSubmitRouter, 'POST', '/api/member/pulse/oauth-ingest', {
        actor: alice,
        body: {
            channelId: aliceTikTok.id,
            items: [
                {
                    url: testVideoUrl,
                    title: 'Handmade bowl restored',
                    thumbnailUrl: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
                    externalId: '7100000000000000001',
                },
            ],
        },
    });
    assert(restoreIngest.status === 200, 'Re-ingestion succeeded');
    const restoredRow = db.prepare('SELECT * FROM pulse_items WHERE id = ?').get(manualItem.id) as any;
    assert(restoredRow.deleted_at === null, 'Tombstoned item is restored (deleted_at is NULL)');
    assert(restoredRow.source === 'oauth', 'Restored item source is now oauth');

    console.log('\n--- 5. Disconnect Flow & Item Preservation ---');
    // 5a: Bob cannot disconnect Alice's channel
    const bobDisconnectAlice = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/disconnect-oauth`, {
        actor: bob,
    });
    assert(bobDisconnectAlice.status === 403, 'Bob cannot disconnect Alice channel (403 NOT_YOURS)');

    // 5b: Alice disconnects her channel
    const disconnectRes = await callRouter(channelRouter, 'POST', `/api/member/channels/${aliceTikTok.id}/disconnect-oauth`, {
        actor: alice,
    });
    assert(disconnectRes.status === 200, 'Disconnect returns 200');
    assert(disconnectRes.body.channel.oauthVerifiedAt === null, 'oauthVerifiedAt is cleared to NULL');
    assert(disconnectRes.body.channel.supportsAutolist === false, 'supportsAutolist is reset to false');

    // 5c: Verify previously ingested items still exist in DB
    const preservedCount = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL')
        .get(aliceTikTok.id) as any).c;
    assert(preservedCount === 1, 'Previously ingested feed items are preserved after disconnect');

    // 5d: Public channel reflects disconnected state
    const publicChipsAfterDisconnect = listPublicChannels(alice);
    const alicePubChanAfter = publicChipsAfterDisconnect.find(c => c.id === aliceTikTok.id);
    assert(alicePubChanAfter?.isVerified === false, 'listPublicChannels returns isVerified: false after disconnect');

    // Clean up test env
    if (origTiktok) process.env.TIKTOK_CLIENT_KEY = origTiktok; else delete process.env.TIKTOK_CLIENT_KEY;
    if (origIg) process.env.INSTAGRAM_APP_ID = origIg; else delete process.env.INSTAGRAM_APP_ID;

    console.log(`\n========================================`);
    console.log(`Phase 5 OAuth Suite: ${passed}/${run} tests passed.`);
    console.log(`========================================\n`);

    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
