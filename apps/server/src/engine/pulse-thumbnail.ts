/**
 * Pulse thumbnail proxy and cache engine — The Pulse.
 *
 * Requirements & Bounds:
 * 1. Keyed by feed item ID (resolves URL from stored pulse_items row; refuses caller-supplied URLs -> SSRF defense).
 * 2. Hard bounds for 1 CPU / 1 GB nodes:
 *    - Maximum entry size: 2 MB (MAX_THUMBNAIL_BYTES).
 *    - Maximum total cache size: 20 MB (DEFAULT_MAX_CACHE_TOTAL_BYTES).
 *    - LRU eviction when full.
 *    - Strict Content-Type enforcement (raster images only).
 *    - Hard fetch timeout (5s).
 * 3. Honest failure & negative caching:
 *    - Fails fast on upstream error (403, 404, SSRF block, timeout).
 *    - Negative cache prevents hammering dead CDNs or tight retry loops.
 *    - Browser card can cleanly fall back to placeholder.
 * 4. Request coalescing:
 *    - In-flight requests for the same item ID share a single upstream fetch.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import {
    ssrfSafeFetch,
    SsrfSecurityError,
    ProhibitedContentTypeError,
    PayloadTooLargeError,
    setPulseItemCacheEvictor,
    type SsrfSafeFetchOptions,
    type SsrfSafeResponse,
} from './pulse-resolver.js';

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_MAX_CACHE_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB RAM
export const DEFAULT_MAX_DISK_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB disk
export const DEFAULT_FETCH_TIMEOUT_MS = 5000; // 5 seconds
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Ceiling on the Instagram embed PAGE read during thumbnail recovery (#813).
 *
 *  Not the image cap: this is the HTML document the fresh CDN URL is extracted from. It was
 *  512 KB, and Instagram's embed page outgrew that, so every recovery died on
 *  "Response exceeded maximum size limit of 524288 bytes" and no Instagram thumbnail could
 *  ever be recovered. Matches the resolver's own DEFAULT_MAX_BYTES; the page is read once per
 *  recovery attempt, and an attempt now costs a backoff step when it fails. */
export const INSTAGRAM_EMBED_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
/** Escalating wait before an item that failed definitively is fetched again. Capped at a day. */
export const THUMBNAIL_BACKOFF_STEPS_MS = [
    60 * 60 * 1000,      // 1 hour
    6 * 60 * 60 * 1000,  // 6 hours
    24 * 60 * 60 * 1000, // 24 hours
];
/** Outbound thumbnail fetches allowed in flight at once during a batch ingest. */
export const INGEST_CONCURRENCY = 3;
export const MAX_NEGATIVE_CACHE_ENTRIES = 1000;

export const ALLOWED_IMAGE_CONTENT_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
];

/**
 * Resolves canonical Instagram embed URL from an item permalink or external ID.
 * Instagram's public embed page serves fresh thumbnail images for public posts/reels
 * without requiring third-party OAuth tokens or leaking visitor IP addresses.
 */
export function extractInstagramEmbedUrl(postUrl?: string | null, externalId?: string | null): string | null {
    if (postUrl) {
        try {
            const u = new URL(postUrl.trim());
            const host = u.hostname.toLowerCase();
            if (host === 'instagram.com' || host === 'www.instagram.com' || host === 'instagr.am') {
                const match = u.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
                if (match && match[1]) {
                    return `https://www.instagram.com/p/${match[1]}/embed/`;
                }
            }
        } catch {}
    }
    if (externalId && /^[A-Za-z0-9_-]+$/.test(externalId)) {
        return `https://www.instagram.com/p/${externalId}/embed/`;
    }
    return null;
}

/**
 * Extracts a fresh CDN thumbnail image URL from an Instagram embed HTML document.
 * Enforces that the extracted URL strictly uses the http: or https: scheme.
 */
export function extractThumbnailFromEmbedHtml(html: string): string | null {
    if (!html) return null;
    let candidate: string | null = null;

    const imgMatch = html.match(/<img[^>]+class="[^"]*EmbeddedMediaImage[^"]*"[^>]+src="([^">]+)"/i) ||
                     html.match(/<img[^>]+src="([^">]+)"[^>]+class="[^"]*EmbeddedMediaImage[^"]*"/i);
    if (imgMatch && imgMatch[1]) {
        candidate = imgMatch[1];
    } else {
        const jsonMatch = html.match(/\\"display_url\\":\\"([^"\\]+(?:\\.[^"\\]+)*)\\"/i) ||
                          html.match(/"display_url":"([^"]+)"/i);
        if (jsonMatch && jsonMatch[1]) {
            candidate = jsonMatch[1];
        } else {
            const ogMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
                            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
            if (ogMatch && ogMatch[1]) {
                candidate = ogMatch[1];
            } else {
                const fallbackImg = html.match(/<img[^>]+src="([^">]*(?:cdninstagram\.com|fbcdn\.net)[^">]*)"/i);
                if (fallbackImg && fallbackImg[1]) {
                    candidate = fallbackImg[1];
                }
            }
        }
    }

    if (candidate) {
        const cleaned = candidate.replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\u0026/g, '&').trim();
        if (/^https?:\/\//i.test(cleaned)) {
            return cleaned;
        }
    }
    return null;
}

export interface ThumbnailCacheEntry {
    buffer: Buffer;
    contentType: string;
    etag: string;
    cachedAt: number;
    size: number;
}

export interface NegativeCacheEntry {
    failedAt: number;
    status: number;
    error: string;
}

export interface ThumbnailResult {
    status: number;
    buffer?: Buffer;
    contentType?: string;
    etag?: string;
    error?: string;
}

