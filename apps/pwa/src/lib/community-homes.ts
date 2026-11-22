/**
 * This community on the web, by any of its addresses (#3354 review round 4; core community-homes.ts): the one rule by which
 * Message (lib/message-anyone.ts) and the address card (components/AddressCardPanel.tsx) tell whether a contact's link, a
 * card's home or the home of a chat across names the community this web app talks to: the address it is open at, and every
 * one the community says is its own (its info's `addresses`, `primaryAddress` and `formerAddresses`: names it had before,
 * never one it lost, which is another community's now). The phone's is apps/native/utils/community-homes.ts. The web holds
 * one community, so there is no other to tell apart; and it is served by the community it talks to, so the list is from a
 * server that leaves a lost name out.
 */
import { communityNamed, formerHomesOf, homesOfCommunity } from '@beanpool/core';
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

/**
 * The community's info asked now, as a chat across is made (a page may have been open for days: a switch turned off, or an
 * address taken on since, never makes a chat whose every line the community refuses); with no answer, as this page read it.
 */
export async function communityInfoNow(): Promise<CommunityInfo | null> {
    return (await inTime(() => getCommunityInfo())) ?? communityInfoKept();
}

/** Whether an address names the community at `here` (this one), by any of its addresses as `info` says them: its address, or null. */
export function namedHere(info: CommunityInfo | null, here: string = nodeAddress()): (address: string | null | undefined) => string | null {
    return communityNamed([{ community: here, says: homesOfCommunity(here, info), before: formerHomesOf(here, info) }]);
}
