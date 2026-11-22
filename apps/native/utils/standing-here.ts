/**
 * Whether the account is suspended in a community, as that community last said (its answer to the membership probe,
 * `standing`: utils/membership-answer.ts). Two asks note it: the app's own, of the community in use (app/NodeStatusContext.tsx:
 * at launch, each time the app comes to the front, and where a screen asks again, as a join or a tapped notice does), and
 * Message's, of each community it weighs (utils/message-anyone.ts standingNow). An ordinary switch (the BeanPool sheet's row,
 * Contacts, Find, Settings) asks nothing, so Message never goes by the note alone: it asks at the tap, and the note is what it
 * takes where there is no answer.
 *
 * In memory, one note for each community and account: its last definite answer. So an answer that comes late, when the phone
 * has moved on, changes its own community's note and no other's. With none (not asked yet, no answer, another account) the
 * account is taken as a member in good standing, as everywhere an answer is missing.
 */
import type { MembershipAnswer } from './membership-answer';
import { sameCommunity } from './push-pins';

interface Note { me: string; community: string; suspended: boolean }
let notes: readonly Note[] = [];

/** Whether a note is what `community` said about `me`, however its address is spelled. */
const isOf = (me: string, community: string) => (n: Note): boolean => n.me === me && sameCommunity(n.community, community);

/** `community`, asked for `me`, answered: a definite answer alone (utils/membership-answer.ts) replaces the one before it there. */
export function noteStandingHere(me: string, community: string, answer: MembershipAnswer): void {
    const its = isOf(me, community);
    notes = [...notes.filter((n) => !its(n)), { me, community, suspended: answer.kind === 'member' && answer.suspended === true }];
}

/** Whether `community` last said `me`'s account there is suspended. */
export function suspendedHere(me: string, community: string): boolean {
    return notes.find(isOf(me, community))?.suspended === true;
}

/** Tests: as before any answer. */
export function resetStandingHereForTests(): void {
    notes = [];
}
