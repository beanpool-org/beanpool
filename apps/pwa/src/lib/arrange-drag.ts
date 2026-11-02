/**
 * Dragging a band in Arrange (DESIGN-home-layout-fable.md §3.2, slice L3): Pointer Events, no library. The arrows stay;
 * this is one more way to the same saved list. A press on a band (never on a button in it) that travels past a few pixels
 * lifts the card (a finger holds first), which follows the pointer while the others slide aside, live, by the half of the card under the pointer:
 * the top half puts the lifted card before it, the bottom half after. Release saves through `onDrop`. Escape, a lost
 * pointer, a pointer cancel and a window blur put everything back and save nothing. A press that never travels is a tap.
 *
 * The cards stay in their DOM places all the while (a node moved in the DOM drops its pointer capture): the page lays them
 * out in the live order, and `follow()` puts the lifted card back under the pointer after each layout and each scroll.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** A pointer that moves this far from where it went down is dragging, not tapping. */
const SLOP_PX = 4;
/** A finger holds this long before a card lifts (design §3.2): a swipe that starts on a band moves nothing. */
const HOLD_MS = 200;
/** Within this of the scrolling edge the page scrolls, faster the nearer the edge. */
const EDGE_PX = 80;
const SCROLL_MAX_PX = 16;
const LIFT_SCALE = 1.02;

/** The card in the air and the place it would take among the movable cards once it is out of the list. */
export interface Lift { id: string; to: number }

interface Gesture {
    id: string; pointerId: number; band: HTMLElement; was: number;
    /** Where the press began, where the pointer is now, and where in the card it took hold. */
    sx: number; sy: number; px: number; py: number; gx: number; gy: number;
    lifted: boolean; frame: number;
    /** A finger's press: when it went down. A mouse needs no hold. */
    heldFrom: number | null;
}

export interface ArrangeDrag {
    lift: Lift | null;
    /** Counts every end of a drag, so the page can settle the card whether or not the list changed. */
    ended: number;
    /** Where the card was let go, in the grid's own coordinates, for the page's slide into its place. Read once. */
    settle: RefObject<{ id: string; x: number; y: number } | null>;
    /** The props for a band that can be dragged. */
    bandProps: (id: string) => { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void };
    /** After the page has laid out: the lifted card goes back under the pointer. */
    follow: () => void;
}

/**
 * `ids` are the movable cards in the saved order. `onDrop(id, to)` runs on release when the place changed; `to` counts
 * among the movable cards with the lifted one out of the list.
 */
