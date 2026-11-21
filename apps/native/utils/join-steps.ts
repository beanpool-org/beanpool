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
 * - The notifications screen (slice N1j of DESIGN-notify-and-backup-asks-fable-amend2.md §4, §12.3) is the last step, after
 *   the way back, only on a phone that must ask and still can (core's `notifyJoinStep`: an iPhone, Android 13 and later;
 *   never Android 8 to 12, which allows them without asking). Then the join is four dots, the front door still none (Marty's
 *   walk, 21 Nov: five screens, four dots); a claim three. {@link afterWayBack} names it as the way back's next screen.
 */
import type { OnboardingFlow } from './onboarding-state';
import type { DoorWay } from './global-join';
import type { SignInCopies } from './vault-config';

export type JoinStep = 'name' | 'photo' | 'wayBack' | 'notify';

export function joinSteps(flow: OnboardingFlow, opts: { wayBack?: boolean; notify?: boolean } = {}): JoinStep[] {
    const steps: JoinStep[] = flow === 'claim' ? ['photo', 'wayBack'] : ['name', 'photo', 'wayBack'];
    const shown = opts.wayBack === false ? steps.filter((s) => s !== 'wayBack') : steps;
    return opts.notify ? [...shown, 'notify'] : shown;
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
 * - `before`: what the phone already knew of this account (utils/way-back-kept.ts): a copy at the key vault, or the words
 *   noted as written down. A sign-in added earlier with no copy is not one.
 */
export function wayBackKept(k: { signIn: boolean; wordsTicked: boolean; before: boolean }): boolean {
    return k.signIn || k.wordsTicked || k.before;
}

/**
 * `before` for the account the join holds: what was read ({@link wayBackKept}'s `before`, utils/way-back-kept.ts) speaks only
 * for the key it was read for. Before the join holds a key (Your name, the global door) it is the phone's own account, which
 * the join then uses (one identity per device). Nothing read yet is "not known", which shows the step.
 */
export function keptBeforeFor(read: { key: string; kept: boolean } | null, joinKey: string | null): boolean {
    return !!read?.kept && (joinKey === null || read.key === joinKey);
}

/**
 * The global door's name screen, before the join lands: whether the way chosen will keep a sign-in's copy (a sign-in, where
 * the global community's rule keeps copies). Its dots only, so they count the screens that way leads to: the skip itself is
 * decided on the photo, from the copy that landed ({@link wayBackKept}'s `signIn`). A copy that fails there shows the way back,
 * one dot more than the door drew: the safe way to be wrong (review of #3330).
 */
export function doorKeepsSignInCopy(way: DoorWay, copies: SignInCopies): boolean {
    return way !== 'words' && copies !== 'none';
}

/**
 * Whether the join leaves out the way-back screen (design §3.1 E, "A join that already linked a sign-in (the global door)
 * skips this screen: there is nothing to ask"): a way back is already kept when the photo step ends. Never for a claim: the
 * owner's own way back is also the community's, so its step stays as it is (notify design §5.2).
 */
export function wayBackSkipped(flow: OnboardingFlow, keptAlready: boolean): boolean {
    return flow !== 'claim' && keptAlready;
}

/**
 * The screen after the way back (or after the photo, where the way back is skipped): the notifications screen where it shows
 * (`notify`, core's `notifyJoinStep`), else {@link afterNotify}'s.
 */
export type AfterWayBack = 'notify' | 'ownerCard' | 'home';
export function afterWayBack(flow: OnboardingFlow, notify = false): AfterWayBack {
    return notify ? 'notify' : afterNotify(flow);
}

/** The screen after the notifications screen, whatever its answer: the owner's card on a claim (it stays last), else Home. */
export function afterNotify(flow: OnboardingFlow): 'ownerCard' | 'home' {
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
