/**
 * The keyboard lift every chat screen uses: the DM, a group or enterprise thread, and an event's chat.
 *
 * Why not react-native-keyboard-controller's own KeyboardAvoidingView (which all three used before):
 * its "padding" behaviour measures the keyboard ONCE. `heightWhenOpened` is written in the handler's
 * `onStart`, and only when the height rises above zero — the open transition. The live height it also
 * tracks is never what the padding reads. So a keyboard that changes height while it STAYS open is
 * never followed, and the padding keeps the height the keyboard had when it first appeared.
 *
 * Gboard changes height while open all the time: the suggestion strip appearing once there is a word to
 * suggest, the emoji and symbols panels, one-handed and floating modes, and — on a device or emulator
 * with a hardware keyboard — the collapsed toolbar expanding into the full keyboard. When the keyboard
 * GROWS, the stale smaller padding leaves the composer underneath it, off-screen and untappable.
 * Measured on the API 36 emulator at 320dp + 1.3x text: the keyboard opened as Gboard's ~240px
 * hardware-keyboard bar and grew to ~960px; the composer never moved off the bottom of the window.
 * A composer with a three-line notice is the tallest one we have, which is why the small screen showed
 * it first — but nothing about the failure is specific to that size.
 *
 * So this pads by the LIVE keyboard height, taken from every keyboard frame rather than just the first.
 *
 * It also owns the Android window's soft-input mode, which was previously set by the DM screen alone:
 * ADJUST_NOTHING, so the OS never resizes or pans the window underneath us and this padding is the only
 * compensation in play. That matters below Android 15, where `adjustResize` still resizes the window and
 * would compensate a second time. The mode is a property of the WINDOW, not of a screen, so the default
 * is restored only once the last chat screen has gone — a chat pushed on top of another chat must not be
 * handed the default back when the one underneath unmounts.
 */

import React, { useEffect } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import {
    AndroidSoftInputModes,
    KeyboardController,
    useGenericKeyboardHandler,
} from 'react-native-keyboard-controller';

/** How many chat screens are mounted. The window's mode belongs to the last one to leave. */
let chatScreensMounted = 0;

function useAndroidAdjustNothing() {
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        chatScreensMounted += 1;
        KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
        return () => {
            chatScreensMounted -= 1;
            if (chatScreensMounted === 0) KeyboardController.setDefaultMode();
        };
    }, []);
}

interface Props {
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}

export function ChatKeyboardAvoidingView({ style, children }: Props) {
    useAndroidAdjustNothing();

    const keyboardHeight = useSharedValue(0);
    // `useGenericKeyboardHandler` is the variant that does NOT set the window to adjustResize on mount —
    // the plain `useKeyboardHandler` does, and would undo the ADJUST_NOTHING above.
    useGenericKeyboardHandler({
        onMove: e => { 'worklet'; keyboardHeight.value = e.height; },
        onInteractive: e => { 'worklet'; keyboardHeight.value = e.height; },
        onEnd: e => { 'worklet'; keyboardHeight.value = e.height; },
    }, []);

    const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(keyboardHeight.value, 0) }));

    return <Animated.View style={[style, lift]}>{children}</Animated.View>;
}
