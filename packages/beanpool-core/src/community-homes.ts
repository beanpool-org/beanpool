/**
 * Is this address one of community C's own names? (slice S5 part 2; #3354 review rounds 4 to 6.) One precedence rule for both
 * apps, for Message's path (message-path.ts) and the address card ("is in this community: write to them here"):
 * {@link nameStanding} for one community, {@link whoseName} among every community the device is in. Nothing else decides it.
 *
 * Why it matters: a contact's link, a card's home and the home a chat across is kept with are addresses, and a community has
 * several and loses some. A server answers as every name it has (apps/server engine/node-key.ts isOwnNodeHome) and refuses a
 * line across to any of them for good, so someone at another of its names is here. A name it LOST is another community's now:
 * a direct chat with someone there would be kept here, read as sent, and reach no one. So a name is never own on a guess.
 *
 * The precedence, first to last:
 *
 * 0. The address the device reaches C at now is C's: whatever is written in C goes to that very address.
 * 1. C's answer, asked now, outranks every kept copy. One that names its addresses and doesn't list this one: NOT own (lost,
 *    another's, or never its own), whatever any copy says. A list that is there and empty is such an answer; only one with no
 *    list says nothing of its names, and is no answer here.
 * 2. C's answer, asked now, that lists it, as a name it goes by or one it had before (a lost one is in neither): own. Unless
 *    the address answered the device as something else: two proofs that disagree are doubt.
 * 3. No answer: the copies the device keeps (C's signed list, the device's record of it, C's last info) make it own only
 *    where they AGREE: the list and the record both hold it, and the info, where kept, does too. Any of them alone, or one
 *    that differs: UNCERTAIN. None holds it: not own.
 * 4. Two communities on the device claiming one name: UNCERTAIN, whoever answered.
 *
 * UNCERTAIN opens nothing: no direct chat and no chat across (message-path.ts `switch`). Compared as homes (address-list.ts
 * addressOf): the host, and the port when not 443.
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

/** What the device knows of one community's names ({@link nameStanding}). */
export interface KnownNames {
    /** The address the app keeps it under: what {@link whoseName} answers with. */
    community: string;
    /** The address the app reaches it at now (the phone's record: the one in use; the web: its own). */
    reached: string;
    /** Its info asked now. Null: asked, and no answer in time. Left out: not asked yet, so a name a copy holds is uncertain. */
    answer?: SaidAddresses | null;
    /** What the device keeps of it, each as old as it is (null: not kept): its last info, its signed list's addresses, the addresses the device's own record of it holds. */
    kept: { info?: SaidAddresses | null; list?: readonly string[] | null; record?: readonly string[] | null };
    /** Addresses that answered the device as something else (the record's `refused`). */
    refused?: readonly string[];
}

/** Whether an address is one of a community's own names. */
export type NameStanding = 'own' | 'not' | 'uncertain';

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const homeOf = (address: unknown): string | null => (typeof address === 'string' ? addressOf(address) : null);
const homesOf = (list: readonly unknown[]): string[] => list.map(homeOf).filter((a): a is string => a !== null);

/** Whether `said` says anything of its names: a list that is there, an empty one included (it then has none). */
export function saysNames(said: SaidAddresses | null | undefined): said is SaidAddresses {
    return Array.isArray(said?.addresses);
}

/**
 * The homes `said` names as its own: where it lives, every name it goes by, every one it had before and still answers as. A
 * name said with no port is on the port the app reaches that host at, as the app names its own home (outside-mail.ts myHome),
 * else 443, or the one its signed list spells for it (`listed`: the list gives only the port, the name is in what it says).
 */
function homesSaid(reached: string, said: SaidAddresses, listed: readonly string[]): Set<string> {
    const at = addressOf(reached);
    const named = homesOf([...listOf(said.addresses), said.primaryAddress, ...listOf(said.formerAddresses)]);
    const hosts = new Set(named.map((home) => audienceOf(home)));
    return new Set([
        ...named.map((home) => (at && audienceOf(home) === audienceOf(at) ? at : home)),
        ...homesOf(listed).filter((home) => hosts.has(audienceOf(home))),
    ]);
}

/** The homes each copy the device keeps holds (null: not kept, or it says nothing of its names). */
function keptHomes({ reached, kept }: KnownNames): { info: Set<string> | null; list: Set<string> | null; record: Set<string> | null } {
    return {
        info: saysNames(kept.info) ? homesSaid(reached, kept.info, kept.list ?? []) : null,
        list: kept.list ? new Set(homesOf(kept.list)) : null,
        record: kept.record ? new Set(homesOf(kept.record)) : null,
    };
}

/** Whether any copy the device keeps of a community holds `address` as a name of it. */
export function keptClaims(names: KnownNames, address: string | null | undefined): boolean {
    const home = homeOf(address);
    return home !== null && Object.values(keptHomes(names)).some((copy) => copy?.has(home));
}

/** Whether `address` (a URL, a host, a home) is one of the community's own names: the precedence rule above, for one community. */
export function nameStanding(names: KnownNames, address: string | null | undefined): NameStanding {
    const home = homeOf(address);
    if (!home) return 'not';
    if (home === addressOf(names.reached)) return 'own';
    const answeredElse = homesOf(names.refused ?? []).includes(home);
    if (saysNames(names.answer)) {
        if (!homesSaid(names.reached, names.answer, names.kept.list ?? []).has(home)) return 'not';
        return answeredElse ? 'uncertain' : 'own';
    }
    if (!keptClaims(names, home)) return 'not';
    if (names.answer === undefined || answeredElse) return 'uncertain';
    const { info, list, record } = keptHomes(names);
    return list?.has(home) && record?.has(home) && (info === null || info.has(home)) ? 'own' : 'uncertain';
}

/** Whose name an address is, among the communities the device is in. */
export type WhoseName = { whose: 'one'; community: string } | { whose: 'none' } | { whose: 'uncertain' };

/**
 * Which of `communities` an address is a name of: the one reached at it; else the only one whose own name it is; none of
 * them; or not known for certain (one that may be its, or two that claim it).
 */
export function whoseName(communities: readonly KnownNames[]): (address: string | null | undefined) => WhoseName {
    return (address) => {
        const home = homeOf(address);
        const reached = home ? communities.find((c) => addressOf(c.reached) === home) : undefined;
        if (reached) return { whose: 'one', community: reached.community };
        const claims = communities.map((c) => ({ community: c.community, standing: nameStanding(c, address) })).filter((c) => c.standing !== 'not');
        if (claims.length === 0) return { whose: 'none' };
        return claims.length === 1 && claims[0].standing === 'own' ? { whose: 'one', community: claims[0].community } : { whose: 'uncertain' };
    };
}

/**
 * Whether a community says it knows no address of its own now (none published, or none it is reached at: `primaryAddress`
 * null). Its server then signs nothing to another (apps/server engine/node-key.ts ownNodeHome: every send answers 503
 * `no_home`), so it takes no messages across whatever its switch says. Not said, or not read: not known, false.
 */
export function saysNoHome(said: SaidAddresses | null | undefined): boolean {
    return Array.isArray(said?.addresses) && (said.addresses.length === 0 || said.primaryAddress === null);
}
