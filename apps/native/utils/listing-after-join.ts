/**
 * Back to the listing after the join (DESIGN-list-on-global-fable.md §6 steps 4 and 7, slice G4), the phone's half: a member
 * who taps Ask to join on a copy of a listing on the global community, and sends the request, lands on that listing in its
 * own community once the community's yes has been joined, the profile step is done and Home's Bring my listings sheet has
 * nothing more to show (components/BringListingsSheet.tsx onQuiet).
 *
 *   1. kept at Send, on the community's card (app/community-card.tsx): the community and the listing's id, nothing else;
 *   2. marked at the join the yes made (joinAnotherCommunity from that card or from Find a community; on a phone that had no
 *      account, welcome's invite step joining that yes, app/welcome.tsx markYesJoined): it may open now;
 *   3. taken once, on Home in that community: its screen (app/post/[id].tsx), which says so in one line if it has gone.
 * A join by someone else's invite, or a request never answered, never marks it, and it lapses a month after the tap (core
 * LISTING_AFTER_JOIN_MS). Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage). Nothing of it leaves the phone.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LISTING_AFTER_JOIN_WORDS, listingAfterJoinHost, listingsAfterJoinOf, t, withListingAfterJoin, type ListingsAfterJoin } from '@beanpool/core';
import { LISTING_AFTER_JOIN_STORE_KEY } from './storage-keys';
import { postRoute, type PostStore } from './post-after-join';

/** The post screen's own mark that it was opened for the listing a member came for: its missing view says so. */
export const CAME_FOR_PARAM = 'cameFor';

async function read(store: PostStore, now: number): Promise<ListingsAfterJoin> {
    try {
        return listingsAfterJoinOf(await store.getItem(LISTING_AFTER_JOIN_STORE_KEY), now);
    } catch {
        return {};
    }
}

async function write(store: PostStore, held: ListingsAfterJoin): Promise<void> {
    try {
        if (Object.keys(held).length) await store.setItem(LISTING_AFTER_JOIN_STORE_KEY, JSON.stringify(held));
        else await store.removeItem(LISTING_AFTER_JOIN_STORE_KEY);
    } catch { /* the member lands on Home there */ }
}

/** A request to join `community` went from a copy of `postId`: keep it until the yes is joined. Anything else keeps nothing. */
export async function keepListingAfterJoin(community: string, postId: unknown, now: number = Date.now(), store: PostStore = AsyncStorage): Promise<void> {
    const held = withListingAfterJoin(await read(store, now), community, postId, now);
    if (held) await write(store, held);
}

/** The yes from `community` has been joined: its listing may open on Home. None kept for it: nothing changes. */
export async function joinedForListing(community: string, now: number = Date.now(), store: PostStore = AsyncStorage): Promise<void> {
    const host = listingAfterJoinHost(community);
    const held = await read(store, now);
    if (!host || !held[host] || held[host].joined) return;
    held[host] = { ...held[host], joined: true };
    await write(store, held);
}

/**
 * The route of the listing kept for the community the phone is on, taken out: once, and only after its yes was joined.
 * Null with none, before the join, or for another community (those stay until their own join, or they lapse). With no
 * community to compare (not heard yet) nothing is read and nothing is lost.
 */
export async function takeListingAfterJoin(community: string | null, now: number = Date.now(), store: PostStore = AsyncStorage): Promise<string | null> {
    const host = listingAfterJoinHost(community);
    if (!host) return null;
    const held = await read(store, now);
    const kept = held[host];
    if (!kept?.joined) {
        // A slot that held only lapsed or malformed entries is cleared as it is read.
        if (!kept) await write(store, held);
        return null;
    }
    delete held[host];
    await write(store, held);
    const route = postRoute(kept.id);
    return route ? `${route}?${CAME_FOR_PARAM}=1` : null;
}

/** Whether the post screen was opened for the listing a member came for (its route's {@link CAME_FOR_PARAM}). */
export function openedForListing(param: unknown): boolean {
    return (Array.isArray(param) ? param[0] : param) === '1';
}

/** The post screen's line where its listing can't be found: for a member who came for it, that it is no longer up. */
export function missingListingLine(cameFor: boolean): string {
    return cameFor ? t(LISTING_AFTER_JOIN_WORDS.gone) : t('Post not found. It may have been expired by the Network.');
}
