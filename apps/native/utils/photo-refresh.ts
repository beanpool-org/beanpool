/**
 * A listing's photo that would not load, read again from the node, bounded.
 *
 * The phone keeps the photo URLs a listing came with. A node that starts keying its listings' photos (PR #1286), stops,
 * or keys them with a new secret, hands out new URLs for listings that did not otherwise change, and the old ones
 * answer 404. The node answers a sync from before that with every listing (apps/server engine/photo-keys.ts), and this
 * is the phone's own net under it: a thumbnail that fails to load has its listing read again (utils/db.ts
 * refreshPostForPhoto), which writes the new URLs and reloads the screens if they changed.
 *
 * An <Image>'s onError does not say why it failed (no connection looks the same as a 404), so every failure counts, and
 * it is bounded so a photo that stays broken never loops: one read per URL per RETRY_AFTER_MS, one at a time per
 * listing, and at most MAX_PER_WINDOW in any WINDOW_MS across the app (a whole Market of stale URLs is then healed a
 * few at a time, while the next sync heals the rest).
 */
import { refreshPostForPhoto } from './db';

export const RETRY_AFTER_MS = 10 * 60_000;
export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 10;
/** The URLs remembered at most; past it the memory starts again (a bound, not a cache). */
const MAX_REMEMBERED = 500;

const triedAt = new Map<string, number>();
const inFlight = new Set<string>();
let windowStart = 0;
let inWindow = 0;

/**
 * Called by a screen whose photo of listing `postId` at `url` would not load. Reads the listing again unless the bounds
 * above say not now. Returns whether it did.
 */
export function refreshListingAfterPhotoError(postId: string | null | undefined, url: string | null | undefined, now: number = Date.now()): boolean {
    if (!postId || !url || !url.includes('/api/marketplace/posts/')) return false;
    const last = triedAt.get(url);
    if (last !== undefined && now - last < RETRY_AFTER_MS) return false;
    if (inFlight.has(postId)) return false;
    if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
    }
    if (inWindow >= MAX_PER_WINDOW) return false;
    inWindow++;
    if (triedAt.size >= MAX_REMEMBERED) triedAt.clear();
    triedAt.set(url, now);
    inFlight.add(postId);
    refreshPostForPhoto(postId, url)
        .catch(() => false)
        .finally(() => { inFlight.delete(postId); });
    return true;
}

/** Tests only: forget every bound. */
export function resetPhotoRefreshForTests(): void {
    triedAt.clear();
    inFlight.clear();
    windowStart = 0;
    inWindow = 0;
}
