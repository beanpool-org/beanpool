/**
 * Pinning utils on the phone (DESIGN-pinning-fable.md §2).
 *
 * Live pins: posts on the board with `pinnedUntil` in the future. Evaluated dynamically via `pinLive`
 * so pins expire by the clock on the device without needing a sync.
 */
import { PIN_CHOICES, type PinDays, PINS_MAX, pinLive, formatDate, t } from '@beanpool/core';

export { PIN_CHOICES, type PinDays, PINS_MAX, pinLive };

/**
 * Normalizes SQLite post row or client post shape and evaluates whether its pin is live at `now`.
 */
export function isPostPinned(post: any, now: number = Date.now()): boolean {
    if (!post) return false;
    const pinnedUntil = post.pinnedUntil || post.pinned_until || null;
    if (!pinnedUntil) return false;

    const isActive = post.active !== undefined
        ? (post.active === 1 || post.active === true)
        : (post.status ? post.status === 'active' : true);

    const status = post.status || (isActive ? 'active' : 'inactive');

    const pinnable = {
        pinnedUntil,
        type: post.type,
        active: isActive,
        status,
        audienceScope: post.audienceScope || post.audience_scope || 'public',
        hiddenByReportsAt: post.hiddenByReportsAt || post.hidden_by_reports_at || null,
        removedByModeratorAt: post.removedByModeratorAt || post.removed_by_moderator_at || null,
        originNode: post.originNode || post.origin_node || null,
        eventState: post.eventState || post.event_state || null,
        eventStartAt: post.eventStartAt || post.event_start_at || null,
        eventEndAt: post.eventEndAt || post.event_end_at || null,
        pollClosesAt: post.pollClosesAt || post.poll_closes_at || null,
    };

    return pinLive(pinnable, now);
}

/**
 * The detail line for a pinned post (DESIGN-pinning-fable.md §0.2, §2.7, §2.12):
 * "Pinned by your community · until {date}"
 * Single line with date formatted through the words layer (no raw Intl).
 */
export function pinnedDetailLine(post: any): string {
    const until = post?.pinnedUntil || post?.pinned_until;
    if (!until) return '';
    const dateStr = formatDate(new Date(until), 'weekday-day-month');
    return t('Pinned by your community · until {date}', { date: dateStr });
}

/**
 * Sort helper for pinned posts: newest pin first (pinned_at / pinnedAt DESC),
 * falling back to created_at DESC.
 */
export function comparePinsNewestFirst(a: any, b: any): number {
    const timeA = new Date(a.pinnedAt || a.pinned_at || a.created_at || a.createdAt || 0).getTime();
    const timeB = new Date(b.pinnedAt || b.pinned_at || b.created_at || b.createdAt || 0).getTime();
    return timeB - timeA;
}