export class PulseThumbnailCache {
    private cache = new Map<string, ThumbnailCacheEntry>();
    private negativeCache = new Map<string, NegativeCacheEntry>();
    private currentBytes = 0;
    private maxTotalBytes: number;
    private maxEntryBytes: number;
    private negativeTtlMs: number;

    constructor(options: {
        maxTotalBytes?: number;
        maxEntryBytes?: number;
        negativeTtlMs?: number;
    } = {}) {
        this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CACHE_TOTAL_BYTES;
        this.maxEntryBytes = options.maxEntryBytes ?? MAX_THUMBNAIL_BYTES;
        this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
    }

    get(itemId: string): ThumbnailCacheEntry | null {
        const entry = this.cache.get(itemId);
        if (!entry) return null;
        // Move to MRU position (Map maintains insertion order)
        this.cache.delete(itemId);
        this.cache.set(itemId, entry);
        return entry;
    }

    getNegative(itemId: string): NegativeCacheEntry | null {
        const entry = this.negativeCache.get(itemId);
        if (!entry) return null;
        if (Date.now() - entry.failedAt > this.negativeTtlMs) {
            this.negativeCache.delete(itemId);
            return null;
        }
        return entry;
    }

    setNegative(itemId: string, status: number, error: string): void {
        if (this.negativeCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
            const firstKey = this.negativeCache.keys().next().value;
            if (firstKey) this.negativeCache.delete(firstKey);
        }
        this.negativeCache.set(itemId, {
            failedAt: Date.now(),
            status,
            error,
        });
    }

