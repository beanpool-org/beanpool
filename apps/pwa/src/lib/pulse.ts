import { getNodeApiUrl } from './api';

/**
 * Resolve the proxy endpoint for a Pulse feed item thumbnail.
 *
 * Directs the browser to the node's same-origin endpoint:
 *   GET /api/pulse/items/:id/thumbnail
 *
 * This satisfies CSP (img-src 'self'), avoids leaking member IPs to Meta and Google,
 * and survives CDN signed URL expiry.
 */
export function resolvePulseThumbnailUrl(itemId: string | null | undefined): string | null {
    if (!itemId || !itemId.trim()) return null;
    const base = getNodeApiUrl();
    return `${base}/api/pulse/items/${encodeURIComponent(itemId.trim())}/thumbnail`;
}

/**
 * Format an ISO publishedAt timestamp into a human-readable relative string.
 *
 * e.g. "Just now", "25m ago", "3h ago", "2d ago", "Aug 24"
 */
export function formatRelativeTime(dateString: string | null | undefined): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diffMs = now - date.getTime();

    // Future timestamp protection
    if (diffMs < 0) return 'Just now';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;

    // Format as "MMM D" e.g. "Aug 24"
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Which lane of the feed an item belongs to.
 *
 * SKETCH ONLY. In production this must be a server-side flag on the channel
 * (creator_channels.is_official, set when an admin creates the channel) and the
 * lane should be a query parameter on GET /api/pulse/feed so pagination stays
 * correct. Deriving it on the client the way this does is a prototype shortcut:
 * it cannot see items that live on later pages.
 */
export function isOfficialSource(item: { source?: string; isOfficial?: boolean }): boolean {
    return item.source === 'official' || Boolean(item.isOfficial);
}

