// @vitest-environment jsdom
/**
 * The shared "scroll the field being typed in into view" helper (components/useScrollFieldIntoView, the maths in
 * utils/scroll-field-target): the 3 Nov keyboard audit's group D. Nothing here draws a frame; the focused input is a
 * stand-in whose measureLayout reports where it sits, and the ScrollView's scrollTo is a spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { scrollTargetForField } from '../scroll-field-target';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rn = vi.hoisted(() => ({ focused: null as any }));
vi.mock('react-native', () => ({
    ScrollView: 'div',
    TextInput: { State: { currentlyFocusedInput: () => rn.focused } },
}));

import { useScrollFieldIntoView, SCROLL_FIELD_SETTLE_MS, type ScrollFieldIntoView } from '../../components/useScrollFieldIntoView';

describe('scrollTargetForField', () => {
    const base = { scrollY: 0, viewportHeight: 300, margin: 16 };

    it('leaves a field that is already in view alone', () => {
        expect(scrollTargetForField({ ...base, fieldTop: 40, fieldBottom: 90 })).toBeNull();
    });

    it('scrolls down so a field under the keyboard clears the bottom edge by the margin', () => {
        // The field ends at 380 in a 300-high view: its bottom + 16 must sit at the view's bottom.
        expect(scrollTargetForField({ ...base, fieldTop: 330, fieldBottom: 380 })).toBe(96);
    });

    it('scrolls up so a field above the view clears the top edge by the margin', () => {
        expect(scrollTargetForField({ ...base, scrollY: 200, fieldTop: 150, fieldBottom: 200 })).toBe(134);
    });

    it('keeps the END of a field taller than the view in sight (the caret of a long note)', () => {
        // A 500-high note in a 300-high view: show its last 268 (300 - 2 * 16 is not enough room for all of it).
        expect(scrollTargetForField({ ...base, fieldTop: 100, fieldBottom: 600 })).toBe(316);
    });

    it('never scrolls above the top or past the end of the content', () => {
        expect(scrollTargetForField({ ...base, scrollY: 50, fieldTop: 0, fieldBottom: 40 })).toBe(0);
        expect(scrollTargetForField({ ...base, fieldTop: 330, fieldBottom: 380, contentHeight: 360 })).toBe(60);
    });

    it('does nothing before the view has a height', () => {
        expect(scrollTargetForField({ ...base, viewportHeight: 0, fieldTop: 330, fieldBottom: 380 })).toBeNull();
    });

    it('ignores a sub-pixel difference', () => {
        expect(scrollTargetForField({ ...base, scrollY: 96.4, fieldTop: 330, fieldBottom: 380 })).toBeNull();
    });
});

describe('useScrollFieldIntoView', () => {
    let host: HTMLElement;
    let root: Root;
    let helper: ScrollFieldIntoView;
    let scrollTo: ReturnType<typeof vi.fn>;

    function Probe() {
        helper = useScrollFieldIntoView();
        return null;
    }
    const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } }) as any;
    const scrolled = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as any;
    const settle = () => act(async () => { vi.advanceTimersByTime(SCROLL_FIELD_SETTLE_MS + 5); });
    /** A focused input at this place in the ScrollView's content. */
    const focusedAt = (y: number, h: number) => {
        rn.focused = { measureLayout: vi.fn((_rel: unknown, ok: (x: number, y: number, w: number, h: number) => void) => ok(0, y, 280, h)) };
    };

    beforeEach(async () => {
        vi.useFakeTimers();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => { root.render(createElement(Probe) as any); });
        scrollTo = vi.fn();
        (helper.scrollRef as any).current = { scrollTo, getInnerViewRef: () => ({ inner: true }) };
        helper.scrollProps.onContentSizeChange(320, 900);
        helper.scrollProps.onLayout(layout(300));
        await settle(); // the first layout's own check, with nothing focused
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        rn.focused = null;
        vi.useRealTimers();
    });

    it('scrolls a lower field into view when it takes focus', async () => {
        focusedAt(330, 50);
        helper.inputProps.onFocus();
        expect(scrollTo).not.toHaveBeenCalled(); // waits for the keyboard to settle
        await settle();
        expect(scrollTo).toHaveBeenCalledWith({ y: 96, animated: true });
    });

    it('scrolls again when the keyboard shrinks the view under a field that was in sight', async () => {
        focusedAt(200, 50);
        helper.inputProps.onFocus();
        await settle();
        expect(scrollTo).not.toHaveBeenCalled();
        helper.scrollProps.onLayout(layout(180)); // the keyboard came up
        await settle();
        expect(scrollTo).toHaveBeenCalledWith({ y: 86, animated: true });
    });

    it('follows a multiline as its content grows, from where the view has been scrolled to', async () => {
        helper.scrollProps.onScroll(scrolled(96));
        focusedAt(330, 140); // the note grew by 90: its bottom is now at 470
        helper.inputProps.onContentSizeChange();
        await settle();
        expect(scrollTo).toHaveBeenCalledWith({ y: 186, animated: true });
    });

    it('measures once for a burst of layout events (the keyboard animating)', async () => {
        focusedAt(330, 50);
        for (const h of [290, 270, 250, 230, 210, 190]) helper.scrollProps.onLayout(layout(h));
        await settle();
        expect(rn.focused.measureLayout).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('does not scroll on the first layout, or when the height is unchanged', async () => {
        focusedAt(330, 50);
        helper.scrollProps.onLayout(layout(300));
        await settle();
        expect(rn.focused.measureLayout).not.toHaveBeenCalled();
    });

    it('leaves a focused input outside its ScrollView alone', async () => {
        rn.focused = { measureLayout: vi.fn((_rel: unknown, _ok: unknown, fail: () => void) => fail()) };
        helper.inputProps.onFocus();
        await settle();
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('does nothing when no input has focus, or when measuring throws', async () => {
        rn.focused = null;
        helper.inputProps.onFocus();
        await settle();
        rn.focused = { measureLayout: () => { throw new Error('detached'); } };
        helper.inputProps.onFocus();
        await settle();
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('drops a pending check when the sheet closes', async () => {
        focusedAt(330, 50);
        helper.inputProps.onFocus();
        act(() => root.unmount());
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(scrollTo).not.toHaveBeenCalled();
        root = createRoot(host); // so afterEach can unmount
    });
});
