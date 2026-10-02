/**
 * The Market's floating "+ ADD POST" button (app/(tabs)/index.tsx `styles.fab`) and the "one way back" card's actions
 * (components/OneWayBackCard.tsx), at 320dp with 1.3x text (PR #1452 re-review, finding 4).
 *
 * The button floats 32dp above the screen's bottom edge, about 58dp tall at the app's largest text. On a small screen the
 * card's two actions rest right there on the Market's first view, and the button then read as one of the card's own
 * buttons. The card keeps its actions full width, and the button steps aside while they are in its band: it is back as
 * soon as the feed scrolls them above it (or below the screen), or the card is put away.
 */

/** The button's bottom edge above the screen's bottom (its `bottom` style). */
export const FAB_BOTTOM_DP = 32;
/** From the screen's bottom edge to a little above the button's top: the band the button covers. */
export const FAB_BAND_DP = 100;

/**
 * Where the card's actions were measured (window coordinates, dp), and the feed's scroll offset at that moment: the
 * actions move up one dp for every dp the feed scrolls on from there.
 */
export interface CardActionsAt {
    top: number;
    bottom: number;
    scrollY: number;
}

/** Whether the button steps aside now: the card's actions, where the feed has moved them, overlap its band. */
export function fabStepsAside(actions: CardActionsAt | null, scrollY: number, windowHeight: number): boolean {
    if (!actions) return false;
    const moved = scrollY - actions.scrollY;
    const top = actions.top - moved;
    const bottom = actions.bottom - moved;
    return bottom > windowHeight - FAB_BAND_DP && top < windowHeight - FAB_BOTTOM_DP;
}
