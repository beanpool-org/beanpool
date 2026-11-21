/**
 * The join's step bar, for the phone and the web alike: one dot per screen this join will actually show, no words
 * (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §3.1 and §5; Marty, 21 Nov 2026: "a standard people are
 * used to rather than a long page"). The front door, Your invite and the ways back have no dot: they are not steps of a
 * join.
 *
 * - `name`: Your name (an open door's own screen stands in for it: it chooses the name). Off for a claim, whose claim
 *   screen is its own.
 * - `photo`: Your photo, always.
 * - `area`: Your area, on the web only where the community syncs listings by area (the phone has no such step).
 * - `wayBack`: the way back. Off for an account that came back with its 12 words, which has nothing to keep.
 * - `notify`: the notifications screen (slice N1j of DESIGN-notify-and-backup-asks-fable-amend2.md §4, §12.3), last, after
 *   the way back, only where it shows (core's `notifyJoinStep`: a phone that must ask and still can). Off by default: the
 *   web has no such step yet (N5a).
 *
 * Kept as a list, not a count, so a later step adds itself in one place.
 */
export type JoinStep = 'name' | 'photo' | 'area' | 'wayBack' | 'notify';

export function joinStepList({ name = true, area = false, wayBack = true, notify = false }: { name?: boolean; area?: boolean; wayBack?: boolean; notify?: boolean } = {}): JoinStep[] {
    const steps: JoinStep[] = [];
    if (name) steps.push('name');
    steps.push('photo');
    if (area) steps.push('area');
    if (wayBack) steps.push('wayBack');
    if (notify) steps.push('notify');
    return steps;
}

/**
 * Where a screen sits in its join's bar: `{ at, of }`, 1-based. Null when the screen is not one of this join's steps, or when
 * the join has a single step (one dot says nothing): no dots are drawn then.
 */
export function stepDot(steps: readonly JoinStep[], step: JoinStep): { at: number; of: number } | null {
    const i = steps.indexOf(step);
    if (i < 0 || steps.length < 2) return null;
    return { at: i + 1, of: steps.length };
}
