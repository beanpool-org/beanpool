/**
 * Automated Test Suite: Pulse Thumbnail Proxy & Cache (Contract B / CSP Defense).
 *
 * Covers:
 * 1. A valid item id returns bytes with an image content type (200, Buffer, image/jpeg).
 * 2. An unknown item id is refused (404).
 * 3. Deleted or missing thumbnail rows are refused (404).
 * 4. An over-size upstream image is refused (413 / 502).
 * 5. A private-IP upstream is refused (SSRF defense against loopback/RFC1918).
 * 6. The cache serves a second request without re-fetching upstream.
 * 7. Conditional GET (If-None-Match) returns 304 Not Modified.
 * 8. Strict content-type enforcement (refuses non-image types like text/html, svg).
 * 9. LRU cache eviction enforces total memory bound on 1 GB nodes.
 * 10. Negative cache prevents tight retry loops when upstream fails.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-thumbnail.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createPulseRoutes } from './routes/pulse.js';
import {
    PulseThumbnailService,
    PulseThumbnailCache,
    PulseThumbnailDiskStore,
    MAX_THUMBNAIL_BYTES,
    type ThumbnailResult,
} from './engine/pulse-thumbnail.js';
import {
    ssrfSafeFetch,
    SsrfSecurityError,
    ProhibitedContentTypeError,
    PayloadTooLargeError,
    type SsrfSafeResponse,
} from './engine/pulse-resolver.js';
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

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; params?: Record<string, string> } = {}
): Promise<{ status: number; body: any; type?: string; headers: Record<string, string> }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in pulse router`);

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

    const resHeaders: Record<string, string> = {};
    const reqHeaders: Record<string, string> = { ...(opts.headers || {}) };

    const ctx: any = {
        state: {},
        params,
        status: 200,
        body: undefined,
        type: undefined,
        headers: reqHeaders,
        get: (h: string) => reqHeaders[h.toLowerCase()] || reqHeaders[h] || '',
        set: (k: string, v: string) => { resHeaders[k.toLowerCase()] = v; },
    };

    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return {
        status: ctx.status,
        body: ctx.body,
        type: ctx.type,
        headers: resHeaders,
    };
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    return pubkey;
}

function makeChannel(ownerPubkey: string, platform = 'youtube'): string {
    const id = 'chan_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
        `INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
         VALUES (?, ?, ?, 'https://youtube.com/@test', 'art', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id, ownerPubkey, platform);
    return id;
}

function makePulseItem(channelId: string, ownerPubkey: string, opts: {
    id?: string;
    thumbnailUrl?: string | null;
    deletedAt?: string | null;
} = {}): string {
    const id = opts.id || ('item_' + crypto.randomBytes(8).toString('hex'));
    db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, title, thumbnail_url, category, source, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 'youtube', 'https://youtube.com/watch?v=1', 'Test Item', ?, 'art', 'autolist', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
    ).run(id, channelId, ownerPubkey, opts.thumbnailUrl ?? null, opts.deletedAt ?? null);
    return id;
}

async function main(): Promise<void> {
    console.log('=== Pulse Thumbnail Proxy & Cache Test Suite ===\n');

    initStateEngine();

    const alice = makeMember('Alice');
    const chan = makeChannel(alice);

    // 1. Mock fetcher tracking call count
    let upstreamFetchCount = 0;
    const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    const mockFetchFn = async (url: string, opts?: any): Promise<SsrfSafeResponse> => {
        upstreamFetchCount++;

        // Simulate over-size response
        if (url.includes('oversize.jpg')) {
            throw new PayloadTooLargeError('Response exceeded maximum size limit');
        }

        // Simulate non-image response
        if (url.includes('html-page.html')) {
            return {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'text/html' },
                url,
                buffer: async () => Buffer.from('<html>not an image</html>'),
                text: async () => '<html>not an image</html>',
                json: async <T = any>(): Promise<T> => ({} as T),
            };
        }

        // Simulate upstream 403 Forbidden (e.g. expired Instagram CDN signature)
        if (url.includes('expired-instagram.jpg')) {
            return {
                status: 403,
                statusText: 'Forbidden',
                headers: { 'content-type': 'text/plain' },
                url,
                buffer: async () => Buffer.from('URL signature expired'),
                text: async () => 'URL signature expired',
                json: async <T = any>(): Promise<T> => ({} as T),
            };
        }

        // Default valid image response
        return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'image/jpeg' },
            url,
            buffer: async () => sampleJpeg,
            text: async () => sampleJpeg.toString(),
            json: async <T = any>(): Promise<T> => ({} as T),
        };
    };

    const thumbnailService = new PulseThumbnailService({
        fetchFn: mockFetchFn,
    });

    const router = createPulseRoutes({
        ...deps,
        thumbnailService,
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Requirement 7.1: A valid item id returns bytes with an image content type
    // ──────────────────────────────────────────────────────────────────────────
    const validItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/photo-123.jpg',
    });

    const res1 = await callRouter(router, 'GET', `/api/pulse/items/${validItemId}/thumbnail`);
    assert(res1.status === 200, 'Valid item returns 200 OK');
    assert(Buffer.isBuffer(res1.body), 'Response body is a binary Buffer');
    assert(res1.body.equals(sampleJpeg), 'Response buffer matches expected image bytes');
    assert(res1.type === 'image/jpeg', 'Content-Type header is image/jpeg');
    assert(typeof res1.headers['etag'] === 'string', 'ETag header is populated');
    assert(res1.headers['cache-control']?.includes('public'), 'Cache-Control is public');
    assert(upstreamFetchCount === 1, 'Upstream was fetched exactly once');

    // Verify duplicate route /api/pulse/thumbnail/:id is NOT mounted
    let aliasMounted = true;
    try {
        await callRouter(router, 'GET', `/api/pulse/thumbnail/${validItemId}`);
    } catch {
        aliasMounted = false;
    }
    assert(!aliasMounted, 'Duplicate route /api/pulse/thumbnail/:id is NOT mounted');

    // ──────────────────────────────────────────────────────────────────────────
    // Requirement 7.5: The cache serves a second request without re-fetching
    // ──────────────────────────────────────────────────────────────────────────
    const res2 = await callRouter(router, 'GET', `/api/pulse/items/${validItemId}/thumbnail`);
    assert(res2.status === 200, 'Second request returns 200 from cache');
    assert(res2.body.equals(sampleJpeg), 'Second request body matches cached bytes');
    assert(res2.type === 'image/jpeg', 'Second request retains image/jpeg type');
    assert(upstreamFetchCount === 1, 'Second request did NOT re-fetch upstream (served from LRU cache)');

    // ──────────────────────────────────────────────────────────────────────────
    // Conditional GET (If-None-Match) returns 304
    // ──────────────────────────────────────────────────────────────────────────
    const etag = res1.headers['etag'];
    const res304 = await callRouter(router, 'GET', `/api/pulse/items/${validItemId}/thumbnail`, {
        headers: { 'if-none-match': etag },
    });
    assert(res304.status === 304, 'Conditional GET with matching ETag returns 304 Not Modified');
    assert(upstreamFetchCount === 1, 'Conditional GET 304 does NOT re-fetch upstream');

    // ──────────────────────────────────────────────────────────────────────────
    // Requirement 7.2: An unknown id is refused
    // ──────────────────────────────────────────────────────────────────────────
    const resUnknown = await callRouter(router, 'GET', '/api/pulse/items/item_does_not_exist/thumbnail');
    assert(resUnknown.status === 404, 'Unknown item id is refused with 404');
    assert(resUnknown.body?.error === 'Item not found', 'Unknown item error message is correct');

    // Item with deleted_at IS NOT NULL (tombstone) is refused with 404
    const deletedItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/deleted.jpg',
        deletedAt: new Date().toISOString(),
    });
    const resDeleted = await callRouter(router, 'GET', `/api/pulse/items/${deletedItemId}/thumbnail`);
    assert(resDeleted.status === 404, 'Tombstoned/deleted item is refused with 404');

    // Item with NULL thumbnail_url is refused with 404
    const noThumbItemId = makePulseItem(chan, alice, {
        thumbnailUrl: null,
    });
    const resNoThumb = await callRouter(router, 'GET', `/api/pulse/items/${noThumbItemId}/thumbnail`);
    assert(resNoThumb.status === 404, 'Item with no thumbnail_url is refused with 404');

    // ──────────────────────────────────────────────────────────────────────────
    // Requirement 7.3: An over-size upstream is refused
    // ──────────────────────────────────────────────────────────────────────────
    const oversizeItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/oversize.jpg',
    });
    const resOversize = await callRouter(router, 'GET', `/api/pulse/items/${oversizeItemId}/thumbnail`);
    assert(resOversize.status === 413 || resOversize.status === 502, 'Over-size upstream is refused (status >= 400)');
    assert(thumbnailService.cache.get(oversizeItemId) === null, 'Over-size image is NOT stored in cache');

    // ──────────────────────────────────────────────────────────────────────────
    // Strict Content-Type enforcement (refuses non-image types)
    // ──────────────────────────────────────────────────────────────────────────
    const htmlItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/html-page.html',
    });
    const resHtml = await callRouter(router, 'GET', `/api/pulse/items/${htmlItemId}/thumbnail`);
    assert(resHtml.status === 502, 'Non-image content type (text/html) is refused with 502');
    assert(!JSON.stringify(resHtml.body).includes('SSRF_BLOCKED'), 'Non-image error is NOT reported as SSRF_BLOCKED');
    assert(resHtml.body?.error?.includes('non-image'), 'Non-image error message indicates non-image upstream');

    // ──────────────────────────────────────────────────────────────────────────
    // Honest handling of expired upstream CDN links (e.g. 403 Forbidden)
    // ──────────────────────────────────────────────────────────────────────────
    const expiredItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://cdn.instagram.com/expired-instagram.jpg',
    });
    const resExpired = await callRouter(router, 'GET', `/api/pulse/items/${expiredItemId}/thumbnail`);
    assert(resExpired.status === 403, 'Expired CDN link returning upstream 403 returns 403');
    assert(resExpired.body?.error === 'Upstream refused: HTTP 403', 'Upstream 403 error is "Upstream refused: HTTP 403"');
    assert(!JSON.stringify(resExpired.body).includes('SSRF_BLOCKED'), 'Expired CDN 403 is NOT reported as SSRF_BLOCKED');

    // ──────────────────────────────────────────────────────────────────────────
    // Negative caching: rapid retry does not re-fetch upstream
    // ──────────────────────────────────────────────────────────────────────────
    const fetchCountBefore = upstreamFetchCount;
    const resExpiredRetry = await callRouter(router, 'GET', `/api/pulse/items/${expiredItemId}/thumbnail`);
    assert(resExpiredRetry.status >= 400, 'Retry of failed thumbnail returns failure');
    assert(upstreamFetchCount === fetchCountBefore, 'Negative cache prevented re-fetching dead upstream in tight loop');

    // ──────────────────────────────────────────────────────────────────────────
    // Requirement 7.4: A private-IP upstream is refused
    // ──────────────────────────────────────────────────────────────────────────
    // Test with real ssrfSafeFetch to prove DNS/socket SSRF protection
    const realSsrfService = new PulseThumbnailService({
        fetchFn: ssrfSafeFetch,
    });
    const realSsrfRouter = createPulseRoutes({
        ...deps,
        thumbnailService: realSsrfService,
    });

    const loopbackItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'http://127.0.0.1:8080/private.jpg',
    });
    const resLoopback = await callRouter(realSsrfRouter, 'GET', `/api/pulse/items/${loopbackItemId}/thumbnail`);
    assert(resLoopback.status === 400 || resLoopback.status === 502, 'Loopback IP (127.0.0.1) upstream is refused');
    assert(resLoopback.body?.error?.includes('SSRF_BLOCKED') || resLoopback.body?.error?.includes('blocked'), 'SSRF error reported on 127.0.0.1');

    const rfc1918ItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'http://10.0.0.1:8080/internal.jpg',
    });
    const resRfc1918 = await callRouter(realSsrfRouter, 'GET', `/api/pulse/items/${rfc1918ItemId}/thumbnail`);
    assert(resRfc1918.status === 400 || resRfc1918.status === 502, 'RFC 1918 private IP (10.0.0.1) upstream is refused');

    const localhostItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'http://localhost/admin.jpg',
    });
    const resLocalhost = await callRouter(realSsrfRouter, 'GET', `/api/pulse/items/${localhostItemId}/thumbnail`);
    assert(resLocalhost.status === 400 || resLocalhost.status === 502, 'localhost hostname upstream is refused');

    const fileSchemeItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'file:///etc/passwd',
    });
    const resFileScheme = await callRouter(realSsrfRouter, 'GET', `/api/pulse/items/${fileSchemeItemId}/thumbnail`);
    assert(resFileScheme.status === 400, 'Non-http/https URL scheme (file:) is refused with 400');

    // ──────────────────────────────────────────────────────────────────────────
    // Cache bounds & LRU eviction testing
    // ──────────────────────────────────────────────────────────────────────────
    const smallCache = new PulseThumbnailCache({
        maxTotalBytes: 300, // holds at most two 120-byte items
        maxEntryBytes: 200,
    });

    const b1 = Buffer.alloc(120, 1);
    const b2 = Buffer.alloc(120, 2);
    const b3 = Buffer.alloc(120, 3);

    smallCache.set('item_a', b1, 'image/jpeg');
    smallCache.set('item_b', b2, 'image/jpeg');
    assert(smallCache.getStats().count === 2, 'Cache contains 2 items');
    assert(smallCache.getStats().totalBytes === 240, 'Cache totalBytes is 240');

    // Adding item_c (120 bytes) exceeds 300 bytes -> oldest (item_a) must be evicted
    smallCache.set('item_c', b3, 'image/jpeg');
    assert(smallCache.get('item_a') === null, 'LRU entry item_a was evicted');
    assert(smallCache.get('item_b') !== null, 'item_b is retained');
    assert(smallCache.get('item_c') !== null, 'item_c is stored');
    assert(smallCache.getStats().totalBytes === 240, 'Cache size remains strictly bounded');

    // Accessing item_b moves it to MRU; then adding item_d evicts item_c (now the oldest)
    smallCache.get('item_b');
    const b4 = Buffer.alloc(120, 4);
    smallCache.set('item_d', b4, 'image/jpeg');
    assert(smallCache.get('item_c') === null, 'item_c was evicted after item_b access refreshed item_b MRU');
    assert(smallCache.get('item_b') !== null, 'item_b is retained');
    assert(smallCache.get('item_d') !== null, 'item_d is stored');

    // Entry larger than maxEntryBytes is refused
    const tooBig = Buffer.alloc(250, 9);
    const setRes = smallCache.set('item_huge', tooBig, 'image/jpeg');
    assert(setRes === null, 'Entry exceeding maxEntryBytes is refused by cache');

    // ──────────────────────────────────────────────────────────────────────────
    // Base64 Data URI handling
    // ──────────────────────────────────────────────────────────────────────────
    const dataUriJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const dataUriItemId = makePulseItem(chan, alice, {
        thumbnailUrl: dataUriJpeg,
    });
    const resDataUri = await callRouter(router, 'GET', `/api/pulse/items/${dataUriItemId}/thumbnail`);
    assert(resDataUri.status === 200, 'Valid base64 data URI returns 200 without network fetch');
    assert(resDataUri.type === 'image/jpeg', 'Base64 data URI preserves image/jpeg content type');

    // ──────────────────────────────────────────────────────────────────────────
    // Persistent disk store: survives memory cache eviction / process restart
    // ──────────────────────────────────────────────────────────────────────────
    const testDiskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-disk-'));
    const persistentDiskStore = new PulseThumbnailDiskStore({
        diskDir: testDiskDir,
        maxDiskBytes: 10 * 1024 * 1024,
    });
    let diskFetchCount = 0;
    const diskFetchFn = async (url: string) => {
        diskFetchCount++;
        return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'image/jpeg' },
            url,
            buffer: async () => sampleJpeg,
            text: async () => sampleJpeg.toString(),
            json: async () => ({}),
        };
    };
    const diskService = new PulseThumbnailService({
        diskStore: persistentDiskStore,
        fetchFn: diskFetchFn as any,
    });

    const persistItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/persistent-photo.jpg',
    });

    // First fetch: fetches upstream and writes to both L1 cache and L2 disk store
    const persistRes1 = await diskService.getThumbnail(persistItemId);
    assert(persistRes1.status === 200, 'Initial fetch succeeds with 200');
    assert(diskFetchCount === 1, 'Initial fetch fetched from upstream once');

    // Simulate node restart: clear L1 in-memory cache completely
    diskService.cache.clear();
    assert(diskService.cache.get(persistItemId) === null, 'L1 in-memory cache cleared');

    // Second fetch: served from L2 persistent disk store without re-fetching upstream
    const persistRes2 = await diskService.getThumbnail(persistItemId);
    assert(persistRes2.status === 200, 'Post-restart fetch succeeds with 200 from disk store');
    assert(persistRes2.buffer?.equals(sampleJpeg) === true, 'Disk store returned exact thumbnail bytes');
    assert(persistRes2.contentType === 'image/jpeg', 'Disk store preserved content type');
    assert(diskFetchCount === 1, 'Disk store served cached image with ZERO upstream fetches');
    assert(diskService.cache.get(persistItemId) !== null, 'Disk hit repopulated L1 memory cache');

    // ──────────────────────────────────────────────────────────────────────────
    // Disk store LRU bounds and eviction
    // ──────────────────────────────────────────────────────────────────────────
    const boundedDiskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-disk-lru-'));
    const boundedDiskStore = new PulseThumbnailDiskStore({
        diskDir: boundedDiskDir,
        maxDiskBytes: 300,
        maxEntryBytes: 200,
    });

    const diskB1 = Buffer.alloc(120, 1);
    const diskB2 = Buffer.alloc(120, 2);
    const diskB3 = Buffer.alloc(120, 3);

    boundedDiskStore.set('item_d1', diskB1, 'image/jpeg');
    boundedDiskStore.set('item_d2', diskB2, 'image/jpeg');
    assert(boundedDiskStore.getStats().count === 2, 'Disk store contains 2 entries');
    assert(boundedDiskStore.getStats().totalBytes === 240, 'Disk store totalBytes is 240');

    // Adding item_d3 (120 bytes) causes total to exceed 300 bytes -> oldest (item_d1) evicted
    boundedDiskStore.set('item_d3', diskB3, 'image/jpeg');
    assert(boundedDiskStore.get('item_d1') === null, 'Oldest entry item_d1 was evicted from disk');
    assert(boundedDiskStore.get('item_d2') !== null, 'item_d2 is retained on disk');
    assert(boundedDiskStore.get('item_d3') !== null, 'item_d3 is retained on disk');
    assert(boundedDiskStore.getStats().totalBytes === 240, 'Disk store size remains strictly bounded');

    // Accessing item_d2 updates lastAccessedAt; adding item_d4 evicts item_d3
    boundedDiskStore.get('item_d2');
    const diskB4 = Buffer.alloc(120, 4);
    boundedDiskStore.set('item_d4', diskB4, 'image/jpeg');
    assert(boundedDiskStore.get('item_d3') === null, 'item_d3 was evicted after item_d2 touch');
    assert(boundedDiskStore.get('item_d2') !== null, 'item_d2 is retained on disk');
    assert(boundedDiskStore.get('item_d4') !== null, 'item_d4 is retained on disk');

    // Explicit delete
    boundedDiskStore.delete('item_d2');
    assert(boundedDiskStore.get('item_d2') === null, 'item_d2 was deleted from disk');

    // ──────────────────────────────────────────────────────────────────────────
    // Ingest-time caching: pre-fetches and caches bytes at ingest time
    // ──────────────────────────────────────────────────────────────────────────
    let ingestFetchCount = 0;
    const ingestFetchFn = async (url: string) => {
        ingestFetchCount++;
        return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'image/jpeg' },
            url,
            buffer: async () => sampleJpeg,
            text: async () => sampleJpeg.toString(),
            json: async () => ({}),
        };
    };

    const ingestService = new PulseThumbnailService({
        fetchFn: ingestFetchFn as any,
    });
    const ingestRouter = createPulseRoutes({
        ...deps,
        thumbnailService: ingestService,
    });

    const ingestedItemId = makePulseItem(chan, alice, {
        thumbnailUrl: 'https://images.example.org/ingest-test.jpg',
    });

    // Ingest thumbnail directly (simulating pulse-submit / oauth-ingest)
    const ingestResult = await ingestService.ingestThumbnail(
        ingestedItemId,
        'https://images.example.org/ingest-test.jpg'
    );
    assert(ingestResult.status === 200, 'ingestThumbnail succeeded with 200');
    assert(ingestFetchCount === 1, 'ingestThumbnail fetched upstream once at ingest');
    assert(ingestService.cache.get(ingestedItemId) !== null, 'Item is present in L1 memory cache after ingest');

    // Subsequent GET proxy request is served from cache with ZERO new fetches
    const resProxy = await callRouter(ingestRouter, 'GET', `/api/pulse/items/${ingestedItemId}/thumbnail`);
    assert(resProxy.status === 200, 'Proxy serves pre-cached thumbnail with 200');
    assert(resProxy.body.equals(sampleJpeg), 'Proxy serves matching bytes from ingest cache');
    assert(ingestFetchCount === 1, 'Zero additional upstream fetches occurred when proxy served ingested thumbnail');

    console.log(`\nResults: ${passed}/${run} assertions passed.`);
    if (passed !== run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Test suite failed with unhandled error:', err);
    process.exit(1);
});
