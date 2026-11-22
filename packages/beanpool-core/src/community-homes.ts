/**
 * One community, all its addresses (slice S5 part 2, #3354 review round 4): whether an address (a contact's link, an address
 * card's home, the home a chat across is kept with) names a community the app is in. One rule for both apps and for every
 * test of "the same community" around a chat across: Message's path (message-path.ts), and the address card's "is in this
 * community: write to them here".
 *
 * A server answers as every one of its names (apps/server engine/node-key.ts isOwnNodeHome): its main address, the main
 * address it had before, a custom domain, a former BeanPool name. It refuses a line across to any of them for good ("That
 * person is in this community: write to them here."). So one spelling is never enough: a contact saved at an older address,
 * or at another of its names, is here. Compared as homes (address-list.ts addressOf): the host, and the port when not 443.
 */
import { addressOf } from './address-list.js';
import { audienceOf } from './request-signing.js';

/** What a community says of its own addresses (GET /api/community/info): hosts, as own-addresses.ts publishes them. */
export interface SaidAddresses {
    addresses?: unknown;
    primaryAddress?: unknown;
    /** Names it had before: still its own (its server still answers as them), never published as where it lives. */
    formerAddresses?: unknown;
}

/**
 * The homes of the community reached at `at`: that address, and every one it says is its own. A name said with no port is on
 * the port the app reaches that host at, as the app names its own home (outside-mail.ts myHome), else 443.
 */
export function homesOfCommunity(at: string, said: SaidAddresses | null | undefined): string[] {
    const reached = addressOf(at);
    const homes = new Set<string>(reached ? [reached] : []);
    const lists = [said?.addresses, said?.formerAddresses, [said?.primaryAddress]];
    for (const a of lists.flatMap((l) => (Array.isArray(l) ? l : []))) {
        const home = typeof a === 'string' ? addressOf(a) : null;
        if (home) homes.add(reached && audienceOf(home) === audienceOf(reached) ? reached : home);
    }
    return [...homes];
}

/** A community the app is in, as {@link communityNamed} weighs an address against it. */
export interface NamedCommunity {
    /** The address the app keeps it under: what {@link communityNamed} answers with. */
    community: string;
    /** Other addresses the device itself knows as this community's (the phone's record: where it met it, uses it, proved it). */
    known?: readonly string[];
    /** The homes it says are its own ({@link homesOfCommunity}, and the phone's signed list of them). */
    says?: readonly string[];
    /** Addresses that answered the phone as something else (the record's `refused`): never this community's, whoever says so. */
    refused?: readonly string[];
}

/**
 * Which of `communities` an address names (a URL, a host, a home), or null for none of them. An address the app keeps one
 * under, then one the device knows as its own, then one it says is its own, in the order given: what a community says of
 * itself never takes an address the device knows to be another's.
 */
export function communityNamed(communities: readonly NamedCommunity[]): (address: string | null | undefined) => string | null {
    const homes = (list: readonly string[] | undefined) => new Set((list ?? []).map((a) => addressOf(a)).filter((a): a is string => a !== null));
    const read = communities.map((c) => ({ community: c.community, own: homes([c.community]), known: homes(c.known), says: homes(c.says), refused: homes(c.refused) }));
    return (address) => {
        const home = typeof address === 'string' ? addressOf(address) : null;
        if (!home) return null;
        const found = read.find((c) => c.own.has(home)) ?? read.find((c) => c.known.has(home)) ?? read.find((c) => c.says.has(home) && !c.refused.has(home));
        return found?.community ?? null;
    };
}