    set(itemId: string, buffer: Buffer, contentType: string): ThumbnailCacheEntry | null {
        if (buffer.length > this.maxEntryBytes) {
            return null; // Refuse over-size entry
        }

        const existing = this.cache.get(itemId);
        if (existing) {
            this.currentBytes -= existing.size;
            this.cache.delete(itemId);
        }

        // Evict LRU entries until there is sufficient room
        while (this.currentBytes + buffer.length > this.maxTotalBytes && this.cache.size > 0) {
            const oldestKey = this.cache.keys().next().value;
            if (!oldestKey) break;
            const oldestEntry = this.cache.get(oldestKey);
            if (oldestEntry) {
                this.currentBytes -= oldestEntry.size;
            }
            this.cache.delete(oldestKey);
        }

        // If buffer is larger than maxTotalBytes itself, do not cache
        if (this.currentBytes + buffer.length > this.maxTotalBytes) {
            return null;
        }

        const etag = `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
        const entry: ThumbnailCacheEntry = {
            buffer,
            contentType,
            etag,
            cachedAt: Date.now(),
            size: buffer.length,
        };

        this.cache.set(itemId, entry);
        this.currentBytes += entry.size;
        this.negativeCache.delete(itemId);
        return entry;
    }

    delete(itemId: string): void {
        const existing = this.cache.get(itemId);
        if (existing) {
            this.currentBytes -= existing.size;
            this.cache.delete(itemId);
        }
        this.negativeCache.delete(itemId);
    }

    clear(): void {
        this.cache.clear();
        this.negativeCache.clear();
        this.currentBytes = 0;
    }

    getStats(): { count: number; totalBytes: number; maxTotalBytes: number; maxEntryBytes: number } {
        return {
            count: this.cache.size,
            totalBytes: this.currentBytes,
            maxTotalBytes: this.maxTotalBytes,
            maxEntryBytes: this.maxEntryBytes,
        };
    }
}

/**
 * Failures that trying again in five minutes cannot fix.
 *
 * A 403 from an expired CDN URL, a gone post, a body over the cap: the same request will get
 * the same answer tomorrow. Anything that might genuinely be transient — a 502, a timeout — is
 * deliberately NOT here, and keeps only the short in-memory negative cache.
 */
export function isPersistentThumbnailFailure(status: number): boolean {
    return status === 400 || status === 403 || status === 404 || status === 410 || status === 413;
}

export interface ThumbnailBackoffEntry {
    itemId: string;
    thumbnailUrl: string | null;
    failureCount: number;
    status: number;
    error: string;
    lastFailedAtMs: number;
    retryAfterMs: number;
}

/**
 * The per-item backoff, kept in SQLite so a restart does not forget it.
 *
 * The in-memory negative cache (5 minutes) is still the first line of defence for a burst of
 * requests. This is the second: it survives restarts and escalates, so an item whose thumbnail
 * cannot be recovered stops costing outbound requests and log lines. The member sees the same
 * "no thumbnail" fallback either way.
 */
export class PulseThumbnailBackoffStore {
    private now: () => number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? (() => Date.now());
    }

    private read(itemId: string): ThumbnailBackoffEntry | null {
        try {
            const row = db.prepare(
                `SELECT item_id, thumbnail_url, failure_count, status, error, last_failed_at, retry_after
                   FROM pulse_thumbnail_backoff WHERE item_id = ?`
            ).get(itemId) as {
                item_id: string;
                thumbnail_url: string | null;
                failure_count: number;
                status: number;
                error: string;
                last_failed_at: string;
                retry_after: string;
            } | undefined;
            if (!row) return null;
            const retryAfterMs = Date.parse(row.retry_after);
            if (Number.isNaN(retryAfterMs)) return null;
            return {
                itemId: row.item_id,
                thumbnailUrl: row.thumbnail_url,
                failureCount: row.failure_count,
                status: row.status,
                error: row.error,
                lastFailedAtMs: Date.parse(row.last_failed_at),
                retryAfterMs,
            };
        } catch {
            // A node whose schema predates this table must still serve thumbnails.
            return null;
        }
    }

    /** The entry that should refuse this request outright, or null to go to the network. */
    getActive(itemId: string, thumbnailUrl: string | null): ThumbnailBackoffEntry | null {
        const entry = this.read(itemId);
        if (!entry) return null;
        // A later sync writing a DIFFERENT URL is a different resource: try it now rather than
        // hiding a working URL behind a backoff the one it replaced earned.
        if ((entry.thumbnailUrl ?? null) !== (thumbnailUrl ?? null)) return null;
        if (entry.retryAfterMs <= this.now()) return null;
        return entry;
    }

    /** Escalate this item one step. Returns the entry now in force. */
    recordFailure(itemId: string, thumbnailUrl: string | null, status: number, error: string): ThumbnailBackoffEntry {
        const url = thumbnailUrl ?? null;
        const existing = this.read(itemId);
        // A new URL restarts the ladder; the count measures failures of THIS URL.
        const carried = existing && (existing.thumbnailUrl ?? null) === url ? existing.failureCount : 0;
        const failureCount = carried + 1;
        const stepMs = THUMBNAIL_BACKOFF_STEPS_MS[
            Math.min(failureCount - 1, THUMBNAIL_BACKOFF_STEPS_MS.length - 1)
        ];
        const nowMs = this.now();
        const retryAfterMs = nowMs + stepMs;
        try {
            db.prepare(
                `INSERT INTO pulse_thumbnail_backoff
                     (item_id, thumbnail_url, failure_count, status, error, last_failed_at, retry_after)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(item_id) DO UPDATE SET
                     thumbnail_url  = excluded.thumbnail_url,
                     failure_count  = excluded.failure_count,
                     status         = excluded.status,
                     error          = excluded.error,
                     last_failed_at = excluded.last_failed_at,
                     retry_after    = excluded.retry_after`
            ).run(
                itemId,
                url,
                failureCount,
                status,
                error,
                new Date(nowMs).toISOString(),
                new Date(retryAfterMs).toISOString()
            );
        } catch { /* best effort: the in-memory negative cache still holds the short line */ }
        return {
            itemId,
            thumbnailUrl: url,
            failureCount,
            status,
            error,
            lastFailedAtMs: nowMs,
            retryAfterMs,
        };
    }

    /** Forget this item: a success, or a tombstone taking the item away. */
    clear(itemId: string): void {
        try {
            db.prepare(`DELETE FROM pulse_thumbnail_backoff WHERE item_id = ?`).run(itemId);
        } catch {}
    }

    clearAll(): void {
        try {
            db.prepare(`DELETE FROM pulse_thumbnail_backoff`).run();
        } catch {}
    }
}

export interface DiskStoreEntryMeta {
    itemId: string;
    contentType: string;
    etag: string;
    size: number;
    cachedAt: number;
    lastAccessedAt: number;
}

let lastMonotonicTimestamp = 0;
function getMonotonicTime(): number {
    const now = Date.now();
    lastMonotonicTimestamp = Math.max(now, lastMonotonicTimestamp + 1);
    return lastMonotonicTimestamp;
}

export class PulseThumbnailDiskStore {
    public readonly diskDir: string;
    private maxDiskBytes: number;
    private maxEntryBytes: number;

    /** Everything eviction needs to decide, held in memory.
     *
     *  The first cut re-read and re-parsed every .json in the directory on every single
     *  set(), and rewrote the meta file on every get() just to touch lastAccessedAt. At a
     *  full 100 MB store that is 1,000-2,000 synchronous open/read/close syscalls per
     *  cached thumbnail on the one event loop, and an OAuth sync of 50 items would have
     *  done it fifty times over — seconds of total freeze, long enough for the watchdog to
     *  call the node dead. The index makes eviction O(1) and get() read-only. */
    private index = new Map<string, DiskStoreEntryMeta>();
    private currentDiskBytes = 0;

    constructor(options: {
        diskDir?: string;
        maxDiskBytes?: number;
        maxEntryBytes?: number;
    } = {}) {
        const dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        // Under data/cache/ rather than beside state.db: these bytes are re-fetchable, and
        // apps/server/README.md tells operators to back up ./data wholesale, so 100 MB of
        // thumbnails would otherwise dwarf a 1-6 MB database in every backup and get moved
        // file-by-file by deploy.sh on every deploy.
        this.diskDir = options.diskDir ?? path.join(dataDir, 'cache', 'pulse-thumbnails');
        this.maxDiskBytes = options.maxDiskBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES;
        this.maxEntryBytes = options.maxEntryBytes ?? MAX_THUMBNAIL_BYTES;
        try {
            fs.mkdirSync(this.diskDir, { recursive: true });
        } catch {}
        this.hydrateIndex();
    }

    /** One directory scan at construction, to adopt whatever survived the last restart. */
    private hydrateIndex(): void {
        try {
            for (const f of fs.readdirSync(this.diskDir)) {
                if (!f.endsWith('.json')) continue;
                try {
                    const meta = JSON.parse(fs.readFileSync(path.join(this.diskDir, f), 'utf8')) as DiskStoreEntryMeta;
                    if (!meta?.itemId || typeof meta.size !== 'number') continue;
                    if (!fs.existsSync(this.binPath(meta.itemId))) continue;
                    this.index.set(meta.itemId, meta);
                    this.currentDiskBytes += meta.size;
                } catch {}
            }
        } catch {}
    }

    /** Hashed, so the mapping is 1:1.
     *
     *  Stripping unsafe characters to '_' was many-to-one: pulse item ids include
     *  `item_curated_<youtube id>` and ids arriving over federation, so `item:123.foo` and
     *  `item_123_foo` collapsed to the same file and one member's thumbnail was served for
     *  another's item. */
    private safeFilename(itemId: string): string {
        return crypto.createHash('sha256').update(itemId).digest('hex');
    }

    private metaPath(itemId: string): string {
        return path.join(this.diskDir, `${this.safeFilename(itemId)}.json`);
    }

    private binPath(itemId: string): string {
        return path.join(this.diskDir, `${this.safeFilename(itemId)}.bin`);
    }

    async get(itemId: string): Promise<ThumbnailCacheEntry | null> {
        const meta = this.index.get(itemId);
        if (!meta) return null;
        // Belt and braces against a stale or hand-edited meta file.
        if (meta.itemId !== itemId) return null;

        try {
            const buffer = await fs.promises.readFile(this.binPath(itemId));
            // Access time lives in memory only. Persisting it made every feed scroll a
            // synchronous disk write; losing it on restart only costs eviction ordering.
            meta.lastAccessedAt = getMonotonicTime();
            return {
                buffer,
                contentType: meta.contentType,
                etag: meta.etag,
                cachedAt: meta.cachedAt,
                size: meta.size,
            };
        } catch {
            // The file went missing under us — drop it from the index so we stop counting it.
            this.index.delete(itemId);
            this.currentDiskBytes -= meta.size;
            return null;
        }
    }

    async set(itemId: string, buffer: Buffer, contentType: string, etag?: string): Promise<ThumbnailCacheEntry | null> {
        if (buffer.length > this.maxEntryBytes || buffer.length > this.maxDiskBytes) {
            return null;
        }

        try {
            const calculatedEtag = etag || `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
            const now = getMonotonicTime();
            const meta: DiskStoreEntryMeta = {
                itemId,
                contentType,
                etag: calculatedEtag,
                size: buffer.length,
                cachedAt: now,
                lastAccessedAt: now,
            };

            const binFile = this.binPath(itemId);
            const metaFile = this.metaPath(itemId);
            // Bytes first, then the meta file that makes them findable, so a crash between
            // the two leaves an orphan blob rather than an index entry pointing at nothing.
            await fs.promises.writeFile(binFile, buffer);
            await fs.promises.writeFile(metaFile, JSON.stringify(meta));

            const previous = this.index.get(itemId);
            if (previous) this.currentDiskBytes -= previous.size;
            this.index.set(itemId, meta);
            this.currentDiskBytes += meta.size;

            await this.evictIfNeeded();

            return {
                buffer,
                contentType,
                etag: calculatedEtag,
                cachedAt: now,
                size: buffer.length,
            };
        } catch {
            return null;
        }
    }

    async delete(itemId: string): Promise<void> {
        const meta = this.index.get(itemId);
        if (meta) {
            this.index.delete(itemId);
            this.currentDiskBytes -= meta.size;
        }
        await Promise.allSettled([
            fs.promises.unlink(this.metaPath(itemId)),
            fs.promises.unlink(this.binPath(itemId)),
        ]);
    }

    async clear(): Promise<void> {
        this.index.clear();
        this.currentDiskBytes = 0;
        try {
            const files = await fs.promises.readdir(this.diskDir);
            await Promise.allSettled(files.map(f => fs.promises.unlink(path.join(this.diskDir, f))));
        } catch {}
    }

    /** O(evicted), not O(stored) — the index already knows the sizes and access times. */
    private async evictIfNeeded(): Promise<void> {
        if (this.currentDiskBytes <= this.maxDiskBytes) return;
        const oldestFirst = [...this.index.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
        for (const entry of oldestFirst) {
            if (this.currentDiskBytes <= this.maxDiskBytes) break;
            await this.delete(entry.itemId);
        }
    }

    getStats(): { count: number; totalBytes: number; maxDiskBytes: number } {
        return {
            count: this.index.size,
            totalBytes: this.currentDiskBytes,
            maxDiskBytes: this.maxDiskBytes,
        };
    }
}

