/**
 * Whether the account is suspended in the community in use, as that community last said (its answer to the membership probe,
 * `standing`: utils/membership-answer.ts). The app asks it at launch, each time it comes to the front and after a join or a switch
 * (app/NodeStatusContext.tsx), so a screen that needs it asks nothing and waits for nothing: Message (utils/message-anyone.ts),
 * whose chats across that community's server would refuse.
 *
 * One answer, the last definite one, of one community for one account, in memory: with none (not asked yet, no answer, another
 * community or account since) the account is taken as a member in good standing, as everywhere an answer is missing.
 */
import type { MembershipAnswer } from './membership-answer';
import { sameCommunity } from './push-pins';

let last: { me: string; community: string; suspended: boolean } | null = null;

/** `community`, asked for `me`, answered: a definite answer alone (utils/membership-answer.ts) replaces the one before it. */
export function noteStandingHere(me: string, community: string, answer: MembershipAnswer): void {
    last = { me, community, suspended: answer.kind === 'member' && answer.suspended === true };
}

/** Whether `community` last said `me`'s account there is suspended. */
export function suspendedHere(me: string, community: string): boolean {
    return last !== null && last.suspended && last.me === me && sameCommunity(last.community, community);
}

/** Tests: as before any answer. */
export function resetStandingHereForTests(): void {
    last = null;
}
