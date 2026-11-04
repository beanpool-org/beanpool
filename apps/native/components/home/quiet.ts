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
