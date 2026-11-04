/**
 * What a card's inside is in Arrange (DESIGN-home-arrange-in-place-fable.md §2.1): dimmed, and no touch and no screen-reader
 * word reaches it until Done. Kept apart, with no imports, so the "one way back" card (which draws its own frame) can use
 * it without pulling the Home card parts into every screen that shows that card.
 *
 * 65 %, not the design's 55 %: measured at 320dp × 1.3 (e2e/arrange-320.mjs), a card's secondary lines and its links read at
 * 2.55:1 in light and 2.81:1 in dark at 55 %, and at 3:1 or better in both at 65 %. An inactive inside is exempt from 4.5:1,
 * but a member should still be able to read what is on the card they are about to move.
 */
export const QUIET_OPACITY = 0.65;

export const quietProps = {
    pointerEvents: 'none',
    // Android hides the whole subtree from TalkBack; iOS's VoiceOver does the same with the other.
    importantForAccessibility: 'no-hide-descendants',
    accessibilityElementsHidden: true,
} as const;

/** What the same wrapper carries on Home: everything reaches what is under it, as if it were not there. */
export const liveProps = {
    pointerEvents: 'auto',
    importantForAccessibility: 'auto',
    accessibilityElementsHidden: false,
} as const;

/**
 * The props of the ONE wrapper a card's inside always sits in. The wrapper must stand in both states: if Home drew the inside
 * bare and Arrange wrapped it, React would see a different element type at that spot and unmount the inside and mount it
 * again on Arrange › and on Done, so a tool's read, Find your community's lines and the photos would start over and the
 * cards below would move (the review of #2867). Only these props and the dimming change; the children never do.
 */
export const quietWrapperProps = (quiet: boolean | undefined) => (quiet ? quietProps : liveProps);
