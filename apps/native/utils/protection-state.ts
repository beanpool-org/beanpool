/**
 * Which of step 3's three states a member is actually in.
 *
 * The screen this feeds is the one place a new member is told how they get back into their
 * account, so the rule it follows is narrow and worth stating: **it never claims a keeper the
 * member does not have.** Revision 3's first draft of that screen said "you're still covered by
 * 3" unconditionally, which was false for every PWA user — told, precisely, to the people who
 * most needed the truth.
 *
 * Kept apart from the component because it is a decision, not a rendering. Inside a screen it
 * would only be checkable by running one, and the failure it guards against — a wrong state
 * shown to a frightened person — is not a visual bug.
 *
 * ## Why "available" and "enrolled" are different numbers
 *
 * Below the threshold, enrolment writes nothing: two holders cannot hold a 3-of-N split, and
 * `splitRecoveryPhrase` refuses to produce one. So a member who came within one keeper has an
 * EMPTY enrolled list, exactly like a member who had none — and they need different screens.
 * `available` is what separates them.
 *
 * The doc's own State B mock shows two keepers with ✅ ticks against them, which cannot be true
 * for this reason: nobody is holding anything yet. They read as "ready" here instead.
 */

import { RECOVERY_THRESHOLD } from '@beanpool/core';
import type { KeeperEnrolmentResult } from './keeper-enrolment';

export type ProtectionState =
    /** Covered: the split happened and enough keepers hold a piece. */
    | 'covered'
    /** One keeper short. The pieces do not exist yet, and one more starts it off. */
    | 'almost'
    /** The twelve words are genuinely the way back, said plainly. */
    | 'words-only';

export interface Protection {
    state: ProtectionState;
    /** Keepers actually holding a piece. Empty in every state but `covered`. */
    holding: string[];
    /** How many more keepers are needed before a split can happen at all. */
    stillNeeded: number;
    /** True when the twelve words should be shown expanded rather than offered behind a tap. */
    showWords: boolean;
}

/** Human-readable keeper names, for a screen that must not say "K2" to anybody. */
export const KEEPER_LABELS: Record<string, string> = {
    device: "This phone's backup",
    hub: 'Your community hub',
    member: 'The person who invited you',
    sso: 'Your sign-in account',
};

/**
 * Read an enrolment result as a screen state.
 *
 * `null` means enrolment has not finished. Treated as `words-only` rather than as a spinner
 * state on purpose: if the result never arrives — a dead node, a request that hangs — the screen
 * still has to say something true, and "here are your words" is true in every case. A member
 * must never sit in front of a screen that is waiting to find out whether they are safe.
 */
export function protectionFrom(result: KeeperEnrolmentResult | null): Protection {
    if (!result || result.enrolled.length === 0) {
        const available = result?.available ?? 0;
        const stillNeeded = Math.max(0, RECOVERY_THRESHOLD - available);

        // One short, and only one short. Two short is not "almost" in any sense a member would
        // recognise, and calling it that would be the same overclaiming in a smaller voice.
        if (available > 0 && stillNeeded === 1) {
            return { state: 'almost', holding: [], stillNeeded, showWords: true };
        }
        return { state: 'words-only', holding: [], stillNeeded, showWords: true };
    }

    if (result.enrolled.length < RECOVERY_THRESHOLD) {
        // Should be unreachable — enrolment writes nothing below the threshold — but a partial
        // enrolment reported as "covered" is the exact failure this model exists to prevent, so
        // it degrades to the honest state rather than trusting an invariant held elsewhere.
        return {
            state: 'words-only',
            holding: result.enrolled.map(k => KEEPER_LABELS[k] ?? k),
            stillNeeded: RECOVERY_THRESHOLD - result.enrolled.length,
            showWords: true,
        };
    }

    return {
        state: 'covered',
        holding: result.enrolled.map(k => KEEPER_LABELS[k] ?? k),
        stillNeeded: 0,
        // Offered behind a tap rather than hidden. The words remain the floor under all of this
        // — keepers are convenience on top and never a replacement — but a member who is
        // genuinely covered should not be met with a wall of twelve words to copy down.
        showWords: false,
    };
}
