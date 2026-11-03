/**
 * Keeps what a member is typing in view inside a form sheet's ScrollView, from the first keystroke, with no scroll
 * needed (Rob on an iPhone, 3 Nov: "the entry was hidden down below the keyboard", fine only after he scrolled).
 *
 * The sheets (New Post, New Event, New Poll) lift themselves above the keyboard with a react-native-keyboard-controller
 * KeyboardAvoidingView, which shrinks the ScrollView to what is left above it. Nothing then scrolled the focused field
 * into that smaller viewport, and a multiline field that grows as you type pushed its caret past the bottom of it.
 *
 * Why not the library's KeyboardAwareScrollView: it works in window coordinates it captures when the keyboard starts
 * moving, which is before this KeyboardAvoidingView has lifted the sheet, so inside one it scrolls a second time for
 * a keyboard the sheet has already made room for; and it adds a keyboard's height of blank space under the form.
 * This hook asks the same library for the same facts (which input is focused, where its caret is) and scrolls only
 * by the field's position INSIDE the scroll view, which is the same whatever the keyboard has done to the sheet.
 *
 * Android soft-input mode: this hook calls nothing that sets it. useFocusedInputHandler and useReanimatedFocusedInput
 * do not touch it (only useKeyboardHandler and the keyboard animation hooks do, via useResizeMode), so it cannot
 * cause the double lift that a second resetter caused in the chats (memory keyboard-avoidance-pattern).
 * No second KeyboardProvider either: the root one feeds these hooks.
 *
 * Spread `scrollProps` onto the ScrollView and pass `scrollRef` as its ref.
 */
import { useCallback, useEffect, useRef } from 'react';
import { TextInput, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';
import { useAnimatedReaction } from 'react-native-reanimated';
import { useFocusedInputHandler, useReanimatedFocusedInput } from 'react-native-keyboard-controller';
import { scheduleOnRN } from 'react-native-worklets';
import { scrollTargetForCaret } from '../utils/scroll-caret-visible';

const GAP = 24;
const LINE_HEIGHT = 22;

export function useKeepCaretVisible(existingRef?: React.RefObject<ScrollView | null>) {
    const ownRef = useRef<ScrollView | null>(null);
    const scrollRef = existingRef ?? ownRef;
    const scrollY = useRef(0);
    const viewportHeight = useRef(0);
    const contentHeight = useRef(0);
    const caretBottom = useRef<number | null>(null);
    const caretTarget = useRef<number | null>(null);
    const pending = useRef<number | null>(null);
    const { input } = useReanimatedFocusedInput();

    const ensure = useCallback(() => {
        const field: any = (TextInput as any).State?.currentlyFocusedInput?.();
        const scroll: any = scrollRef.current;
        const content: any = scroll?.getInnerViewRef?.() ?? scroll?.getInnerViewNode?.();
        if (!field || !scroll || !content || typeof field.measureLayout !== 'function') return;
        field.measureLayout(
            content,
            (_x: number, y: number, _w: number, h: number) => {
                const target = scrollTargetForCaret({
                    scrollY: scrollY.current,
                    viewportHeight: viewportHeight.current,
                    contentHeight: contentHeight.current,
                    fieldTop: y,
                    fieldHeight: h,
                    caretBottomInField: caretBottom.current,
                    lineHeight: LINE_HEIGHT,
                    gap: GAP,
                });
                if (target != null) {
                    scrollY.current = target;
                    scroll.scrollTo({ y: target, animated: false });
                }
            },
            () => { /* the field left the tree between the event and the measure: nothing to do */ },
        );
    }, [scrollRef]);

    // One measure per frame however many layout/selection events arrive (the sheet's lift fires one per frame).
    const schedule = useCallback(() => {
        if (pending.current != null) return;
        pending.current = requestAnimationFrame(() => {
            pending.current = null;
            ensure();
        });
    }, [ensure]);

    useEffect(() => () => {
        if (pending.current != null) cancelAnimationFrame(pending.current);
    }, []);

    const onCaret = useCallback((target: number, bottomInField: number) => {
        // A caret from another field is not this field's caret: remember whose it is.
        if (caretTarget.current !== target) caretTarget.current = target;
        caretBottom.current = bottomInField > 0 ? bottomInField : null;
        schedule();
    }, [schedule]);

    const onFocusOrResize = useCallback((target: number) => {
        if (caretTarget.current !== target) {
            caretTarget.current = target;
            caretBottom.current = null;
        }
        schedule();
    }, [schedule]);

    // The caret moved (typing, a new line, a tap): keep its line in view.
    useFocusedInputHandler({
        onSelectionChange: (e) => {
            'worklet';
            scheduleOnRN(onCaret, e.target, e.selection.end.y);
        },
    }, [onCaret]);

    // A different field was focused: look at it.
    useAnimatedReaction(
        () => (input.value ? input.value.target : -1),
        (cur, prev) => {
            if (cur !== -1 && cur !== prev) scheduleOnRN(onFocusOrResize, cur);
        },
        [onFocusOrResize],
    );

    // The focused field changed height (typing, pasting): look again.
    useAnimatedReaction(
        () => (input.value ? Math.round(input.value.layout.height) : -1),
        (cur, prev) => {
            if (cur !== -1 && cur !== prev) scheduleOnRN(schedule);
        },
        [schedule],
    );

    const onLayout = useCallback((e: LayoutChangeEvent) => {
        viewportHeight.current = e.nativeEvent.layout.height;
        // The keyboard came or went and the sheet resized: the focused field may now be under the edge.
        schedule();
    }, [schedule]);

    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
    }, []);

    const onContentSizeChange = useCallback((_w: number, h: number) => {
        contentHeight.current = h;
    }, []);

    return {
        scrollRef,
        scrollProps: { onLayout, onScroll, onContentSizeChange, scrollEventThrottle: 32 },
    };
}