export function useArrangeDrag({ gridRef, ids, enabled, onDrop }: {
    gridRef: RefObject<HTMLElement | null>; ids: readonly string[]; enabled: boolean; onDrop: (id: string, to: number) => void;
}): ArrangeDrag {
    const [lift, setLift] = useState<Lift | null>(null);
    const [ended, setEnded] = useState(0);
    const g = useRef<Gesture | null>(null);
    const liftRef = useRef<Lift | null>(null);
    const settle = useRef<{ id: string; x: number; y: number } | null>(null);
    const live = useRef({ ids, onDrop });
    live.current = { ids, onDrop };

    // Made once: the listeners are added and removed by name, so they must be the same functions every time.
    const [api] = useState(() => {
        const cardEl = (id: string) => Array.from(gridRef.current?.children ?? []).find(el => el.getAttribute('data-testid') === `home-card-${id}`) as HTMLElement | undefined;

        function follow() {
            const s = g.current;
            const el = s?.lifted ? cardEl(s.id) : undefined;
            if (!s || !el) return;
            el.style.transform = '';
            const r = el.getBoundingClientRect();
            el.style.transform = `translate(${s.px - s.gx - r.left}px, ${s.py - s.gy - r.top}px) scale(${LIFT_SCALE})`;
        }

        /** The half of the card under the pointer decides; cards are read where the layout puts them, not where a slide has them. */
        function retarget(s: Gesture) {
            const grid = gridRef.current;
            if (!grid) return;
            const box = grid.getBoundingClientRect();
            const x = s.px - box.left;
            const y = s.py - box.top;
            const others = live.current.ids.filter(i => i !== s.id);
            for (let k = 0; k < others.length; k++) {
                const el = cardEl(others[k]);
                if (!el || x < el.offsetLeft || x >= el.offsetLeft + el.offsetWidth || y < el.offsetTop || y >= el.offsetTop + el.offsetHeight) continue;
                const to = k + (y > el.offsetTop + el.offsetHeight / 2 ? 1 : 0);
                if (to !== liftRef.current?.to) {
                    liftRef.current = { id: s.id, to };
                    setLift(liftRef.current);
                }
                return;
            }
        }

        function scrollNearEdge(s: Gesture) {
            const main = gridRef.current?.closest('main');
            const scroller = main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
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

        function end(commit: boolean) {
            const s = g.current;
            if (!s) return;
            g.current = null;
            cancelAnimationFrame(s.frame);
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onCancel, true);
            window.removeEventListener('lostpointercapture', onCancel, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onCancel);
            try { s.band.releasePointerCapture(s.pointerId); } catch { /* it had gone already */ }
            if (!s.lifted) return;
            const l = liftRef.current;
            liftRef.current = null;
            const el = cardEl(s.id);
            const grid = gridRef.current;
            if (el && grid) {
                const box = grid.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                settle.current = { id: s.id, x: r.left - box.left, y: r.top - box.top };
                el.style.transform = '';
            }
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
                if (Math.hypot(s.px - s.sx, s.py - s.sy) < SLOP_PX) return;
                if (s.heldFrom !== null && e.timeStamp - s.heldFrom < HOLD_MS) { end(false); return; }
                const el = cardEl(s.id);
                if (!el) { end(false); return; }
                const r = el.getBoundingClientRect();
                s.gx = s.sx - r.left;
                s.gy = s.sy - r.top;
                s.lifted = true;
                liftRef.current = { id: s.id, to: s.was };
                setLift(liftRef.current);
                const tick = () => { if (g.current !== s) return; scrollNearEdge(s); s.frame = requestAnimationFrame(tick); };
                s.frame = requestAnimationFrame(tick);
            }
            e.preventDefault();
            follow();
            retarget(s);
        }
        function onUp(e: PointerEvent) { if (e.pointerId === g.current?.pointerId) end(true); }
        // The page moved under a still pointer (a wheel, a key): the card goes back under it, and the place is read again.
        function onScroll() { const s = g.current; if (s?.lifted) { follow(); retarget(s); } }
        function onCancel(e: Event) { if (!('pointerId' in e) || e.pointerId === g.current?.pointerId) end(false); }
        // Escape puts the card back, and only that: the Escape that ends Arrange waits for a press with nothing in the air.
        function onKey(e: KeyboardEvent) {
            if (e.key !== 'Escape' || !g.current?.lifted) return;
            e.preventDefault();
            e.stopPropagation();
            end(false);
        }
        function begin(id: string, e: ReactPointerEvent<HTMLElement>) {
            const was = live.current.ids.indexOf(id);
            if (g.current || was < 0 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest?.('button, a')) return;
            const band = e.currentTarget;
            g.current = { id, pointerId: e.pointerId, band, was, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, gx: 0, gy: 0, lifted: false, frame: 0, heldFrom: e.pointerType === 'touch' ? e.timeStamp : null };
            try { band.setPointerCapture(e.pointerId); } catch { /* a pointer that has gone */ }
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
            window.addEventListener('lostpointercapture', onCancel, true);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('blur', onCancel);
        }
        return { follow, end, begin };
    });

    // Leaving Arrange, or the page, with a card in the air puts it back.
    useEffect(() => { if (!enabled) api.end(false); }, [enabled, api]);
    useEffect(() => () => api.end(false), [api]);

    return {
        lift, ended, settle, follow: api.follow,
        bandProps: (id: string) => ({ onPointerDown: (e: ReactPointerEvent<HTMLElement>) => api.begin(id, e) }),
    };
}
