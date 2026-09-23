/**
 * The ONE place a stored avatar value becomes a URL this node emits, and the ONE place that
 * decides whether a stored value is a real avatar at all.
 *
 * Two problems live here.
 *
 * STALENESS. `/api/avatar/<pk>?size=thumb` carried no version, so a changed photo kept the
 * same URL. Every client that caches by URL — expo-image with `cachePolicy="memory-disk"` on
 * the phone, and the browser for the PWA — kept serving the old bytes, and the route's
 * `must-revalidate` + ETag never got the chance to say otherwise. The URL now carries `&v=`,
 * derived from the CONTENT of the stored avatar. Because it is derived from the content, it
 * changes on every write path — profile update, enterprise or group edit, federation import,
 * restore, prune — without any of them having to remember to invalidate anything. Fixing this
 * at the server fixes the builds already on members' phones, and the PWA, as soon as a node
 * updates.
 *
 * SELF-REFERENCE. Installed app builds read `members.avatar_url` out of their synced local
 * row — which since #725 holds this node's own `/api/avatar/…` string — and post it straight
 * back as `avatar` on the next profile save. The node stored it, and from then on
 * `GET /api/avatar/<pk>` 404d: the photo was gone. Such a row now reads as NO avatar
 * (emitted null, and no photo for the marketplace gate), so members see their initials rather
 * than a blank ring and the phone's existing self-heal republishes the canonical copy.
 * `isSelfAvatarUrl` is the write-side half: see `engine/members.ts` and `db/db.ts`.
 */

import crypto from 'node:crypto';

/**
 * Is this string one of THIS node's own avatar URLs, round-tripped back to us?
 *
 * Matched relative (`/api/avatar/<pk>?size=thumb`) and absolute on ANY host: the phone
 * resolves the relative path against whichever node it is anchored to before it renders,
 * and a member who joins a second node can carry the first node's absolute URL over.
 * Deliberately host-agnostic — a URL naming some other node's avatar route is no more a
 * portable avatar than one naming ours.
 */
export function isSelfAvatarUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Relative: the exact shape emitted below.
    if (/^\/api\/avatar\//i.test(trimmed)) return true;
    // Absolute: any scheme, any host, provided the PATH is the avatar route.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/api\/avatar\//i.test(trimmed)) return true;
    return false;
}

/**
 * Is this stored value something the node can actually serve as an avatar?
 *
 * `bundled://…` is a reference to a shipped asset; anything else is expected to be image
 * bytes (a `data:` URI, or the legacy bare base64 the avatar service still decodes). A
 * self-referential URL is neither, and reads as "no avatar".
 */
export function isServableAvatarValue(stored: string | null | undefined): stored is string {
    if (!stored || !stored.trim()) return false;
    return !isSelfAvatarUrl(stored);
}

/**
 * Content-derived version cache.
 *
 * Hashing a stored avatar is cheap once and wasteful per row: a members list re-derives the
 * same version for the same unchanged bytes on every request. So the version is memoised per
 * id, and reused only when the stored string is byte-for-byte what it was — an exact `===`,
 * never a length or prefix sample, so a changed avatar can never keep an old version. That
 * comparison is a memcmp of two strings already in memory; the hash is a SHA-256 over up to
 * 2 MB, which is what we are avoiding on every row of every list.
 *
 * Bounded like `AvatarCache`, and for the same reason: the entries hold avatar-sized strings,
 * so an unbounded map is a slow memory leak on a node with many members. Least-recently-used
 * is evicted first.
 */
const MAX_VERSION_CACHE_CHARS = 8 * 1024 * 1024;

interface VersionCacheEntry {
    stored: string;
    version: string;
}

const versionCache = new Map<string, VersionCacheEntry>();
let versionCacheChars = 0;

/** Test seam: drop every memoised version, so a suite can prove the derivation, not the cache. */
export function clearAvatarVersionCache(): void {
    versionCache.clear();
    versionCacheChars = 0;
}

/** Test seam: how much the memo is holding. */
export function avatarVersionCacheStats(): { count: number; chars: number } {
    return { count: versionCache.size, chars: versionCacheChars };
}

/**
 * A short, stable, content-derived version for a stored avatar value.
 *
 * Same bytes in, same version out, for the life of the node and across restarts — it is a
 * hash, not a counter, so a restore or a federation import that brings back an older photo
 * brings back its old version too, which is correct: the bytes really are those bytes.
 */
export function avatarVersionOf(id: string, stored: string): string {
    const cached = versionCache.get(id);
    if (cached && cached.stored === stored) {
        // Refresh LRU position.
        versionCache.delete(id);
        versionCache.set(id, cached);
        return cached.version;
    }

    const version = crypto.createHash('sha256').update(stored).digest('hex').slice(0, 8);

    if (cached) {
        versionCacheChars -= cached.stored.length;
        versionCache.delete(id);
    }
    while (versionCacheChars + stored.length > MAX_VERSION_CACHE_CHARS && versionCache.size > 0) {
        const oldestKey = versionCache.keys().next().value;
        if (!oldestKey) break;
        const oldest = versionCache.get(oldestKey);
        if (oldest) versionCacheChars -= oldest.stored.length;
        versionCache.delete(oldestKey);
    }
    // A single avatar larger than the whole budget is served without being memoised rather
    // than evicting everything else to hold it.
    if (versionCacheChars + stored.length <= MAX_VERSION_CACHE_CHARS) {
        versionCache.set(id, { stored, version });
        versionCacheChars += stored.length;
    }

    return version;
}

/**
 * The avatar URL to emit for a member, enterprise, treasury or group.
 *
 * @param id      the key `/api/avatar/:pubkey` will be looked up by — a member public key, an
 *                enterprise or treasury pubkey, or a group id.
 * @param stored  the raw stored `avatar_url`, exactly as the row holds it.
 *
 * Returns null when there is nothing servable, `bundled://…` unchanged (it names a shipped
 * asset, so it is already versioned by its name and needs no buster), and otherwise the
 * versioned route URL.
 */
export function avatarUrlFor(id: string, stored: string | null | undefined): string | null {
    if (!isServableAvatarValue(stored)) return null;
    const trimmed = stored.trim();
    if (trimmed.startsWith('bundled://')) return stored;
    return `/api/avatar/${id}?size=thumb&v=${avatarVersionOf(id, trimmed)}`;
}
