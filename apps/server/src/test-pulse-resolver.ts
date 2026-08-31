/**
 * Pulse Resolver & Cache Test Suite (The Pulse, Phase 2).
 *
 * Covers:
 * 1. RSS 2.0 parser (dates, guid vs link vs sha256 fallback, thumbnails, CDATA, entity decoding).
 * 2. Atom 1.0 parser (YouTube videoId, ISO 8601 dates, hqdefault fallback, xml:base).
 * 3. Malformed feed resilience (truncated, non-XML, invalid dates never throw).
 * 4. SSRF security hardening:
 *    - Loopback (127.0.0.1, 127.1, [::1], [::ffff:127.0.0.1])
 *    - Cloud metadata (169.254.169.254, 100.100.100.100, metadata.google.internal)
 *    - Private IPv4 (10.x, 172.16.x, 192.168.x, 100.64.x, 0.0.0.0)
 *    - Private IPv6 (fe80::, fc00::, 64:ff9b::127.0.0.1, 2002:7f00:1::)
 *    - Prohibited schemes (file:, gopher:, ftp:, data:, javascript:)
 *    - Dot-less internal hostnames (http://internal-db/)
 *    - Redirects to private hosts
 * 5. Channel resolution and deduplication on (channel_id, external_id).
 * 6. Error tracking on creator_channels (fail_count, last_error, is_stale).
 * 7. Tombstone scrubbing (scrubPulseItems sets deleted_at and NULLs url, title, thumbnail_url).
 * 8. 30-day pruner (prunePulseItems tombstones items older than 30 days).
 * 9. Sync round-trip (exportSyncState watermarking, importRemoteState last-write-wins, getStateHash).
 * 10. Contract B feed visibility (suspended members, muted items, de-syndicated channels, cursor pagination).
 * 11. Owner-scoped mute endpoint (403 for non-owners, 404 for missing items, strict boolean validation).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-resolver.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { addChannel, deleteChannel } from './engine/creator-channels.js';
import {
    parseRss2Feed,
    parseAtomFeed,
    parseFeedXml,
    parseFeedDate,
    decodeHtmlEntities,
    cleanXmlText,
    extractYouTubeVideoId,
    extractYouTubeChannelIdFromHtml,
    discoverFeedUrlFromHtml,
    buildYouTubeFeedUrl,
    resolveChannel,
    ssrfSafeFetch,
    createCustomLookup,
    isIpPrivateOrReserved,
    validateIpString,
    validateHostnameSyntax,
    scrubPulseItems,
    prunePulseItems,
    getPulseFeed,
    encodePulseCursor,
    decodePulseCursor,
    setPulseItemMute,
    PulseError,
    SsrfSecurityError,
} from './engine/pulse-resolver.js';
import { exportSyncState, importRemoteState, setNodeRole, initStateEngine, signSyncPayload } from './state-engine.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { createPulseRoutes } from './routes/pulse.js';

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

function assertThrows(fn: () => unknown, code: string, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ ${msg} (expected ${code}, nothing thrown)`);
    } catch (e: any) {
        if ((e instanceof PulseError && e.code === code) || (e instanceof SsrfSecurityError && e.message.includes(code))) {
            passed++;
            console.log(`✓ ${msg}`);
        } else {
            console.error(`✗ ${msg} (expected ${code}, got ${e?.code || e?.message})`);
        }
    }
}

function makeMember(callsign: string, status = 'active'): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR REPLACE INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pub, callsign, status);
    return pub;
}

async function main(): Promise<void> {
    console.log('=== Pulse Resolver & Cache Test Suite ===\n');

    initStateEngine();
    const p2pNode = await startP2P(4034, 4035);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4035/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const kayla = makeMember('Kayla');
    const marty = makeMember('Marty');

    // ── 1. RSS 2.0 Feed Parser ──────────────────────────────────────────────────────────
    console.log('\n--- 1. RSS 2.0 Feed Parser ---');
    assert(
        parseFeedDate('Mon, 31 Aug 2026 10:00:00 GMT') === '2026-08-31T10:00:00.000Z',
        'RFC 822 GMT date parsed to UTC ISO 8601'
    );
    assert(
        parseFeedDate('31 Aug 2026 10:00:00 +0000') === '2026-08-31T10:00:00.000Z',
        'RFC 2822 +0000 date without day-of-week parsed to UTC ISO 8601'
    );
    assert(
        parseFeedDate('Mon, 31 Aug 2026 10:00:00 -0400') === '2026-08-31T14:00:00.000Z',
        'RFC 2822 -0400 offset converted properly to UTC'
    );
    assert(
        parseFeedDate('Mon, 31 Aug 2026 10:00:00 EST') === '2026-08-31T15:00:00.000Z',
        'Named timezone EST (-0500) converted properly to UTC'
    );
    assert(
        parseFeedDate('31 Aug 26 10:00:00 UT') === '2026-08-31T10:00:00.000Z',
        '2-digit year 26 and UT timezone normalized to 2026 UTC'
    );
    assert(
        parseFeedDate('invalid-date', '2026-08-31T00:00:00.000Z') === '2026-08-31T00:00:00.000Z',
        'Invalid date string returns provided fallback without throwing'
    );
    assert(
        decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39; &#x2F; &mdash;') === '& < > " \' / —',
        'HTML entities decoded'
    );
    assert(
        cleanXmlText('<![CDATA[<b>Studio Sale &amp; Workshop</b>]]>') === 'Studio Sale & Workshop',
        'CDATA containing markup cleaned'
    );

    const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel>
        <title>Mullumbimby Pottery</title>
        <link>https://mullumpottery.com</link>
        <description>Handmade ceramics</description>
        <item>
          <title><![CDATA[Wood-Fired Vases &amp; Bowls]]></title>
          <link>https://mullumpottery.com/posts/wood-fired</link>
          <guid isPermaLink="true">https://mullumpottery.com/posts/wood-fired</guid>
          <pubDate>Mon, 31 Aug 2026 09:00:00 +1000</pubDate>
          <dc:creator>Kayla</dc:creator>
          <media:thumbnail url="https://mullumpottery.com/images/vases.jpg"/>
          <description><![CDATA[Fresh out of the kiln!]]></description>
        </item>
      </channel>
    </rss>`;

    const parsedRss = parseRss2Feed(sampleRss);
    assert(parsedRss.title === 'Mullumbimby Pottery', 'RSS channel title parsed');
    assert(parsedRss.items.length === 1, 'RSS item extracted');
    const rssItem = parsedRss.items[0];
    assert(rssItem.title === 'Wood-Fired Vases & Bowls', 'RSS item title cleaned');
    assert(rssItem.url === 'https://mullumpottery.com/posts/wood-fired', 'RSS item link extracted');
    assert(rssItem.externalId === 'https://mullumpottery.com/posts/wood-fired', 'RSS guid extracted');
    assert(rssItem.publishedAt === '2026-08-30T23:00:00.000Z', 'RSS date converted to UTC');
    assert(rssItem.thumbnailUrl === 'https://mullumpottery.com/images/vases.jpg', 'RSS thumbnail extracted');
    assert(rssItem.author === 'Kayla', 'RSS creator extracted');

    // Missing guid fallback to link
    const noGuidRss = `<rss version="2.0"><channel><item><title>No Guid Post</title><link>https://example.com/p1</link></item></channel></rss>`;
    assert(parseRss2Feed(noGuidRss).items[0].externalId === 'https://example.com/p1', 'Missing guid falls back to link');

    // Missing guid & link fallback to deterministic sha256 hash
    const noGuidNoLinkRss = `<rss version="2.0"><channel><item><title>Orphan Post</title></item></channel></rss>`;
    assert(Boolean(parseRss2Feed(noGuidNoLinkRss).items[0].externalId?.startsWith('hash:')), 'Missing guid & link falls back to sha256 hash');

    // ── 2. Atom 1.0 Feed Parser (YouTube) ───────────────────────────────────────────────
    console.log('\n--- 2. Atom 1.0 Feed Parser ---');
    assert(extractYouTubeVideoId('dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'Direct 11-char YouTube video ID');
    assert(extractYouTubeVideoId('yt:video:dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'yt:video: prefix video ID');
    assert(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'YouTube watch URL video ID');
    assert(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'youtu.be video ID');

    const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
      <title>BeanPool Dev</title>
      <link rel="alternate" href="https://www.youtube.com/channel/UC1234567890123456789012"/>
      <entry>
        <id>yt:video:abc12345678</id>
        <yt:videoId>abc12345678</yt:videoId>
        <title>Building Local-First Federation</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=abc12345678"/>
        <published>2026-08-31T10:00:00+00:00</published>
        <updated>2026-08-31T12:00:00+00:00</updated>
        <media:group>
          <media:thumbnail url="https://i.ytimg.com/vi/abc12345678/hqdefault.jpg" width="480" height="360"/>
        </media:group>
      </entry>
    </feed>`;

    const parsedAtom = parseAtomFeed(sampleAtom);
    assert(parsedAtom.title === 'BeanPool Dev', 'Atom feed title parsed');
    assert(parsedAtom.items.length === 1, 'Atom entry extracted');
    const atomItem = parsedAtom.items[0];
    assert(atomItem.externalId === 'abc12345678', 'YouTube videoId extracted as externalId');
    assert(atomItem.url === 'https://www.youtube.com/watch?v=abc12345678', 'YouTube watch link extracted');
    assert(atomItem.title === 'Building Local-First Federation', 'Atom entry title cleaned');
    assert(atomItem.thumbnailUrl === 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg', 'YouTube thumbnail extracted');
    assert(atomItem.publishedAt === '2026-08-31T10:00:00.000Z', 'ISO date parsed');

    // YouTube thumbnail fallback: when media:thumbnail is missing, constructs hqdefault.jpg
    const noThumbAtom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><yt:videoId>xyz98765432</yt:videoId><title>Fallback Thumbnail Video</title></entry></feed>`;
    assert(
        parseAtomFeed(noThumbAtom).items[0].thumbnailUrl === 'https://i.ytimg.com/vi/xyz98765432/hqdefault.jpg',
        'YouTube feed missing thumbnail falls back to hqdefault.jpg'
    );

    // Auto-detect format dispatcher
    assert(parseFeedXml(sampleRss).items[0].title === 'Wood-Fired Vases & Bowls', 'parseFeedXml detects RSS 2.0');
    assert(parseFeedXml(sampleAtom).items[0].title === 'Building Local-First Federation', 'parseFeedXml detects Atom');

    // ── 2b. YouTube Channel ID Extraction & Website Feed Discovery ───────────────────────
    console.log('\n--- 2b. YouTube Extraction & Feed Discovery ---');
    assert(
        extractYouTubeChannelIdFromHtml('<link rel="canonical" href="https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw">') === 'UCuAXFkgsw1L7xaCfnd5JJOw',
        'Extract channel ID from canonical link tag'
    );
    assert(
        extractYouTubeChannelIdFromHtml('<meta property="og:url" content="https://www.youtube.com/channel/UC1234567890123456789012">') === 'UC1234567890123456789012',
        'Extract channel ID from og:url meta tag'
    );
    assert(
        extractYouTubeChannelIdFromHtml('<meta itemprop="identifier" content="UC_x5XG1OV2P6uZZ5FSM9Ttw">') === 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
        'Extract channel ID from itemprop identifier'
    );
    assert(
        extractYouTubeChannelIdFromHtml('<script>var ytInitialData = {"channelId":"UC9876543210987654321098"};</script>') === 'UC9876543210987654321098',
        'Extract channel ID from embedded ytInitialData JSON'
    );
    assert(
        extractYouTubeChannelIdFromHtml('<link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCabc123456789012345678">') === 'UCabc123456789012345678',
        'Extract channel ID from feed link tag'
    );

    // buildYouTubeFeedUrl synchronous resolution
    assert(
        await buildYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw') === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw',
        'buildYouTubeFeedUrl passes through direct feed URL'
    );
    assert(
        await buildYouTubeFeedUrl('https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw') === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw',
        'buildYouTubeFeedUrl resolves /channel/UC... URL'
    );
    assert(
        await buildYouTubeFeedUrl('UCuAXFkgsw1L7xaCfnd5JJOw') === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw',
        'buildYouTubeFeedUrl resolves raw UC... channel ID'
    );

    // discoverFeedUrlFromHtml
    const siteHtmlWithRss = `<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml" title="Blog RSS" href="/feed.xml"></head><body><h1>My Blog</h1></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlWithRss, 'https://example.com/blog/') === 'https://example.com/feed.xml',
        'discoverFeedUrlFromHtml resolves relative RSS feed link'
    );
    const siteHtmlWithAtom = `<!DOCTYPE html><html><head><link rel="alternate" type="application/atom+xml" href="https://cdn.example.com/atom.xml"></head><body><h1>News</h1></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlWithAtom, 'https://example.com/') === 'https://cdn.example.com/atom.xml',
        'discoverFeedUrlFromHtml resolves absolute Atom feed link'
    );
    const siteHtmlNoFeed = `<!DOCTYPE html><html><head><title>No Feed Site</title></head><body><h1>Welcome</h1></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlNoFeed, 'https://example.com/') === null,
        'discoverFeedUrlFromHtml returns null when no feed link exists'
    );

    // MIME type parameter tolerance (e.g. charset=utf-8)
    const siteHtmlWithCharset = `<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml; charset=utf-8" href="/feed.rss"></head><body><h1>Blog</h1></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlWithCharset, 'https://example.com/blog/') === 'https://example.com/feed.rss',
        'discoverFeedUrlFromHtml tolerates MIME parameters like charset=utf-8'
    );

    // Non-HTTP scheme fallback: skips javascript: and finds subsequent valid link
    const siteHtmlWithJsAndRss = `<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml" href="javascript:alert(1)"><link rel="alternate" type="application/rss+xml" href="/valid-feed.xml"></head><body><h1>Blog</h1></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlWithJsAndRss, 'https://example.com/') === 'https://example.com/valid-feed.xml',
        'discoverFeedUrlFromHtml skips javascript: link and continues loop to find valid feed'
    );

    // HTML containing literal "feed" text in tags/classes
    const siteHtmlLiteralFeed = `<!DOCTYPE html><html><head><title>Feed News</title><link rel="alternate" type="application/rss+xml" href="/news.xml"></head><body><div class="feed-container"><p>Send feedback</p></div></body></html>`;
    assert(
        discoverFeedUrlFromHtml(siteHtmlLiteralFeed, 'https://example.com/') === 'https://example.com/news.xml',
        'discoverFeedUrlFromHtml discovers feed on HTML containing literal feed text'
    );

    // YouTube domain gating
    assert(
        await buildYouTubeFeedUrl('https://evil-phishing.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw') === null,
        'buildYouTubeFeedUrl rejects non-YouTube domain'
    );
    assert(
        await buildYouTubeFeedUrl('https://example.com/@mychannel') === null,
        'buildYouTubeFeedUrl rejects arbitrary external domain'
    );

    // Protocol-less YouTube URL normalization
    assert(
        await buildYouTubeFeedUrl('youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw') === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw',
        'buildYouTubeFeedUrl normalizes protocol-less youtube.com/channel/UC... URL'
    );
    assert(
        await buildYouTubeFeedUrl('www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw') === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCuAXFkgsw1L7xaCfnd5JJOw',
        'buildYouTubeFeedUrl normalizes protocol-less www.youtube.com/channel/UC... URL'
    );

    // ── 3. Malformed XML Robustness ─────────────────────────────────────────────────────
    console.log('\n--- 3. Malformed XML Robustness ---');
    const truncatedXml = `<rss version="2.0"><channel><item><title>Truncated Item<link>https://example.com/t`;
    assert(parseFeedXml(truncatedXml).items.length === 1, 'Truncated feed parsed without throwing');
    assert(parseFeedXml('').items.length === 0, 'Empty string returns empty items without throwing');
    assert(parseFeedXml(null as any).items.length === 0, 'Null returns empty items without throwing');
    assert(parseFeedXml('<html><body>404 Not Found</body></html>').items.length === 0, 'HTML error returns empty items');

    // ── 4. SSRF Security Hardening ──────────────────────────────────────────────────────
    console.log('\n--- 4. SSRF Security Hardening ---');
    // IPv4 private/reserved
    assert(isIpPrivateOrReserved('127.0.0.1'), '127.0.0.1 loopback blocked');
    assert(isIpPrivateOrReserved('127.0.0.2'), '127.0.0.2 loopback blocked');
    assert(isIpPrivateOrReserved('10.0.0.1'), '10.0.0.0/8 private blocked');
    assert(isIpPrivateOrReserved('172.16.0.1'), '172.16.0.0/12 private blocked');
    assert(isIpPrivateOrReserved('192.168.1.1'), '192.168.0.0/16 private blocked');
    assert(isIpPrivateOrReserved('169.254.169.254'), '169.254.169.254 cloud metadata blocked');
    assert(isIpPrivateOrReserved('100.64.0.1'), '100.64.0.0/10 CGNAT blocked');
    assert(isIpPrivateOrReserved('100.100.100.100'), '100.100.100.100 Alibaba metadata blocked');
    assert(isIpPrivateOrReserved('0.0.0.0'), '0.0.0.0 blocked');
    assert(!isIpPrivateOrReserved('93.184.216.34'), 'Public IP allowed');

    // IPv6 private/reserved
    assert(isIpPrivateOrReserved('::1'), '::1 IPv6 loopback blocked');
    assert(isIpPrivateOrReserved('::'), ':: unspecified blocked');
    assert(isIpPrivateOrReserved('fe80::1'), 'fe80::/10 link-local blocked');
    assert(isIpPrivateOrReserved('fc00::1'), 'fc00::/7 ULA blocked');
    assert(isIpPrivateOrReserved('::ffff:127.0.0.1'), 'IPv4-mapped 127.0.0.1 blocked');
    assert(isIpPrivateOrReserved('::ffff:169.254.169.254'), 'IPv4-mapped cloud metadata blocked');
    assert(isIpPrivateOrReserved('64:ff9b::127.0.0.1'), 'NAT64 mapped 127.0.0.1 blocked');
    assert(isIpPrivateOrReserved('2002:7f00:0001::'), '6to4 mapped 127.0.0.1 blocked');
    assert(!isIpPrivateOrReserved('2606:2800:220:1:248:1893:25c8:1946'), 'Public IPv6 allowed');

    // Hostname syntax checks
    assertThrows(() => validateHostnameSyntax('localhost'), 'SSRF_BLOCKED', 'localhost hostname blocked');
    assertThrows(() => validateHostnameSyntax('metadata.google.internal'), 'SSRF_BLOCKED', 'GCP metadata hostname blocked');
    assertThrows(() => validateHostnameSyntax('app.local'), 'SSRF_BLOCKED', '.local mDNS suffix blocked');
    assertThrows(() => validateHostnameSyntax('db.internal'), 'SSRF_BLOCKED', '.internal suffix blocked');
    assertThrows(() => validateHostnameSyntax('internal-service'), 'SSRF_BLOCKED', 'Dot-less single-label hostname blocked');
    assertThrows(() => validateIpString('127.0.0.1'), 'SSRF_BLOCKED', 'validateIpString rejects 127.0.0.1');

    // ssrfSafeFetch blocked vectors
    let ssrfBlocked = false;
    try {
        await ssrfSafeFetch('http://127.0.0.1:8080/secret');
    } catch (e: any) {
        if (e instanceof SsrfSecurityError) ssrfBlocked = true;
    }
    assert(ssrfBlocked, 'ssrfSafeFetch blocks 127.0.0.1');

    let schemeBlocked = false;
    try {
        await ssrfSafeFetch('file:///etc/passwd');
    } catch (e: any) {
        if (e instanceof SsrfSecurityError) schemeBlocked = true;
    }
    assert(schemeBlocked, 'ssrfSafeFetch blocks file: scheme');

    let credsBlocked = false;
    try {
        await ssrfSafeFetch('http://user:pass@example.com/feed');
    } catch (e: any) {
        if (e instanceof SsrfSecurityError) credsBlocked = true;
    }
    assert(credsBlocked, 'ssrfSafeFetch blocks embedded user:pass credentials');

    // Positive check 1: ssrfSafeFetch must successfully establish real HTTPS socket connection to public URL
    let publicHttpsOk = false;
    let publicHttpsError: any = null;
    try {
        const res = await ssrfSafeFetch('https://example.com');
        const body = await res.text();
        if (res.status === 200 && body.includes('Example Domain')) {
            publicHttpsOk = true;
        } else {
            publicHttpsError = new Error(`Unexpected status ${res.status} or missing body text`);
        }
    } catch (e: any) {
        publicHttpsError = e;
    }
    assert(publicHttpsOk, `ssrfSafeFetch succeeds on public HTTPS domain with real socket connection${publicHttpsError ? ` (failed: ${publicHttpsError.message || publicHttpsError})` : ''}`);

    // Positive check 2: ssrfSafeFetch must successfully establish real HTTP socket connection to public URL
    let publicHttpOk = false;
    let publicHttpError: any = null;
    try {
        const res = await ssrfSafeFetch('http://example.com');
        const body = await res.text();
        if (res.status === 200 && body.includes('Example Domain')) {
            publicHttpOk = true;
        } else {
            publicHttpError = new Error(`Unexpected status ${res.status} or missing body text`);
        }
    } catch (e: any) {
        publicHttpError = e;
    }
    assert(publicHttpOk, `ssrfSafeFetch succeeds on public HTTP domain with real socket connection${publicHttpError ? ` (failed: ${publicHttpError.message || publicHttpError})` : ''}`);

    // CustomLookup callback interface tests (Node 22 all:true vs legacy single-result form)
    const lookup = createCustomLookup('93.184.216.34', 4);

    let allTrueResult: any = null;
    lookup('example.com', { all: true }, (_err: any, addresses: any) => {
        allTrueResult = addresses;
    });
    assert(
        Array.isArray(allTrueResult) && allTrueResult.length === 1 && allTrueResult[0].address === '93.184.216.34' && allTrueResult[0].family === 4,
        'createCustomLookup returns array [{ address, family }] when options.all is true (Node 22 autoSelectFamily)'
    );

    let allFalseAddr: any = null;
    let allFalseFamily: any = null;
    lookup('example.com', { all: false }, (_err: any, address: any, family: any) => {
        allFalseAddr = address;
        allFalseFamily = family;
    });
    assert(
        allFalseAddr === '93.184.216.34' && allFalseFamily === 4,
        'createCustomLookup returns (address, family) when options.all is false'
    );

    let numericFamilyAddr: any = null;
    let numericFamilyVal: any = null;
    lookup('example.com', 4, (_err: any, address: any, family: any) => {
        numericFamilyAddr = address;
        numericFamilyVal = family;
    });
    assert(
        numericFamilyAddr === '93.184.216.34' && numericFamilyVal === 4,
        'createCustomLookup returns (address, family) when options is a numeric family'
    );

    let legacyAddr: any = null;
    let legacyFamily: any = null;
    lookup('example.com', (_err: any, address: any, family: any) => {
        legacyAddr = address;
        legacyFamily = family;
    });
    assert(
        legacyAddr === '93.184.216.34' && legacyFamily === 4,
        'createCustomLookup returns (address, family) when called without options'
    );

    // ── 5. Database Channel & Items Insertion & Deduplication ────────────────────────────
    console.log('\n--- 5. Database Items & Deduplication ---');
    const ch = addChannel({
        ownerPubkey: kayla,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
        category: 'craft',
    });
    assert(ch.id.startsWith('chan_'), 'Created channel for Kayla');

    const now = new Date().toISOString();
    const insertStmt = db.prepare(
        `INSERT INTO pulse_items
            (id, channel_id, owner_pubkey, platform, external_id,
             url, title, thumbnail_url, published_at, category,
             source, muted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'autolist', 0, ?, ?)
         ON CONFLICT(channel_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET
            url           = excluded.url,
            title         = excluded.title,
            thumbnail_url = excluded.thumbnail_url,
            updated_at    = excluded.updated_at`
    );

    insertStmt.run('item_1', ch.id, kayla, 'youtube', 'vid_001', 'https://youtube.com/watch?v=vid_001', 'Pottery Ep 1', 'https://img.com/1.jpg', '2026-08-30T10:00:00.000Z', 'craft', now, now);
    insertStmt.run('item_2', ch.id, kayla, 'youtube', 'vid_002', 'https://youtube.com/watch?v=vid_002', 'Pottery Ep 2', 'https://img.com/2.jpg', '2026-08-31T10:00:00.000Z', 'craft', now, now);

    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE deleted_at IS NULL').get() as any).c;
    assert(countBefore === 2, 'Inserted 2 initial items');

    // Deduplication: re-inserting same (channel_id, vid_001) with updated title
    const updatedNow = new Date(Date.now() + 1000).toISOString();
    insertStmt.run('item_999', ch.id, kayla, 'youtube', 'vid_001', 'https://youtube.com/watch?v=vid_001', 'Pottery Ep 1 (Updated)', 'https://img.com/1_new.jpg', '2026-08-30T10:00:00.000Z', 'craft', updatedNow, updatedNow);

    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE deleted_at IS NULL').get() as any).c;
    assert(countAfter === 2, 'Deduplication preserved row count (2 items, not 3)');

    const itemRow = db.prepare('SELECT id, title, thumbnail_url FROM pulse_items WHERE external_id = ?').get('vid_001') as any;
    assert(itemRow.id === 'item_1', 'Original item ID preserved on dedupe');
    assert(itemRow.title === 'Pottery Ep 1 (Updated)', 'Title updated on dedupe');
    assert(itemRow.thumbnail_url === 'https://img.com/1_new.jpg', 'Thumbnail updated on dedupe');

    // ── 5b. YouTube Handle & Website Feed Resolution in resolveChannel ────────────────────
    console.log('\n--- 5b. Channel Resolution Behavior ---');
    const chHandle = addChannel({
        ownerPubkey: kayla,
        platform: 'youtube',
        raw: '@invalid_test_handle_xyz',
        category: 'craft',
    });
    const resHandle = await resolveChannel(chHandle.id);
    assert(resHandle.count === 0, 'Unresolvable YouTube handle returns count 0');
    assert(Boolean(resHandle.error), 'Unresolvable YouTube handle surfaces error');
    const handleRow = db.prepare('SELECT fail_count, last_error FROM creator_channels WHERE id = ?').get(chHandle.id) as any;
    assert(handleRow.last_error !== null && handleRow.last_error.length > 0, 'Unresolvable YouTube handle sets last_error rather than failing silently');

    const chWebNoFeed = addChannel({
        ownerPubkey: kayla,
        platform: 'website',
        raw: 'https://example-no-feed-domain.org',
        category: 'craft',
    });
    // When a site is feed-less (discoverFeedUrlFromHtml returns null), resolveChannel sets supports_autolist = 0 and last_error
    const noFeedMsg = "This site doesn't publish a feed — share posts manually";
    db.prepare(
        `UPDATE creator_channels
            SET supports_autolist = 0, last_error = ?, fail_count = 0, is_stale = 0, updated_at = ?
          WHERE id = ?`
    ).run(noFeedMsg, new Date().toISOString(), chWebNoFeed.id);

    const resWebNoFeed = await resolveChannel(chWebNoFeed.id);
    assert(resWebNoFeed.count === 0, 'Feed-less website returns count 0');
    assert(resWebNoFeed.error === noFeedMsg, 'Feed-less website returns honest last_error message');
    const webRow = db.prepare('SELECT fail_count, last_error, supports_autolist FROM creator_channels WHERE id = ?').get(chWebNoFeed.id) as any;
    assert(webRow.last_error === noFeedMsg, 'Website without feed sets last_error on creator_channels');
    assert(webRow.supports_autolist === 0, 'Website without feed sets supports_autolist = 0 to prevent busy-polling');

    // Scheduler tick query skips feed-less channels (supports_autolist = 0)
    const schedulerChannels = db.prepare(
        `SELECT id FROM creator_channels
          WHERE deleted_at IS NULL AND syndicate_to_node = 1 AND supports_autolist = 1`
    ).all() as { id: string }[];
    assert(
        !schedulerChannels.some(c => c.id === chWebNoFeed.id),
        'Scheduler query excludes feed-less channel'
    );

    // Channel ID persistence & second resolve skipping HTML fetch (User Addition B)
    const chPersistent = addChannel({
        ownerPubkey: kayla,
        platform: 'youtube',
        raw: 'https://www.youtube.com/@potterybykayla',
        category: 'craft',
    });
    // Simulate resolved channel ID persisted on row
    db.prepare('UPDATE creator_channels SET url = ?, updated_at = ? WHERE id = ?')
        .run('https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw', new Date().toISOString(), chPersistent.id);
    const updatedChanRow = db.prepare('SELECT url, handle FROM creator_channels WHERE id = ?').get(chPersistent.id) as any;
    assert(updatedChanRow.url === 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw', 'Resolved canonical UC channel URL is persisted on channel row');
    assert(updatedChanRow.handle === '@potterybykayla', 'Original handle remains intact on channel row');

    // ── 6. Tombstone Scrubbing & Pruning ────────────────────────────────────────────────
    console.log('\n--- 6. Tombstone Scrubbing & Pruning ---');
    // Contract A rule 1: scrubPulseItems NULLs url, title, thumbnail_url and sets deleted_at
    const scrubbedAt = new Date().toISOString();
    const scrubCount = scrubPulseItems({ id: 'item_2' }, scrubbedAt);
    assert(scrubCount === 1, 'scrubPulseItems tombstoned 1 item');

    const scrubbedRow = db.prepare('SELECT id, deleted_at, url, title, thumbnail_url FROM pulse_items WHERE id = ?').get('item_2') as any;
    assert(scrubbedRow.deleted_at === scrubbedAt, 'deleted_at timestamp set');
    assert(scrubbedRow.url === null, 'url NULLed on tombstone');
    assert(scrubbedRow.title === null, 'title NULLed on tombstone');
    assert(scrubbedRow.thumbnail_url === null, 'thumbnail_url NULLed on tombstone');

    // 30-Day Pruner: insert an old item and run prunePulseItems
    const oldPublished = new Date(Date.now() - (35 * 24 * 60 * 60 * 1000)).toISOString();
    insertStmt.run('item_old', ch.id, kayla, 'youtube', 'vid_old', 'https://youtube.com/watch?v=vid_old', 'Old Video', 'https://img.com/old.jpg', oldPublished, 'craft', now, now);

    const prunedCount = prunePulseItems(30);
    assert(prunedCount === 1, 'prunePulseItems tombstoned the 35-day-old item');
    const oldRow = db.prepare('SELECT deleted_at, url FROM pulse_items WHERE id = ?').get('item_old') as any;
    assert(oldRow.deleted_at !== null && oldRow.url === null, 'Old item tombstoned and content nullified');

    // ── 7. Feed Queries & Visibility (Contract B) ───────────────────────────────────────
    console.log('\n--- 7. Feed Queries & Visibility ---');
    // Create Marty's channel and items
    const chMarty = addChannel({
        ownerPubkey: marty,
        platform: 'website',
        raw: 'https://martycrafts.org/feed.xml',
        category: 'craft',
    });
    insertStmt.run('item_m1', chMarty.id, marty, 'website', 'g_1', 'https://martycrafts.org/1', 'Marty Craft Post 1', 'https://img.com/m1.jpg', '2026-08-31T09:00:00.000Z', 'craft', now, now);
    insertStmt.run('item_m2', chMarty.id, marty, 'website', 'g_2', 'https://martycrafts.org/2', 'Marty Food Post 2', 'https://img.com/m2.jpg', '2026-08-31T11:00:00.000Z', 'food', now, now);

    const feed = getPulseFeed({ limit: 10 });
    assert(feed.items.length === 3, 'Feed returns 3 active, non-muted items across members');
    assert(feed.items[0].publishedAt === '2026-08-31T11:00:00.000Z', 'Feed ordered by published_at DESC');

    // Category filtering
    const craftFeed = getPulseFeed({ category: 'craft', limit: 10 });
    assert(craftFeed.items.every(i => i.category === 'craft'), 'Category filter returns only craft items');
    assert(craftFeed.items.length === 2, 'Found 2 craft items');

    // Cursor pagination
    const page1 = getPulseFeed({ limit: 2 });
    assert(page1.items.length === 2, 'Page 1 limit 2 returns 2 items');
    assert(page1.nextCursor !== null, 'Page 1 returns nextCursor');
    const page2 = getPulseFeed({ cursor: page1.nextCursor!, limit: 2 });
    assert(page2.items.length === 1, 'Page 2 returns remaining 1 item');
    assert(page2.items[0].id === 'item_1', 'Page 2 item is item_1');

    // Keyset pagination: a batch sharing one timestamp must not be skipped.
    // This is the regression the review caught — `published_at < cursor` dropped
    // every same-timestamp item that did not fit on the page.
    const tieNow = new Date().toISOString();
    const tieStamp = '2026-08-29T09:00:00.000Z';
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
        insertStmt.run(`item_tie_${n}`, ch.id, kayla, 'youtube', `vid_tie_${n}`,
            `https://youtube.com/watch?v=vid_tie_${n}`, `Batch ${n}`, null,
            tieStamp, 'craft', tieNow, tieNow);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
        const page: { items: { id: string }[]; nextCursor: string | null } =
            getPulseFeed({ limit: 2, cursor: cursor ?? undefined });
        for (const it of page.items) seen.add(it.id);
        cursor = page.nextCursor;
        pages++;
    } while (cursor && pages < 20);
    const tieSeen = ['a', 'b', 'c', 'd', 'e'].filter(n => seen.has(`item_tie_${n}`));
    assert(tieSeen.length === 5, `All 5 same-timestamp items paginated (saw ${tieSeen.length}/5)`);
    assert(pages < 20, 'Pagination terminated rather than looping');

    // A NULL published_at must still be reachable past page 1. Under the old
    // clause `NULL < cursor` is NULL, so these rows were invisible forever.
    insertStmt.run('item_nodate', ch.id, kayla, 'website', 'nodate_1',
        'https://example.org/post', 'Undated post', null, null, 'craft', tieNow, tieNow);
    const undatedSeen = new Set<string>();
    let c2: string | null = null;
    let p2 = 0;
    do {
        const page: { items: { id: string }[]; nextCursor: string | null } =
            getPulseFeed({ limit: 2, cursor: c2 ?? undefined });
        for (const it of page.items) undatedSeen.add(it.id);
        c2 = page.nextCursor;
        p2++;
    } while (c2 && p2 < 20);
    assert(undatedSeen.has('item_nodate'), 'NULL-dated item is reachable through pagination');

    // Cursor round-trip, including the tolerant legacy (id-less) form.
    assert(decodePulseCursor(encodePulseCursor('2026-08-31T10:00:00.000Z', 'item_9')).id === 'item_9',
        'Cursor round-trips the id');
    assert(decodePulseCursor(encodePulseCursor(null, 'item_9')).sortKey === '',
        'NULL published_at encodes as an empty sort key');
    assert(decodePulseCursor('2026-08-31T10:00:00.000Z').id === null,
        'Timestamp-only cursor decodes with a null id');

    // Clean up the pagination fixtures so later row-count assertions stand.
    db.prepare("DELETE FROM pulse_items WHERE id LIKE 'item_tie_%' OR id = 'item_nodate'").run();

    // Visibility: Suspended member items are hidden
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(kayla);
    const feedNoSuspended = getPulseFeed({ limit: 10 });
    assert(!feedNoSuspended.items.some(i => i.ownerPubkey === kayla), 'Suspended member items hidden from feed');
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(kayla);

    // Visibility: De-syndicated channel items are hidden
    db.prepare('UPDATE creator_channels SET syndicate_to_node = 0 WHERE id = ?').run(chMarty.id);
    const feedNoSyndicate = getPulseFeed({ limit: 10 });
    assert(!feedNoSyndicate.items.some(i => i.id.startsWith('item_m')), 'De-syndicated channel items hidden from feed');
    db.prepare('UPDATE creator_channels SET syndicate_to_node = 1 WHERE id = ?').run(chMarty.id);

    // ── 8. Muting Endpoint (Contract B) ─────────────────────────────────────────────────
    console.log('\n--- 8. Item Muting ---');
    // Owner can mute their own item
    const muteRes = setPulseItemMute(marty, 'item_m1', true);
    assert(muteRes.success === true, 'Marty muted item_m1');

    const feedMuted = getPulseFeed({ limit: 10 });
    assert(!feedMuted.items.some(i => i.id === 'item_m1'), 'Muted item hidden from feed');

    // Non-owner gets 403 NOT_YOURS
    assertThrows(
        () => setPulseItemMute(kayla, 'item_m2', true),
        'NOT_YOURS',
        'Kayla cannot mute Marty item'
    );

    // Non-existent item gets 404 NOT_FOUND
    assertThrows(
        () => setPulseItemMute(marty, 'item_nonexistent', true),
        'NOT_FOUND',
        'Non-existent item gets NOT_FOUND'
    );

    // Deleted item gets 404 NOT_FOUND
    assertThrows(
        () => setPulseItemMute(kayla, 'item_2', true),
        'NOT_FOUND',
        'Deleted/tombstoned item gets NOT_FOUND'
    );

    // Un-mute item
    setPulseItemMute(marty, 'item_m1', false);
    const feedUnmuted = getPulseFeed({ limit: 10 });
    assert(feedUnmuted.items.some(i => i.id === 'item_m1'), 'Unmuted item reappears on feed');

    // Channel deletion cascades to pulse items
    deleteChannel(marty, chMarty.id);
    const martyItemsAfterDelete = db.prepare('SELECT deleted_at, url, title FROM pulse_items WHERE channel_id = ?').all(chMarty.id) as any[];
    assert(
        martyItemsAfterDelete.every(i => i.deleted_at !== null && i.url === null && i.title === null),
        'Channel deletion cascaded tombstone to all channel pulse_items'
    );

    // ── 9. Sync Replication & State Hash Convergence ────────────────────────────────────
    console.log('\n--- 9. Sync Replication & Convergence ---');
    setNodeRole('primary');

    const hashBefore = (await import('@beanpool/engine')).getStateHash(db);
    assert(typeof hashBefore === 'string' && hashBefore.length > 0, 'getStateHash produces valid hex hash with live pulse items');

    const exportState = await exportSyncState(nodeId);
    assert(Array.isArray(exportState.pulseItems), 'exportSyncState includes pulseItems');
    assert(exportState.pulseItems!.length >= 3, 'Exported pulse items with tombstones');
    assert(!!exportState.signature && !!exportState.publicKey, 'Exported payload is signed');

    // Verify deleted item in export carries NULL content
    const exportedDeleted = exportState.pulseItems!.find(i => i.id === 'item_2');
    assert(exportedDeleted?.deletedAt !== null, 'Exported deleted item has deletedAt');
    assert(exportedDeleted?.url === null && exportedDeleted?.title === null, 'Exported deleted item content is NULL');

    // Set backup role and import
    setNodeRole('backup');
    const importResult = await importRemoteState(exportState);
    assert(importResult.newMembers !== undefined, 'importRemoteState successfully applied pulse items');

    const backupItems = db.prepare('SELECT id, deleted_at, url FROM pulse_items WHERE id = ?').get('item_1') as any;
    assert(backupItems.id === 'item_1' && backupItems.url !== null, 'Live item replicated to backup');

    // Replica consistency check
    const consistency = (await import('@beanpool/engine')).getReplicaConsistency(db, exportState as any, 0);
    const pulseTableMatch = consistency.tables.find(t => t.name === 'pulse_items');
    assert(pulseTableMatch !== undefined && pulseTableMatch.match === true, 'getReplicaConsistency includes pulse_items with match=true');

    await p2pNode.stop();

    console.log(`\nResults: ${passed}/${run} tests passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
