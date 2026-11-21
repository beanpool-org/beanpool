/**
 * The join's step bar on the phone: one dot per screen the member will actually see, no words. The rule is core's, shared
 * with the web (packages/beanpool-core/src/join-steps.ts): this names the phone's joins in it.
 *
 * - An invite: Your name (the global door's own screen stands in for it: it chooses the name), Your photo, the way back.
 * - The global door or another community's open door: the same three.
 * - A claim: Your photo and the way back (the claim screen is its own; the owner's card after them has no dot).
 *
 * The notifications screen (slice N1j of DESIGN-notify-and-backup-asks-fable-amend2.md §12) goes after the way back on phones
 * that must ask, as the fourth dot, added in core's list.
 */
import { joinStepList, stepDot, type JoinStep } from '@beanpool/core';
import type { OnboardingFlow } from './onboarding-state';

export { stepDot, type JoinStep };

export function joinSteps(flow: OnboardingFlow): JoinStep[] {
    return joinStepList({ name: flow !== 'claim' });
}
