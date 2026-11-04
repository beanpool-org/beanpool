/**
 * The phone's drag in Arrange (DESIGN-home-arrange-in-place-fable.md §2.2, §2.3, slice A4), as a state machine with no React
 * Native in it, so its paths can be tested in Node: hold → lift → move → drop, and every way it is put back.
 *
 * - **Hold.** A card is lifted by a hold: its band held 500 ms on Home (the hold that opens Arrange carries on as a drag), or
 *   anywhere on a card that moves, held still 250 ms, in Arrange. A finger that moves before the hold fires is scrolling:
 *   the Pressable that times the hold lets the list take the touch, and nothing is lifted (`lift` is never called).
 * - **Lift.** The list stops scrolling (the finger has not moved, so no scroll has begun), a light tick, and Home draws the
 *   card where it would land (at first, where it stands) with the band in the finger.
 * - **Move.** The band follows the finger; the place is `placeLifted`'s (core, one rule for both apps), read again only when
 *   the finger is over another place, and after each step of the edge scroll.
 * - **Drop.** Saved once, through the same write as an arrow, and only if the place changed. Back, Home losing focus, the app
 *   going to the background, a touch taken by the system, the card leaving Home, and the screen going away all put it back
 *   and save nothing. Every path gives the list its scrolling back.
 */

/** Holding a card this long in Arrange lifts it (§2.2: hold still, then move). */
export const ARRANGE_HOLD_MS = 250;
/** Within this far of the list's top or bottom edge, a carried card scrolls the list (L3's `scrollNearEdge`). */
export const EDGE_DP = 80;
/** The most the list scrolls in one frame at the very edge. */
export const EDGE_SCROLL_MAX_DP = 16;
/** The other cards making room: a LayoutAnimation this long at each change of place (none with reduced motion). */
export const REFLOW_MS = 150;
/** The carried band goes back into the card's own band this fast on a drop (none with reduced motion). */
export const DROP_MS = 120;
/** The carried band's height: a band's (HOME_TARGET_DP). */
export const GHOST_DP = 48;

export interface DragPoint { x: number; y: number }

/** A card lifted, and where it would land now: what Home draws while a drag lasts. */
export interface Lifted { id: string; from: number; to: number }

export interface ArrangeDragDeps {
    /** The list's own scrolling, off while a card is lifted. */
    setScrollEnabled(on: boolean): void;
    /** The card lifted and its place (Home lays it out there, dimmed), or none. */
    setLifted(lifted: Lifted | null): void;
    /** Where the carried band's top-left is, in the screen's coordinates (the Home view's), dp. */
    moveGhost(x: number, y: number): void;
    /** The place among the cards that move where `point` (in the list's coordinates) would put the card. */
    place(id: string, point: DragPoint, current: number): number;
    /** A screen point in the list's coordinates (the scroll added, the list's top taken away). */
    toList(screen: DragPoint): DragPoint;
    /** The list's visible top and bottom on the screen, dp. */
    viewport(): { top: number; bottom: number };
    /** Scrolls the list by `dy` (clamped to what it can); returns how far it moved. */
    scrollBy(dy: number): number;
    /** A light tick on lift. */
    haptic(): void;
    /** The drop: the card to place `to` among the cards that move. Called only when the place changed. */
    save(id: string, to: number): void;
    /** The drag ended: the band goes, back into `id`'s band when the finger let go (`released`), at once when put back. */
    ended(id: string, released: boolean): void;
    /** One frame later (requestAnimationFrame); returns a cancel. */
    frame(cb: () => void): () => void;
}

export type DragPhase = 'idle' | 'lifted' | 'dragging';

export interface ArrangeDrag {
    readonly phase: DragPhase;
    readonly lifted: Lifted | null;
    /**
     * The hold fired: lift `id`, standing at place `from`. `finger` is where the finger is on the screen; `grab` is how far
     * below the card's top it holds it. A grab lower than the band re-anchors so the finger is on the band.
     */
    lift(id: string, from: number, finger: DragPoint, grab: DragPoint): boolean;
    /** Whether the card wrapper should take the touch now (it has a card lifted): the PanResponder's capture. */
    wants(id: string): boolean;
    /** The wrapper took the touch from the Pressable that timed the hold. */
    grant(): void;
    /** The finger moved, on the screen. */
    move(finger: DragPoint): void;
    /** The finger left the screen. */
    release(): void;
    /** Put it back, save nothing (Back, blur, background, terminate, the card gone, unmount). */
    cancel(): void;
    /** The cards changed under a still finger (a reflow, a fresh answer): read the place again. */
    replace(): void;
}

export function createArrangeDrag(deps: ArrangeDragDeps): ArrangeDrag {
    let phase: DragPhase = 'idle';
    let lifted: Lifted | null = null;
    /** The finger's last place on the screen, and the band's anchor under it. */
    let finger: DragPoint = { x: 0, y: 0 };
    let anchor: DragPoint = { x: 0, y: 0 };
    let stopFrame: (() => void) | null = null;

    const ghostAt = () => deps.moveGhost(finger.x - anchor.x, finger.y - anchor.y);

    const retarget = () => {
        if (!lifted) return;
        const to = deps.place(lifted.id, deps.toList(finger), lifted.to);
        if (to !== lifted.to) {
            lifted = { ...lifted, to };
            deps.setLifted(lifted);
        }
    };

    /** How hard the edge pushes: -1 … 1, 0 away from both edges (the web's curve). */
    const push = () => {
        const { top, bottom } = deps.viewport();
        const y = finger.y;
        if (y < top + EDGE_DP) return -(1 - Math.max(y - top, 0) / EDGE_DP);
        if (y > bottom - EDGE_DP) return 1 - Math.max(bottom - y, 0) / EDGE_DP;
        return 0;
    };

    const tick = () => {
        stopFrame = null;
        if (!lifted) return;
        const p = push();
        if (!p) return;
        const moved = deps.scrollBy((p < 0 ? -1 : 1) * Math.ceil(Math.abs(p) * EDGE_SCROLL_MAX_DP));
        if (moved) retarget();
        // At the end of the list nothing moves: wait for the finger to move rather than spin.
        if (moved) stopFrame = deps.frame(tick);
    };

    const edge = () => {
        if (stopFrame || !push()) return;
        stopFrame = deps.frame(tick);
    };

    const end = (commit: boolean) => {
        if (!lifted) return;
        const was = lifted;
        lifted = null;
        phase = 'idle';
        stopFrame?.();
        stopFrame = null;
        if (commit && was.to !== was.from) deps.save(was.id, was.to);
        deps.setScrollEnabled(true);
        deps.setLifted(null);
        deps.ended(was.id, commit);
    };

    return {
        get phase() { return phase; },
        get lifted() { return lifted; },
        lift(id, from, at, grab) {
            if (lifted || from < 0) return false;
            lifted = { id, from, to: from };
            phase = 'lifted';
            finger = { ...at };
            anchor = { x: grab.x, y: grab.y <= GHOST_DP ? grab.y : GHOST_DP / 2 };
            deps.setScrollEnabled(false);
            deps.haptic();
            deps.setLifted(lifted);
            ghostAt();
            return true;
        },
        wants(id) { return !!lifted && lifted.id === id; },
        grant() { if (lifted) phase = 'dragging'; },
        move(at) {
            if (!lifted) return;
            finger = { ...at };
            ghostAt();
            retarget();
            edge();
        },
        release() { end(true); },
        cancel() { end(false); },
        replace() { retarget(); },
    };
}
