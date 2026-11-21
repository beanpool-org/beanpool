/**
 * The join's step bar: one dot per screen the member will actually see on this phone, no words
 * (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §3.1, slice S3; Marty, 21 Nov: "a standard people are used to
 * rather than a long page"). The front door, Your invite and the ways back have no dot: they are not steps of a join.
 *
 * - An invite: Your name (the global door's own screen stands in for it: it chooses the name), Your photo, the way back.
 * - The global door or another community's open door: the same three.
 * - A claim: Your photo and the way back (the claim screen is its own; the owner's card after them has no dot).
 *
 * Kept as a list, not a count, so a later step adds itself in one place: the notifications screen (slice N1j of
 * DESIGN-notify-and-backup-asks-fable-amend2.md §12) goes after the way back on phones that must ask, as the fourth dot.
 */
import type { OnboardingFlow } from './onboarding-state';

export type JoinStep = 'name' | 'photo' | 'wayBack';

export function joinSteps(flow: OnboardingFlow): JoinStep[] {
    return flow === 'claim' ? ['photo', 'wayBack'] : ['name', 'photo', 'wayBack'];
}

/**
 * Where a screen sits in its join's bar: `{ at, of }`, 1-based. Null when the screen is not one of this join's steps, or when
 * the join has a single step (one dot says nothing): no bar is drawn then.
 */
export function stepDot(steps: readonly JoinStep[], step: JoinStep): { at: number; of: number } | null {
    const i = steps.indexOf(step);
    if (i < 0 || steps.length < 2) return null;
    return { at: i + 1, of: steps.length };
}
