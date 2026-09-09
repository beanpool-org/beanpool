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
import { URL } from 'node:url';
import { db } from '../db/db.js';
import {
    ssrfSafeFetch,
    SsrfSecurityError,
    PayloadTooLargeError,
    type SsrfSafeFetchOptions,
    type SsrfSafeResponse,
} from './pulse-resolver.js';

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_MAX_CACHE_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB
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

export interface PulseThumbnailOptions {
    cache?: PulseThumbnailCache;
    fetchFn?: (url: string, options?: SsrfSafeFetchOptions) => Promise<SsrfSafeResponse>;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
    timeoutMs?: number;
    negativeTtlMs?: number;
}

export class PulseThumbnailService {
    public readonly cache: PulseThumbnailCache;
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

        // 2. Check negative cache (fast rejection to prevent tight retry loops)
        const neg = this.cache.getNegative(itemId);
        if (neg) {
            return { status: neg.status, error: neg.error };
        }

        // 3. Database lookup for feed item
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

        // 4. Handle base64 data URIs
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
                if (options.ifNoneMatch && options.ifNoneMatch === etag) {
                    return { status: 304 };
                }
                return { status: 200, buffer: buf, contentType: mimeType, etag };
            } catch {
                this.cache.setNegative(itemId, 400, 'Malformed base64 data URI');
                return { status: 400, error: 'Malformed base64 data URI' };
            }
        }

        // 5. Scheme check
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

        // 6. Request coalescing for concurrent fetches
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
                    const error = `Upstream returned HTTP ${res.status}`;
                    this.cache.setNegative(itemId, status, error);
                    return { status, error };
                }

                const rawContentType = res.headers['content-type'] || '';
                const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
                if (!mimeType || !ALLOWED_IMAGE_CONTENT_TYPES.includes(mimeType)) {
                    const error = `Prohibited or invalid Content-Type: ${mimeType || 'none'}`;
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
                } else if (err instanceof PayloadTooLargeError) {
                    status = 413;
                    error = err.message;
                } else if (err?.name === 'AbortError' || err?.message?.includes('timed out')) {
                    status = 504;
                    error = 'Upstream thumbnail request timed out';
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
}

export const defaultPulseThumbnailService = new PulseThumbnailService();

export function getPulseThumbnailService(): PulseThumbnailService {
    return defaultPulseThumbnailService;
}
