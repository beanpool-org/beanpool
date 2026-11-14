/**
 * Back to the listing after the join (DESIGN-list-on-global-fable.md §6 steps 4 and 7, slice G4): a member who taps Ask to
 * join on a copy of a listing on the global community lands on that listing in its own community once they have joined it,
 * with its price, its place and its author. Both apps keep what they need for that in one slot of the device's own storage,
 * read and written by the rules here: per community (its host), the listing's id and when it was kept, and nothing else.
 * Nothing of it goes to any server; a slot past {@link LISTING_AFTER_JOIN_MS} is dropped unread.
 *
 * The phone (apps/native utils/listing-after-join.ts) keeps it at Ask to join, marks it at the join that the community's yes
 * made, and opens it once Home has nothing else to show. The web (apps/pwa lib/visitor-lobby.ts keepLinkedPost) keeps it at
 * the copy's door, hands it to the community's page with the account, and that page opens it once the member is in.
 */
import { askHost } from './community-card.js';
import { landingPostId } from './invite-and-share.js';
import { word } from './words.js';

/** How long a listing waits for its community's yes: a request can sit for days, and past a month it is no longer why they came. */
export const LISTING_AFTER_JOIN_MS = 30 * 24 * 60 * 60_000;

/** The most communities one slot holds a listing for: the oldest goes first. */
export const LISTING_AFTER_JOIN_MOST = 20;

/** Where the listing a member came for has gone by the time they are in: the Market, and this line. */
export const LISTING_AFTER_JOIN_WORDS = {
    gone: word('The listing you came for is no longer up.'),
} as const;

/** One community's listing: its id, when it was kept, and (the phone) whether the yes that lets it open has been joined. */
export interface ListingAfterJoin {
    id: string;
    at: number;
    joined?: true;
}

/** The slot: community host → its listing. */
export type ListingsAfterJoin = Record<string, ListingAfterJoin>;

/** A community's host from its host or its address (`https://hillside.example.org/`), as the slot keys it; null for anything else. */
export function listingAfterJoinHost(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    return askHost(raw.trim().replace(/^https:\/\//i, '').replace(/\/+$/, ''));
}

/** The slot as stored, read: only well-formed entries, kept less than a month ago and never "later" than now. */
export function listingsAfterJoinOf(raw: string | null | undefined, now: number): ListingsAfterJoin {
    if (!raw) return {};
    let held: unknown;
    try {
        held = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!held || typeof held !== 'object' || Array.isArray(held)) return {};
    const out: ListingsAfterJoin = {};
    for (const [key, value] of Object.entries(held as Record<string, unknown>)) {
        const host = listingAfterJoinHost(key);
        const v = value as Partial<ListingAfterJoin> | null;
        const id = landingPostId(v?.id);
        const at = v?.at;
        if (!host || host !== key || !id || typeof at !== 'number' || !Number.isFinite(at) || at > now || now - at > LISTING_AFTER_JOIN_MS) continue;
        out[host] = { id, at, ...(v?.joined === true ? { joined: true as const } : {}) };
    }
    return out;
}

/**
 * The slot with `id` kept for `host` from `now`: a new tap starts again, unjoined. Null where the host or the id is not one,
 * so nothing is written. At most {@link LISTING_AFTER_JOIN_MOST} communities: the oldest is dropped.
 */
export function withListingAfterJoin(held: ListingsAfterJoin, host: unknown, id: unknown, now: number): ListingsAfterJoin | null {
    const h = listingAfterJoinHost(host);
    const postId = landingPostId(id);
    if (!h || !postId) return null;
    const rest = Object.entries(held).filter(([k]) => k !== h).sort((a, b) => b[1].at - a[1].at).slice(0, LISTING_AFTER_JOIN_MOST - 1);
    return { ...Object.fromEntries(rest), [h]: { id: postId, at: now } };
}
