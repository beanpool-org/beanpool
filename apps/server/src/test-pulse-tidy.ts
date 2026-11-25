/**
 * Pulse Tidy Test Suite:
 * 1. Table test for cross-channel feed deduplication in getPulseFeed (same platform + external_id
 *    shows one card, seeded BeanPool channel preferred, otherwise earliest; different ids or
 *    platforms show both; member's own duplicate row is never deleted; pagination stays clean).
 * 2. Resolver gone-at-source tests with an injected fetchFn:
 *    - video missing from YouTube RSS + oEmbed 404 / 401 -> tombstoned via scrubPulseItems
 *    - video missing from YouTube RSS + oEmbed 200 -> kept
 *    - RSS fetch failed (network error) / 5xx / 429 / partial XML -> kept
 *    - oEmbed 5xx / 429 / network error -> kept
 *    - aged out of the 15-video RSS window with oEmbed 200 -> kept
 *    - oEmbed requests strictly target https://www.youtube.com/oembed with maxRedirects: 0
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

    // ── 2. Resolver gone-at-source tests with injected fetchFn ──────────────────────────
    console.log('\n--- 2. Gone-at-Source Resolver Tests ---');

    assert(isCompleteFeedXml(youtubeAtomFeed([])), 'isCompleteFeedXml accepts complete Atom feed');
    assert(!isCompleteFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Cut off'), 'isCompleteFeedXml rejects truncated Atom feed');
    assert(!isCompleteFeedXml('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), 'isCompleteFeedXml rejects HTML error page');

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
        { label: 'oEmbed 429', handler: async (url: string) => makeResponse(429, 'Rate Limited', url, 'text/plain') },
        { label: 'oEmbed network error', handler: async () => { throw new Error('ETIMEDOUT'); } },
    ]) {
        await resolveChannel(ytChan.id, {
            fetchFn: async (url) => {
                if (url === feedEndpoint) return makeResponse(200, onlyKeptXml, url);
                if (url.startsWith('https://www.youtube.com/oembed?')) return oembedErr.handler(url);
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        const liveCount = (db.prepare(
            `SELECT COUNT(*) AS c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL`
        ).get(ytChan.id) as { c: number }).c;
        assert(liveCount === 5, `Missing from RSS + ${oembedErr.label} keeps all items (live=${liveCount}/5)`);
    }

    // 2c. Missing from RSS + oEmbed 404 / 401 -> tombstoned; missing + oEmbed 200 -> kept;
    //     oEmbed requests go strictly to www.youtube.com with maxRedirects: 0.
    const oembedCalls: Array<{ url: string; maxRedirects: number | undefined }> = [];
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
            if (target.includes('ufwPPP0oZZA')) return makeResponse(404, 'Not Found', url, 'text/plain');
            if (target.includes('privVid0001')) return makeResponse(401, 'Unauthorized', url, 'text/plain');
            if (target.includes('liveMiss001')) return makeResponse(200, JSON.stringify({ title: 'Still Live' }), url, 'application/json');
            throw new Error(`Unexpected oEmbed target: ${target}`);
        },
    });

    assert(!tidyRes.error, `Resolve succeeded without error (${tidyRes.error ?? 'ok'})`);
    assert(tidyRes.tombstoned === 2, `Tombstoned 2 gone items (got ${tidyRes.tombstoned})`);
    assert(oembedCalls.every((c) => c.maxRedirects === 0), 'All oEmbed fetches pass maxRedirects: 0');
    assert(!oembedCalls.some((c) => c.url.includes('manualVid01')), 'Manual submission was not probed or tombstoned by RSS sweep');
    assert(!oembedCalls.some((c) => c.url.includes('keptInRss01')), 'Item present in RSS was not probed');

    const gone404 = rowState('ufwPPP0oZZA');
    assert(
        gone404.deleted_at !== null && gone404.url === null && gone404.title === null && gone404.thumbnail_url === null,
        'Missing + oEmbed 404 item tombstoned with deleted_at set and url/title/thumbnail NULLed'
    );
    const gone401 = rowState('privVid0001');
    assert(
        gone401.deleted_at !== null && gone401.url === null && gone401.title === null && gone401.thumbnail_url === null,
        'Missing + oEmbed 401 item tombstoned with deleted_at set and url/title/thumbnail NULLed'
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
    assert(!feedAfterTombstone.includes(gone404.id) && !feedAfterTombstone.includes(gone401.id), 'Tombstoned items no longer appear in getPulseFeed');
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

    console.log(`\nResults: ${passed}/${run} tests passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
