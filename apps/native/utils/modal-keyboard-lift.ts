/**
 * How far to lift a bottom sheet inside an RN <Modal> above the keyboard, and how tall it may be
 * (components/useModalKeyboardLift has the story). Pure, so it is unit tested.
 */

export function modalKeyboardLift(args: {
    windowHeight: number;
    backdropHeight: number;
    keyboardHeight: number;
    keyboardVisible: boolean;
    topGap: number;
    maxFraction?: number;
}): { lift: number; maxHeight: number } {
    const { windowHeight, backdropHeight, keyboardHeight, keyboardVisible, topGap, maxFraction = 0.9 } = args;
    const available = backdropHeight > 0 ? backdropHeight : windowHeight;
    if (!keyboardVisible || keyboardHeight <= 0) {
        return { lift: 0, maxHeight: Math.max(0, Math.min(available * maxFraction, available - topGap)) };
    }
    // The window already shrank for the keyboard when the backdrop is clearly shorter than the full window.
    const windowShrank = available < windowHeight - keyboardHeight / 2;
    const lift = windowShrank ? 0 : keyboardHeight;
    return { lift, maxHeight: Math.max(0, available - lift - topGap) };
}
