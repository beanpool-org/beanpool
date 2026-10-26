/**
 * Pure helpers for the "needs you" alerts in the top bar: priority order,
 * slot calculation / fitting into available width, and invite change detection.
 * Shared between phone and web (@beanpool/core).
 */

export type NeedsYouKind = 'admin' | 'deal' | 'vote' | 'invite' | 'message' | 'group';

/**
 * Highest first. The highest sits nearest the right-hand controls and keeps its spot as others
 * come and go; the lowest are the first to fold into "•••".
 */
export const NEEDS_YOU_PRIORITY: readonly NeedsYouKind[] = ['admin', 'deal', 'vote', 'invite', 'message', 'group'];

export const NEEDS_YOU_SLOT = 48;

/**
 * What fits in a slot this wide. When there are more kinds than slots, the last slot
 * becomes "•••" for the rest. Nothing shows until the slot has been measured (width <= 0).
 */
export function fitNeedsYou<T extends { kind: NeedsYouKind }>(entries: T[], width: number, slot = NEEDS_YOU_SLOT): { shown: T[]; hidden: number } {
    const slots = Math.floor(width / slot);
    if (slots <= 0) return { shown: [], hidden: 0 };
    if (entries.length <= slots) return { shown: entries, hidden: 0 };
    const shown = entries.slice(0, slots - 1);
    return { shown, hidden: entries.length - shown.length };
}

/**
 * Left to right, as drawn: the row is right-aligned against the right-hand controls, so the
 * highest priority is last (rightmost) and "•••" is first (nearest the bean/title).
 */
export function needsYouRowOrder<T extends { kind: NeedsYouKind }>(fit: { shown: T[]; hidden: number }): (NeedsYouKind | 'more')[] {
    const kinds: (NeedsYouKind | 'more')[] = fit.shown.map(e => e.kind).reverse();
    return fit.hidden > 0 ? ['more', ...kinds] : kinds;
}

/**
 * A socket event that changes one of this member's own invitations to a group: one made (`group_member_invited`, which
 * the node sends to the group's convenors and the member invited), or one taken up, declined or withdrawn (the row
 * updated or removed, which the member's own sockets get too).
 */
export function isOwnInviteChange(data: unknown, me: string | null | undefined): boolean {
    if (!me || !data || typeof data !== 'object') return false;
    const d = data as { type?: unknown; member?: { memberPubkey?: unknown } | null; memberPubkey?: unknown };
    if (d.type === 'group_member_invited' || d.type === 'group_member_updated') return d.member?.memberPubkey === me;
    if (d.type === 'group_member_removed') return d.memberPubkey === me;
    return false;
}
