/**
 * The Market on a node with Beans off: the worldwide community (design §1, D6: "no Beans field at all on the global
 * node: posts say Free / Swap / Ask"). Local communities are unchanged: every rule here keys on the node saying
 * outright that Beans are off (`features.beans === false`), and a node that says nothing trades in Beans.
 *
 * What the server does (G1, apps/server/src/config/node-profile.ts): a post there is stored at 0 Beans, a post with
 * a Beans price is refused ("say in the description what you'd like in return, or that it's free"), and there is
 * no separate field for the terms. So a post's terms live in its description, and the Market shows no price at
 * all: no Beans figure, no "Beans only" filter. Where a price used to be on a post's own page, the member reads that
 * it's free, a swap, or to ask.
 *
 * Nearest first (design §3.2, §4.2 `distanceSearch`): on a node that sorts by distance, the feed and the Market's
 * search are ordered from where the member is, when the phone already knows (the feed never asks for location).
 */

import { beansOn, type NodeFeatures, type NodeProfile } from './node-profile';
import type { MarketExtraFilter } from './market-filters';
import { feedSections, type FeedSection } from './feed-sections';

/** Whether the Market shows Beans: a price on each card and the "Beans only" filter. */
export function marketShowsBeans(features: NodeFeatures | null | undefined): boolean {
    return beansOn(features);
}

/** The second row's filters, without "Beans only" where there are no Beans. */
export function marketExtras(extras: readonly MarketExtraFilter[], features: NodeFeatures | null | undefined): MarketExtraFilter[] {
    return marketShowsBeans(features) ? [...extras] : extras.filter(e => e !== 'beans');
}

/** Where a price was, on a post's own page, on a node with Beans off. */
export const NO_BEANS_TERMS = {
    label: 'IN RETURN',
    value: 'Free, a swap, or ask',
    note: 'There are no Beans here. The description says what they would like in return, or that it is free. Message them to ask.',
} as const;

/** What a post's edit form, and the map's Offer/Need form, say in place of the price field, on a node with Beans off. */
export const NO_BEANS_EDIT_NOTE = 'No price here: say in the description what you would like in return, or that it is free.';

/*
 * The map's Offer/Need form (app/(tabs)/map.tsx). With Beans off it has no price section, and the price never holds
 * a post back: whatever the field holds (a draft saved with a price, an offer picked from the Community Pricing
 * Guide), the post goes up at 0 Beans and a total price, which is all the server takes there. With Beans on, or on a
 * node that says nothing, each of these is exactly what the form did before.
 */

/** The Beans the post goes up at. */
export function postFormCredits(field: string, features: NodeFeatures | null | undefined): number {
    return marketShowsBeans(features) ? Number(field) || 0 : 0;
}

/** Total, per hour, per day...: only where there is a price. */
export function postFormPriceType(priceType: string, features: NodeFeatures | null | undefined): string {
    return marketShowsBeans(features) ? priceType : 'fixed';
}

/** The price field is empty: the button asks for a price and stays grey. */
export function postFormPriceMissing(field: string, features: NodeFeatures | null | undefined): boolean {
    return marketShowsBeans(features) && field === '';
}

/** Tapping Post marks the price field: empty, or not a number. */
export function postFormPriceInvalid(field: string, features: NodeFeatures | null | undefined): boolean {
    return marketShowsBeans(features) && (field.trim() === '' || isNaN(Number(field)));
}

export interface PostFormState {
    posting: boolean;
    needBlocked: boolean;
    postType: 'offer' | 'need';
    category: string;
    hasLocation: boolean;
    photoCount: number;
    credits: string;
    title: string;
    description: string;
}

/** The submit button's words: the next thing missing, or Post Offer / Post Need. */
export function postFormSubmitLabel(s: PostFormState, features: NodeFeatures | null | undefined): string {
    return s.posting ? 'Posting...'
        : s.needBlocked ? '🟢 List an Offer first to post Needs'
        : (!s.category) ? '📂 Select a category'
        : (!s.hasLocation) ? '📍 Set a location'
        : (s.photoCount < 1) ? '📷 Add a photo'
        : postFormPriceMissing(s.credits, features) ? '💰 Set a price'
        : (!s.title.trim() || !s.description.trim()) ? '✏️ Fill required fields'
        : `Post ${s.postType === 'offer' ? 'Offer' : 'Need'}`;
}

/** Whether this node orders its listings from where the member is. */
export function sortsByDistance(profile: NodeProfile | null | undefined): boolean {
    return profile?.features.distanceSearch === true;
}

export interface Point { lat: number; lng: number }

/** The Market search's distance parameters (G4, routes/distance-query.ts): a point and `sort=distance`, or none. */
export function marketSearchDistanceParams(profile: NodeProfile | null | undefined, point: Point | null): string {
    if (!sortsByDistance(profile) || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return '';
    return `&lat=${point.lat.toFixed(4)}&lng=${point.lng.toFixed(4)}&sort=distance`;
}

const toRad = (d: number) => (d * Math.PI) / 180;

function km(a: Point, b: Point): number {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function placeOf(p: Record<string, any>): Point | null {
    const lat = typeof p.lat === 'number' ? p.lat : Number(p.lat);
    const lng = typeof p.lng === 'number' ? p.lng : Number(p.lng);
    if (p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
}

/** Nearest first from `from`; posts with no place keep their order, after those with one. */
export function nearestFirst<T extends Record<string, any>>(posts: readonly T[], from: Point): T[] {
    const placed: Array<{ p: T; d: number; i: number }> = [];
    const unplaced: T[] = [];
    posts.forEach((p, i) => {
        const at = placeOf(p);
        if (at) placed.push({ p, d: km(from, at), i });
        else unplaced.push(p);
    });
    placed.sort((a, b) => a.d - b.d || a.i - b.i);
    return [...placed.map(x => x.p), ...unplaced];
}

export const NEAREST_FIRST_HEADING = 'Nearest first';

/**
 * The list view's sections on a node that sorts by distance, from where the member is: events under their own
 * heading as everywhere (soonest first), then every listing nearest first under one heading, instead of by the day
 * it was posted. Without a point, or on a node that doesn't sort by distance, the feed keeps its day headings.
 */
export function marketFeedSections<T extends Record<string, any>>(
    posts: T[], profile: NodeProfile | null | undefined, point: Point | null, nowMs: number = Date.now(),
): FeedSection<T>[] {
    const byDay = feedSections(posts, nowMs);
    if (!sortsByDistance(profile) || !point) return byDay;
    const events = byDay.filter(s => s.id === 'header-events');
    const listings = posts.filter(p => p.type !== 'event');
    return listings.length > 0
        ? [...events, { id: 'header-nearest', title: NEAREST_FIRST_HEADING, posts: nearestFirst(listings, point) }]
        : events;
}
