/**
 * How far a chat's composer has to rise to clear the keyboard — computed FRAME-RELATIVE, every frame.
 *
 * The lift is not "the keyboard's height". It is how far the keyboard reaches ABOVE the bottom edge of the
 * view we are padding. Those two are the same number only when that edge is at the bottom of an unshrunken
 * window, and on Android that depends on the window's soft-input mode, which no chat screen controls:
 *
 *   - SOFT_INPUT_ADJUST_NOTHING — the OS leaves the window alone. The view's bottom stays at the window's
 *     bottom and the keyboard covers it, so the lift is the keyboard's full height (less whatever inset
 *     already sits below the view).
 *   - adjustResize (this app's manifest: app.json `softwareKeyboardLayoutMode: "resize"`) — the OS has already
 *     shrunk the window by the keyboard. The view's bottom has moved up with it and is already clear of the
 *     keyboard, so the lift is 0. Padding by the keyboard's height here lifts the composer TWICE, leaving it
 *     stranded half a keyboard up the screen (Android 10 and below; this product's floor is API 26).
 *
 * The mode is a property of the WINDOW and is global. react-native-keyboard-controller hands it back to the
 * manifest default from about twenty components — every `KeyboardAvoidingView`, `KeyboardStickyView` and
 * `KeyboardAwareScrollView` calls `useResizeMode()` (node_modules/react-native-keyboard-controller/src/hooks/
 * index.ts:31-38, via 56, 77, 190), which is `setInputMode(ADJUST_RESIZE)` on mount and `setDefaultMode()` on
 * unmount. Inside a chat that is ReviewModal, and any screen pushed on top of one. Declaring ADJUST_NOTHING
 * and policing every component that might undo it is a race we cannot win; measuring against the view's own
 * bottom edge means we never have to care which mode won.
 *
 * That is how the library's own KeyboardAvoidingView avoided this: `relativeKeyboardHeight()` measures the
 * view's frame against the keyboard's top rather than reading the keyboard's height (components/
 * KeyboardAvoidingView/index.tsx:101-108). Its one fault is that the height it measures against is LATCHED:
 * `keyboard.heightWhenOpened` is written only in `onStart`, and only when the height rises above zero
 * (components/KeyboardAvoidingView/hooks.ts:31-38), so a keyboard that changes height while it STAYS open is
 * never followed. Gboard does that constantly — the suggestion strip, the emoji and symbols panels, one-handed
 * and floating modes, and a hardware keyboard's collapsed toolbar expanding into the full keyboard. Measured
 * on the API 36 emulator at 320dp + 1.3x text: the keyboard opened as a ~240px bar and grew to ~960px, and the
 * composer never moved. KeyboardStickyView is the mirror image — live height, but an absolute `translateY`
 * (components/KeyboardStickyView/index.tsx:54,65). Nothing in 1.20.7 is both frame-relative AND live, which is
 * why this is ours.
 */

/** A window's height is only usable if it is a real, positive measurement. */
function usable(n: number): boolean {
    'worklet';
    return Number.isFinite(n) && n > 0;
}

export interface ChatKeyboardLiftFrame {
    /** The padded view's bottom edge, in the window's coordinates: its layout `y` + `height`. */
    viewBottom: number;
    /**
     * The window's height with NO keyboard up — the reference the view's bottom is read against.
     * Not the live height: under adjustResize the live height shrinks WITH the view, which would cancel out
     * and hide the very compensation we are trying to detect. See `restingWindowHeight`.
     */
    windowHeight: number;
    /** The keyboard's height THIS frame — not the height it had when it opened. */
    keyboardHeight: number;
}

/**
 * The padding that puts the view's bottom edge on top of the keyboard, for one frame.
 *
 * `windowHeight - keyboardHeight` is where the keyboard's top edge sits in the resting window. Anything of the
 * view below that line is covered, and that overlap is the lift. A view already clear of the line — because the
 * OS resized the window, or because the view does not reach the bottom of the screen — gets nothing.
 */
export function chatKeyboardLift(frame: ChatKeyboardLiftFrame): number {
    'worklet';
    const { viewBottom, windowHeight, keyboardHeight } = frame;
    if (!Number.isFinite(viewBottom) || !usable(windowHeight)) return 0;
    if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
    const keyboardTop = windowHeight - keyboardHeight;
    return Math.max(viewBottom - keyboardTop, 0);
}

/**
 * The window's height with no keyboard up, learned from the live heights we are handed.
 *
 * Under ADJUST_NOTHING the live height never moves, so this is just that height. Under adjustResize it drops
 * while the keyboard is open and comes back when it closes, so the resting height is the largest one seen.
 * Taking the maximum rather than "the height while `isVisible` is false" is deliberate: the window resize and
 * the keyboard's visibility reach JS as two separate events, and if the resize lands first a visibility-gated
 * rule would record the shrunken height as the resting one and lift twice — exactly the bug this replaces.
 *
 * The maximum is reset from outside on a Dimensions change, which is the only honest reason for the window to
 * get shorter for good (rotation, split screen, a folding device).
 */
export function restingWindowHeight(previous: number | null, live: number): number {
    'worklet';
    if (!usable(live)) return usable(previous ?? 0) ? (previous as number) : 0;
    if (previous === null || !usable(previous)) return live;
    return Math.max(previous, live);
}

/**
 * What a chat's keyboard lift starts at, read from the keyboard state the provider is already holding.
 *
 * ChatKeyboardAvoidingView follows the keyboard's live height through keyboard EVENTS, and a chat that mounts
 * while the keyboard is already up gets no event: the next frame it hears about is the keyboard moving again.
 * Starting at zero leaves that composer under the keyboard until then. The library's KeyboardAvoidingView
 * seeded itself the same way, from the provider's current height in a layout effect
 * (components/KeyboardAvoidingView/hooks.ts:18-27).
 *
 * That mount happens: `new-message.tsx` keeps taps with `keyboardShouldPersistTaps="handled"` and opens the DM
 * with `router.replace` straight from the search field, and `people.tsx` does the same.
 *
 * `height` alone is not the answer: the module keeps the last height it saw, so a closed keyboard can still
 * report the height it had when it was open. Only a keyboard that is up is a lift.
 */
export function initialChatKeyboardLift(state: { height: number; isVisible: boolean }): number {
    if (!state.isVisible) return 0;
    if (!Number.isFinite(state.height) || state.height <= 0) return 0;
    return state.height;
}
