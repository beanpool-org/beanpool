/**
 * Keeps the field a member is typing in (and the end of a long note as it grows) in view inside a sheet's ScrollView.
 *
 * Found by the 3 Nov keyboard audit (group D): the sheets inside a Modal are lifted above the keyboard
 * (useModalKeyboardLift, or a keyboard-controller KeyboardAvoidingView), but their plain ScrollView never moved, so a
 * field low in the form, or a multiline's caret as the note grew, could end up under the keyboard.
 *
 * Wire it on the sheet's ScrollView and on each of its TextInputs:
 *
 *   const fieldScroll = useScrollFieldIntoView();
 *   <ScrollView {...fieldScroll.scrollProps}> … <TextInput {...fieldScroll.inputProps} /> … </ScrollView>
 *
 * It re-checks when a field takes focus, when the ScrollView's own height changes (the keyboard opening shrinks or pads
 * it) and when a multiline's content size changes. The check is debounced, so the keyboard's animation moves the view
 * once, not once a frame. A focused input that is not inside this ScrollView is left alone.
 *
 * `inputProps` carries onFocus and onContentSizeChange. An input that has handlers of its own calls both.
 * A field in a child component reaches the sheet's helper through ScrollFieldContext.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { TextInput } from 'react-native';
import type { ScrollView } from 'react-native';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { scrollTargetForField } from '../utils/scroll-field-target';

/** Wait this long after the last focus / layout / size change before measuring: the keyboard animates for ~250 ms. */
export const SCROLL_FIELD_SETTLE_MS = 60;

export interface ScrollFieldIntoView {
    scrollRef: RefObject<ScrollView | null>;
    scrollProps: {
        ref: RefObject<ScrollView | null>;
        onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
        onLayout: (e: LayoutChangeEvent) => void;
        onContentSizeChange: (w: number, h: number) => void;
        scrollEventThrottle: number;
    };
    inputProps: {
        onFocus: () => void;
        onContentSizeChange: () => void;
    };
    /** Scroll the focused input into view (after the settle delay). */
    ensureVisible: () => void;
}

type FocusedInput = {
    measureLayout?: (relativeTo: unknown, ok: (x: number, y: number, w: number, h: number) => void, fail: () => void) => void;
};

export function useScrollFieldIntoView(margin = 16): ScrollFieldIntoView {
    const scrollRef = useRef<ScrollView>(null);
    const scrollY = useRef(0);
    const viewportHeight = useRef(0);
    const contentHeight = useRef<number | undefined>(undefined);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const run = useCallback(() => {
        timer.current = null;
        const input = TextInput.State?.currentlyFocusedInput?.() as FocusedInput | null | undefined;
        const view = scrollRef.current;
        const inner = (view as unknown as { getInnerViewRef?: () => unknown } | null)?.getInnerViewRef?.();
        if (!input?.measureLayout || !view || !inner) return;
        try {
            input.measureLayout(
                inner,
                (_x, y, _w, h) => {
                    const target = scrollTargetForField({
                        fieldTop: y,
                        fieldBottom: y + h,
                        scrollY: scrollY.current,
                        viewportHeight: viewportHeight.current,
                        margin,
                        contentHeight: contentHeight.current,
                    });
                    if (target !== null) view.scrollTo({ y: target, animated: true });
                },
                () => { /* the focused input is outside this ScrollView: nothing to do */ },
            );
        } catch {
            /* the same */
        }
    }, [margin]);

    const ensureVisible = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(run, SCROLL_FIELD_SETTLE_MS);
    }, [run]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
    }, []);
    const onLayout = useCallback((e: LayoutChangeEvent) => {
        const h = e.nativeEvent.layout.height;
        const changed = Math.abs(h - viewportHeight.current) >= 1;
        viewportHeight.current = h;
        // Only a height change can have uncovered or covered the field; the first layout has no focus yet.
        if (changed) ensureVisible();
    }, [ensureVisible]);
    const onScrollContentSize = useCallback((_w: number, h: number) => {
        contentHeight.current = h;
    }, []);

    return useMemo(() => ({
        scrollRef,
        scrollProps: { ref: scrollRef, onScroll, onLayout, onContentSizeChange: onScrollContentSize, scrollEventThrottle: 16 },
        inputProps: { onFocus: ensureVisible, onContentSizeChange: ensureVisible },
        ensureVisible,
    }), [onScroll, onLayout, onScrollContentSize, ensureVisible]);
}
