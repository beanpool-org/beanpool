/**
 * How far to lift a bottom sheet inside an RN <Modal> above the keyboard, and how tall it may be
 * (components/useModalKeyboardLift has the story). Pure, so it is unit tested.
 */

export function modalKeyboardLift(args: {
    windowHeight: number;
    keyboardHeight: number;
    keyboardVisible: boolean;
    topGap: number;
    maxFraction?: number;
}): { lift: number; maxHeight: number } {
    const { windowHeight, keyboardHeight, keyboardVisible, topGap, maxFraction = 0.9 } = args;
    const lift = keyboardVisible && keyboardHeight > 0 ? keyboardHeight : 0;
    // 90% of the screen with no keyboard; everything between the top gap and the keyboard with one.
    const maxHeight = Math.max(0, Math.min(windowHeight * maxFraction, windowHeight - lift - topGap));
    return { lift, maxHeight };
}
