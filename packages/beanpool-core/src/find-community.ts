/**
 * "Find your community" on the global node's Home (the web's find card, the phone's FindCommunityBody and its find
 * screen): which of five things it says, and the words both apps say for the three about nothing nearby (rehearsal
 * 2026-10-14 B2; privacy review M3 and S5).
 *
 * - **Never "none" before the list has loaded.** The node sends `directoryFetchedAt`, null until its mirror has fetched
 *   the directory once (the first minutes after a boot, a restore or a take-over, or while the registry is down). Until
 *   then an empty list is unknown, not empty. A count it did send is still a count, so a positive one is said.
 * - **An unknown count is unknown, never 0.**
 * - **Near is {@link NEAR_COMMUNITY_KM}, 250 km**: the radius both apps already call "within reach" (`ASK_WITHIN_KM`,
 *   the ask-to-join step) and the global node's listings use (a member's set is the nearest 500 within 250 km). One
 *   meaning of "near" on every screen: a community 12,000 km away is listed with its distance, never as "nearest you".
 * - **One "none" sentence**, {@link FIND_COMMUNITY_WORDS}.noneNear, with Start a community beside it on both apps (a
 *   real control: the Start a community screen), and never "ask to be told" on the web, which has no place watches.
 */

/** "Near you", in km: see the header. */
export const NEAR_COMMUNITY_KM = 250;

/**
 * - `near`: the nearest listed community is within {@link NEAR_COMMUNITY_KM}.
 * - `far`: communities are listed, the nearest farther than that: "No community near you yet", and the far list.
 * - `none`: the directory is loaded and nothing is listed near (or at all).
 * - `no_point`: the node measured from nowhere (no area shared, no town typed); the count, when known, is said.
 * - `not_loaded`: the node hasn't fetched the directory yet; nothing about "none" may be said.
 */
export type FindCommunityState = 'near' | 'far' | 'none' | 'no_point' | 'not_loaded';

/** What the node's `find` card (GET /api/global/home) says, as each app reads it. */
export interface FindCommunityFacts {
    /** Nearest first, as the node sends them; a community with no distance is not "near" anything. */
    communities: readonly { distanceKm?: number | null }[];
    /** Every community listed; null or absent when the node didn't say. */
    communityCount?: number | null;
    /** Where the node measured from; null: nowhere. */
    point?: 'request' | 'area' | null;
    /** When the node last fetched the directory; null or absent: never. */
    directoryFetchedAt?: string | null;
}

const isKm = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A count the node said, or null: anything that isn't a whole number from 0 is no count. */
export function knownCommunityCount(v: unknown): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function findCommunityState(f: FindCommunityFacts): FindCommunityState {
    const nearest = f.communities.find(c => isKm(c.distanceKm));
    if (nearest) return (nearest.distanceKm as number) <= NEAR_COMMUNITY_KM ? 'near' : 'far';
    const count = knownCommunityCount(f.communityCount);
    const measured = f.point === 'request' || f.point === 'area';
    if (!measured && count !== null && count > 0) return 'no_point';
    if (!f.directoryFetchedAt) return 'not_loaded';
    if (!measured && count === null) return 'no_point';
    return 'none';
}

/** The words both apps share. */
export const FIND_COMMUNITY_WORDS = {
    title: 'Find your community',
    /** `not_loaded` (M3): what is true, and nothing about none. */
    notLoaded: "The list of communities isn't available right now. Try again soon.",
    /** `none`, and the start of `far`: the one "none" sentence. */
    noneNear: 'No community near you yet.',
    /** `far`, after noneNear, over the list (each line says its distance). */
    farLead: (n: number) => (n === 1 ? 'The nearest listed is far from here:' : 'The nearest listed are far from here:'),
    /** The control beside `none` and `far`: it opens the Start a community screen. */
    start: 'Start a community',
} as const;
