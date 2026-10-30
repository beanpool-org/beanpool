/**
 * A Market that reads by area (the worldwide community, `features.nearbyListings`) and finds little near the member
 * fills itself in underneath with the newest from elsewhere (Damo via Marty, 30 Oct: "Nearby, then fill"), so a
 * newcomer never lands on an empty list. Both apps use the same rule; the listings are exactly the ones "Show
 * everywhere" reads, so nothing new is shown that the member could not already have asked for.
 *
 * Nearest first stays: the nearby listings come first, as read. Only when they are fewer than FILL_BELOW does the
 * fill come after them, never repeating one already shown, and never taking the list past a page.
 */

/** Fewer than this many listings shown near the member, under the current filters, and the fill is read. */
export const FILL_BELOW = 8;

/** The most the whole list holds with the fill in it: the node's own page (50) of the "everywhere" read. */
export const FILL_MAX = 50;

/** Whether the list shown near the member is short enough to be filled. */
export function wantsFill(shownNear: number): boolean {
    return shownNear < FILL_BELOW;
}

/**
 * The listings that fill under `shown`: from `everywhere` in the order it came (newest first), not one already in
 * `shown`, each once, up to FILL_MAX in all. Nothing when `shown` is long enough already.
 */
export function elsewhereFill<T extends { id: string }>(shown: readonly T[], everywhere: readonly T[]): T[] {
    if (!wantsFill(shown.length)) return [];
    const seen = new Set(shown.map(p => p.id));
    const room = FILL_MAX - shown.length;
    const fill: T[] = [];
    for (const p of everywhere) {
        if (fill.length >= room) break;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fill.push(p);
    }
    return fill;
}
