/**
 * A pin (scratch/fable-design/DESIGN-pinning-fable.md §2): an owner's or admin's choice to hold one public post at the top
 * of the Market for a short, fixed time. Two stamps on the post, `pinnedUntil` and `pinnedAt`, written by the node
 * (apps/server engine/pins.ts). One rule here, so that a pin ends by the clock on every screen the moment its time passes,
 * whether or not the node has tidied the row yet.
 *
 * The node's own reads hold the same rule in SQL (@beanpool/engine PIN_ON_BOARD_SQL), which adds what only the node knows:
 * whether the author's account is on the board. A sync read gives such a listing as paused, so here it reads as not live.
 */

/** How long a pin lasts, in days: the pinner's three choices, and a week is the longest. */
export const PIN_CHOICES = Object.freeze([1, 3, 7] as const);
export type PinDays = (typeof PIN_CHOICES)[number];

/** The most live pins a community holds at once. */
export const PINS_MAX = 3;

export function isPinDays(value: unknown): value is PinDays {
    return (PIN_CHOICES as readonly unknown[]).includes(value);
}

/** What the rule reads of a post. */
export interface PinnablePost {
    pinnedUntil?: string | null;
    type?: string;
    active?: boolean;
    status?: string;
    audienceScope?: string | null;
    hiddenByReportsAt?: string | null;
    removedByModeratorAt?: string | null;
    originNode?: string | null;
    eventState?: string | null;
    eventStartAt?: string | null;
    eventEndAt?: string | null;
    pollClosesAt?: string | null;
}

/**
 * Whether a post's pin stands at `now`: its time hasn't passed, and the post is still on the board. Active, public, not
 * hidden or removed, this community's own, an event not ended or cancelled, and a poll not closed. A post that has been
 * taken up, paused or completed has a status other than active, and is not live.
 */
export function pinLive(post: PinnablePost, now: number = Date.now()): boolean {
    if (!post.pinnedUntil) return false;
    const until = Date.parse(post.pinnedUntil);
    if (!(until > now)) return false;
    if (post.active === false || post.status !== 'active') return false;
    if (post.audienceScope && post.audienceScope !== 'public') return false;
    if (post.hiddenByReportsAt || post.removedByModeratorAt || post.originNode) return false;
    if (post.type === 'event') {
        if (post.eventState === 'cancelled') return false;
        const ends = post.eventEndAt ?? post.eventStartAt;
        if (ends && !(Date.parse(ends) > now)) return false;
    }
    if (post.type === 'poll' && post.pollClosesAt && !(Date.parse(post.pollClosesAt) > now)) return false;
    return true;
}
