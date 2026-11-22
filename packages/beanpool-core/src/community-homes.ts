/**
 * One community, all its addresses (slice S5 part 2, #3354 review round 4): whether an address (a contact's link, an address
 * card's home, the home a chat across is kept with) names a community the app is in. One rule for both apps and for every
 * test of "the same community" around a chat across: Message's path (message-path.ts), and the address card's "is in this
 * community: write to them here".
 *
 * A server answers as every one of its names (apps/server engine/node-key.ts isOwnNodeHome): its main address, the main
 * address it had before, a custom domain, a former BeanPool name. It refuses a line across to any of them for good ("That
 * person is in this community: write to them here."). So one spelling is never enough: a contact saved at an older address,
 * or at another of its names, is here. Not a name it LOST (round 5): that is another community's now, its server answers as
 * it no more, and someone there would never see a chat made here. Compared as homes (address-list.ts addressOf): the host,
 * and the port when not 443.
 */
import { addressOf } from './address-list.js';
import { audienceOf } from './request-signing.js';

/** What a community says of its own addresses (GET /api/community/info): hosts, as own-addresses.ts publishes them. */
export interface SaidAddresses {
    addresses?: unknown;
    primaryAddress?: unknown;
    /** Names it had before: still its own (its server still answers as them), never published as where it lives, never a lost one. */
    formerAddresses?: unknown;
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Each of `names` as a home: a name said with no port is on the port the app reaches that host at, as the app names its own home (outside-mail.ts myHome), else 443. */
function homesSaid(at: string, names: readonly unknown[]): string[] {
    const reached = addressOf(at);
    const homes = names.map((a) => (typeof a === 'string' ? addressOf(a) : null)).filter((a): a is string => a !== null);
    return homes.map((home) => (reached && audienceOf(home) === audienceOf(reached) ? reached : home));
}

/** The homes the community reached at `at` goes by now: that address, and every one it says is its own today ({@link formerHomesOf}: those before). */
export function homesOfCommunity(at: string, said: SaidAddresses | null | undefined): string[] {
    const reached = addressOf(at);
    return [...new Set([...(reached ? [reached] : []), ...homesSaid(at, [...listOf(said?.addresses), said?.primaryAddress])])];
}

/** The homes the community reached at `at` says it had before: its own still, as long as no other community goes by one now. */
export function formerHomesOf(at: string, said: SaidAddresses | null | undefined): string[] {
    return [...new Set(homesSaid(at, listOf(said?.formerAddresses)))];
}

/**
 * Whether a community says it knows no address of its own now (none published, or none it is reached at: `primaryAddress`
 * null). Its server then signs nothing to another (apps/server engine/node-key.ts ownNodeHome: every send answers 503
 * `no_home`), so it takes no messages across whatever its switch says. Not said, or not read: not known, false.
 */
export function saysNoHome(said: SaidAddresses | null | undefined): boolean {
    return Array.isArray(said?.addresses) && (said.addresses.length === 0 || said.primaryAddress === null);
}

/** A community the app is in, as {@link communityNamed} weighs an address against it. */
export interface NamedCommunity {
    /** The address the app keeps it under: what {@link communityNamed} answers with. */
    community: string;
    /** Other addresses the device itself knows as this community's (the phone's record: where it met it, uses it, proved it). */
    known?: readonly string[];
    /** The homes it says are its own now ({@link homesOfCommunity}, and the phone's signed list of them). */
    says?: readonly string[];
    /** The homes it says it had before ({@link formerHomesOf}). A server from before #3354 lists a name it lost among them. */
    before?: readonly string[];
    /** Addresses that answered the phone as something else (the record's `refused`): never this community's, whoever says so. */
    refused?: readonly string[];
}

/**
 * Which of `communities` an address names (a URL, a host, a home), or null for none of them. An address the app keeps one
 * under, then one the device knows as its own, then one it says is its own now, then one it says it had before, in the order
 * given: what a community says of itself never takes an address the device knows to be another's, and a name one had
 * before is never taken from the one that goes by it now (a name it lost: what is written to it there is for someone in the
 * other community, and a chat in this one would reach no one).
 */
export function communityNamed(communities: readonly NamedCommunity[]): (address: string | null | undefined) => string | null {
    const homes = (list: readonly string[] | undefined) => new Set((list ?? []).map((a) => addressOf(a)).filter((a): a is string => a !== null));
    const read = communities.map((c) => ({
        community: c.community, own: homes([c.community]), known: homes(c.known), says: homes(c.says), before: homes(c.before), refused: homes(c.refused),
    }));
    return (address) => {
        const home = typeof address === 'string' ? addressOf(address) : null;
        if (!home) return null;
        const found = read.find((c) => c.own.has(home)) ?? read.find((c) => c.known.has(home))
            ?? read.find((c) => c.says.has(home) && !c.refused.has(home)) ?? read.find((c) => c.before.has(home) && !c.refused.has(home));
        return found?.community ?? null;
    };
}