export interface PulseThumbnailOptions {
    cache?: PulseThumbnailCache;
    diskStore?: PulseThumbnailDiskStore | null;
    fetchFn?: (url: string, options?: SsrfSafeFetchOptions) => Promise<SsrfSafeResponse>;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
    maxDiskBytes?: number;
    diskDir?: string;
    timeoutMs?: number;
    negativeTtlMs?: number;
    /** null disables the persisted backoff (a caller that wants memory-only behaviour). */
    backoffStore?: PulseThumbnailBackoffStore | null;
}

export class PulseThumbnailService {
    public readonly cache: PulseThumbnailCache;
    public readonly diskStore: PulseThumbnailDiskStore | null;
    public readonly backoffStore: PulseThumbnailBackoffStore | null;
    private inFlight = new Map<string, Promise<ThumbnailResult>>();
    private ingestQueue: Promise<void> = Promise.resolve();
    private fetchFn: (url: string, options?: SsrfSafeFetchOptions) => Promise<SsrfSafeResponse>;
    private maxEntryBytes: number;
    private timeoutMs: number;

    constructor(options: PulseThumbnailOptions = {}) {
        this.maxEntryBytes = options.maxEntryBytes ?? MAX_THUMBNAIL_BYTES;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
        this.cache = options.cache ?? new PulseThumbnailCache({
            maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_CACHE_TOTAL_BYTES,
            maxEntryBytes: this.maxEntryBytes,
            negativeTtlMs: options.negativeTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
        });
        this.diskStore = options.diskStore !== undefined
            ? options.diskStore
            : new PulseThumbnailDiskStore({
                diskDir: options.diskDir,
                maxDiskBytes: options.maxDiskBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES,
                maxEntryBytes: this.maxEntryBytes,
            });
        this.fetchFn = options.fetchFn ?? ssrfSafeFetch;
        this.backoffStore = options.backoffStore !== undefined
            ? options.backoffStore
            : new PulseThumbnailBackoffStore();
    }

