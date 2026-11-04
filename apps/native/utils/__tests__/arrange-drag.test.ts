/**
 * The phone's drag in Arrange as a state machine (utils/arrange-drag.ts; DESIGN-home-arrange-in-place-fable.md §2.2, §2.3,
 * §5 slice A4): hold → lift → move → drop; a swipe before the hold lifts nothing; Back, blur and unmount put it back and give
 * the list its scrolling back. The place is core's `placeLifted` on one column, the phone's, and the drop is `moveCardTo`.
 */
import { describe, expect, it, vi } from 'vitest';
import { placeLifted, type PlaceItem } from '@beanpool/core';
import { ARRANGE_HOLD_MS, EDGE_DP, GHOST_DP, createArrangeDrag, type ArrangeDragDeps, type Lifted } from '../arrange-drag';
import { moveCardTo, type HomeLayout } from '../home-cards';

/** Five cards stacked as Home draws them (one column, no gap between wrappers): Needs you stays; four move. */
const ITEMS: PlaceItem[] = [
    { id: 'needs', height: 90, movable: false },
    { id: 'sky', height: 110 },
    { id: 'beans', height: 160 },
    { id: 'groups', height: 200 },
    { id: 'events', height: 240 },
].map(it => ({ movable: true, ...it }));
/** Each card's top in the list, in the order given. */
const tops = (order: readonly PlaceItem[]) => {
    let y = 0;
    return new Map(order.map(it => { const top = y; y += it.height; return [it.id, top]; }));
};

function harness(opts: { scroll?: number; viewport?: number; content?: number } = {}) {
    const calls: string[] = [];
    let scroll = opts.scroll ?? 0;
    const frames: Array<() => void> = [];
    const lifts: Array<Lifted | null> = [];
    const deps: ArrangeDragDeps = {
        setScrollEnabled: vi.fn((on: boolean) => { calls.push(on ? 'scroll-on' : 'scroll-off'); }),
        setLifted: vi.fn((l: Lifted | null) => { lifts.push(l); }),
        moveGhost: vi.fn(),
        // The real rule, on the phone's one column (320 dp less the gutters), with the cards' heights.
        place: vi.fn((id, point, current) => placeLifted(ITEMS, id, point, 1, 288, 0, current)),
        toList: p => ({ x: 144, y: p.y + scroll }),
        viewport: () => ({ top: 0, bottom: opts.viewport ?? 569 }),
        scrollBy: vi.fn((dy: number) => {
            const max = Math.max(0, (opts.content ?? 2000) - (opts.viewport ?? 569));
            const next = Math.min(max, Math.max(0, scroll + dy));
            const moved = next - scroll;
            scroll = next;
            return moved;
        }),
        haptic: vi.fn(() => { calls.push('tick'); }),
        save: vi.fn((id: string, to: number) => { calls.push(`save ${id} ${to}`); }),
        ended: vi.fn((id: string, released: boolean) => { calls.push(`ended ${id} ${released ? 'released' : 'put back'}`); }),
        frame: vi.fn((cb: () => void) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; }),
    };
    const drag = createArrangeDrag(deps);
    const runFrames = (n: number) => { for (let k = 0; k < n && frames.length; k++) frames.shift()!(); };
    return { drag, deps, calls, lifts, frames, runFrames, scroll: () => scroll };
}

