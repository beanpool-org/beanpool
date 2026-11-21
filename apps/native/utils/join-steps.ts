/**
 * The join's step bar: one dot per screen the member will actually see on this phone, no words
 * (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §3.1, slice S3; Marty, 21 Nov: "a standard people are used to
 * rather than a long page"). The front door, Your invite and the ways back have no dot: they are not steps of a join.
 *
 * - An invite: Your name (the global door's own screen stands in for it: it chooses the name), Your photo, the way back.
 * - The global door or another community's open door: the same three.
 * - A claim: Your photo and the way back (the claim screen is its own; the owner's card after them has no dot).
 * - The way back is left out where it is skipped ({@link wayBackSkipped}, slice S4): a sign-in already keeps a copy, or the
 *   member already said the words are kept. Then the join is two dots.
 *
 * Kept as a list, not a count, so a later step adds itself in one place: the notifications screen (slice N1j of
 * DESIGN-notify-and-backup-asks-fable-amend2.md §12) goes after the way back on phones that must ask, as the fourth dot,
 * and {@link afterWayBack} names it as the way back's next screen.
 */
import type { OnboardingFlow } from './onboarding-state';

export type JoinStep = 'name' | 'photo' | 'wayBack';

export function joinSteps(flow: OnboardingFlow, opts: { wayBack?: boolean } = {}): JoinStep[] {
    const steps: JoinStep[] = flow === 'claim' ? ['photo', 'wayBack'] : ['name', 'photo', 'wayBack'];
    return opts.wayBack === false ? steps.filter((s) => s !== 'wayBack') : steps;
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

/**
 * The way back is kept (slice S4, design §3.1 E): what turns its button from "Later" into "Let's go", and what puts Home's
 * "Your way back in" card away at the end of the join. Only what is true counts:
 * - `signIn`: a sign-in's copy is kept (`protectionFrom(enrolment).state === 'covered'`). A sign-in added with no copy (the
 *   copy failed, or the community keeps none) is not a way back, and does not count;
 * - `wordsTicked`: the member's own "I've saved these words", or Yes after the recovery kit, on this screen;
 * - `before`: what the phone already knew of this account (utils/way-back-kept.ts): a copy at the key vault, a sign-in the
 *   community says was added, or the words noted as written down.
 */
export function wayBackKept(k: { signIn: boolean; wordsTicked: boolean; before: boolean }): boolean {
    return k.signIn || k.wordsTicked || k.before;
}

/**
 * Whether the join leaves out the way-back screen (design §3.1 E, "A join that already linked a sign-in (the global door)
 * skips this screen: there is nothing to ask"): a way back is already kept when the photo step ends. Never for a claim: the
 * owner's own way back is also the community's, so its step stays as it is (notify design §5.2).
 */
export function wayBackSkipped(flow: OnboardingFlow, keptAlready: boolean): boolean {
    return flow !== 'claim' && keptAlready;
}

/** The screen after the way back: the owner's card on a claim, else Home. N1j adds the notifications screen here. */
export type AfterWayBack = 'ownerCard' | 'home';
export function afterWayBack(flow: OnboardingFlow): AfterWayBack {
    return flow === 'claim' ? 'ownerCard' : 'home';
}

/**
 * The way back's one button: "Later" until a way back is kept (true to its word: Home's card shows from the first landing),
 * then "Next" where a screen follows, or "Let's go" into Home.
 */
export function wayBackButton(kept: boolean, next: AfterWayBack): 'later' | 'next' | 'letsGo' {
    if (!kept) return 'later';
    return next === 'home' ? 'letsGo' : 'next';
}