    /**
     * Record a refusal: the short in-memory line always, the persisted backoff only for a
     * failure that trying again soon cannot fix.
     *
     * Failures that cost no outbound request (a malformed data URI, a bad scheme) stay on the
     * in-memory cache alone — there is nothing to protect the node from.
     */
    private refuse(itemId: string, thumbnailUrl: string | null, status: number, error: string): ThumbnailResult {
        this.cache.setNegative(itemId, status, error);
        if (this.backoffStore && isPersistentThumbnailFailure(status)) {
            this.backoffStore.recordFailure(itemId, thumbnailUrl, status, error);
        }
        return { status, error };
    }

    /** Bytes landed: whatever this item owed, it has paid. */
    private clearBackoff(itemId: string): void {
        this.backoffStore?.clear(itemId);
    }

    private async attemptThumbnailRecovery(
        itemId: string,
        row: { platform?: string; url?: string | null; external_id?: string | null },
        options: { ifNoneMatch?: string } = {}
    ): Promise<ThumbnailResult | null> {
        // 1. Instagram post recovery via public embed page
        const isInstagram = row.platform === 'instagram' ||
            Boolean(row.url && /(?:instagram\.com|instagr\.am)/i.test(row.url));
        if (isInstagram) {
            const embedUrl = extractInstagramEmbedUrl(row.url, row.external_id);
            if (embedUrl) {
                try {
                    const embedRes = await this.fetchFn(embedUrl, {
                        method: 'GET',
                        timeoutMs: this.timeoutMs,
                        maxBytes: INSTAGRAM_EMBED_MAX_BYTES,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        },
                        allowedContentTypes: ['text/html', 'text/plain'],
                    });
                    if (embedRes.status === 200) {
                        const html = await embedRes.text();
                        const freshUrl = extractThumbnailFromEmbedHtml(html);
                        if (freshUrl && /^https?:\/\//i.test(freshUrl)) {
                            const imgRes = await this.fetchFn(freshUrl, {
                                method: 'GET',
                                timeoutMs: this.timeoutMs,
                                maxBytes: this.maxEntryBytes,
                                allowedContentTypes: ALLOWED_IMAGE_CONTENT_TYPES,
                            });
                            if (imgRes.status === 200) {
                                const rawType = imgRes.headers['content-type'] || 'image/jpeg';
                                const mimeType = rawType.split(';')[0].trim().toLowerCase();
                                if (ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                                    const buffer = await imgRes.buffer();
                                    if (buffer.length <= this.maxEntryBytes) {
                                        try {
                                            const info = db.prepare(
                                                `UPDATE pulse_items SET thumbnail_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND deleted_at IS NULL`
                                            ).run(freshUrl, itemId);
                                            if (info.changes === 0) {
                                                // Item was deleted or tombstoned while recovery was in flight — discard bytes
                                                return null;
                                            }
                                        } catch {
                                            return null;
                                        }

                                        const entry = this.cache.set(itemId, buffer, mimeType);
                                        const etag = entry?.etag || `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
                                        if (this.diskStore) {
                                            await this.diskStore.set(itemId, buffer, mimeType, etag);
                                        }
                                        this.clearBackoff(itemId);
                                        if (options.ifNoneMatch && options.ifNoneMatch === etag) {
                                            return { status: 304 };
                                        }
                                        return { status: 200, buffer, contentType: mimeType, etag };
                                    }
                                }
                            }
                        }
                    }
                } catch (err: any) {
                    if (err instanceof SsrfSecurityError) throw err;
                    logger.warn('SYS', `[PulseThumbnail] Instagram embed recovery failed for item ${itemId}: ${err?.message || err}`);
                }
            }
        }
        return null;
    }

    async getThumbnail(
        itemId: string,
        options: { ifNoneMatch?: string } = {}
    ): Promise<ThumbnailResult> {
        if (!itemId || typeof itemId !== 'string') {
            return { status: 400, error: 'Invalid item ID' };
        }

        // 1. The tombstone check comes FIRST, ahead of both cache tiers.
        //
        // Caching the URL was harmless to get wrong; caching the bytes is not. scrubPulseItems
        // and prunePulseItems now evict the default service's cache as they tombstone, but a
        // tombstone can still arrive without them — a replica importing one through sync, a
        // service instance other than the default, a fetch that lands after the scrub. Behind
        // the old ordering such images kept answering 200 forever, and because each hit
        // refreshed lastAccessedAt they were never evicted either. A primary-key lookup costs
        // microseconds; a deletion that does not delete costs the promise the app makes about
        // erasing an account.
        const row = db.prepare(
            `SELECT id, platform, url, external_id, thumbnail_url, deleted_at FROM pulse_items WHERE id = ?`
        ).get(itemId) as {
            id: string;
            platform?: string;
            url?: string | null;
            external_id?: string | null;
            thumbnail_url: string | null;
            deleted_at: string | null;
        } | undefined;

        if (!row || row.deleted_at !== null) {
            // Scrubbed out from under the cache — take the bytes with it.
            this.delete(itemId);
            return { status: 404, error: 'Item not found' };
        }

        // What the backoff is keyed against: the exact URL a failure would be about.
        const normalisedThumbnailUrl = row.thumbnail_url?.trim() ? row.thumbnail_url.trim() : null;

        // 2. Check in-memory LRU cache
        const cached = this.cache.get(itemId);
        if (cached) {
            if (options.ifNoneMatch && options.ifNoneMatch === cached.etag) {
                return { status: 304 };
            }
            return {
                status: 200,
                buffer: cached.buffer,
                contentType: cached.contentType,
                etag: cached.etag,
            };
        }

        // 3. Check persistent disk store
        if (this.diskStore) {
            const diskEntry = await this.diskStore.get(itemId);
            if (diskEntry) {
                this.cache.set(itemId, diskEntry.buffer, diskEntry.contentType);
                if (options.ifNoneMatch && options.ifNoneMatch === diskEntry.etag) {
                    return { status: 304 };
                }
                return {
                    status: 200,
                    buffer: diskEntry.buffer,
                    contentType: diskEntry.contentType,
                    etag: diskEntry.etag,
                };
            }
        }

        // 4. Check negative cache (fast rejection to prevent tight retry loops)
        const neg = this.cache.getNegative(itemId);
        if (neg) {
            return { status: neg.status, error: neg.error };
        }

        // 4b. Check the persisted backoff, which outlives both the 5-minute negative cache and
        // a restart. It sits BELOW both cache tiers on purpose: an item that already has bytes
        // keeps serving them. Returning here is also what makes the failure log lines appear
        // once per backoff step instead of once per request — neither fetch below is reached.
        const backedOff = this.backoffStore?.getActive(itemId, normalisedThumbnailUrl) ?? null;
        if (backedOff) {
            return { status: backedOff.status, error: backedOff.error };
        }

        if (!row.thumbnail_url || !row.thumbnail_url.trim()) {
            const pending = this.inFlight.get(itemId);
            if (pending) return await pending;

            const recoveryPromise = (async (): Promise<ThumbnailResult> => {
                try {
                    const recovered = await this.attemptThumbnailRecovery(itemId, row, options);
                    if (recovered) return recovered;
                } catch (recoveryErr: any) {
                    if (recoveryErr instanceof SsrfSecurityError) {
                        logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address for item ${itemId}: ${recoveryErr.message}`);
                        return this.refuse(itemId, null, 400, recoveryErr.message);
                    }
                }
                return this.refuse(itemId, null, 404, 'Item has no thumbnail');
            })();

            this.inFlight.set(itemId, recoveryPromise);
            try {
                return await recoveryPromise;
            } finally {
                this.inFlight.delete(itemId);
            }
        }

        const rawUrl = row.thumbnail_url.trim();

        // 5. Handle base64 data URIs
        const dataMatch = rawUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (dataMatch) {
            const mimeType = dataMatch[1].toLowerCase().trim();
            if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                this.cache.setNegative(itemId, 400, `Prohibited data URI Content-Type: ${mimeType}`);
                return { status: 400, error: `Prohibited data URI Content-Type: ${mimeType}` };
            }
            try {
                const buf = Buffer.from(dataMatch[2], 'base64');
                if (buf.length > this.maxEntryBytes) {
                    this.cache.setNegative(itemId, 413, 'Thumbnail exceeds maximum size');
                    return { status: 413, error: 'Thumbnail exceeds maximum size' };
                }
                const entry = this.cache.set(itemId, buf, mimeType);
                const etag = entry?.etag || `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`;
                if (this.diskStore) {
                    await this.diskStore.set(itemId, buf, mimeType, etag);
                }
                this.clearBackoff(itemId);
                if (options.ifNoneMatch && options.ifNoneMatch === etag) {
                    return { status: 304 };
                }
                return { status: 200, buffer: buf, contentType: mimeType, etag };
            } catch {
                this.cache.setNegative(itemId, 400, 'Malformed base64 data URI');
                return { status: 400, error: 'Malformed base64 data URI' };
            }
        }

        // 6. Scheme check
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            this.cache.setNegative(itemId, 400, 'Invalid thumbnail URL syntax');
            return { status: 400, error: 'Invalid thumbnail URL syntax' };
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            this.cache.setNegative(itemId, 400, `Prohibited URL scheme: ${parsedUrl.protocol}`);
            return { status: 400, error: `Prohibited URL scheme: ${parsedUrl.protocol}` };
        }

