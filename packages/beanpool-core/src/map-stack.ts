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

/**
 * The list opens by itself (Marty, 2 Nov: "if you can bring up a bubble - why not just bring up the list? that also closes
 * as you zoom out?"). Both apps keep this state and hand `settleStackList` what the map shows each time it stops, so the rule
 * is one rule. A bubble's keys are its pins, so a filter or a sync can change a stack and it is still that stack.
 */

/** How much of the map the list covers, from the bottom: enough for a row or two to scroll, with the stack in view above. */
export const STACK_LIST_SHARE = 1 / 3;
/** How long the map must have stopped before the list opens: a pinch that pauses and goes on is still one pinch. */
export const STACK_REST_MS = 400;
/** How far above the list's top edge a stack's point must sit for its bubble, about 60 px tall, to show whole. */
export const STACK_CLEARANCE_PX = 40;
/**
 * "Near the middle", as shares of the view. Wider than a bullseye, because the list has to find a stack a member zoomed in on
 * by feel, but it stops above the list's top edge, so an opening list never covers the stack it opened for.
 */
const MIDDLE = { left: 0.2, right: 0.8, top: 0.2, bottom: 0.55 };

export interface MapFrame { width: number; height: number }

/** A bubble on the map when it stopped. */
export interface StackBubble {
    keys: readonly string[];
    /** Its point, in px from the view's top left. */
    x: number;
    y: number;
}

export interface MapRest {
    view: MapFrame;
    /** The bubbles on the map, on the view or not. */
    bubbles: readonly StackBubble[];
    /**
     * The map is as deep as a tap would take it, the cap. A bubble still there cannot part by a tap, since it parts past the
     * cap by definition. Above the cap a stack is a bubble among the town's, and stays one until it is tapped.
     */
    atCap: boolean;
    /** A post, a pin's card, the category panel or the composer is open. They win: nothing opens or closes under them. */
    blocked: boolean;
}

export interface StackListState {
    /** The open list's pins, or null. */
    open: readonly string[] | null;
    /** The member opened it, so it is theirs at any zoom. */
    byTap: boolean;
    /** The pins of the stack the member closed. It stays closed until they have left it. */
    shut: readonly string[] | null;
}

export const STACK_LIST_CLOSED: StackListState = { open: null, byTap: false, shut: null };

/** A tap on a bubble, at any zoom. It is the member's own ask, so it also ends an earlier ✕ on that stack. */
export function stackTapped(keys: readonly string[]): StackListState {
    return { open: keys, byTap: true, shut: null };
}

/** The member closed it: ✕, a tap on the map, Escape. */
export function stackShut(state: StackListState): StackListState {
    return { open: null, byTap: false, shut: state.open ?? state.shut };
}

/** It went for another reason (a pin's card, a row emptied, leaving the map): the stack is free to open it again. */
export function stackDropped(state: StackListState): StackListState {
    return state.open ? { ...state, open: null, byTap: false } : state;
}

const sharesPin = (a: readonly string[], b: readonly string[]) => a.some((key) => b.includes(key));
const within = (a: readonly string[], b: readonly string[]) => a.length > 0 && a.every((key) => b.includes(key));

function nearMiddle(b: StackBubble, view: MapFrame): boolean {
    return b.x >= view.width * MIDDLE.left && b.x <= view.width * MIDDLE.right
        && b.y >= view.height * MIDDLE.top && b.y <= view.height * MIDDLE.bottom;
}

function distanceFromMiddle(b: StackBubble, view: MapFrame): number {
    return Math.hypot(b.x - view.width / 2, b.y - view.height / 2);
}

/** The y of the list's top edge. */
export function stackListTop(view: MapFrame): number {
    return view.height * (1 - STACK_LIST_SHARE);
}

/** On the part of the view the list leaves showing. */
function aboveList(b: StackBubble, view: MapFrame): boolean {
    return b.x >= 0 && b.x <= view.width && b.y >= 0 && b.y <= stackListTop(view);
}

function onView(b: StackBubble, view: MapFrame): boolean {
    return b.x >= 0 && b.x <= view.width && b.y >= 0 && b.y <= view.height;
}

/**
 * How far up a tapped bubble must go to stay in view above the list, in px; 0 when it already is. A tap can be anywhere, so
 * unlike an opening by itself, it can land under where the list comes up. A point past the bottom of the view is a view read
 * mid-move, not a place the member tapped, so it moves nothing.
 */
export function stackLift(y: number, view: MapFrame): number {
    return y > view.height ? 0 : Math.max(0, y - (stackListTop(view) - STACK_CLEARANCE_PX));
}

/**
 * What the list does when the map has stopped.
 *
 * - It opens for the stack nearest the middle that cannot part, once the map is at the cap.
 * - It stays while its stack shows above it, and a list that opened by itself also needs the map to stay at the cap, so
 *   zooming out closes it. A tapped list was asked for, so it only closes when its stack has gone: panned away, merged into
 *   a bigger bubble, or parted.
 * - With two stacks it stays on the open one for as long as that one is near the middle, then moves in one step when another
 *   is, so panning between them never closes and reopens it, and a stack on the line cannot flicker.
 * - A closed stack stays closed until it is off the view, the map is back above the cap, or it has parted.
 */
export function settleStackList(state: StackListState, rest: MapRest): StackListState {
    if (rest.blocked) return state;
    const { view, bubbles, atCap } = rest;

    const shut = state.shut && atCap && bubbles.some((b) => onView(b, view) && sharesPin(b.keys, state.shut!)) ? state.shut : null;
    const candidates = atCap
        ? bubbles.filter((b) => nearMiddle(b, view) && !(shut && sharesPin(b.keys, shut)))
        : [];
    const nearest = candidates.reduce<StackBubble | null>(
        (best, b) => (!best || distanceFromMiddle(b, view) < distanceFromMiddle(best, view) ? b : best), null);

    if (state.open) {
        const open = state.open;
        const mine = bubbles.find((b) => within(b.keys, open));
        const stays = !!mine && aboveList(mine, view) && (state.byTap || atCap);
        if (stays && (state.byTap || nearMiddle(mine!, view) || !nearest || sharesPin(nearest.keys, open))) return { ...state, shut };
    }
    return nearest ? { open: nearest.keys, byTap: false, shut } : { open: null, byTap: false, shut };
}

/**
 * Waits for the map to have stopped. `moving` is every sign it has not, `stopped` the end of a move: Google Maps reports one
 * whenever the camera pauses, even with fingers still down, so `fire` runs only if nothing moves for `wait` after it.
 */
export function stackRestWatch(fire: () => void, wait: number = STACK_REST_MS) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const moving = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return {
        moving,
        stopped() {
            moving();
            timer = setTimeout(() => { timer = null; fire(); }, wait);
        },
    };
}
