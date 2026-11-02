import { describe, expect, it, vi } from 'vitest';
import {
    MAP_TAP_CAP_ZOOM, STACK_CLEARANCE_PX, STACK_LIST_CLOSED, STACK_REST_MS, bubbleLandingZoom, bubbleTap, orderStack, settleMapStop, settleStackList,
    stackDropped, stackHeading, stackLift, stackListTop, stackRestWatch, stackShut, stackTapped, type MapRest, type StackBubble, type StackListState,
} from '../map-stack.js';

describe('the list opening by itself when the map stops', () => {
    const view = { width: 320, height: 600 };
    const MIDDLE = { x: 160, y: 300 };
    /** A stack that cannot part, at this point. */
    const stack = (keys: string[], at: { x: number; y: number } = MIDDLE): StackBubble => ({ keys, ...at });
    const rest = (bubbles: StackBubble[], over: Partial<MapRest> = {}): MapRest => ({ view, bubbles, atCap: true, blocked: false, ...over });
    const HALL = ['a', 'b', 'c'];
    const open = (keys = HALL): StackListState => settleStackList(STACK_LIST_CLOSED, rest([stack(keys)]));

    it('opens for a stack near the middle at the cap, with no tap', () => {
        expect(open()).toEqual({ open: HALL, byTap: false, shut: null });
    });

    describe("with a pin's card open (Marty, 2 Nov: \"a card ... up from a pin somewhere else\")", () => {
        const LEFT_BEHIND = { x: 2400, y: -900 };
        const HERE = { x: 240, y: 300 };

        it('a card left open from somewhere else closes, and the list opens', () => {
            expect(settleMapStop(STACK_LIST_CLOSED, rest([stack(HALL)], { card: LEFT_BEHIND })))
                .toEqual({ list: { open: HALL, byTap: false, shut: null }, closeCard: true });
        });

        it('a pin off any one edge of the view has left it', () => {
            for (const card of [{ x: -1, y: 300 }, { x: 321, y: 300 }, { x: 160, y: -1 }, { x: 160, y: 601 }]) {
                expect(settleMapStop(STACK_LIST_CLOSED, rest([stack(HALL)], { card })).closeCard, JSON.stringify(card)).toBe(true);
            }
        });

        it('a card opened at this spot stays, wherever on the view its pin is', () => {
            // The last two are under where the card comes up, and on the very edge: a member can tap either.
            for (const card of [HERE, { x: 160, y: 300 }, { x: 160, y: 590 }, { x: 0, y: 600 }]) {
                expect(settleMapStop(STACK_LIST_CLOSED, rest([stack(HALL)], { card })), JSON.stringify(card)).toEqual({ list: STACK_LIST_CLOSED, closeCard: false });
            }
        });

        it('a card left open stays when nothing here qualifies: above the cap, off the middle, or no stack', () => {
            for (const stopped of [rest([stack(HALL)], { atCap: false }), rest([stack(HALL, { x: 20, y: 300 })]), rest([])]) {
                const { list, closeCard } = settleMapStop(STACK_LIST_CLOSED, { ...stopped, card: LEFT_BEHIND });
                expect(closeCard).toBe(false);
                expect(list.open).toBeNull();
            }
        });

        it("a ✕'d stack still wins: the card stays and the list stays closed", () => {
            const shut = stackShut(open());
            const { list, closeCard } = settleMapStop(shut, rest([stack(HALL)], { card: LEFT_BEHIND }));
            expect(closeCard).toBe(false);
            expect(list).toEqual(shut);
        });

        it('leaving a ✕\'d stack with a card up ends the ✕, as it does with none', () => {
            const away = settleMapStop(stackShut(open()), rest([], { card: LEFT_BEHIND }));
            expect(away.list.shut).toBeNull();
            expect(settleMapStop(away.list, rest([stack(HALL)], { card: LEFT_BEHIND })).list.open).toEqual(HALL);
        });

        it('an open post or the category panel still wins: nothing moves, card or list', () => {
            for (const card of [LEFT_BEHIND, HERE]) {
                expect(settleMapStop(STACK_LIST_CLOSED, rest([stack(HALL)], { card, blocked: true }))).toEqual({ list: STACK_LIST_CLOSED, closeCard: false });
            }
        });

        it('with no card it is the rule it always was', () => {
            for (const card of [undefined, null]) {
                expect(settleMapStop(STACK_LIST_CLOSED, rest([stack(HALL)], { card }))).toEqual({ list: open(), closeCard: false });
            }
            expect(settleMapStop(open(), rest([stack(HALL)], { atCap: false })).list.open).toBeNull();
        });
    });

    it('does not open above the cap: there a stack is a bubble among the town\'s, and a tap still opens it', () => {
        expect(settleStackList(STACK_LIST_CLOSED, rest([stack(HALL)], { atCap: false })).open).toBeNull();
    });

    it('does not open for a bubble near the edge', () => {
        expect(settleStackList(STACK_LIST_CLOSED, rest([stack(HALL, { x: 20, y: 300 })])).open).toBeNull();
        expect(settleStackList(STACK_LIST_CLOSED, rest([stack(HALL, { x: 160, y: 40 })])).open).toBeNull();
    });

    it('never opens where the list would cover the stack', () => {
        const under = { x: 160, y: stackListTop(view) - 1 };
        expect(settleStackList(STACK_LIST_CLOSED, rest([stack(HALL, under)])).open).toBeNull();
    });

    it('closes as the map zooms out above the cap', () => {
        expect(settleStackList(open(), rest([stack(HALL)], { atCap: false })).open).toBeNull();
    });

    it('closes when the stack is panned away, and stays open while it still shows above the list', () => {
        const drifted = { x: 40, y: 380 };
        expect(settleStackList(open(), rest([stack(HALL, drifted)])).open).toEqual(HALL);
        expect(settleStackList(open(), rest([stack(HALL, { x: 160, y: stackListTop(view) + 10 })])).open).toBeNull();
        expect(settleStackList(open(), rest([])).open).toBeNull();
    });

    it('closes when the stack parts or folds into a bigger bubble', () => {
        expect(settleStackList(open(), rest([])).open).toBeNull();
        expect(settleStackList(open(), rest([stack([...HALL, 'd'])])).open).toEqual([...HALL, 'd']);
        expect(settleStackList(open(), rest([stack([...HALL, 'd'])], { atCap: false })).open).toBeNull();
    });

    it('keeps a stack that lost a pin to a filter: it is still that stack', () => {
        expect(settleStackList(open(), rest([stack(['a', 'b'])])).open).toEqual(HALL);
    });

    it('stays closed after ✕ for that stack, however often the map stops on it', () => {
        let state = stackShut(open());
        expect(state.open).toBeNull();
        for (const at of [MIDDLE, { x: 150, y: 280 }, { x: 170, y: 320 }]) {
            state = settleStackList(state, rest([stack(HALL, at)]));
            expect(state.open).toBeNull();
        }
    });

    it('stays closed after ✕ for the same stack with a pin more or a pin fewer', () => {
        const state = stackShut(open());
        expect(settleStackList(state, rest([stack(['a', 'b'])])).open).toBeNull();
        expect(settleStackList(state, rest([stack([...HALL, 'd'])])).open).toBeNull();
    });

    it('opens again once the member has zoomed out of it', () => {
        const left = settleStackList(stackShut(open()), rest([stack(HALL)], { atCap: false }));
        expect(left.shut).toBeNull();
        expect(settleStackList(left, rest([stack(HALL)])).open).toEqual(HALL);
    });

    it('opens again once the member has panned it off the view, and not before', () => {
        const nudged = settleStackList(stackShut(open()), rest([stack(HALL, { x: 20, y: 500 })]));
        expect(nudged.shut).toEqual(HALL);
        expect(settleStackList(nudged, rest([stack(HALL)])).open).toBeNull();
        const left = settleStackList(nudged, rest([stack(HALL, { x: -40, y: 300 })]));
        expect(left.shut).toBeNull();
        expect(settleStackList(left, rest([stack(HALL)])).open).toEqual(HALL);
    });

    it('lets another stack open while the closed one stays closed', () => {
        const state = settleStackList(stackShut(open()), rest([stack(HALL), stack(['x', 'y'], { x: 200, y: 260 })]));
        expect(state).toEqual({ open: ['x', 'y'], byTap: false, shut: HALL });
    });

    it('opens for the stack nearest the middle when two qualify', () => {
        const far = stack(['x', 'y'], { x: 120, y: 200 });
        const near = stack(['p', 'q'], { x: 170, y: 310 });
        expect(settleStackList(STACK_LIST_CLOSED, rest([far, near])).open).toEqual(['p', 'q']);
        expect(settleStackList(STACK_LIST_CLOSED, rest([near, far])).open).toEqual(['p', 'q']);
    });

    it('panning between two stacks moves the list in one step and never closes it between them', () => {
        const place = (a: { x: number; y: number }, b: { x: number; y: number }) => rest([stack(HALL, a), stack(['x', 'y'], b)]);
        let state = settleStackList(STACK_LIST_CLOSED, place({ x: 160, y: 300 }, { x: 300, y: 300 }));
        expect(state.open).toEqual(HALL);
        // The other comes nearer the middle, and this one is still near it: the list stays put, so a stack on the line cannot flicker.
        state = settleStackList(state, place({ x: 100, y: 300 }, { x: 170, y: 300 }));
        expect(state.open).toEqual(HALL);
        state = settleStackList(state, place({ x: 110, y: 300 }, { x: 180, y: 300 }));
        expect(state.open).toEqual(HALL);
        // This one has left the middle: straight to the other, with no closed state between.
        state = settleStackList(state, place({ x: 40, y: 300 }, { x: 160, y: 300 }));
        expect(state.open).toEqual(['x', 'y']);
    });

    it.each([['a post'], ['a pin\'s card'], ['the category panel'], ['the composer']])('opens nothing over %s, and closes nothing under it', () => {
        expect(settleStackList(STACK_LIST_CLOSED, rest([stack(HALL)], { blocked: true })).open).toBeNull();
        const list = open();
        expect(settleStackList(list, rest([], { blocked: true }))).toBe(list);
    });

    describe('a list opened by a tap', () => {
        const tapped = stackTapped(HALL);

        it('stays at any zoom while its stack shows, since the member asked for it', () => {
            expect(settleStackList(tapped, rest([stack(HALL, { x: 40, y: 100 })], { atCap: false })).open).toEqual(HALL);
        });

        it('is not moved by another stack nearer the middle', () => {
            expect(settleStackList(tapped, rest([stack(HALL, { x: 40, y: 100 }), stack(['x', 'y'])])).open).toEqual(HALL);
        });

        it('closes when its stack has gone or folded in with others', () => {
            expect(settleStackList(tapped, rest([], { atCap: false })).open).toBeNull();
            expect(settleStackList(tapped, rest([stack([...HALL, 'd'])], { atCap: false })).open).toBeNull();
        });

        it('ends an earlier ✕, because the member reopened it', () => {
            expect(stackTapped(HALL).shut).toBeNull();
        });
    });

    it('leaves a stack free to open again when something else took the list\'s place', () => {
        const dropped = stackDropped(open());
        expect(dropped).toEqual({ open: null, byTap: false, shut: null });
        expect(settleStackList(dropped, rest([stack(HALL)])).open).toEqual(HALL);
    });

    it('keeps the ✕ when a tap on the map closes nothing', () => {
        const closed = stackShut(open());
        expect(stackShut(closed).shut).toEqual(HALL);
    });

    describe('waiting for the map to stop', () => {
        it('never runs while the map is moving: a move cancels the wait', () => {
            vi.useFakeTimers();
            const fire = vi.fn();
            const watch = stackRestWatch(fire);
            watch.stopped();
            vi.advanceTimersByTime(STACK_REST_MS - 1);
            watch.moving();
            vi.advanceTimersByTime(STACK_REST_MS * 2);
            expect(fire).not.toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('runs once after the map stops, and a second stop starts the wait again', () => {
            vi.useFakeTimers();
            const fire = vi.fn();
            const watch = stackRestWatch(fire);
            watch.stopped();
            vi.advanceTimersByTime(STACK_REST_MS - 1);
            watch.stopped();
            vi.advanceTimersByTime(STACK_REST_MS - 1);
            expect(fire).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(fire).toHaveBeenCalledTimes(1);
            vi.useRealTimers();
        });
    });

    it('lifts a tapped bubble clear of the list only when it would be covered', () => {
        const top = stackListTop(view);
        expect(top).toBeCloseTo(400);
        expect(stackLift(300, view)).toBe(0);
        expect(stackLift(top - STACK_CLEARANCE_PX, view)).toBe(0);
        expect(stackLift(top + 100, view)).toBeCloseTo(100 + STACK_CLEARANCE_PX);
    });

    it('moves nothing for a point past the bottom of the view: that view was read mid-move', () => {
        expect(stackLift(view.height + 1, view)).toBe(0);
    });
});

describe('a tap on a map bubble', () => {
    it('zooms while the cap can part the bubble, and lists it past that', () => {
        expect(bubbleTap(MAP_TAP_CAP_ZOOM - 1, MAP_TAP_CAP_ZOOM)).toBe('zoom');
        expect(bubbleTap(MAP_TAP_CAP_ZOOM, MAP_TAP_CAP_ZOOM)).toBe('zoom');
        expect(bubbleTap(MAP_TAP_CAP_ZOOM + 1, MAP_TAP_CAP_ZOOM)).toBe('list');
        expect(bubbleTap(Infinity, MAP_TAP_CAP_ZOOM)).toBe('list');
    });

    it('lands where the pins fit, deep enough to part them, and never past the cap', () => {
        expect(bubbleLandingZoom(15.4, 14, 17)).toBe(15.4);
        expect(bubbleLandingZoom(12, 14, 17)).toBe(14);
        expect(bubbleLandingZoom(20, 14, 17)).toBe(17);
        expect(bubbleLandingZoom(Infinity, 14, 17)).toBe(17);
    });
});

describe('the order of a bubble\'s list', () => {
    type Row = { id: string; eventStartMs: number | null; createdMs: number };
    const row = (id: string, eventStartMs: number | null, createdMs: number): Row => ({ id, eventStartMs, createdMs });
    const order = (rows: Row[]) => orderStack(rows, (r) => r).map((r) => r.id);

    it('puts the soonest events first, then Offers and Needs together, newest first', () => {
        expect(order([row('old', null, 1), row('later', 900, 5), row('new', null, 3), row('soon', 500, 9), row('mid', null, 2)]))
            .toEqual(['soon', 'later', 'new', 'mid', 'old']);
    });

    it('puts an event with no readable date after the dated ones and before the listings', () => {
        expect(order([row('listing', null, 9), row('undated', NaN, 1), row('dated', 500, 1)])).toEqual(['dated', 'undated', 'listing']);
    });

    it('puts a listing with no readable date last, and keeps ties in the order they came', () => {
        expect(order([row('unknown', null, NaN), row('a', null, 5), row('b', null, 5)])).toEqual(['a', 'b', 'unknown']);
    });
});

describe('the list\'s header', () => {
    it('counts the pins', () => {
        expect(stackHeading(3)).toBe('3 at this spot');
        expect(stackHeading(100)).toBe('100 at this spot');
    });
});
