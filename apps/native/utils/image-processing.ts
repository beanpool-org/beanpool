/**
 * A member's or an enterprise's picture's address, ready to draw. A picture picked for an avatar or a logo is cut on the
 * crop screen (utils/picture-crop.ts, components/PictureCrop.tsx: the part the member chose, 512 px square).
 */
import { getCachedAnchorUrl } from './node-post';

/**
 * Build a cache-busted avatar URI for rendering.
 * Handles data URIs, remote URLs, relative paths, and adds cache-busting query params.
 * 
 * @param url - The raw avatar URL (data: URI, remote URL, relative /api/ path, or null)
 * @param pubkey - User's public key (fallback cache key)
 * @param updatedAt - ISO timestamp of last profile update (preferred cache key)
 * @param nodeUrl - Optional base node URL to resolve relative paths
 * @returns Cache-busted URI string, or null if no avatar
 */
export function avatarUri(url: string | null | undefined, pubkey: string, updatedAt?: string | null, nodeUrl?: string | null): string | null {
    if (!url) return null;
    // data: URIs are already unique by content
    if (url.startsWith('data:')) return url;
    // Bundled avatar references don't need cache-busting
    if (url.startsWith('bundled://')) return url;
    let resolved = url;
    if (resolved.startsWith('/')) {
        const base = (nodeUrl || getCachedAnchorUrl() || '').replace(/\/+$/, '');
        if (base) {
            resolved = `${base}${resolved}`;
        }
    }
    // Use profile_updated_at for precise cache-busting, fall back to pubkey slice
    const cacheKey = updatedAt ? new Date(updatedAt).getTime() : pubkey.slice(0, 8);
    const sep = resolved.includes('?') ? '&' : '?';
    return `${resolved}${sep}_v=${cacheKey}`;
}
