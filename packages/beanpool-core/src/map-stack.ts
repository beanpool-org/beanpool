/**
 * What a tap on a map bubble does, the same on the phone and the web (Marty, 2 Nov, after testing 1.2.87): pins in one
 * spot never split, and a tap that chased them landed so deep "you have to scroll out for ages just to get to see other
 * pins". A tap either zooms, stopping at a cap, or, when the bubble would still be a bubble at the cap, opens a list of its
 * pins. The two apps cluster with different libraries, so each works out when its own bubble splits and passes it here.
 */
import { t } from './words.js';

/**
 * The deepest a tap on a bubble takes the map, as a map zoom. At 17 a 320 dp phone shows about 340 m across at Bangalow's
 * latitude: a few blocks, with the town a couple of zooms out. A member can still pinch deeper; only a tap stops here.
 */
export const MAP_TAP_CAP_ZOOM = 17;

export type BubbleTap = 'zoom' | 'list';

/**
 * `splitsAt` is the first zoom at which the bubble is no longer the same bubble. Past the cap a tap could not part it, so
 * zooming would be a tap that does nothing useful: it opens the list instead.
 */
export function bubbleTap(splitsAt: number, capZoom: number): BubbleTap {
    return splitsAt > capZoom ? 'list' : 'zoom';
}

/**
 * Where a zoom lands: the zoom that fits the bubble's pins, but deep enough that the bubble parts (a fit can stop short of
 * that, and a tap that leaves the same bubble is a dead end) and never past the cap.
 */
export function bubbleLandingZoom(fitZoom: number, splitsAt: number, capZoom: number): number {
    return Math.min(capZoom, Math.max(fitZoom, splitsAt));
}

export interface StackSortKeys {
    /** An event's start in ms; null for an Offer, a Need or anything else with no date. */
    eventStartMs: number | null;
    /** When it was posted, in ms; NaN or 0 when unknown, which sorts last. */
    createdMs: number;
}

/**
 * The list's order: the soonest events first, then Offers and Needs together, newest first. An event with no readable
 * date goes after the dated ones and before the listings. Ties keep the order they came in.
 */
export function orderStack<T>(rows: readonly T[], keysOf: (row: T) => StackSortKeys): T[] {
    const created = (k: StackSortKeys) => (Number.isFinite(k.createdMs) ? k.createdMs : 0);
    const start = (k: StackSortKeys) => (Number.isFinite(k.eventStartMs) ? (k.eventStartMs as number) : Infinity);
    return rows
        .map((row) => ({ row, keys: keysOf(row) }))
        .sort((a, b) => {
            const aEvent = a.keys.eventStartMs !== null;
            const bEvent = b.keys.eventStartMs !== null;
            if (aEvent !== bEvent) return aEvent ? -1 : 1;
            if (aEvent) {
                const sa = start(a.keys);
                const sb = start(b.keys);
                return sa === sb ? 0 : sa < sb ? -1 : 1;
            }
            return created(b.keys) - created(a.keys);
        })
        .map(({ row }) => row);
}

/** The list's header. One sentence for every count, so it reads the same at 1 as at 100. */
export function stackHeading(n: number): string {
    return t('{n} at this spot', { n });
}