        // 7. Request coalescing for concurrent fetches
        const pending = this.inFlight.get(itemId);
        if (pending) {
            return await pending;
        }

        const fetchPromise = (async (): Promise<ThumbnailResult> => {
            try {
                const res = await this.fetchFn(rawUrl, {
                    method: 'GET',
                    timeoutMs: this.timeoutMs,
                    maxBytes: this.maxEntryBytes,
                    allowedContentTypes: ALLOWED_IMAGE_CONTENT_TYPES,
                });

                if (res.status < 200 || res.status >= 300) {
                    if (res.status === 403 || res.status === 404 || res.status === 410) {
                        try {
                            const recovered = await this.attemptThumbnailRecovery(itemId, row, options);
                            if (recovered) return recovered;
                        } catch (recoveryErr: any) {
                            if (recoveryErr instanceof SsrfSecurityError) {
                                logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address for item ${itemId}: ${recoveryErr.message}`);
                                return this.refuse(itemId, rawUrl, 400, recoveryErr.message);
                            }
                        }
                    }
                    const status = (res.status >= 400 && res.status < 500) ? res.status : 502;
                    const error = `Upstream refused: HTTP ${res.status}`;
                    logger.warn('SYS', `[PulseThumbnail] Upstream refused for item ${itemId}: HTTP ${res.status}`);
                    return this.refuse(itemId, rawUrl, status, error);
                }

                const rawContentType = res.headers['content-type'] || '';
                const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
                if (!mimeType || !ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                    const error = `Upstream returned a non-image: ${mimeType || 'none'}`;
                    logger.warn('SYS', `[PulseThumbnail] Upstream returned a non-image for item ${itemId}: ${mimeType || 'none'}`);
                    return this.refuse(itemId, rawUrl, 502, error);
                }

                const buffer = await res.buffer();
                if (buffer.length > this.maxEntryBytes) {
                    const error = `Thumbnail body ${buffer.length} bytes exceeds maximum limit of ${this.maxEntryBytes} bytes`;
                    return this.refuse(itemId, rawUrl, 413, error);
                }

                const entry = this.cache.set(itemId, buffer, mimeType);
                const etag = entry?.etag || `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
                if (this.diskStore) {
                    await this.diskStore.set(itemId, buffer, mimeType, etag);
                }
                this.clearBackoff(itemId);

                if (options.ifNoneMatch && options.ifNoneMatch === etag) {
                    return { status: 304 };
                }

                return {
                    status: 200,
                    buffer,
                    contentType: mimeType,
                    etag,
                };
            } catch (err: any) {
                let status = 502;
                let error = err?.message || 'Failed to fetch thumbnail';

                if (err instanceof SsrfSecurityError) {
                    status = 400;
                    error = err.message;
                    logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address for item ${itemId}: ${err.message}`);
                } else {
                    try {
                        const recovered = await this.attemptThumbnailRecovery(itemId, row, options);
                        if (recovered) return recovered;
                    } catch (recoveryErr: any) {
                        if (recoveryErr instanceof SsrfSecurityError) {
                            logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address for item ${itemId}: ${recoveryErr.message}`);
                            return this.refuse(itemId, rawUrl, 400, recoveryErr.message);
                        }
                    }

                    if (err instanceof ProhibitedContentTypeError) {
                        status = 502;
                        error = `Upstream returned a non-image: ${err.message}`;
                        logger.warn('SYS', `[PulseThumbnail] Upstream returned a non-image for item ${itemId}: ${err.message}`);
                    } else if (err instanceof PayloadTooLargeError) {
                        status = 413;
                        error = err.message;
                        logger.warn('SYS', `[PulseThumbnail] Upstream payload too large for item ${itemId}: ${err.message}`);
                    } else if (err?.name === 'AbortError' || err?.message?.includes('timed out')) {
                        status = 504;
                        error = 'Upstream thumbnail request timed out';
                        logger.warn('SYS', `[PulseThumbnail] Upstream thumbnail request timed out for item ${itemId}`);
                    } else {
                        logger.warn('SYS', `[PulseThumbnail] Upstream thumbnail fetch failed for item ${itemId}: ${error}`);
                    }
                }

                return this.refuse(itemId, rawUrl, status, error);
            } finally {
                this.inFlight.delete(itemId);
            }
        })();

        this.inFlight.set(itemId, fetchPromise);
        return await fetchPromise;
    }

