/**
 * Pinning utils on the phone (DESIGN-pinning-fable.md §2).
 *
 * Live pins: posts on the board with `pinnedUntil` in the future. Evaluated dynamically via `pinLive`
 * so pins expire by the clock on the device without needing a sync.
 */
import { PIN_CHOICES, type PinDays, PINS_MAX, pinLive, formatDate, t } from '@beanpool/core';

import { signedRequestWords } from '../components/signed-request-lines';

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

// ---- Who sees what (DESIGN-pinning-fable.md §2.3, question 5) --------------------------------------------------------
// The node decides every pin and unpin (engine/pins.ts mayPin: owner or admin; unpin adds the post's author). These
// only decide what the phone OFFERS, from the role the node last told it (GET /api/node-admin/me).

/** The reader's role here as the node said it: null for none or not heard. */
export type PinRole = 'owner' | 'admin' | 'moderator' | null | undefined;

/** Pinning is for an owner or an admin. A moderator and a plain member are not offered it. */
export function mayPinHere(role: PinRole): boolean {
    return role === 'owner' || role === 'admin';
}

/** Taking a pin off is for an owner, an admin, or the post's author. */
export function mayTakePinOff(role: PinRole, isAuthor: boolean): boolean {
    return mayPinHere(role) || isAuthor;
}

/**
 * Whether a post's "···" is drawn: pins are on in this community, and there is something in it for this reader. An owner or
 * admin always has something (Pin, or Take the pin off); the author of a pinned post has Take the pin off; nobody else has.
 */
export function showPinMenu(o: { pinsOn: boolean; role: PinRole; pinned: boolean; isAuthor: boolean }): boolean {
    if (!o.pinsOn) return false;
    if (mayPinHere(o.role)) return true;
    return o.pinned && o.isAuthor;
}

/**
 * The words for a pin or unpin that did not work, as every other signed send's refusal is shown (components/signed-request-lines
 * `signedRequestWords`): the node's own sentence exactly as given (it writes it in the member's language: db.ts
 * `_signedRequest` sends X-Language), db.ts's own sentences ("Server returned 500", off-grid) in the member's language,
 * and, when there is no message at all, the caller's fallback, which the caller has put through t().
 */
export function pinFailureText(err: unknown, fallback: string): string {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    if (typeof message !== 'string' || !message.trim()) return fallback;
    return signedRequestWords(message);
}

// ---- The Market's pinned block ---------------------------------------------------------------------------------------

/** Whether any of these posts has a live pin at `now`: the Market's 30-second clock runs only while one does. */
export function anyLivePin(posts: ReadonlyArray<any>, now: number = Date.now()): boolean {
    return posts.some(p => isPostPinned(p, now));
}

/**
 * The Market's pinned block (DESIGN-pinning-fable.md §0.2, §2.2, §2.9): up to PINS_MAX live pins from `basePosts` that pass
 * `visible` (the member's filters), newest pin first, none while the list is narrowed (search, tag, distance). `rest` is
 * `filtered` without them, so a pin is never drawn twice; `allMatching` and `realMatchingCount` count both, which is what the
 * fill, the empty state and the example listings weigh.
 */
export function marketPins<T extends { id: string }>(o: {
    basePosts: ReadonlyArray<T>;
    filtered: ReadonlyArray<T>;
    narrowed: boolean;
    now: number;
    visible: (p: T) => boolean;
}): { pinned: T[]; rest: T[]; allMatching: T[]; realMatchingCount: number } {
    let pinned: T[] = [];
    if (!o.narrowed) {
        pinned = o.basePosts.filter(p => isPostPinned(p, o.now) && o.visible(p));
        pinned.sort(comparePinsNewestFirst);
        pinned = pinned.slice(0, PINS_MAX);
    }
    const ids = new Set(pinned.map(p => p.id));
    const rest = pinned.length > 0 ? o.filtered.filter(p => !ids.has(p.id)) : [...o.filtered];
    const allMatching = [...rest, ...pinned];
    return { pinned, rest, allMatching, realMatchingCount: allMatching.length };
}
