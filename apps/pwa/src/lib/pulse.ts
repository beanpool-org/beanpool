import { formatDate, t } from '@beanpool/core';
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
 * How long ago an ISO publishedAt timestamp was, in the one unit a card says it in: under a minute (or in the future),
 * minutes, hours, days, or from a week on the date itself. Null when there is no usable date (the phone's
 * utils/pulse.ts pulseAge).
 */
export type PulseAge =
    | { unit: 'now' }
    | { unit: 'minutes' | 'hours' | 'days'; n: number }
    | { unit: 'date'; date: Date };

export function pulseAge(dateString: string | null | undefined): PulseAge | null {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null;

    const diffMs = Date.now() - date.getTime();

    // Future timestamp protection
    if (diffMs < 0) return { unit: 'now' };

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return { unit: 'now' };
    if (diffMin < 60) return { unit: 'minutes', n: diffMin };
    if (diffHour < 24) return { unit: 'hours', n: diffHour };
    if (diffDay < 7) return { unit: 'days', n: diffDay };
    return { unit: 'date', date };
}

/**
 * When an item was published, in the member's language (the same words as the phone's PulseFeedCard): "Just now",
 * "25m ago", "3h ago", "2d ago", then the date ("24 Aug"). Called where the card is drawn, never at module level.
 */
export function formatRelativeTime(dateString: string | null | undefined): string {
    const age = pulseAge(dateString);
    if (!age) return '';
    switch (age.unit) {
        case 'now': return t('Just now');
        case 'minutes': return t('{n}m ago', { n: age.n });
        case 'hours': return t('{n}h ago', { n: age.n });
        case 'days': return t('{n}d ago', { n: age.n });
        case 'date': return formatDate(age.date, 'day-month');
    }
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

