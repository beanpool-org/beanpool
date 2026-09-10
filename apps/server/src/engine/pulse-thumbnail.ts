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
    type SsrfSafeFetchOptions,
    type SsrfSafeResponse,
} from './pulse-resolver.js';

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_MAX_CACHE_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB RAM
export const DEFAULT_MAX_DISK_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB disk
export const DEFAULT_FETCH_TIMEOUT_MS = 5000; // 5 seconds
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_NEGATIVE_CACHE_ENTRIES = 1000;

export const ALLOWED_IMAGE_CONTENT_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
];

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

    constructor(options: {
        diskDir?: string;
        maxDiskBytes?: number;
        maxEntryBytes?: number;
    } = {}) {
        const dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        this.diskDir = options.diskDir ?? path.join(dataDir, 'pulse-thumbnails');
        this.maxDiskBytes = options.maxDiskBytes ?? DEFAULT_MAX_DISK_CACHE_BYTES;
        this.maxEntryBytes = options.maxEntryBytes ?? MAX_THUMBNAIL_BYTES;
        try {
            if (!fs.existsSync(this.diskDir)) {
                fs.mkdirSync(this.diskDir, { recursive: true });
            }
        } catch {}
    }

    private safeFilename(itemId: string): string {
        return itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private metaPath(itemId: string): string {
        return path.join(this.diskDir, `${this.safeFilename(itemId)}.json`);
    }

    private binPath(itemId: string): string {
        return path.join(this.diskDir, `${this.safeFilename(itemId)}.bin`);
    }

    get(itemId: string): ThumbnailCacheEntry | null {
        try {
            const metaFile = this.metaPath(itemId);
            const binFile = this.binPath(itemId);
            if (!fs.existsSync(metaFile) || !fs.existsSync(binFile)) return null;

            const meta: DiskStoreEntryMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            const buffer = fs.readFileSync(binFile);

            // Touch lastAccessedAt
            meta.lastAccessedAt = getMonotonicTime();
            try {
                fs.writeFileSync(metaFile, JSON.stringify(meta));
            } catch {}

            return {
                buffer,
                contentType: meta.contentType,
                etag: meta.etag,
                cachedAt: meta.cachedAt,
                size: meta.size,
            };
        } catch {
            return null;
        }
    }

    set(itemId: string, buffer: Buffer, contentType: string, etag?: string): ThumbnailCacheEntry | null {
        if (buffer.length > this.maxEntryBytes || buffer.length > this.maxDiskBytes) {
            return null;
        }

        try {
            if (!fs.existsSync(this.diskDir)) {
                fs.mkdirSync(this.diskDir, { recursive: true });
            }

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

            const metaFile = this.metaPath(itemId);
            const binFile = this.binPath(itemId);

            fs.writeFileSync(binFile, buffer);
            fs.writeFileSync(metaFile, JSON.stringify(meta));

            this.evictIfNeeded();

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

    delete(itemId: string): void {
        try {
            const metaFile = this.metaPath(itemId);
            const binFile = this.binPath(itemId);
            if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
            if (fs.existsSync(binFile)) fs.unlinkSync(binFile);
        } catch {}
    }

    clear(): void {
        try {
            if (!fs.existsSync(this.diskDir)) return;
            const files = fs.readdirSync(this.diskDir);
            for (const f of files) {
                try {
                    fs.unlinkSync(path.join(this.diskDir, f));
                } catch {}
            }
        } catch {}
    }

    private evictIfNeeded(): void {
        try {
            const files = fs.readdirSync(this.diskDir);
            const metaFiles = files.filter(f => f.endsWith('.json'));
            const entries: Array<{ itemId: string; size: number; lastAccessedAt: number }> = [];
            let totalBytes = 0;

            for (const mf of metaFiles) {
                try {
                    const raw = fs.readFileSync(path.join(this.diskDir, mf), 'utf8');
                    const parsed = JSON.parse(raw) as DiskStoreEntryMeta;
                    entries.push({
                        itemId: parsed.itemId,
                        size: parsed.size || 0,
                        lastAccessedAt: parsed.lastAccessedAt || parsed.cachedAt || 0,
                    });
                    totalBytes += (parsed.size || 0);
                } catch {}
            }

            if (totalBytes <= this.maxDiskBytes) return;

            // Sort ascending by lastAccessedAt (oldest first)
            entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

            for (const entry of entries) {
                if (totalBytes <= this.maxDiskBytes) break;
                this.delete(entry.itemId);
                totalBytes -= entry.size;
            }
        } catch {}
    }

    getStats(): { count: number; totalBytes: number; maxDiskBytes: number } {
        try {
            if (!fs.existsSync(this.diskDir)) {
                return { count: 0, totalBytes: 0, maxDiskBytes: this.maxDiskBytes };
            }
            const files = fs.readdirSync(this.diskDir);
            const metaFiles = files.filter(f => f.endsWith('.json'));
            let totalBytes = 0;
            for (const mf of metaFiles) {
                try {
                    const raw = fs.readFileSync(path.join(this.diskDir, mf), 'utf8');
                    const parsed = JSON.parse(raw);
                    totalBytes += parsed.size || 0;
                } catch {}
            }
            return {
                count: metaFiles.length,
                totalBytes,
                maxDiskBytes: this.maxDiskBytes,
            };
        } catch {
            return { count: 0, totalBytes: 0, maxDiskBytes: this.maxDiskBytes };
        }
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
}

export class PulseThumbnailService {
    public readonly cache: PulseThumbnailCache;
    public readonly diskStore: PulseThumbnailDiskStore | null;
    private inFlight = new Map<string, Promise<ThumbnailResult>>();
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
    }

    async getThumbnail(
        itemId: string,
        options: { ifNoneMatch?: string } = {}
    ): Promise<ThumbnailResult> {
        if (!itemId || typeof itemId !== 'string') {
            return { status: 400, error: 'Invalid item ID' };
        }

        // 1. Check in-memory LRU cache
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

        // 2. Check persistent disk store
        if (this.diskStore) {
            const diskEntry = this.diskStore.get(itemId);
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

        // 3. Check negative cache (fast rejection to prevent tight retry loops)
        const neg = this.cache.getNegative(itemId);
        if (neg) {
            return { status: neg.status, error: neg.error };
        }

        // 4. Database lookup for feed item
        const row = db.prepare(
            `SELECT id, thumbnail_url, deleted_at FROM pulse_items WHERE id = ?`
        ).get(itemId) as { id: string; thumbnail_url: string | null; deleted_at: string | null } | undefined;

        if (!row || row.deleted_at !== null) {
            return { status: 404, error: 'Item not found' };
        }

        if (!row.thumbnail_url || !row.thumbnail_url.trim()) {
            return { status: 404, error: 'Item has no thumbnail' };
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
                    this.diskStore.set(itemId, buf, mimeType, etag);
                }
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
                    const status = (res.status >= 400 && res.status < 500) ? res.status : 502;
                    const error = `Upstream refused: HTTP ${res.status}`;
                    logger.warn('SYS', `[PulseThumbnail] Upstream refused for item ${itemId}: HTTP ${res.status}`);
                    this.cache.setNegative(itemId, status, error);
                    return { status, error };
                }

                const rawContentType = res.headers['content-type'] || '';
                const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
                if (!mimeType || !ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                    const error = `Upstream returned a non-image: ${mimeType || 'none'}`;
                    logger.warn('SYS', `[PulseThumbnail] Upstream returned a non-image for item ${itemId}: ${mimeType || 'none'}`);
                    this.cache.setNegative(itemId, 502, error);
                    return { status: 502, error };
                }

                const buffer = await res.buffer();
                if (buffer.length > this.maxEntryBytes) {
                    const error = `Thumbnail body ${buffer.length} bytes exceeds maximum limit of ${this.maxEntryBytes} bytes`;
                    this.cache.setNegative(itemId, 413, error);
                    return { status: 413, error };
                }

                const entry = this.cache.set(itemId, buffer, mimeType);
                const etag = entry?.etag || `"${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}"`;
                if (this.diskStore) {
                    this.diskStore.set(itemId, buffer, mimeType, etag);
                }

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
                } else if (err instanceof ProhibitedContentTypeError) {
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

                this.cache.setNegative(itemId, status, error);
                return { status, error };
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
            const diskEntry = this.diskStore.get(itemId);
            if (diskEntry) {
                this.cache.set(itemId, diskEntry.buffer, diskEntry.contentType);
                return { status: 200, buffer: diskEntry.buffer, contentType: diskEntry.contentType, etag: diskEntry.etag };
            }
        }

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
                    this.diskStore.set(itemId, buf, mimeType, etag);
                }
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
                this.diskStore.set(itemId, buffer, mimeType, etag);
            }

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

    delete(itemId: string): void {
        this.cache.delete(itemId);
        if (this.diskStore) {
            this.diskStore.delete(itemId);
        }
    }

    clear(): void {
        this.cache.clear();
        if (this.diskStore) {
            this.diskStore.clear();
        }
    }
}

export const defaultPulseThumbnailService = new PulseThumbnailService();

export function getPulseThumbnailService(): PulseThumbnailService {
    return defaultPulseThumbnailService;
}