describe('the drag as a state machine (slice A4)', () => {
    it('hold 250 ms, as the web; a band\'s ghost a band tall', () => {
        expect(ARRANGE_HOLD_MS).toBe(250);
        expect(GHOST_DP).toBe(48);
        expect(EDGE_DP).toBe(80);
    });

    it('hold → lift → move → drop: card 4 carried above card 1 is saved there, once, and the list scrolls again', () => {
        const { drag, deps, calls, lifts } = harness();
        const t = tops(ITEMS);
        // "events" is the fourth card that moves (place 3); held 20 dp into its band.
        expect(drag.lift('events', 3, { x: 100, y: t.get('events')! + 20 }, { x: 84, y: 20 })).toBe(true);
        expect(drag.phase).toBe('lifted');
        expect(calls).toEqual(['scroll-off', 'tick']);
        expect(lifts).toEqual([{ id: 'events', from: 3, to: 3 }]);
        // The band's top-left is the finger less the grab: the grab point is kept.
        expect(deps.moveGhost).toHaveBeenLastCalledWith(16, t.get('events')!);
        // The wrapper takes the touch only for the card that is lifted.
        expect(drag.wants('events')).toBe(true);
        expect(drag.wants('sky')).toBe(false);
        drag.grant();
        expect(drag.phase).toBe('dragging');
        // Over Your groups: the card goes where the finger is, and what was under it moves down.
        drag.move({ x: 100, y: t.get('groups')! + 10 });
        expect(lifts.at(-1)).toEqual({ id: 'events', from: 3, to: 2 });
        // Over Sun and moon, card 1 of the four (Needs you stays first).
        drag.move({ x: 100, y: t.get('sky')! + 5 });
        expect(lifts.at(-1)).toEqual({ id: 'events', from: 3, to: 0 });
        // Over Needs you, which stays: the nearest place is still the first.
        drag.move({ x: 100, y: 10 });
        expect(lifts.at(-1)).toEqual({ id: 'events', from: 3, to: 0 });
        const before = lifts.length;
        drag.release();
        expect(calls.slice(2)).toEqual(['save events 0', 'scroll-on', 'ended events released']);
        expect(lifts.length).toBe(before + 1);
        expect(lifts.at(-1)).toBeNull();
        expect(drag.phase).toBe('idle');
        expect(drag.wants('events')).toBe(false);
    });

    it('the place is only read again when it changes: a still finger over the same card sets nothing new', () => {
        const { drag, lifts } = harness();
        const t = tops(ITEMS);
        drag.lift('events', 3, { x: 100, y: t.get('events')! + 20 }, { x: 84, y: 20 });
        drag.grant();
        drag.move({ x: 100, y: t.get('groups')! + 10 });
        drag.move({ x: 100, y: t.get('groups')! + 12 });
        drag.move({ x: 104, y: t.get('groups')! + 12 });
        expect(lifts).toEqual([{ id: 'events', from: 3, to: 3 }, { id: 'events', from: 3, to: 2 }]);
    });

    it('a swipe before the hold lifts nothing: the wrapper never takes the touch, nothing scrolls off, nothing is saved', () => {
        const { drag, deps, calls } = harness();
        // The Pressable that times the hold gave the touch to the list as the finger moved: `lift` was never called.
        expect(drag.wants('events')).toBe(false);
        drag.move({ x: 100, y: 300 });
        drag.release();
        drag.cancel();
        expect(calls).toEqual([]);
        expect(deps.setLifted).not.toHaveBeenCalled();
        expect(deps.moveGhost).not.toHaveBeenCalled();
        expect(drag.phase).toBe('idle');
    });

    it('a hold let go where it began saves nothing (and the band goes back into its card)', () => {
        const { drag, deps, calls } = harness();
        drag.lift('beans', 1, { x: 100, y: 230 }, { x: 84, y: 30 });
        drag.release();
        expect(deps.save).not.toHaveBeenCalled();
        expect(calls).toEqual(['scroll-off', 'tick', 'scroll-on', 'ended beans released']);
    });

    it('moved away and back to where it began: nothing saved', () => {
        const { drag, deps } = harness();
        const t = tops(ITEMS);
        drag.lift('beans', 1, { x: 100, y: t.get('beans')! + 10 }, { x: 84, y: 10 });
        drag.grant();
        drag.move({ x: 100, y: t.get('events')! + 100 });
        drag.move({ x: 100, y: t.get('beans')! + 10 });
        drag.release();
        expect(deps.save).not.toHaveBeenCalled();
    });

    it('Back, Home losing focus, unmount, the system taking the touch: put back, nothing saved, the list scrolls again', () => {
        for (const how of ['back', 'blur', 'unmount', 'terminate'] as const) {
            const { drag, deps, calls, lifts } = harness();
            const t = tops(ITEMS);
            drag.lift('events', 3, { x: 100, y: t.get('events')! + 20 }, { x: 84, y: 20 });
            drag.grant();
            drag.move({ x: 100, y: t.get('sky')! + 5 });
            drag.cancel();
            expect(deps.save, how).not.toHaveBeenCalled();
            expect(calls.slice(-2), how).toEqual(['scroll-on', 'ended events put back']);
            expect(lifts.at(-1), how).toBeNull();
            expect(drag.phase, how).toBe('idle');
            // A second cancel (unmount after Back) does nothing more.
            drag.cancel();
            expect(deps.setScrollEnabled, how).toHaveBeenCalledTimes(2);
        }
    });

    it('one card at a time: a second hold while one is lifted is refused, and a card that stays is never lifted', () => {
        const { drag } = harness();
        expect(drag.lift('needs', -1, { x: 0, y: 10 }, { x: 0, y: 10 })).toBe(false);
        expect(drag.lift('sky', 0, { x: 0, y: 100 }, { x: 0, y: 10 })).toBe(true);
        expect(drag.lift('beans', 1, { x: 0, y: 220 }, { x: 0, y: 10 })).toBe(false);
        expect(drag.lifted?.id).toBe('sky');
    });

    it('a grab low in a tall card re-anchors so the finger is on the band; a grab in the band keeps its point', () => {
        const low = harness();
        low.drag.lift('events', 3, { x: 120, y: 700 }, { x: 104, y: 140 });
        expect(low.deps.moveGhost).toHaveBeenLastCalledWith(16, 700 - GHOST_DP / 2);
        const band = harness();
        band.drag.lift('events', 3, { x: 120, y: 700 }, { x: 104, y: 30 });
        expect(band.deps.moveGhost).toHaveBeenLastCalledWith(16, 670);
        band.drag.move({ x: 140, y: 650 });
        expect(band.deps.moveGhost).toHaveBeenLastCalledWith(36, 620);
    });

    it('near the bottom edge the list scrolls, faster nearer the edge, the place is read again after each step, and it stops at the end', () => {
        const { drag, deps, frames, runFrames, scroll } = harness({ viewport: 569, content: 900 });
        drag.lift('sky', 0, { x: 100, y: 120 }, { x: 84, y: 20 });
        drag.grant();
        drag.move({ x: 100, y: 300 });
        expect(frames.length).toBe(0);
        // 20 dp from the bottom: three quarters of the way into the edge.
        drag.move({ x: 100, y: 549 });
        expect(frames.length).toBe(1);
        const placed = (deps.place as ReturnType<typeof vi.fn>).mock.calls.length;
        runFrames(1);
        expect(deps.scrollBy).toHaveBeenLastCalledWith(12);
        expect((deps.place as ReturnType<typeof vi.fn>).mock.calls.length).toBe(placed + 1);
        // At the very edge: the most in a frame.
        drag.move({ x: 100, y: 569 });
        runFrames(1);
        expect(deps.scrollBy).toHaveBeenLastCalledWith(16);
        runFrames(100);
        expect(scroll()).toBe(900 - 569);
        // The end of the list: nothing moves, so no frame waits.
        expect(frames.length).toBe(0);
        // The drop stops it too.
        drag.move({ x: 100, y: 10 });
        expect(frames.length).toBe(1);
        drag.release();
        expect(frames.length).toBe(0);
    });

    it('the place under a still finger is read again when the cards change (`replace`)', () => {
        const { drag, deps } = harness();
        drag.lift('sky', 0, { x: 100, y: 120 }, { x: 84, y: 20 });
        const n = (deps.place as ReturnType<typeof vi.fn>).mock.calls.length;
        drag.replace();
        expect((deps.place as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n + 1);
    });
});

describe('moveCardTo: the drop saved as an arrow saves (slice A4)', () => {
    const layout = (ids: string[]): HomeLayout => ({ v: 2, cards: ids.map(id => ({ id, type: id })), dismissed: {}, updatedAt: '2026-11-05T00:00:00.000Z' }) as unknown as HomeLayout;
    const among = (ids: string[]) => ids.map(id => ({ id, type: id }));

    it('card 4 above card 1: the four that move are reordered in their own slots; Needs you and the community card keep theirs', () => {
        const next = moveCardTo(layout(['needs', 'sky', 'beans', 'groups', 'events', 'community']), 'events', 0, among(['needs', 'sky', 'beans', 'groups', 'events', 'community']), Date.parse('2026-11-05T10:00:00Z'));
        expect(next?.cards.map(c => c.id)).toEqual(['needs', 'events', 'sky', 'beans', 'groups', 'community']);
        expect(next?.updatedAt).toBe('2026-11-05T10:00:00.000Z');
    });

    it('the same order as the preview: what reorderIds draws is what is saved', () => {
        const ids = ['needs', 'sky', 'beans', 'groups', 'events', 'community'];
        const next = moveCardTo(layout(ids), 'sky', 2, among(ids), Date.now());
        expect(next?.cards.map(c => c.id)).toEqual(['needs', 'beans', 'groups', 'sky', 'events', 'community']);
    });

    it('a card on the list but not drawn keeps its saved slot: the drawn cards move round it', () => {
        // "deals" is on the list with nothing to show (in the strip): not among the drawn cards.
        const next = moveCardTo(layout(['needs', 'sky', 'deals', 'beans', 'events', 'community']), 'events', 0, among(['needs', 'sky', 'beans', 'events', 'community']), Date.now());
        expect(next?.cards.map(c => c.id)).toEqual(['needs', 'events', 'deals', 'sky', 'beans', 'community']);
    });

    it('no move, a place out of range, or a card that stays: nothing to save', () => {
        const ids = ['needs', 'sky', 'beans', 'community'];
        expect(moveCardTo(layout(ids), 'sky', 0, among(ids), Date.now())).toBeNull();
        expect(moveCardTo(layout(ids), 'sky', 5, among(ids), Date.now())).toBeNull();
        expect(moveCardTo(layout(ids), 'needs', 1, among(ids), Date.now())).toBeNull();
    });
});
