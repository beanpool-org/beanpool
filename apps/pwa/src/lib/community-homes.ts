/**
 * This community on the web, as an address is weighed against it (slice S5 part 2; #3354 review rounds 4 to 6). The rule is
 * core's alone (community-homes.ts nameStanding, whoseName), the phone's too (apps/native/utils/community-homes.ts): Message
 * (lib/message-anyone.ts) and the address card (components/AddressCardPanel.tsx) ask it here whether a contact's link, a card's
 * home or the home of a chat across is one of this community's own names. The web holds one community, so there is no other
 * to tell apart; it keeps no signed list and no record of it, only its info as this page read it, which a page open for days
 * keeps too long. So a name other than the address this app is open at is the community's only by what it answers now.
 */
import { whoseName, type KnownNames, type WhoseName } from '@beanpool/core';
import { getCommunityInfo, nodeAddress, type CommunityInfo } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';

/** How long Message waits for one of the community's own answers before it goes on without it. */
const ASK_MS = 5_000;

/** What the community answers within {@link ASK_MS}; null when it doesn't, or the ask fails. */
export async function inTime<T>(ask: () => Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ASK_MS); });
    return Promise.race([Promise.resolve().then(ask).catch(() => null), late]).finally(() => clearTimeout(timer));
}

/** The community's info as this page read it (lib/visitor-lobby-gate.ts), or null when it can't be read. */
export function communityInfoKept(): Promise<CommunityInfo | null> {
    return inTime(() => communityInfoOnce());
}

/** The community's info asked now (a page may have been open for days: a switch turned off, a name taken on or lost since); null with no answer in time. */
export function communityAnswerNow(): Promise<CommunityInfo | null> {
    return inTime(() => getCommunityInfo());
}

/** This community's names, as the rule weighs them: `kept` as this page read it; `answer` asked now (left out: not asked). */
export function namesHere(kept: CommunityInfo | null, answer?: CommunityInfo | null, here: string = nodeAddress()): KnownNames[] {
    return [{ community: here, reached: here, answer, kept: { info: kept } }];
}

/** Whose name `address` is: this community's, none of its, or not known for certain. It is asked only where what this page read (`kept`) makes it one of its names. */
export async function whoseNameNow(kept: CommunityInfo | null, address: string | null | undefined, here: string = nodeAddress()): Promise<WhoseName> {
    const whose = whoseName(namesHere(kept, undefined, here))(address);
    return whose.whose === 'uncertain' ? whoseName(namesHere(kept, await communityAnswerNow(), here))(address) : whose;
}
