/**
 * Member Avatar Service.
 *
 * Serves real image bytes with proper Content-Type (NOT base64 data URIs).
 *
 * Key behaviors:
 * 1. Strong ETag derived from avatar content hash.
 * 2. Conditional GET with If-None-Match returns 304 Not Modified.
 * 3. Immutable caching headers: Cache-Control: public, max-age=31536000, immutable.
 * 4. Size parameter support:
 *    - `?size=thumb` is reserved for future thumbnail generation (e.g. client-side on upload).
 *      Currently serves stored full-size avatar bytes for all sizes without native resize dependencies (no sharp).
 * 5. In-memory LRU cache (10 MB bound) for fast decoded-byte retrieval and instant ETag comparison.
 * 6. Reference implementation matches /api/marketplace/posts/:id/photos/:orderNum for data URI decoding.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/db.js';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_MAX_AVATAR_CACHE_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB RAM

export interface AvatarCacheEntry {
    rawUrl: string;
    buffer: Buffer;
    contentType: string;
    etag: string;
    cachedAt: number;
    size: number;
}

export interface AvatarResult {
    status: number;
    buffer?: Buffer;
    contentType?: string;
    etag?: string;
    error?: string;
}

export class AvatarCache {
    private cache = new Map<string, AvatarCacheEntry>();
    private currentBytes = 0;
    private maxTotalBytes: number;
    private maxEntryBytes: number;

    constructor(options: { maxTotalBytes?: number; maxEntryBytes?: number } = {}) {
        this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_AVATAR_CACHE_TOTAL_BYTES;
        this.maxEntryBytes = options.maxEntryBytes ?? MAX_AVATAR_BYTES;
    }

    get(key: string): AvatarCacheEntry | null {
        const entry = this.cache.get(key);
        if (!entry) return null;
        // Move to MRU position
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry;
    }

    set(key: string, entry: Omit<AvatarCacheEntry, 'size'>): AvatarCacheEntry | null {
        if (entry.buffer.length > this.maxEntryBytes) return null;

        const existing = this.cache.get(key);
        if (existing) {
            this.currentBytes -= existing.size;
            this.cache.delete(key);
        }

        while (this.currentBytes + entry.buffer.length > this.maxTotalBytes && this.cache.size > 0) {
            const oldestKey = this.cache.keys().next().value;
            if (!oldestKey) break;
            const oldestEntry = this.cache.get(oldestKey);
            if (oldestEntry) {
                this.currentBytes -= oldestEntry.size;
            }
            this.cache.delete(oldestKey);
        }

        if (this.currentBytes + entry.buffer.length > this.maxTotalBytes) return null;

        const fullEntry: AvatarCacheEntry = {
            ...entry,
            size: entry.buffer.length,
        };

        this.cache.set(key, fullEntry);
        this.currentBytes += fullEntry.size;
        return fullEntry;
    }

    delete(key: string): void {
        const existing = this.cache.get(key);
        if (existing) {
            this.currentBytes -= existing.size;
            this.cache.delete(key);
        }
    }

    deleteByPrefix(prefix: string): void {
        for (const key of Array.from(this.cache.keys())) {
            if (key.startsWith(prefix)) {
                this.delete(key);
            }
        }
    }

    clear(): void {
        this.cache.clear();
        this.currentBytes = 0;
    }

    getStats(): { count: number; totalBytes: number; maxTotalBytes: number } {
        return {
            count: this.cache.size,
            totalBytes: this.currentBytes,
            maxTotalBytes: this.maxTotalBytes,
        };
    }
}

function findBundledAvatarFile(name: string): string | null {
    const filename = `avatar_${name.replace(/-/g, '_')}.jpg`;
    const candidates = [
        path.resolve('public', 'avatars', filename),
        path.join(process.cwd(), 'public', 'avatars', filename),
        path.join(process.cwd(), 'apps', 'server', 'public', 'avatars', filename),
        path.join(process.cwd(), 'apps', 'pwa', 'public', 'avatars', filename),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

export interface AvatarServiceOptions {
    cache?: AvatarCache;
    maxTotalBytes?: number;
}

export class AvatarService {
    public readonly cache: AvatarCache;

    constructor(options: AvatarServiceOptions = {}) {
        this.cache = options.cache ?? new AvatarCache({
            maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_AVATAR_CACHE_TOTAL_BYTES,
        });
    }

    async getAvatar(
        pubkey: string,
        _size: 'thumb' | 'full' = 'full',
        options: { ifNoneMatch?: string } = {}
    ): Promise<AvatarResult> {
        if (!pubkey || typeof pubkey !== 'string') {
            return { status: 400, error: 'Invalid public key' };
        }

        // Check if member exists and has an avatar_url
        const row = db.prepare(
            `SELECT public_key, avatar_url FROM members WHERE public_key = ?`
        ).get(pubkey) as { public_key: string; avatar_url: string | null } | undefined;

        if (!row || !row.avatar_url || !row.avatar_url.trim()) {
            return { status: 404, error: 'Avatar not found' };
        }

        const rawUrl = row.avatar_url.trim();

        // Check in-memory L1 cache; if rawUrl matches, use cached decoded buffer and etag
        const cached = this.cache.get(pubkey);
        if (cached && cached.rawUrl === rawUrl) {
            const ifNoneMatch = options.ifNoneMatch?.replace(/^W\//, '');
            const cleanEtag = cached.etag.replace(/^W\//, '');
            if (ifNoneMatch && (ifNoneMatch === cleanEtag || ifNoneMatch === cleanEtag.replace(/"/g, ''))) {
                return { status: 304, etag: cached.etag };
            }
            return {
                status: 200,
                buffer: cached.buffer,
                contentType: cached.contentType,
                etag: cached.etag,
            };
        }

        // Resolve raw bytes and mimeType
        let fullBuffer: Buffer;
        let mimeType = 'image/jpeg';

        if (rawUrl.startsWith('bundled://')) {
            const bundledId = rawUrl.replace('bundled://', '').split('?')[0];
            const filePath = findBundledAvatarFile(bundledId);
            if (!filePath) {
                return { status: 404, error: `Bundled avatar ${bundledId} not found on disk` };
            }
            try {
                fullBuffer = await fs.promises.readFile(filePath);
                mimeType = 'image/jpeg';
            } catch {
                return { status: 500, error: 'Failed to read bundled avatar file' };
            }
        } else {
            // Match behaviour of /api/marketplace/posts/:id/photos/:orderNum
            const dataMatch = rawUrl.match(/^data:([^;]+);base64,(.*)$/);
            if (dataMatch) {
                mimeType = dataMatch[1].toLowerCase().trim();
                try {
                    fullBuffer = Buffer.from(dataMatch[2], 'base64');
                } catch {
                    return { status: 400, error: 'Malformed base64 data URI' };
                }
            } else {
                try {
                    fullBuffer = Buffer.from(rawUrl, 'base64');
                    mimeType = 'image/jpeg';
                } catch {
                    return { status: 400, error: 'Unsupported avatar format' };
                }
            }
        }

        if (fullBuffer.length > MAX_AVATAR_BYTES) {
            return { status: 413, error: 'Avatar exceeds maximum size limit' };
        }

        // Strong ETag derived from avatar content hash
        const contentHash = crypto.createHash('sha256').update(fullBuffer).digest('hex').slice(0, 16);
        const etag = `"${contentHash}"`;

        // Cache decoded buffer and content type
        this.cache.set(pubkey, {
            rawUrl,
            buffer: fullBuffer,
            contentType: mimeType,
            etag,
            cachedAt: Date.now(),
        });

        const ifNoneMatch = options.ifNoneMatch?.replace(/^W\//, '');
        const cleanEtag = etag.replace(/^W\//, '');
        if (ifNoneMatch && (ifNoneMatch === cleanEtag || ifNoneMatch === cleanEtag.replace(/"/g, ''))) {
            return { status: 304, etag };
        }

        return {
            status: 200,
            buffer: fullBuffer,
            contentType: mimeType,
            etag,
        };
    }

    delete(pubkey: string): void {
        this.cache.delete(pubkey);
    }

    clear(): void {
        this.cache.clear();
    }
}

let defaultAvatarService: AvatarService | null = null;
export function getAvatarService(options?: AvatarServiceOptions): AvatarService {
    if (!defaultAvatarService || options) {
        defaultAvatarService = new AvatarService(options);
    }
    return defaultAvatarService;
}
