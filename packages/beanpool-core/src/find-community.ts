/**
 * "Find your community" on the global node's Home (the web's find card, the phone's FindCommunityBody and its find
 * screen): which of five things it says, and the words both apps say for the three about nothing nearby (rehearsal
 * 2026-10-14 B2; privacy review M3 and S5).
 *
 * - **Never "none" before the list has loaded.** The node sends `directoryFetchedAt`, null until its mirror has fetched
 *   the directory once (the first minutes after a boot, a restore or a take-over, or while the registry is down). Until
 *   then an empty list is unknown, not empty. A count it did send is still a count, so a positive one is said.
 * - **An unknown count is unknown, never 0.**
 * - **Near is {@link NEAR_COMMUNITY_KM}, 250 km**: the radius both apps call "within reach" (the ask-to-join step reads
 *   this constant) and the global node's listings use (a member's set is the nearest 500 within 250 km). One meaning of
 *   "near" on every screen: a community 12,000 km away is listed with its distance, never as "nearest you", and never
 *   counted as "more nearby" ({@link communitiesNear}).
 * - **One "none" sentence**, {@link FIND_COMMUNITY_WORDS}.noneNear, with Start a community beside it on both apps (a
 *   real control: the Start a community screen), and "Tell me when one starts here" (a place watch) on both.
 */

import { t, tn, word } from './words.js';

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

/** Whether a distance is "near": a number of km from 0 to {@link NEAR_COMMUNITY_KM}. No distance is near nothing. */
export function isNearKm(km: unknown): boolean {
    return isKm(km) && km <= NEAR_COMMUNITY_KM;
}

/**
 * The communities within {@link NEAR_COMMUNITY_KM}, in the order given: the only ones a screen may count or name as
 * "nearest you" or "nearby" (deciding review of #1935, finding 2: "Lismore is 12 km away, and 1 more nearby" counted
 * Byron at 12,525 km).
 */
export function communitiesNear<T extends { distanceKm?: number | null }>(communities: readonly T[]): T[] {
    return communities.filter(c => isNearKm(c.distanceKm));
}

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

/** The words both apps share: each is a word() key, shown through t() (farLead and farLine translate themselves). */
export const FIND_COMMUNITY_WORDS = {
    title: word('Find your community'),
    /** `not_loaded` (M3): what is true, and nothing about none. */
    notLoaded: word("The list of communities isn't available right now. Try again soon."),
    /** `none`, and the start of `far`: the one "none" sentence. */
    noneNear: word('No community near you yet.'),
    /** `far`, after noneNear, over the list (each line says its distance). */
    farLead: (n: number) => tn(n, 'The nearest listed is far from here:', 'The nearest listed are far from here:'),
    /**
     * `far`, the whole line over the list: noneNear then farLead, both in the member's language (deciding review of
     * #2152: an English noneNear before a translated lead). The joiner is a sentence of its own: zh and ja put no space
     * between sentences.
     */
    farLine: (n: number): string => t('{none} {lead}', { none: t(FIND_COMMUNITY_WORDS.noneNear), lead: FIND_COMMUNITY_WORDS.farLead(n) }),
    /** The control beside `none` and `far`: it opens the Start a community screen. */
    start: word('Start a community'),
    /**
     * Under a listed community's name when its last push to the directory is more than {@link NOT_ANSWERING_AFTER_HOURS}
     * ago (front doors S13): it is still listed, and asking to join still works (the knock waits until it answers).
     */
    notAnswering: word('Not answering lately'),
    /** The honest waiting card (Lounge L1, entry S1): measured response lines from the directory. */
    answersWeek: word('Usually answers within a week'),
    answersSlow: word("Hasn't answered requests lately"),
    answersNone: word('Not taking requests right now'),
    /** Honest waiting card status and cancellation words. */
    requestArrived: word('Your request arrived.'),
    cancelRequest: word('Cancel my request'),
    cancelling: word('Cancelling…'),
    keepIt: word('Keep it'),
    cancelConfirmBody: word('You can ask again after 24 hours.'),
    cancelConfirmText: word('Cancel your request to join {name}? You can ask again after 24 hours.'),
} as const;

/**
 * Entry S1's measured line for how promptly a community answers requests to join (from directory push answers).
 * Returns the line in the member's language, or null when not measured or fewer than 3 knocks seen.
 */
export function communityAnswersLine(answers?: 'week' | 'slow' | 'none' | null): string | null {
    switch (answers) {
        case 'week': return t(FIND_COMMUNITY_WORDS.answersWeek);
        case 'slow': return t(FIND_COMMUNITY_WORDS.answersSlow);
        case 'none': return t(FIND_COMMUNITY_WORDS.answersNone);
        default: return null;
    }
}

/**
 * How long after a community's last push to the directory a row says "Not answering lately" (design §2.3): a node pushes
 * every 12 hours by default, so 36 hours is three missed pushes. The directory stops showing a row after 7 days.
 */
export const NOT_ANSWERING_AFTER_HOURS = 36;

/**
 * Whether a listed community has not pushed for more than {@link NOT_ANSWERING_AFTER_HOURS} (its `lastSeenAt`, an ISO
 * time, as global's /api/global/communities sends it). Unknown (absent, not a time, or in the future) is never "not
 * answering": the line is only said when the directory says so.
 */
export function notAnsweringLately(lastSeenAt: unknown, now: number = Date.now()): boolean {
    if (typeof lastSeenAt !== 'string' || lastSeenAt.length > 64) return false;
    const t = Date.parse(lastSeenAt);
    return Number.isFinite(t) && now - t > NOT_ANSWERING_AFTER_HOURS * 3_600_000;
}

/** The node's code when a member already watches as many places as it allows (409, with its `limit`). */
export const PLACE_WATCH_LIMIT_CODE = 'watch_limit';

/**
 * "Tell me when one starts here" refused because the member already watches `limit` places (the node's PLACE_WATCHES_MAX,
 * 3 unless its operator set another): what both apps say, in the member's language.
 */
export function placeWatchLimitLine(limit: number): string {
    return tn(limit, 'You can watch up to {n} place. Remove it to watch another.', 'You can watch up to {n} places. Remove one to watch another.');
}
