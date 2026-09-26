/**
 * The global node's lobby in a web browser (design G9a §7, "PWA lobby (G9b)"): a visitor with no key looks at the
 * Market and the Map before joining. The node decides what a visitor gets (G9a: `guestListingsOnly`, `guestPost()`):
 * each listing without the person (no key, name, face or tier) and with the place moved to the centre of its 0.1°
 * cell. This page never asks for more, and never shows a thing a visitor could write with.
 *
 * Nobody mints a key just to look: the lobby has no identity at all. The only key made before joining is the join's
 * own (WebJoin's pending join, design G11 §4.1).
 *
 * The words and the small rules here; what decides whether the lobby is shown is lib/visitor-lobby-gate.ts.
 */

import type { CommunityInfo, MarketplacePost } from './api';

/** Under the first card of the lobby's list, once (not per card). */
export const VISITOR_LIST_NOTE = 'Names, photos of people and exact places appear when you join.';

/** Under the photo picker of a member's new post, on a node that shows visitors its listings. */
export function composerVisitorNote(profile: CommunityInfo['profile']): string {
    return `Visitors to ${profile === 'global' ? 'the global community' : 'this community'} can see this listing's photos and its rough area before they join.`;
}

/** Where a price was, on a node with Beans off: the terms are in the description (as the phone's NO_BEANS_TERMS). */
export const NO_BEANS_TERMS_TEXT = 'Free, a swap, or ask';

/** An event's place, on the visitor's detail sheet: the node sends only the rough area. */
export const PLACE_AFTER_JOIN = 'Place shown after you join';

/** Whether this node shows a visitor its listings in a lobby, from `/api/community/info` (a public read). */
export function visitorsSeeListings(info: CommunityInfo | null | undefined): boolean {
    return info?.features?.guestListingsOnly === true;
}

/** Whether the node trades in Beans: only a node that says outright it doesn't (the global profile) has none. */
export function beansOn(info: CommunityInfo | null | undefined): boolean {
    return info?.features?.beans !== false;
}

/** A listing's terms on a visitor's card: no Beans figure where there are no Beans. */
export function visitorPriceText(post: Pick<MarketplacePost, 'credits' | 'priceType'>, beans: boolean): string {
    if (!beans) return NO_BEANS_TERMS_TEXT;
    if (!post.credits) return 'Free';
    const per = ({ fixed: '', hourly: ' an hour', daily: ' a day', weekly: ' a week', monthly: ' a month' } as Record<string, string>)[post.priceType] ?? '';
    return `${post.credits} Beans${per}`;
}

/**
 * How far a listing is from the point the visitor shared, in whole km: the node places it at its cell's centre, so a
 * tenth of a km would claim a precision nobody has.
 */
export function visitorDistanceText(km: number): string {
    return `about ${Math.max(1, Math.round(km))} km`;
}

/**
 * A listing the lobby opened from a shared link (`/?post=<id>`), kept in this tab until the visitor has joined, so they
 * land on it as a member. App strips `?post=` from the address as the page loads, and a join by sign-in leaves the page
 * and comes back, so neither the address nor App's state lasts that long; this tab's sessionStorage does. One key, one
 * use, and only the post's id: nothing the visitor typed, chose or shared goes in it.
 */
export const LINKED_POST_STORAGE_KEY = 'beanpool_lobby_linked_post';

/** How long a kept listing waits for its visitor: a sign-in's round trip and the steps after it, with room to read. */
export const LINKED_POST_KEPT_MS = 60 * 60_000;

/** A post id as the node makes them (a UUID) or a client names one: no spaces, no address, nothing long. */
const POST_ID = /^[\w.:-]{1,200}$/;

/** The lobby opened `postId` from a shared link: keep it for after the join. A storage that refuses keeps nothing. */
export function keepLinkedPost(postId: string, now: number = Date.now()): void {
    if (!POST_ID.test(postId)) return;
    try {
        sessionStorage.setItem(LINKED_POST_STORAGE_KEY, JSON.stringify({ id: postId, at: now }));
    } catch { /* a private window: the member lands on the Market */ }
}

/**
 * The listing kept by the lobby, taken out: its id once, then never again. Nothing when there is none, when it was
 * kept longer ago than a join takes (or "later" than now), or when the slot holds anything but an id and a time.
 */
export function takeKeptLinkedPost(now: number = Date.now()): string | null {
    let raw: string | null;
    try {
        raw = sessionStorage.getItem(LINKED_POST_STORAGE_KEY);
        if (raw === null) return null;
        sessionStorage.removeItem(LINKED_POST_STORAGE_KEY);
    } catch {
        return null;
    }
    try {
        const kept = JSON.parse(raw) as unknown;
        if (!kept || typeof kept !== 'object') return null;
        const { id, at } = kept as { id?: unknown; at?: unknown };
        if (typeof id !== 'string' || !POST_ID.test(id) || typeof at !== 'number' || !Number.isFinite(at)) return null;
        if (at > now || now - at > LINKED_POST_KEPT_MS) return null;
        return id;
    } catch {
        return null;
    }
}
