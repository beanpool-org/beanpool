/**
 * Waits for the keyboard to close, but never for longer than `timeoutMs`.
 *
 * `KeyboardController.dismiss()` resolves when keyboard-controller sees the keyboard hide. Inside an RN
 * <Modal> on Android 8–10 (API < 30) that event may never arrive, so an unbounded `await` leaves the caller
 * stuck — Create Group did nothing at all. The dismiss is awaited only so an Alert is not opened over a
 * raised keyboard (phantom padding); after a short wait we carry on regardless.
 *
 * Takes the dismiss function rather than importing keyboard-controller so it can be tested in node.
 */
export const KEYBOARD_DISMISS_TIMEOUT_MS = 400;

export function dismissKeyboardWithin(
    dismiss: () => unknown,
    timeoutMs: number = KEYBOARD_DISMISS_TIMEOUT_MS,
): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const done = () => { clearTimeout(timer); resolve(); };
        // Promise.resolve().then(...) also catches a dismiss that throws synchronously.
        Promise.resolve().then(dismiss).then(done, done);
    });
}
