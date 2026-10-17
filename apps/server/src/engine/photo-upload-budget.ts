/**
 * Per-member daily photo upload budget and free-disk floor (storage design P7).
 *
 * Bounds the photo bytes a single member can store in 24 hours across chat attachments,
 * listing photos, avatars, and group pictures.
 *
 * Refusal:
 * - When over PHOTO_BYTES_PER_MEMBER_PER_DAY: HTTP 429, Retry-After header, and
 *   "You've shared a lot of photos today. Try again tomorrow."
 * - When free disk space falls below PHOTO_MIN_FREE_DISK_MB (for disk store only):
 *   HTTP 507 Insufficient Storage and "This community's storage is nearly full. Tell its owner."
 *   Owners and admins are not exempt from the floor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isSelfAvatarUrl, isSelfGroupPictureUrl } from '@beanpool/core';
import { db } from '../db/db.js';
import { configuredImageStoreKind, imagesDir } from '../storage/image-store.js';
import { isSelfPostPhotoUrl } from './avatar.js';

export const PHOTO_BUDGET_EXCEEDED_MESSAGE = "You've shared a lot of photos today. Try again tomorrow.";
export const STORAGE_NEARLY_FULL_MESSAGE = "This community's storage is nearly full. Tell its owner.";

export const DEFAULT_PHOTO_BYTES_PER_MEMBER_PER_DAY = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_PHOTO_MIN_FREE_DISK_MB = 2048; // 2048 MB = 2 GB
export const DAY_MS = 24 * 60 * 60 * 1000;

const BASE64_TEXT = /^[A-Za-z0-9+/=_\-\s]+$/;

export class PhotoBudgetExceededError extends Error {
    readonly status = 429;
    readonly code = 'photo_budget';
    constructor(
        readonly resetsAt: string,
        readonly retryAfterSeconds: number,
        message = PHOTO_BUDGET_EXCEEDED_MESSAGE
    ) {
        super(message);
        this.name = 'PhotoBudgetExceededError';
    }
}

export class StorageNearlyFullError extends Error {
    readonly status = 507;
    readonly code = 'storage_nearly_full';
    constructor(message = STORAGE_NEARLY_FULL_MESSAGE) {
        super(message);
        this.name = 'StorageNearlyFullError';
    }
}

/**
 * Read PHOTO_BYTES_PER_MEMBER_PER_DAY from the environment every time.
 * Default: 100 MB (104,857,600 bytes). 0 = off.
 */
export function photoBytesPerMemberPerDay(): number {
    const raw = process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY;
    if (raw === undefined || raw === '') return DEFAULT_PHOTO_BYTES_PER_MEMBER_PER_DAY;
    const num = Number(raw.trim());
    return Number.isFinite(num) && num >= 0 ? num : DEFAULT_PHOTO_BYTES_PER_MEMBER_PER_DAY;
}

/**
 * Read PHOTO_MIN_FREE_DISK_MB from the environment every time.
 * Default: 2048 MB.
 */
export function photoMinFreeDiskMb(): number {
    const raw = process.env.PHOTO_MIN_FREE_DISK_MB;
    if (raw === undefined || raw === '') return DEFAULT_PHOTO_MIN_FREE_DISK_MB;
    const num = Number(raw.trim());
    return Number.isFinite(num) && num >= 0 ? num : DEFAULT_PHOTO_MIN_FREE_DISK_MB;
}

let simulatedFreeDiskBytes: number | null = null;

export function setSimulatedFreeDiskBytesForTests(bytes: number | null): void {
    simulatedFreeDiskBytes = bytes;
}

/**
 * Check free disk space on the filesystem hosting the disk image store.
 */
