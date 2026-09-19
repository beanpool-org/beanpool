/**
 * Keeps a bottom sheet inside an RN <Modal> above the keyboard.
 *
 * Found on the emulator at 320dp x 569dp (groups slice 2 mock): with react-native-keyboard-controller's
 * KeyboardAvoidingView inside Create a Group's Modal, the keyboard (425px of 854) left the sheet 85px tall — its
 * title only, under the status bar, the form gone. At normal height the over-padding still left a small scroll area,
 * so it went unnoticed.
 *
 * The Modal's window does NOT shrink for the keyboard (measured: at 320dp the keyboard simply covered the name
 * field once the padding was removed), and the KeyboardAvoidingView over-padded inside the Modal. So the sheet is
 * lifted by exactly the keyboard's height from the root provider's state, and fits what is left above it.
 *
 * Never a nested KeyboardProvider inside a Modal (memory keyboard-avoidance-pattern).
 */

import { useWindowDimensions } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { modalKeyboardLift } from '../utils/modal-keyboard-lift';

export function useModalKeyboardLift(topGap: number, maxFraction = 0.9) {
    const { height: windowHeight } = useWindowDimensions();
    const keyboardHeight = useKeyboardState(s => s.height);
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    return modalKeyboardLift({ windowHeight, keyboardHeight, keyboardVisible, topGap, maxFraction });
}
