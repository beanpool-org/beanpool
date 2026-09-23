/**
 * What a chat's keyboard lift starts at, read from the keyboard state the provider is already holding.
 *
 * ChatKeyboardAvoidingView follows the keyboard's live height through keyboard EVENTS, and a chat that mounts
 * while the keyboard is already up gets no event: the next frame it hears about is the keyboard moving again.
 * Starting at zero leaves that composer under the keyboard until then. The library's KeyboardAvoidingView
 * seeded itself the same way, from the provider's current height in a layout effect
 * (components/KeyboardAvoidingView/hooks.ts).
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