export function getFreeDiskBytes(dir = imagesDir()): number {
    if (simulatedFreeDiskBytes !== null) return simulatedFreeDiskBytes;
    try {
        let checkPath = dir;
        if (!fs.existsSync(checkPath)) {
            while (!fs.existsSync(checkPath) && checkPath !== path.dirname(checkPath)) {
                checkPath = path.dirname(checkPath);
            }
        }
        const stats = fs.statfsSync(checkPath);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * Verify disk storage floor. Skipped when IMAGE_STORE=s3.
 */
export function assertDiskFloorSpace(): void {
    if (configuredImageStoreKind() === 's3') return;
    const floorMb = photoMinFreeDiskMb();
    if (floorMb <= 0) return;
    const floorBytes = floorMb * 1024 * 1024;
    const freeBytes = getFreeDiskBytes();
    if (freeBytes < floorBytes) {
        throw new StorageNearlyFullError();
    }
}

/**
 * Compute the byte size of an incoming photo upload (chat attachment, listing photo, avatar, or group picture).
 * Returns 0 if the value is null, undefined, a self reference URL, or an existing external URL.
 */
export function incomingPhotoBytes(value: unknown): number {
    if (!value) return 0;
    if (typeof value === 'object' && value !== null && 'data' in value && typeof (value as any).data === 'string') {
        return Buffer.byteLength((value as any).data, 'base64');
    }
    if (typeof value !== 'string') return 0;
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (
        isSelfAvatarUrl(trimmed) ||
        isSelfGroupPictureUrl(trimmed) ||
        isSelfPostPhotoUrl(trimmed) ||
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('bundled://') ||
        trimmed.startsWith('/api/') ||
        (trimmed.startsWith('/') && trimmed.length < 512)
    ) {
        return 0;
    }
    if (/^data:/i.test(trimmed)) {
        const match = trimmed.match(/^data:[^;]+;base64,(.+)$/is);
        if (match) {
            return Buffer.byteLength(match[1].trim(), 'base64');
        }
        return 0;
    }
    if (BASE64_TEXT.test(trimmed) && trimmed.length >= 16) {
        return Buffer.byteLength(trimmed, 'base64');
    }
    return 0;
}

export function incomingPhotosBytes(photos: unknown[]): number {
    if (!Array.isArray(photos)) return 0;
    return photos.reduce((sum: number, p: unknown) => sum + incomingPhotoBytes(p), 0);
}

let tableChecked = false;
function ensurePhotoBudgetTable(): void {
    if (tableChecked) return;
    try {
        db.prepare('SELECT 1 FROM photo_budget_log LIMIT 1').get();
        tableChecked = true;
    } catch {
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS photo_budget_log (
                    member_pubkey TEXT NOT NULL,
                    at INTEGER NOT NULL,
                    bytes INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_photo_budget_log_member_at ON photo_budget_log(member_pubkey, at);
                CREATE INDEX IF NOT EXISTS idx_photo_budget_log_at ON photo_budget_log(at);
            `);
            tableChecked = true;
        } catch {
            // Ignore if db is not initialized yet
        }
    }
}

export function resetPhotoBudgetForTests(): void {
    ensurePhotoBudgetTable();
    try {
        db.prepare('DELETE FROM photo_budget_log').run();
    } catch { }
    simulatedFreeDiskBytes = null;
}

export function advancePhotoBudgetForTests(ms: number): void {
    ensurePhotoBudgetTable();
    try {
        db.prepare('UPDATE photo_budget_log SET at = at - ?').run(ms);
    } catch { }
}

export function getMemberPhotoUsageForTests(authorPubkey: string, now = Date.now()): { usedBytes: number; entryCount: number } {
    ensurePhotoBudgetTable();
    try {
        const rows = db.prepare('SELECT bytes FROM photo_budget_log WHERE member_pubkey = ? AND at > ?')
            .all(authorPubkey, now - DAY_MS) as { bytes: number }[];
        return {
            usedBytes: rows.reduce((sum, r) => sum + r.bytes, 0),
            entryCount: rows.length,
        };
    } catch {
        return { usedBytes: 0, entryCount: 0 };
    }
}

/**
 * Asserts that the member has sufficient daily budget to store incomingBytes,
 * and that disk image storage satisfies the minimum free disk floor.
 *
 * Owners and admins are not exempt.
 */
export function assertMayStorePhotoBytes(authorPubkey: string, incomingBytes: number, now = Date.now()): void {
    assertDiskFloorSpace();
    if (incomingBytes <= 0) return;
    const budget = photoBytesPerMemberPerDay();
    if (budget <= 0) return;

    ensurePhotoBudgetTable();

    let rows: { at: number; bytes: number }[] = [];
    try {
        rows = db.prepare('SELECT at, bytes FROM photo_budget_log WHERE member_pubkey = ? AND at > ? ORDER BY at ASC')
            .all(authorPubkey, now - DAY_MS) as { at: number; bytes: number }[];
    } catch {
        rows = [];
    }

    const usedBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
    if (usedBytes + incomingBytes > budget) {
        let resetsAtMs = now + DAY_MS;
        if (rows.length > 0) {
            let freed = 0;
            for (const r of rows) {
                freed += r.bytes;
                if ((usedBytes - freed) + incomingBytes <= budget) {
                    resetsAtMs = r.at + DAY_MS;
                    break;
                }
            }
        }
        resetsAtMs = Math.max(now + 1000, resetsAtMs);
        const retryAfterSeconds = Math.max(1, Math.ceil((resetsAtMs - now) / 1000));
        throw new PhotoBudgetExceededError(new Date(resetsAtMs).toISOString(), retryAfterSeconds);
    }
}

/**
 * Record successfully stored photo bytes in the 24-hour sliding window.
 * Prunes entries older than 48 hours.
 */
export function recordStoredPhotoBytes(authorPubkey: string, bytes: number, now = Date.now()): void {
    if (bytes <= 0) return;
    ensurePhotoBudgetTable();
    try {
        db.prepare('INSERT INTO photo_budget_log (member_pubkey, at, bytes) VALUES (?, ?, ?)').run(authorPubkey, now, bytes);
        db.prepare('DELETE FROM photo_budget_log WHERE at < ?').run(now - 48 * 60 * 60 * 1000);
    } catch { }
}
