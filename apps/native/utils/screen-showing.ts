/**
 * Whether a screen in a stack can still be seen: it is the one on top, or only see-through screens are over it.
 *
 * components/ScreenStatusBar.tsx counts a screen's own status bar only while this is true. React Native keeps one stack of
 * status bar entries for the whole app, in mount order, the newest winning (StatusBar's pushStackEntry), and a screen under
 * another stays mounted: so a bar set for one screen's header otherwise stays on every screen opened over it that sets none
 * (WALK 3 phone, 17 Nov 2026: the tabs' light bar, made for their dark header, white on the guest chat's light page).
 */

/**
 * The root stack's screens drawn over the screen that opened them with that screen still showing around them (presentation
 * 'transparentModal' in app/_layout.tsx): the status bar sits over the opener's header, so the opener's bar stays.
 * status-bar-every-screen.test.ts holds this list to app/_layout.tsx's see-through screens.
 */
export const SEE_THROUGH_SCREENS: readonly string[] = ['new-listing'];

/** The part of a navigator's state this reads (React Navigation's NavigationState). */
export type StackStateLike = {
    type?: string;
    index: number;
    routes: ReadonlyArray<{ key: string; name: string }>;
};

/**
 * True while the route with `key` is the navigator's focused route, or it sits in a stack under nothing but see-through
 * screens. A state or a key it can't place keeps the bar, as it was before this check.
 */
export function screenShowing(state: StackStateLike | undefined | null, key: string | undefined): boolean {
    if (!state || !key) return true;
    const at = state.routes.findIndex((r) => r.key === key);
    if (at < 0) return true;
    if (at === state.index) return true;
    if (state.type !== 'stack' || at > state.index) return false;
    return state.routes.slice(at + 1, state.index + 1).every((r) => SEE_THROUGH_SCREENS.includes(r.name));
}