    async ingestThumbnail(itemId: string, rawUrl: string): Promise<ThumbnailResult> {
        if (!itemId || !rawUrl || typeof rawUrl !== 'string') {
            return { status: 400, error: 'Invalid item ID or URL' };
        }

        // 1. Check if already cached in memory or disk
        const cached = this.cache.get(itemId);
        if (cached) {
            return { status: 200, buffer: cached.buffer, contentType: cached.contentType, etag: cached.etag };
        }
        if (this.diskStore) {
            const diskEntry = await this.diskStore.get(itemId);
            if (diskEntry) {
                this.cache.set(itemId, diskEntry.buffer, diskEntry.contentType);
                return { status: 200, buffer: diskEntry.buffer, contentType: diskEntry.contentType, etag: diskEntry.etag };
            }
        }

        // Share the coalescing map with getThumbnail. Without it, a member scrolling the
        // feed while their sync is still filling it fetched the same image twice.
        const pending = this.inFlight.get(itemId);
        if (pending) return await pending;

        const work = this.ingestUncoalesced(itemId, rawUrl);
        this.inFlight.set(itemId, work);
        try {
            return await work;
        } finally {
            this.inFlight.delete(itemId);
        }
    }

    private async ingestUncoalesced(itemId: string, rawUrl: string): Promise<ThumbnailResult> {
        const trimmed = rawUrl.trim();

        // 2. Base64 data URI
        const dataMatch = trimmed.match(/^data:([^;]+);base64,(.*)$/);
        if (dataMatch) {
            const mimeType = dataMatch[1].toLowerCase().trim();
            if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                return { status: 400, error: `Prohibited data URI Content-Type: ${mimeType}` };
            }
            try {
                const buf = Buffer.from(dataMatch[2], 'base64');
                if (buf.length > this.maxEntryBytes) {
                    return { status: 413, error: 'Thumbnail exceeds maximum size' };
                }
                const entry = this.cache.set(itemId, buf, mimeType);
                const etag = entry?.etag || `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`;
                if (this.diskStore) {
                    await this.diskStore.set(itemId, buf, mimeType, etag);
                }
                this.clearBackoff(itemId);
                return { status: 200, buffer: buf, contentType: mimeType, etag };
            } catch {
                return { status: 400, error: 'Malformed base64 data URI' };
            }
        }

