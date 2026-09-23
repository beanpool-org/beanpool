/**
 * The keyboard lift every chat screen uses: the DM, a group or enterprise thread, and an event's chat.
 *
 * It pads its own bottom by however far the keyboard reaches ABOVE its bottom edge, recomputed from the LIVE
 * keyboard height on every frame. utils/chat-keyboard-lift.ts carries the reasoning: why the lift has to be
 * measured against the view's own edge rather than read off the keyboard (the Android window's soft-input mode
 * is global, and about twenty of react-native-keyboard-controller's components hand it back to the manifest's
 * adjustResize from under us), and why neither of the library's own views can do it (KeyboardAvoidingView is
 * frame-relative but latches the height the keyboard had when it opened; KeyboardStickyView is live but
 * absolute).
 *
 * Because the measurement is relative, this view sets no window mode and cares about none. Whatever the mode
 * is when the keyboard opens — whatever a ReviewModal or a pushed post screen last left it as — the composer
 * ends up on top of the keyboard exactly once.
 */

import React, { useCallback, useEffect, useReducer } from 'react';
import { Dimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import {
    useGenericKeyboardHandler,
    useKeyboardState,
    useWindowDimensions,
} from 'react-native-keyboard-controller';
import {
    chatKeyboardLift,
    initialChatKeyboardLift,
    restingWindowHeight,
} from '../../utils/chat-keyboard-lift';

/**
 * The resting window height belongs to the WINDOW, so it outlives any one chat screen. Learning it once and
 * keeping it also covers the only case a single screen cannot learn for itself: a chat that mounts while the
 * keyboard is already up has never seen the window at rest, but the app it was opened from has.
 */
let restingHeightCache: number | null = null;

function useRestingWindowHeight(): number {
    const live = useWindowDimensions().height;
    const [, forget] = useReducer((n: number) => n + 1, 0);

    // A real size change — rotation, split screen, unfolding — is the one honest reason for the window to get
    // shorter for good, so the learned maximum is thrown away and relearned from the next live height.
    useEffect(() => {
        const sub = Dimensions.addEventListener('change', () => {
            restingHeightCache = null;
            forget();
        });
        return () => sub.remove();
    }, []);

    // Computed in render rather than an effect so the first paint already has it. `restingWindowHeight` is a
    // maximum, so running it twice with the same input is the same as running it once.
    restingHeightCache = restingWindowHeight(restingHeightCache, live);
    return restingHeightCache;
}

interface Props {
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}

export function ChatKeyboardAvoidingView({ style, children }: Props) {
    const windowHeight = useRestingWindowHeight();

    /** This view's bottom edge, in the window's coordinates. Only layout moves it, so only layout re-reads it. */
    const viewBottom = useSharedValue(0);
    const onLayout = useCallback((e: LayoutChangeEvent) => {
        const { y, height } = e.nativeEvent.layout;
        viewBottom.value = y + height;
    }, []);

    // A chat can mount with the keyboard already up — the DM opened straight from a search field's results,
    // which keep their taps and `router.replace` to the chat. There is no keyboard event in that, so the
    // handler below would not hear a height until the keyboard next MOVED, and the composer would sit under
    // it until then. The provider already knows the height: start there. (Only the initial render's value is
    // read; every later height comes from the handler.)
    const keyboardHeight = useSharedValue(initialChatKeyboardLift({
        height: useKeyboardState(s => s.height),
        isVisible: useKeyboardState(s => s.isVisible),
    }));
    // `useGenericKeyboardHandler` is the variant that does NOT touch the window's soft-input mode. This view
    // wants the frames and nothing else; the mode is no longer any of its business.
    useGenericKeyboardHandler({
        onMove: e => { 'worklet'; keyboardHeight.value = e.height; },
        onInteractive: e => { 'worklet'; keyboardHeight.value = e.height; },
        onEnd: e => { 'worklet'; keyboardHeight.value = e.height; },
    }, []);

    const lift = useAnimatedStyle(() => ({
        paddingBottom: chatKeyboardLift({
            viewBottom: viewBottom.value,
            windowHeight,
            keyboardHeight: keyboardHeight.value,
        }),
    }), [windowHeight]);

    return <Animated.View style={[style, lift]} onLayout={onLayout}>{children}</Animated.View>;
}
