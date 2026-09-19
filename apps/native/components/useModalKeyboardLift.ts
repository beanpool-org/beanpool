/**
 * Keeps a bottom sheet inside an RN <Modal> above the keyboard, measured rather than assumed.
 *
 * Found on the emulator at 320dp x 569dp (groups slice 2 mock): with react-native-keyboard-controller's
 * KeyboardAvoidingView inside Create a Group's Modal, the keyboard (425px of 854) left the sheet 85px tall — its
 * title only, under the status bar, the form gone. At normal height the same sheet kept a small scroll area, so it
 * went unnoticed. Whether the Modal's window is resized for the keyboard differs by Android version and window
 * mode, so this measures instead: the backdrop's own height tells us whether the window already shrank; only if it
 * did not do we lift the sheet by the keyboard's height ourselves. The sheet's maxHeight is then whatever is left.
 *
 * Uses the root KeyboardProvider's state — never a nested provider inside a Modal (memory keyboard-avoidance-pattern).
 */

import { useCallback, useState } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { modalKeyboardLift } from '../utils/modal-keyboard-lift';

export function useModalKeyboardLift(topGap: number, maxFraction = 0.9) {
    const { height: windowHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardState(s => s.height);
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    const [backdropHeight, setBackdropHeight] = useState(0);
    const onLayout = useCallback((e: LayoutChangeEvent) => setBackdropHeight(e.nativeEvent.layout.height), []);
    const { lift, maxHeight } = modalKeyboardLift({ windowHeight, backdropHeight, keyboardHeight, keyboardVisible, topGap, maxFraction });
    return { onLayout, lift, maxHeight, keyboardVisible };
}
