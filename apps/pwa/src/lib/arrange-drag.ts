/**
 * Dragging a card in Arrange (DESIGN-home-arrange-in-place-fable.md §2.2–§2.3, slice A2): Pointer Events, no library. The
 * arrows stay; this is one more way to the same saved list.
 *
 * - **The handle is the whole card** (`cardProps`), never one of its arrows: its body is quiet in Arrange, so there is no
 *   button or row to fight. A mouse lifts it past a few pixels; a finger holds still for 250 ms first, and one that moves
 *   before that is scrolling the page (the card keeps `touch-action: pan-y`). Once a finger has lifted a card, a
 *   non-passive `touchmove` on it stops the scroll that has not begun.
 * - **The hold that opens Arrange goes on as a drag** (`adopt`): the band held 500 ms on Home with the finger or the button
 *   still down lifts its card as soon as Arrange has drawn it, and the first movement moves it.
 * - **What you carry is the band** (`ghostRef`, one fixed element the page draws): it follows the pointer. The card stays in
 *   the grid, dimmed, laid out where the drop would put it, so what you see while pointing is what you get.
 * - **Where it lands is `place`** (the page's `placeLifted`, from core): the place whose layout puts the card nearest the
 *   pointer.
 *
 * Release saves through `onDrop`; the band slides back into the card (none with reduced motion). Escape, a lost pointer, a
 * pointer cancel and a window blur put everything back and save nothing. A press that never travels is a tap. The cards
 * stay in their DOM places all the while (a node moved in the DOM drops its pointer capture): the page lays them out in the
 * live order.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** A mouse that moves this far from where it went down is dragging, not tapping. */
const SLOP_PX = 4;
/** Inside Arrange a finger holds still this long before a card lifts (design §2.2). */
export const TOUCH_HOLD_MS = 250;
/** A finger that travels this far before the hold is up is scrolling, not holding. */
const TOUCH_STILL_PX = 10;
/** Within this of the scrolling edge the page scrolls, faster the nearer the edge. */
const EDGE_PX = 80;
const SCROLL_MAX_PX = 16;
const GHOST_SCALE = 1.02;
/** The band's height: a card taken lower than this, by its body, is carried by its band's middle. */
const BAND_PX = 48;
/** The band's slide back into its card at the drop. */
const DROP_MS = 120;

/** The card in the air and the place it would take among the movable cards once it is out of the list. */
export interface Lift { id: string; to: number }

/** The press the band's hold on Home hands over (components/HomeCard.tsx `useHold`): the same pointer, still down. */
export interface HeldPress { pointerId: number; pointerType: string; clientX: number; clientY: number; target: HTMLElement }

/** What a card that can be dragged carries in Arrange. */
export interface CardHandle {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
    style: CSSProperties;
}

interface Gesture {
    id: string; pointerId: number; touch: boolean;
    /** The element the press is on: the card, or the band whose hold opened Arrange. */
    el: HTMLElement;
    /** The card's place among the movable cards when it was taken; -1 until Arrange has drawn an adopted one. */
    was: number;
    /** Where the press began, where the pointer is now, where on the band it is held, and the band's width. */
    sx: number; sy: number; px: number; py: number; gx: number; gy: number; w: number;
    lifted: boolean; frame: number; timer: ReturnType<typeof setTimeout> | null;
    /** Handed over by the hold that opened Arrange: lifted once Arrange has drawn the card, where it stood at the hold. */
    adopted: { top: number } | null;
}

export interface ArrangeDrag {
    lift: Lift | null;
    /** Counts every end of a drag, so the page can settle the cards whether or not the list changed. */
    ended: number;
    /** The props for a card that can be dragged, in Arrange. */
    cardProps: (id: string) => CardHandle;
    /** The band's hold on Home, with the pointer still down: the card lifts as soon as Arrange has drawn it. */
    adopt: (id: string, press: HeldPress) => void;
    /** The carried band, drawn by the page while a card is lifted. */
    ghostRef: (el: HTMLElement | null) => void;
    /** After the page has laid out: the band goes back under the pointer. */
    follow: () => void;
}

const calm = () => {
    try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
};

/**
 * `ids` are the movable cards in the saved order. `place(id, point, current)` is where the card would land with the
 * pointer at `point` (px from the grid's top-left corner). `onDrop(id, to)` runs on release when the place changed; `to`
 * counts among the movable cards with the lifted one out of the list.
 */
