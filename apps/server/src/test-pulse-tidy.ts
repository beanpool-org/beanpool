/**
 * Pulse Tidy Test Suite:
 * 1. Table test for cross-channel feed deduplication in getPulseFeed (same platform + external_id
 *    shows one card, seeded BeanPool channel preferred, otherwise earliest; different ids or
 *    platforms show both; member's own duplicate row is never deleted; pagination stays clean).
 * 2. Resolver gone-at-source tests with an injected fetchFn:
 *    - video missing from YouTube RSS + oEmbed 404 -> tombstoned via scrubPulseItems with fresh updated_at
 *    - video missing from YouTube RSS + oEmbed 401 (embedding disabled / restricted) -> kept
 *    - video missing from YouTube RSS + oEmbed 200 -> kept (and cached when useOEmbedCache is enabled)
 *    - RSS fetch failed (network error) / 5xx / 429 / partial XML -> kept
 *    - oEmbed 403 / 5xx / 429 / network error -> kept and aborts loop immediately
 *    - aged out of the 15-video RSS window with oEmbed 200 -> kept
 *    - oEmbed requests strictly target https://www.youtube.com/oembed with maxRedirects: 0
 *    - non-YouTube rss/website channels never trigger YouTube oEmbed probes
 *    - EXPLAIN QUERY PLAN verifies zero temp B-trees on feed & liveAutolist queries
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-tidy.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { addChannel } from './engine/creator-channels.js';
import { BEANPOOL_LEARN_CHANNEL_ID, seedPulseCurated } from './engine/pulse-seed.js';
import {
    getPulseFeed,
    resolveChannel,
    setPulseItemMute,
    isCompleteFeedXml,
    resetYouTubeOEmbedStateForTests,
    type SsrfSafeFetchOptions,
    type SsrfSafeResponse,
} from './engine/pulse-resolver.js';

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pub, callsign);
    return pub;
}

function makeResponse(status: number, body: string, url: string, contentType = 'application/atom+xml'): SsrfSafeResponse {
    return {
        status,
        statusText: status === 200 ? 'OK' : `HTTP ${status}`,
        headers: { 'content-type': contentType },
        url,
        buffer: async () => Buffer.from(body, 'utf-8'),
        text: async () => body,
        json: async <T = unknown>() => JSON.parse(body) as T,
    };
}

function youtubeAtomFeed(videos: Array<{ id: string; title: string; publishedAt: string }>): string {
    const entries = videos.map((v) => `
      <entry>
        <id>yt:video:${v.id}</id>
        <yt:videoId>${v.id}</yt:videoId>
        <title>${v.title}</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=${v.id}"/>
        <published>${v.publishedAt}</published>
        <media:group>
          <media:thumbnail url="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" width="480" height="360"/>
        </media:group>
      </entry>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Test YouTube Channel</title>
  ${entries}
</feed>`;
}

interface SeedRow {
    id: string;
    channelId: string;
    ownerPubkey: string;
    platform: string;
    externalId: string | null;
    publishedAt: string;
    createdAt: string;
    category?: string;
    source?: string;
    curated?: number;
}

function insertItem(r: SeedRow): void {
    const url = r.platform === 'youtube' && r.externalId
        ? `https://www.youtube.com/watch?v=${r.externalId}`
        : `https://example.org/${r.id}`;
    db.prepare(
        `INSERT INTO pulse_items
            (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url,
             published_at, category, source, muted, curated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
        r.id,
        r.channelId,
        r.ownerPubkey,
        r.platform,
        r.externalId,
        url,
        `Title ${r.id}`,
        `https://i.ytimg.com/vi/${r.externalId ?? r.id}/hqdefault.jpg`,
        r.publishedAt,
        r.category ?? 'learn',
        r.source ?? 'autolist',
        r.curated ?? 0,
        r.createdAt,
        r.createdAt,
    );
}

async function main(): Promise<void> {
    console.log('=== Pulse Tidy Test Suite ===\n');
    initStateEngine();
    seedPulseCurated();

    const beanpoolChan = db.prepare(
        `SELECT id, owner_pubkey FROM creator_channels WHERE id = ?`
    ).get(BEANPOOL_LEARN_CHANNEL_ID) as { id: string; owner_pubkey: string };
    assert(Boolean(beanpoolChan), 'Seeded BeanPool learn channel exists');

    const alice = makeMember('AliceMaker');
    const bob = makeMember('BobMaker');
    const chAliceYt = addChannel({
        ownerPubkey: alice,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC1111111111111111111111',
        category: 'learn',
    });
    const chBobYt = addChannel({
        ownerPubkey: bob,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC2222222222222222222222',
        category: 'learn',
    });
    const chBobTikTok = addChannel({
        ownerPubkey: bob,
        platform: 'tiktok',
        raw: 'https://www.tiktok.com/@bobmaker',
        category: 'learn',
    });

    // Clear curated items so each table case has an exact, minimal item set.
    const clearItems = () => db.prepare('DELETE FROM pulse_items').run();

    // ── 1. Table test: Cross-channel feed deduplication ─────────────────────────────────
    console.log('--- 1. Feed Deduplication (Table Test) ---');

    interface DedupeCase {
        name: string;
        rows: SeedRow[];
        expectedFeedIds: string[];
        mustStillExistLive: string[];
    }

    const dedupeCases: DedupeCase[] = [
        {
            name: 'same video on BeanPool and member channel -> one card, BeanPool preferred even when member row is earlier & newer-dated',
            rows: [
                {
                    id: 'item_alice_dup',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidShared01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T08:00:00.000Z',
                },
                {
                    id: 'item_bp_dup',
                    channelId: beanpoolChan.id,
                    ownerPubkey: beanpoolChan.owner_pubkey,
                    platform: 'youtube',
                    externalId: 'vidShared01',
                    publishedAt: '2026-11-25T10:00:00.000Z',
                    createdAt: '2026-11-25T09:00:00.000Z',
                },
            ],
            expectedFeedIds: ['item_bp_dup'],
            mustStillExistLive: ['item_bp_dup', 'item_alice_dup'],
        },
        {
            name: 'same video on two member channels (neither BeanPool) -> one card, earliest created_at wins',
            rows: [
                {
                    id: 'item_bob_later',
                    channelId: chBobYt.id,
                    ownerPubkey: bob,
                    platform: 'youtube',
                    externalId: 'vidShared02',
                    publishedAt: '2026-11-25T11:00:00.000Z',
                    createdAt: '2026-11-25T11:05:00.000Z',
                },
                {
                    id: 'item_alice_earlier',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidShared02',
                    publishedAt: '2026-11-25T11:00:00.000Z',
                    createdAt: '2026-11-25T10:00:00.000Z',
                },
            ],
            expectedFeedIds: ['item_alice_earlier'],
            mustStillExistLive: ['item_alice_earlier', 'item_bob_later'],
        },
        {
            name: 'different video ids on two channels -> both cards shown',
            rows: [
                {
                    id: 'item_bp_unique',
                    channelId: beanpoolChan.id,
                    ownerPubkey: beanpoolChan.owner_pubkey,
                    platform: 'youtube',
                    externalId: 'vidUnique01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T12:00:00.000Z',
                },
                {
                    id: 'item_alice_unique',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidUnique02',
                    publishedAt: '2026-11-25T11:00:00.000Z',
                    createdAt: '2026-11-25T11:00:00.000Z',
                },
            ],
            expectedFeedIds: ['item_bp_unique', 'item_alice_unique'],
            mustStillExistLive: ['item_bp_unique', 'item_alice_unique'],
        },
        {
            name: 'same external_id on different platforms -> both cards shown',
            rows: [
                {
                    id: 'item_yt_sameid',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'shared12345',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T12:00:00.000Z',
                },
                {
                    id: 'item_tt_sameid',
                    channelId: chBobTikTok.id,
                    ownerPubkey: bob,
                    platform: 'tiktok',
                    externalId: 'shared12345',
                    publishedAt: '2026-11-25T11:00:00.000Z',
                    createdAt: '2026-11-25T11:00:00.000Z',
                },
            ],
            expectedFeedIds: ['item_yt_sameid', 'item_tt_sameid'],
            mustStillExistLive: ['item_yt_sameid', 'item_tt_sameid'],
        },
        {
            name: 'items with NULL external_id on same platform -> never collapsed',
            rows: [
                {
                    id: 'item_null_1',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: null,
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T12:00:00.000Z',
                },
                {
                    id: 'item_null_2',
                    channelId: chBobYt.id,
                    ownerPubkey: bob,
                    platform: 'youtube',
                    externalId: null,
                    publishedAt: '2026-11-25T11:00:00.000Z',
                    createdAt: '2026-11-25T11:00:00.000Z',
                },
            ],
            expectedFeedIds: ['item_null_1', 'item_null_2'],
            mustStillExistLive: ['item_null_1', 'item_null_2'],
        },
    ];

    for (const tc of dedupeCases) {
        clearItems();
        for (const r of tc.rows) insertItem(r);
        const feed = getPulseFeed({ limit: 20 });
        const gotIds = feed.items.map((i) => i.id);
        assert(
            JSON.stringify(gotIds) === JSON.stringify(tc.expectedFeedIds),
            `${tc.name} (got ${JSON.stringify(gotIds)})`
        );
        for (const id of tc.mustStillExistLive) {
            const row = db.prepare('SELECT deleted_at, url, title FROM pulse_items WHERE id = ?').get(id) as
                { deleted_at: string | null; url: string | null; title: string | null } | undefined;
            assert(
                Boolean(row && row.deleted_at === null && row.url !== null && row.title !== null),
                `row ${id} was not deleted or scrubbed (${tc.name})`
            );
        }
    }

    // Pagination + non-destructive fallback when winner is muted
    clearItems();
    insertItem({
        id: 'item_p_alice_dup',
        channelId: chAliceYt.id,
        ownerPubkey: alice,
        platform: 'youtube',
        externalId: 'vidPageDup1',
        publishedAt: '2026-11-25T15:00:00.000Z', // newer than BeanPool's copy
        createdAt: '2026-11-25T09:00:00.000Z',
    });
    insertItem({
        id: 'item_p_other',
        channelId: chBobYt.id,
        ownerPubkey: bob,
        platform: 'youtube',
        externalId: 'vidPageOth1',
        publishedAt: '2026-11-25T14:00:00.000Z',
        createdAt: '2026-11-25T10:00:00.000Z',
    });
    insertItem({
        id: 'item_p_bp_win',
        channelId: beanpoolChan.id,
        ownerPubkey: beanpoolChan.owner_pubkey,
        platform: 'youtube',
        externalId: 'vidPageDup1',
        publishedAt: '2026-11-25T13:00:00.000Z',
        createdAt: '2026-11-25T11:00:00.000Z',
    });

    const seenPaginated: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
        const page = getPulseFeed({ limit: 1, cursor });
        seenPaginated.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    assert(
        JSON.stringify(seenPaginated) === JSON.stringify(['item_p_other', 'item_p_bp_win']),
        `Cursor pagination (limit=1) keeps BeanPool winner and never leaks losing duplicate across pages (got ${JSON.stringify(seenPaginated)})`
    );

    // If BeanPool's copy is muted, Alice's intact row surfaces cleanly.
    setPulseItemMute(beanpoolChan.owner_pubkey, 'item_p_bp_win', true);
    const afterMuteIds = getPulseFeed({ limit: 10 }).items.map((i) => i.id);
    assert(
        JSON.stringify(afterMuteIds) === JSON.stringify(['item_p_alice_dup', 'item_p_other']),
        `Muting winner lets member's preserved duplicate surface (got ${JSON.stringify(afterMuteIds)})`
    );

    // 1b. Security tie-breakers: curated/admin BeanPool > OAuth-verified > autolist > oauth > manual
    const chAliceVerified = addChannel({
        ownerPubkey: alice,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC3333333333333333333333',
        category: 'learn',
    });
    db.prepare(`UPDATE creator_channels SET oauth_verified_at = '2026-11-20T00:00:00.000Z' WHERE id = ?`).run(chAliceVerified.id);

    const chAdminBeanPool = addChannel({
        ownerPubkey: beanpoolChan.owner_pubkey,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC4444444444444444444444',
        category: 'learn',
    });

    const carol = makeMember('CarolMaker');
    const chCarolYt = addChannel({
        ownerPubkey: carol,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC5555555555555555555555',
        category: 'learn',
    });

    const securityTieBreakerCases: DedupeCase[] = [
        {
            name: 'OAuth-verified channel beats earlier unverified channel',
            rows: [
                {
                    id: 'item_unverified_early',
                    channelId: chBobYt.id,
                    ownerPubkey: bob,
                    platform: 'youtube',
                    externalId: 'vidSecVer01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T08:00:00.000Z',
                    source: 'autolist',
                },
                {
                    id: 'item_verified_later',
                    channelId: chAliceVerified.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidSecVer01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T10:00:00.000Z',
                    source: 'autolist',
                },
            ],
            expectedFeedIds: ['item_verified_later'],
            mustStillExistLive: ['item_unverified_early', 'item_verified_later'],
        },
        {
            name: 'autolist feed item beats earlier manual front-run and unverified oauth ingest',
            rows: [
                {
                    id: 'item_manual_squat',
                    channelId: chBobYt.id,
                    ownerPubkey: bob,
                    platform: 'youtube',
                    externalId: 'vidSecSrc01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T07:00:00.000Z',
                    source: 'manual',
                },
                {
                    id: 'item_oauth_squat',
                    channelId: chCarolYt.id,
                    ownerPubkey: carol,
                    platform: 'youtube',
                    externalId: 'vidSecSrc01',
                    publishedAt: '2020-01-01T00:00:00.000Z',
                    createdAt: '2026-11-25T07:30:00.000Z',
                    source: 'oauth',
                },
                {
                    id: 'item_real_autolist',
                    channelId: chAliceYt.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidSecSrc01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T09:00:00.000Z',
                    source: 'autolist',
                },
            ],
            expectedFeedIds: ['item_real_autolist'],
            mustStillExistLive: ['item_manual_squat', 'item_oauth_squat', 'item_real_autolist'],
        },
        {
            name: 'admin-added BeanPool channel beats earlier OAuth-verified member channel',
            rows: [
                {
                    id: 'item_member_verified',
                    channelId: chAliceVerified.id,
                    ownerPubkey: alice,
                    platform: 'youtube',
                    externalId: 'vidSecAdm01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T08:00:00.000Z',
                    source: 'autolist',
                },
                {
                    id: 'item_bp_admin_chan',
                    channelId: chAdminBeanPool.id,
                    ownerPubkey: beanpoolChan.owner_pubkey,
                    platform: 'youtube',
                    externalId: 'vidSecAdm01',
                    publishedAt: '2026-11-25T12:00:00.000Z',
                    createdAt: '2026-11-25T09:00:00.000Z',
                    source: 'autolist',
                },
            ],
            expectedFeedIds: ['item_bp_admin_chan'],
            mustStillExistLive: ['item_member_verified', 'item_bp_admin_chan'],
        },
    ];

    for (const tc of securityTieBreakerCases) {
        clearItems();
        for (const r of tc.rows) {
            insertItem(r);
        }
        const feed = getPulseFeed({ limit: 20 });
        const gotIds = feed.items.map((i) => i.id);
        assert(
            JSON.stringify(gotIds) === JSON.stringify(tc.expectedFeedIds),
            `${tc.name} (got ${JSON.stringify(gotIds)})`
        );
        for (const id of tc.mustStillExistLive) {
            const row = db.prepare('SELECT deleted_at, url, title FROM pulse_items WHERE id = ?').get(id) as
                { deleted_at: string | null; url: string | null; title: string | null } | undefined;
            assert(
                Boolean(row && row.deleted_at === null && row.url !== null && row.title !== null),
                `row ${id} preserved live (${tc.name})`
            );
        }
    }

    // 1c. EXPLAIN QUERY PLAN checks (zero TEMP B-TREE on feed & liveAutolist queries)
    const feedPlan = (db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT i.id
           FROM pulse_items i
           CROSS JOIN creator_channels c ON c.id = i.channel_id
           CROSS JOIN members m ON m.public_key = i.owner_pubkey
          WHERE i.deleted_at IS NULL AND i.muted = 0
            AND c.deleted_at IS NULL AND c.syndicate_to_node = 1
            AND m.status = 'active'
            AND (
                i.external_id IS NULL OR i.external_id = ''
                OR NOT EXISTS (
                    SELECT 1
                      FROM pulse_items i2
                      CROSS JOIN creator_channels c2 ON c2.id = i2.channel_id
                      CROSS JOIN members m2 ON m2.public_key = i2.owner_pubkey
                     WHERE i2.platform = i.platform
                       AND i2.external_id = i.external_id
                       AND i2.external_id IS NOT NULL AND i2.external_id != ''
                       AND i2.deleted_at IS NULL AND i2.muted = 0
                       AND i2.id != i.id
                       AND c2.deleted_at IS NULL AND c2.syndicate_to_node = 1
                       AND m2.status = 'active'
                       AND (CASE WHEN i2.channel_id = ? THEN 0 ELSE 1 END, i2.id)
                         < (CASE WHEN i.channel_id = ? THEN 0 ELSE 1 END, i.id)
                )
            )
          ORDER BY COALESCE(i.published_at, '') DESC, i.id DESC
          LIMIT 21`
    ).all(BEANPOOL_LEARN_CHANNEL_ID, BEANPOOL_LEARN_CHANNEL_ID) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
    assert(
        feedPlan.includes('idx_pulse_items_feed') && feedPlan.includes('idx_pulse_items_platform_ext') && !feedPlan.includes('TEMP B-TREE'),
        `getPulseFeed uses idx_pulse_items_feed + idx_pulse_items_platform_ext with zero TEMP B-TREE (${feedPlan})`
    );

    const catFeedPlan = (db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT i.id
           FROM pulse_items i
           CROSS JOIN creator_channels c ON c.id = i.channel_id
           CROSS JOIN members m ON m.public_key = i.owner_pubkey
          WHERE i.deleted_at IS NULL AND i.muted = 0 AND i.category = 'learn'
            AND c.deleted_at IS NULL AND c.syndicate_to_node = 1
            AND m.status = 'active'
          ORDER BY COALESCE(i.published_at, '') DESC, i.id DESC
          LIMIT 21`
    ).all() as Array<{ detail: string }>).map(r => r.detail).join(' | ');
    assert(
        catFeedPlan.includes('idx_pulse_items_category_feed') && !catFeedPlan.includes('TEMP B-TREE'),
        `getPulseFeed(category) uses idx_pulse_items_category_feed with zero TEMP B-TREE (${catFeedPlan})`
    );

    const channelLivePlan = (db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, platform, external_id, url
           FROM pulse_items
          WHERE channel_id = ? AND deleted_at IS NULL AND source = 'autolist' AND curated = 0
          ORDER BY COALESCE(published_at, '') DESC, id DESC`
    ).all(chAliceYt.id) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
    assert(
        channelLivePlan.includes('idx_pulse_items_channel_live') && !channelLivePlan.includes('TEMP B-TREE'),
        `liveAutolist query uses idx_pulse_items_channel_live with zero TEMP B-TREE (${channelLivePlan})`
    );

    // ── 2. Resolver gone-at-source tests with injected fetchFn ──────────────────────────
    console.log('\n--- 2. Gone-at-Source Resolver Tests ---');

    assert(isCompleteFeedXml(youtubeAtomFeed([])), 'isCompleteFeedXml accepts complete Atom feed');
    assert(!isCompleteFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Cut off'), 'isCompleteFeedXml rejects truncated Atom feed');
    assert(!isCompleteFeedXml('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), 'isCompleteFeedXml rejects HTML error page');
    assert(
        !isCompleteFeedXml('<?xml version="1.0"?><rdf:RDF><channel><title>RSS 1.0</title></channel><item><title>Truncated'),
        'isCompleteFeedXml rejects RSS 1.0 truncated after </channel> before </rdf:RDF>'
    );
    assert(
        isCompleteFeedXml('<?xml version="1.0"?><rdf:RDF><channel><title>RSS 1.0</title></channel><item><title>Ok</title></item></rdf:RDF>'),
        'isCompleteFeedXml accepts complete RSS 1.0 feed ending with </rdf:RDF>'
    );
    assert(
        !isCompleteFeedXml('<?xml version="1.0"?><rss version="2.0"><channel><title>RSS 2.0</title></channel>'),
        'isCompleteFeedXml rejects RSS 2.0 missing </rss>'
    );
    assert(
        isCompleteFeedXml('<?xml version="1.0"?><rss version="2.0"><channel><title>RSS 2.0</title></channel></rss>'),
        'isCompleteFeedXml accepts complete RSS 2.0 feed'
    );
    const redosStart = Date.now();
    const redosPayload = '<feed xmlns="http://www.w3.org/2005/Atom">' + '<!--'.repeat(50000);
    const redosComplete = isCompleteFeedXml(redosPayload);
    const redosElapsedMs = Date.now() - redosStart;
    assert(
        !redosComplete && redosElapsedMs < 500,
        `isCompleteFeedXml handles 50k unclosed XML comments in O(N) without ReDoS (${redosElapsedMs}ms)`
    );

    clearItems();
    const ytChan = addChannel({
        ownerPubkey: alice,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC9999999999999999999999',
        category: 'craft',
    });
    const feedEndpoint = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9999999999999999999999';

    // Seed initial live items via a real resolveChannel call
    const initialVideos = [
        { id: 'ufwPPP0oZZA', title: 'Old Upload To Delete', publishedAt: '2026-11-25T10:00:00.000Z' },
        { id: 'privVid0001', title: 'Made Private Video', publishedAt: '2026-11-25T09:00:00.000Z' },
        { id: 'liveMiss001', title: 'Missing From Feed But Still Live', publishedAt: '2026-11-25T08:00:00.000Z' },
        { id: 'keptInRss01', title: 'Still In RSS Feed', publishedAt: '2026-11-25T11:00:00.000Z' },
    ];

    const seedRes = await resolveChannel(ytChan.id, {
        fetchFn: async (url) => {
            if (url === feedEndpoint) return makeResponse(200, youtubeAtomFeed(initialVideos), url);
            throw new Error(`Unexpected fetch during seed: ${url}`);
        },
    });
    assert(!seedRes.error && seedRes.count === 4, `Seeded 4 YouTube autolist items (count=${seedRes.count})`);

    // Also add a manually submitted item on the same channel (must never be tombstoned by RSS sweep)
    insertItem({
        id: 'item_manual_yt',
        channelId: ytChan.id,
        ownerPubkey: alice,
        platform: 'youtube',
        externalId: 'manualVid01',
        publishedAt: '2026-11-25T07:00:00.000Z',
        createdAt: '2026-11-25T07:00:00.000Z',
        category: 'craft',
        source: 'manual',
    });

    const rowState = (extId: string) => db.prepare(
        `SELECT id, deleted_at, url, title, thumbnail_url FROM pulse_items WHERE channel_id = ? AND external_id = ?`
    ).get(ytChan.id, extId) as {
        id: string;
        deleted_at: string | null;
        url: string | null;
        title: string | null;
        thumbnail_url: string | null;
    };

    // 2a. RSS fetch failures (network error, 5xx, 429, truncated XML): NEVER tombstone, NEVER probe oEmbed
    const rssFailureCases: Array<{
        name: string;
        fetchFn: (url: string, opts?: SsrfSafeFetchOptions) => Promise<SsrfSafeResponse>;
    }> = [
        {
            name: 'RSS network error keeps all items',
            fetchFn: async (url) => {
                if (url === feedEndpoint) throw new Error('ECONNRESET');
                throw new Error(`oEmbed must not be called on RSS network error: ${url}`);
            },
        },
        {
            name: 'RSS HTTP 500 keeps all items',
            fetchFn: async (url) => {
                if (url === feedEndpoint) return makeResponse(500, 'Internal Server Error', url, 'text/plain');
                throw new Error(`oEmbed must not be called on RSS 500: ${url}`);
            },
        },
        {
            name: 'RSS HTTP 503 keeps all items',
            fetchFn: async (url) => {
                if (url === feedEndpoint) return makeResponse(503, 'Service Unavailable', url, 'text/plain');
                throw new Error(`oEmbed must not be called on RSS 503: ${url}`);
            },
        },
        {
            name: 'RSS HTTP 429 keeps all items',
            fetchFn: async (url) => {
                if (url === feedEndpoint) return makeResponse(429, 'Too Many Requests', url, 'text/plain');
                throw new Error(`oEmbed must not be called on RSS 429: ${url}`);
            },
        },
        {
            name: 'RSS HTTP 200 with truncated/partial XML keeps all items',
            fetchFn: async (url) => {
                if (url === feedEndpoint) {
                    return makeResponse(200, '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><yt:videoId>keptInRss01</yt:videoId>', url);
                }
                throw new Error(`oEmbed must not be called on partial XML: ${url}`);
            },
        },
    ];

    for (const fc of rssFailureCases) {
        await resolveChannel(ytChan.id, { fetchFn: fc.fetchFn });
        const liveCount = (db.prepare(
            `SELECT COUNT(*) AS c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL`
        ).get(ytChan.id) as { c: number }).c;
        assert(liveCount === 5, `${fc.name} (live=${liveCount}/5)`);
    }

    // 2b. Missing from RSS + oEmbed transient failures (5xx, 429, network error) -> kept
    const onlyKeptXml = youtubeAtomFeed([
        { id: 'keptInRss01', title: 'Still In RSS Feed', publishedAt: '2026-11-25T11:00:00.000Z' },
    ]);

    for (const oembedErr of [
        { label: 'oEmbed 500', handler: async (url: string) => makeResponse(500, 'Server Error', url, 'text/plain') },
        { label: 'oEmbed 403', handler: async (url: string) => makeResponse(403, 'Forbidden', url, 'text/plain') },
        { label: 'oEmbed 429', handler: async (url: string) => makeResponse(429, 'Rate Limited', url, 'text/plain') },
        { label: 'oEmbed network error', handler: async () => { throw new Error('ETIMEDOUT'); } },
    ]) {
        let abortProbeCount = 0;
        await resolveChannel(ytChan.id, {
            fetchFn: async (url) => {
                if (url === feedEndpoint) return makeResponse(200, onlyKeptXml, url);
                if (url.startsWith('https://www.youtube.com/oembed?')) {
                    abortProbeCount++;
                    return oembedErr.handler(url);
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        const liveCount = (db.prepare(
            `SELECT COUNT(*) AS c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL`
        ).get(ytChan.id) as { c: number }).c;
        assert(liveCount === 5, `Missing from RSS + ${oembedErr.label} keeps all items (live=${liveCount}/5)`);
        assert(abortProbeCount === 1, `${oembedErr.label} aborts probe loop after first error (probes=${abortProbeCount})`);
    }

    // 2c. Missing from RSS + oEmbed 404 -> tombstoned with fresh updated_at;
    //     missing + oEmbed 401 (disabled embedding) or 200 -> kept;
    //     oEmbed requests go strictly to www.youtube.com with maxRedirects: 0.
    const oembedCalls: Array<{ url: string; maxRedirects: number | undefined }> = [];
    const preTidyTime = new Date().toISOString();
    let afterOEmbedDelayTime = '';
    const tidyRes = await resolveChannel(ytChan.id, {
        fetchFn: async (url, opts) => {
            if (url === feedEndpoint) return makeResponse(200, onlyKeptXml, url);
            const parsed = new URL(url);
            assert(
                parsed.origin === 'https://www.youtube.com' && parsed.pathname === '/oembed',
                `oEmbed request targets https://www.youtube.com/oembed only (got ${parsed.origin}${parsed.pathname})`
            );
            oembedCalls.push({ url, maxRedirects: opts?.maxRedirects });
            const target = parsed.searchParams.get('url') ?? '';
            if (target.includes('ufwPPP0oZZA')) {
                await new Promise((r) => setTimeout(r, 25));
                afterOEmbedDelayTime = new Date().toISOString();
                return makeResponse(404, 'Not Found', url, 'text/plain');
            }
            if (target.includes('privVid0001')) return makeResponse(401, 'Unauthorized', url, 'text/plain');
            if (target.includes('liveMiss001')) return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            throw new Error(`Unexpected oEmbed target: ${target}`);
        },
    });

    assert(!tidyRes.error, `Resolve succeeded without error (${tidyRes.error ?? 'ok'})`);
    assert(tidyRes.tombstoned === 1, `Tombstoned 1 gone item (404 only; got ${tidyRes.tombstoned})`);
    assert(oembedCalls.every((c) => c.maxRedirects === 0), 'All oEmbed fetches pass maxRedirects: 0');
    assert(!oembedCalls.some((c) => c.url.includes('manualVid01')), 'Manual submission was not probed or tombstoned by RSS sweep');
    assert(!oembedCalls.some((c) => c.url.includes('keptInRss01')), 'Item present in RSS was not probed');

    const gone404Row = db.prepare(
        `SELECT id, deleted_at, url, title, thumbnail_url, updated_at FROM pulse_items WHERE channel_id = ? AND external_id = ?`
    ).get(ytChan.id, 'ufwPPP0oZZA') as {
        id: string;
        deleted_at: string | null;
        url: string | null;
        title: string | null;
        thumbnail_url: string | null;
        updated_at: string;
    };
    assert(
        gone404Row.deleted_at !== null && gone404Row.url === null && gone404Row.title === null && gone404Row.thumbnail_url === null,
        'Missing + oEmbed 404 item tombstoned with deleted_at set and url/title/thumbnail NULLed'
    );
    assert(
        gone404Row.updated_at > preTidyTime && gone404Row.updated_at >= afterOEmbedDelayTime,
        `Tombstone updated_at (${gone404Row.updated_at}) is freshly stamped after network probes (pre=${preTidyTime}, post=${afterOEmbedDelayTime})`
    );
    const kept401 = rowState('privVid0001');
    assert(
        kept401.deleted_at === null && kept401.url !== null && kept401.title !== null && kept401.thumbnail_url !== null,
        'Missing + oEmbed 401 (embedding disabled / restricted) item is kept intact and not falsely tombstoned'
    );
    const kept200 = rowState('liveMiss001');
    assert(
        kept200.deleted_at === null && kept200.url !== null && kept200.title !== null && kept200.thumbnail_url !== null,
        'Missing + oEmbed 200 item kept intact'
    );
    const keptPresent = rowState('keptInRss01');
    assert(keptPresent.deleted_at === null && keptPresent.url !== null, 'Item present in RSS kept intact');
    const keptManual = rowState('manualVid01');
    assert(keptManual.deleted_at === null && keptManual.url !== null, 'Manually submitted item kept intact');

    const feedAfterTombstone = getPulseFeed({ category: 'craft', limit: 20 }).items.map((i) => i.id);
    assert(!feedAfterTombstone.includes(gone404Row.id), 'Tombstoned 404 item no longer appears in getPulseFeed');
    assert(feedAfterTombstone.includes(kept401.id), 'oEmbed-401 kept item still appears in getPulseFeed');
    assert(feedAfterTombstone.includes(kept200.id), 'oEmbed-200 kept item still appears in getPulseFeed');

    // 2d. Aged out of the 15-video YouTube RSS window with oEmbed 200 -> kept
    clearItems();
    const agedChan = addChannel({
        ownerPubkey: bob,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UC8888888888888888888888',
        category: 'craft',
    });
    const agedFeedEndpoint = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC8888888888888888888888';

    // 18 live autolist items: 3 older ones (outside the 15-video YouTube RSS window) + 15 recent ones
    const agedOutIds = ['agedOut0001', 'agedOut0002', 'agedOut0003'];
    for (let i = 0; i < agedOutIds.length; i++) {
        insertItem({
            id: `item_aged_${i}`,
            channelId: agedChan.id,
            ownerPubkey: bob,
            platform: 'youtube',
            externalId: agedOutIds[i],
            publishedAt: `2026-10-0${i + 1}T12:00:00.000Z`,
            createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
            category: 'craft',
            source: 'autolist',
        });
    }
    const latest15 = Array.from({ length: 15 }, (_, i) => {
        const num = String(i + 1).padStart(2, '0');
        return {
            id: `recentVid${num}`,
            title: `Recent Video ${num}`,
            publishedAt: `2026-11-${num}T12:00:00.000Z`,
        };
    });

    const probedAgedIds: string[] = [];
    const agedRes = await resolveChannel(agedChan.id, {
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                const target = new URL(url).searchParams.get('url') ?? '';
                probedAgedIds.push(target);
                return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(!agedRes.error && !agedRes.tombstoned, `Aged-out RSS window visit tombstoned nothing (tombstoned=${agedRes.tombstoned ?? 0})`);
    assert(probedAgedIds.length === 3, `Probed the 3 items outside the 15-video RSS window (got ${probedAgedIds.length})`);
    const agedLive = db.prepare(
        `SELECT external_id, deleted_at, url FROM pulse_items WHERE channel_id = ? AND external_id IN ('agedOut0001','agedOut0002','agedOut0003')`
    ).all(agedChan.id) as Array<{ external_id: string; deleted_at: string | null; url: string | null }>;
    assert(
        agedLive.length === 3 && agedLive.every((r) => r.deleted_at === null && r.url !== null),
        'All 3 videos aged out of the 15-item RSS window with oEmbed 200 are kept intact'
    );

    // 2e. Live TTL cache, probe cap (3 per visit), and abort cooldown when cache is enabled
    resetYouTubeOEmbedStateForTests();
    for (let i = 3; i < 5; i++) {
        insertItem({
            id: `item_aged_${i}`,
            channelId: agedChan.id,
            ownerPubkey: bob,
            platform: 'youtube',
            externalId: `agedOut000${i + 1}`,
            publishedAt: `2026-10-0${i + 1}T12:00:00.000Z`,
            createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
            category: 'craft',
            source: 'autolist',
        });
    }
    const visit1Probes: string[] = [];
    await resolveChannel(agedChan.id, {
        useOEmbedCache: true,
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                visit1Probes.push(url);
                return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(visit1Probes.length === 3, `Probe cap limits visit 1 to 3 oEmbed checks out of 5 missing (got ${visit1Probes.length})`);

    const visit2Probes: string[] = [];
    await resolveChannel(agedChan.id, {
        useOEmbedCache: true,
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                visit2Probes.push(url);
                return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(visit2Probes.length === 2, `Live TTL cache skips the 3 cached videos and probes only the remaining 2 (got ${visit2Probes.length})`);

    const visit3Probes: string[] = [];
    await resolveChannel(agedChan.id, {
        useOEmbedCache: true,
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                visit3Probes.push(url);
                return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(visit3Probes.length === 0, `All 5 aged-out live videos cached -> 0 oEmbed probes on visit 3 (got ${visit3Probes.length})`);

    // Abort cooldown stops probing on subsequent visits after 403/429/5xx
    resetYouTubeOEmbedStateForTests();
    let cooldownProbes = 0;
    await resolveChannel(agedChan.id, {
        useOEmbedCache: true,
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                cooldownProbes++;
                return makeResponse(429, 'Too Many Requests', url, 'text/plain');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    await resolveChannel(agedChan.id, {
        useOEmbedCache: true,
        fetchFn: async (url) => {
            if (url === agedFeedEndpoint) return makeResponse(200, youtubeAtomFeed(latest15), url);
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                cooldownProbes++;
                return makeResponse(200, '{}', url, 'application/json');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(cooldownProbes === 1, `Abort cooldown prevents oEmbed probes on next visit after 429 (total probes=${cooldownProbes})`);
    resetYouTubeOEmbedStateForTests();

    // 2f. Non-YouTube rss/website channels must NOT trigger YouTube oEmbed probes (no amplification)
    const rssChan = addChannel({
        ownerPubkey: bob,
        platform: 'rss',
        raw: 'https://example.org/feed.xml',
        category: 'craft',
    });
    insertItem({
        id: 'item_rss_yt_link',
        channelId: rssChan.id,
        ownerPubkey: bob,
        platform: 'rss',
        externalId: 'rss-guid-1',
        publishedAt: '2026-11-25T10:00:00.000Z',
        createdAt: '2026-11-25T10:00:00.000Z',
        category: 'craft',
        source: 'autolist',
    });
    db.prepare(`UPDATE pulse_items SET url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' WHERE id = 'item_rss_yt_link'`).run();
    let rssOembedCalls = 0;
    const rssRes = await resolveChannel(rssChan.id, {
        fetchFn: async (url) => {
            if (url === 'https://example.org/feed.xml') {
                return makeResponse(200, '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>', url);
            }
            if (url.startsWith('https://www.youtube.com/oembed?')) {
                rssOembedCalls++;
                return makeResponse(404, 'Not Found', url, 'text/plain');
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    assert(!rssRes.error && rssOembedCalls === 0, `Non-YouTube RSS channel never calls YouTube oEmbed (calls=${rssOembedCalls})`);

    console.log(`\nResults: ${passed}/${run} tests passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