        // 3. Scheme check
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(trimmed);
        } catch {
            return { status: 400, error: 'Invalid thumbnail URL syntax' };
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { status: 400, error: `Prohibited URL scheme: ${parsedUrl.protocol}` };
        }

        try {
            const res = await this.fetchFn(trimmed, {
                method: 'GET',
                timeoutMs: this.timeoutMs,
                maxBytes: this.maxEntryBytes,
                allowedContentTypes: ALLOWED_IMAGE_CONTENT_TYPES,
            });

            if (res.status < 200 || res.status >= 300) {
                if (res.status === 403 || res.status === 404 || res.status === 410) {
                    try {
                        const row = db.prepare(
                            `SELECT id, platform, url, external_id, thumbnail_url, deleted_at FROM pulse_items WHERE id = ?`
                        ).get(itemId) as any;
                        if (row && row.deleted_at === null) {
                            const recovered = await this.attemptThumbnailRecovery(itemId, row);
                            if (recovered && recovered.status === 200) return recovered;
                        }
                    } catch (recoveryErr: any) {
                        if (recoveryErr instanceof SsrfSecurityError) {
                            logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address at ingest for item ${itemId}: ${recoveryErr.message}`);
                            return { status: 400, error: recoveryErr.message };
                        }
                    }
                }
                const status = (res.status >= 400 && res.status < 500) ? res.status : 502;
                const error = `Upstream refused: HTTP ${res.status}`;
                logger.warn('SYS', `[PulseThumbnail] Upstream refused at ingest for item ${itemId}: HTTP ${res.status}`);
                return { status, error };
            }

            const rawContentType = res.headers['content-type'] || '';
            const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
            if (!mimeType || !ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                const error = `Upstream returned a non-image: ${mimeType || 'none'}`;
                logger.warn('SYS', `[PulseThumbnail] Upstream returned a non-image at ingest for item ${itemId}: ${mimeType || 'none'}`);
                return { status: 502, error };
            }

            const buffer = await res.buffer();
            if (buffer.length > this.maxEntryBytes) {
                return { status: 413, error: `Thumbnail body ${buffer.length} bytes exceeds limit` };
            }

            const entry = this.cache.set(itemId, buffer, mimeType);
            const etag = entry?.etag || `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
            if (this.diskStore) {
                await this.diskStore.set(itemId, buffer, mimeType, etag);
            }
            // Bytes exist for this item again: a backoff row left from an earlier failure would
            // otherwise refuse the read path once the memory and disk copies age out.
            this.clearBackoff(itemId);

            return { status: 200, buffer, contentType: mimeType, etag };
        } catch (err: any) {
            let status = 502;
            let error = err?.message || 'Failed to ingest thumbnail';

            if (err instanceof SsrfSecurityError) {
                status = 400;
                error = err.message;
                logger.security('SYS', `[PulseThumbnail] Blocked as a prohibited address at ingest for item ${itemId}: ${err.message}`);
            } else if (err instanceof ProhibitedContentTypeError) {
                status = 502;
                error = `Upstream returned a non-image: ${err.message}`;
                logger.warn('SYS', `[PulseThumbnail] Upstream returned a non-image at ingest for item ${itemId}: ${err.message}`);
            } else if (err instanceof PayloadTooLargeError) {
                status = 413;
                error = err.message;
                logger.warn('SYS', `[PulseThumbnail] Upstream payload too large at ingest for item ${itemId}: ${err.message}`);
            } else if (err?.name === 'AbortError' || err?.message?.includes('timed out')) {
                status = 504;
                error = 'Upstream thumbnail request timed out';
                logger.warn('SYS', `[PulseThumbnail] Upstream thumbnail request timed out at ingest for item ${itemId}`);
            } else {
                logger.warn('SYS', `[PulseThumbnail] Failed to ingest thumbnail for item ${itemId}: ${error}`);
            }
            return { status, error };
        }
    }

    /** Synchronous for callers on a request path; the disk unlink settles on its own. */
    delete(itemId: string): void {
        this.cache.delete(itemId);
        this.clearBackoff(itemId);
        void this.diskStore?.delete(itemId).catch(() => {});
    }

    clear(): void {
        this.cache.clear();
        this.backoffStore?.clearAll();
        void this.diskStore?.clear().catch(() => {});
    }

    /**
     * Cache a batch of thumbnails, at most `concurrency` fetches in the air at once.
     *
     * Firing one fetch per item with Promise.allSettled put up to fifty 2 MB downloads in
     * flight together — 100 MB of live buffers against a 512 MB heap that already sits at
     * 120-180 MB, and an outbound request flood a member could aim at any host by choosing
     * what they post. Three at a time keeps the peak near 6 MB and the node a poor
     * amplifier, at the cost of a slower background fill nobody is waiting on.
     */
    async ingestThumbnails(entries: Array<{ id: string; url: string }>, concurrency = INGEST_CONCURRENCY): Promise<void> {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
            while (cursor < entries.length) {
                const entry = entries[cursor++];
                try {
                    await this.ingestThumbnail(entry.id, entry.url);
                } catch { /* best effort: the proxy can still fetch on demand */ }
            }
        });
        await Promise.all(workers);
    }

    /**
     * Queue a batch to fill in after the response has gone out, and expose the tail so a
     * test (or a shutdown) can wait for it. Ingest exists to catch the signed URL while it
     * is fresh, which it still does seconds later — it does not need to be on the critical
     * path of the member's request.
     */
    queueIngest(entries: Array<{ id: string; url: string }>): void {
        if (entries.length === 0) return;
        this.ingestQueue = this.ingestQueue
            .then(() => this.ingestThumbnails(entries))
            .catch(() => {});
    }

    /** Resolves when every queued background ingest has settled. */
    async idle(): Promise<void> {
        let previous: Promise<void>;
        do {
            previous = this.ingestQueue;
            await previous;
        } while (previous !== this.ingestQueue);
    }
}

export const defaultPulseThumbnailService = new PulseThumbnailService();

// Every tombstone written through scrubPulseItems/prunePulseItems evicts here, not only the routes
// that remember to call delete().
setPulseItemCacheEvictor((itemId) => defaultPulseThumbnailService.delete(itemId));

export function getPulseThumbnailService(): PulseThumbnailService {
    return defaultPulseThumbnailService;
}