export function useArrangeDrag({ gridRef, ids, enabled, onDrop, place }: {
    gridRef: RefObject<HTMLElement | null>; ids: readonly string[]; enabled: boolean;
    onDrop: (id: string, to: number) => void;
    place: (id: string, point: { x: number; y: number }, current: number) => number;
}): ArrangeDrag {
    const [lift, setLift] = useState<Lift | null>(null);
    const [ended, setEnded] = useState(0);
    const g = useRef<Gesture | null>(null);
    const liftRef = useRef<Lift | null>(null);
    const live = useRef({ ids, onDrop, place });
    live.current = { ids, onDrop, place };

    // Made once: the listeners are added and removed by name, so they must be the same functions every time.
    const [api] = useState(() => {
        let ghost: HTMLElement | null = null;
        const cardEl = (id: string) => Array.from(gridRef.current?.children ?? []).find(el => el.getAttribute('data-testid') === `home-card-${id}`) as HTMLElement | undefined;
        const scrollerOf = () => {
            const main = gridRef.current?.closest('main');
            return main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
        };

        function follow() {
            const s = g.current;
            if (!s?.lifted || !ghost) return;
            ghost.style.width = `${s.w}px`;
            ghost.style.transformOrigin = `${s.gx}px ${s.gy}px`;
            ghost.style.transform = `translate(${s.px - s.gx}px, ${s.py - s.gy}px) scale(${GHOST_SCALE})`;
        }

        /** The place the pointer asks for, from the page's rule; read again at every move and every scroll step. */
        function retarget(s: Gesture) {
            const grid = gridRef.current;
            if (!grid || !s.lifted) return;
            const box = grid.getBoundingClientRect();
            const to = live.current.place(s.id, { x: s.px - box.left, y: s.py - box.top }, liftRef.current?.to ?? s.was);
            if (to !== liftRef.current?.to) {
                liftRef.current = { id: s.id, to };
                setLift(liftRef.current);
            }
        }

        function scrollNearEdge(s: Gesture) {
            const main = gridRef.current?.closest('main');
            const scroller = scrollerOf();
            if (!scroller) return;
            const r = scroller === main ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
            const top = Math.max(r.top, 0);
            const bottom = Math.min(r.bottom, window.innerHeight);
            const push = s.py < top + EDGE_PX ? -(1 - Math.max(s.py - top, 0) / EDGE_PX) : s.py > bottom - EDGE_PX ? 1 - Math.max(bottom - s.py, 0) / EDGE_PX : 0;
            if (!push) return;
            scroller.scrollTop += (push < 0 ? -1 : 1) * Math.ceil(Math.abs(push) * SCROLL_MAX_PX);
            follow();
            retarget(s);
        }

        /** The card goes up: dimmed in its place, its band under the pointer. */
        function liftNow(s: Gesture) {
            const el = cardEl(s.id);
            if (!el || s.was < 0) { end(false); return; }
            if (s.timer) clearTimeout(s.timer);
            s.timer = null;
            const r = el.getBoundingClientRect();
            s.w = r.width;
            s.gx = Math.min(Math.max(s.sx - r.left, 0), r.width);
            const gy = s.sy - r.top;
            // Taken by the body, low in a tall card: the band comes to the pointer, not the pointer to a band far above it.
            s.gy = gy >= 0 && gy < BAND_PX ? gy : BAND_PX / 2;
            s.lifted = true;
            liftRef.current = { id: s.id, to: s.was };
            setLift(liftRef.current);
            const tick = () => { if (g.current !== s) return; scrollNearEdge(s); s.frame = requestAnimationFrame(tick); };
            s.frame = requestAnimationFrame(tick);
            retarget(s);
        }

        /** Let go: the band slides into its card's band and goes. A copy does it, so the page can take the band away at once. */
        function settleBand(id: string) {
            const el = cardEl(id);
            if (!ghost || !el || calm() || typeof ghost.animate !== 'function') return;
            const copy = ghost.cloneNode(true) as HTMLElement;
            copy.setAttribute('data-testid', 'home-arrange-ghost-drop');
            document.body.appendChild(copy);
            const r = el.getBoundingClientRect();
            const run = copy.animate([{ transform: ghost.style.transform }, { transform: `translate(${r.left}px, ${r.top}px) scale(1)` }], { duration: DROP_MS, easing: 'ease-out', fill: 'forwards' });
            run.onfinish = () => copy.remove();
            run.oncancel = () => copy.remove();
        }

        function end(commit: boolean) {
            const s = g.current;
            if (!s) return;
            g.current = null;
            cancelAnimationFrame(s.frame);
            if (s.timer) clearTimeout(s.timer);
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onCancel, true);
            window.removeEventListener('lostpointercapture', onCancel, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('contextmenu', onMenu, true);
            window.removeEventListener('blur', onCancel);
            s.el.removeEventListener('touchmove', onTouchMove);
            try { s.el.releasePointerCapture(s.pointerId); } catch { /* it had gone already */ }
            if (!s.lifted) return;
            const l = liftRef.current;
            liftRef.current = null;
            if (commit) settleBand(s.id);
            setLift(null);
            setEnded(n => n + 1);
            if (commit && l && l.to !== s.was) live.current.onDrop(s.id, l.to);
        }

        function onMove(e: PointerEvent) {
            const s = g.current;
            if (!s || e.pointerId !== s.pointerId) return;
            s.px = e.clientX;
            s.py = e.clientY;
            if (!s.lifted) {
                // Handed over by the hold: it lifts when Arrange has drawn the card, and the pointer is followed from there.
                if (s.adopted) return;
                const far = Math.hypot(s.px - s.sx, s.py - s.sy);
                // A finger that moves before its hold is up is scrolling the page: it lets the card be.
                if (s.touch) { if (far > TOUCH_STILL_PX) end(false); return; }
                if (far < SLOP_PX) return;
                liftNow(s);
                if (!s.lifted) return;
            }
            e.preventDefault();
            follow();
            retarget(s);
        }
        // Lifted by a finger: the page's scroll, which has not begun (the finger held still), never starts.
        function onTouchMove(e: TouchEvent) { if (g.current?.lifted && e.cancelable) e.preventDefault(); }
        function onUp(e: PointerEvent) { if (e.pointerId === g.current?.pointerId) end(true); }
        // The page moved under a still pointer (a wheel, a key, the edge): the place is read again.
        function onScroll() { const s = g.current; if (s?.lifted) { follow(); retarget(s); } }
        function onCancel(e: Event) { if (!('pointerId' in e) || e.pointerId === g.current?.pointerId) end(false); }
        // A long press's menu never opens under a card being held.
        function onMenu(e: Event) { if (g.current) e.preventDefault(); }
        // Escape puts the card back, and only that: the Escape that ends Arrange waits for a press with nothing in the air.
        function onKey(e: KeyboardEvent) {
            if (e.key !== 'Escape' || !g.current?.lifted) return;
            e.preventDefault();
            e.stopPropagation();
            end(false);
        }

        function start(s: Gesture) {
            g.current = s;
            try { s.el.setPointerCapture(s.pointerId); } catch { /* a pointer that has gone */ }
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
            window.addEventListener('lostpointercapture', onCancel, true);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('contextmenu', onMenu, true);
            window.addEventListener('blur', onCancel);
            if (s.touch) s.el.addEventListener('touchmove', onTouchMove, { passive: false });
        }
        const gesture = (id: string, el: HTMLElement, e: { pointerId: number; pointerType: string; clientX: number; clientY: number }, was: number): Gesture => ({
            id, pointerId: e.pointerId, touch: e.pointerType === 'touch', el, was,
            sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, gx: 0, gy: 0, w: 0, lifted: false, frame: 0, timer: null, adopted: null,
        });

        function begin(id: string, e: ReactPointerEvent<HTMLElement>) {
            const was = live.current.ids.indexOf(id);
            if (g.current || was < 0 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest?.('button, a')) return;
            const s = gesture(id, e.currentTarget, e, was);
            start(s);
            // A finger lifts the card by holding still; one that moves first has let it be (onMove), and the page scrolls.
            if (s.touch) s.timer = setTimeout(() => { if (g.current === s && !s.lifted) liftNow(s); }, TOUCH_HOLD_MS);
        }

        function adopt(id: string, press: HeldPress) {
            if (g.current) return;
            const card = press.target.closest<HTMLElement>(`[data-testid="home-card-${id}"]`);
            const s = gesture(id, press.target, press, -1);
            s.adopted = { top: card?.getBoundingClientRect().top ?? NaN };
            start(s);
        }

        /** Arrange has drawn: an adopted card lifts, with the page scrolled so it is still under the pointer that held it. */
        function takeOver() {
            const s = g.current;
            if (!s?.adopted || s.lifted) return;
            s.was = live.current.ids.indexOf(s.id);
            const el = cardEl(s.id);
            const scroller = scrollerOf();
            if (el && scroller && Number.isFinite(s.adopted.top)) scroller.scrollTop += el.getBoundingClientRect().top - s.adopted.top;
            s.adopted = null;
            liftNow(s);
        }

        const ghostRef = (el: HTMLElement | null) => { ghost = el; follow(); };
        return { follow, end, begin, adopt, takeOver, ghostRef };
    });

    // Arrange opened under a held band: its card lifts now that it is drawn, before the paint.
    const idsKey = ids.join(',');
    useLayoutEffect(() => { if (enabled) api.takeOver(); }, [enabled, idsKey, api]);
    // Leaving Arrange, or the page, with a card in the air puts it back.
    useEffect(() => { if (!enabled && !g.current?.adopted) api.end(false); }, [enabled, api]);
    useEffect(() => () => api.end(false), [api]);

    return {
        lift, ended, follow: api.follow, adopt: api.adopt, ghostRef: api.ghostRef,
        cardProps: (id: string) => ({
            onPointerDown: (e: ReactPointerEvent<HTMLElement>) => api.begin(id, e),
            // No long-press menu or text selection under a thumb that holds a card.
            onContextMenu: (e: ReactMouseEvent<HTMLElement>) => e.preventDefault(),
            style: { touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: lift?.id === id ? 'grabbing' : 'grab' } as CSSProperties,
        }),
    };
}
