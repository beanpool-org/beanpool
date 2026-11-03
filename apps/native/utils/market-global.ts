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
import { sectionsOfOrdered, type FeedSection } from './feed-sections';
import { formatDistance } from './events';
import { LOCAL_COMMUNITY_LINES, isNodePulsePost, marketOrder, postRulesFor, t, word } from '@beanpool/core';

/** Whether the Market shows Beans: a price on each card and the "Beans only" filter. */
export function marketShowsBeans(features: NodeFeatures | null | undefined): boolean {
    return beansOn(features);
}

/** The second row's filters, without "Beans only" where there are no Beans. */
export function marketExtras(extras: readonly MarketExtraFilter[], features: NodeFeatures | null | undefined): MarketExtraFilter[] {
    return marketShowsBeans(features) ? [...extras] : extras.filter(e => e !== 'beans');
}

/** Where a price was, on a post's own page, on a node with Beans off: word() keys, shown through t(). */
export const NO_BEANS_TERMS = {
    label: word('IN RETURN'),
    value: word('Free, a swap, or ask'),
    note: word('There are no Beans here. The description says what they would like in return, or that it is free. Message them to ask.'),
} as const;

/**
 * The note under it, in the member's language. Where Beans are previewed (the worldwide community's showcase, design §1
 * row 2), where Beans are: "No Beans here yet. In a local community the price is in Beans…". On a local community whose
 * operator turned Beans off, that would be false, so it says what it always said (review of #1852, finding 7).
 */
export function noBeansTermsNote(beansPreview: boolean): string {
    return beansPreview
        ? t('{noBeans} The description says what they would like in return, or that it is free. Message them to ask.', { noBeans: t(LOCAL_COMMUNITY_LINES.noBeansTerms) })
        : t(NO_BEANS_TERMS.note);
}

/**
 * What a post's edit form, and the map's Offer/Need form, say in place of the price field, on a node with Beans off. A
 * word() key: the post's edit form shows it through t() (the map's form is the map's, for a later sweep).
 */
export const NO_BEANS_EDIT_NOTE = word('No price here: say in the description what you would like in return, or that it is free.');

/**
 * Another member's profile where Beans are off (the worldwide one): the trust verdict, tier and trade counts are Beans and
 * are not drawn there (#2022), but meeting a stranger still deserves the plain advice the verdict carried on a local
 * community (apps/server/src/state-engine.ts assessTradeRisk's meeting tips). Nothing about trades or vouching: neither
 * happens there. Director's call, 16 Oct.
 */
export function meetingTips(): { heading: string; tips: string[] } {
    return {
        heading: t('Meeting someone new'),
        tips: [
            t('Meet somewhere public the first time.'),
            t("Don't share your home address until you've met."),
            t("Tell a friend where and when you're meeting."),
        ],
    };
}

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
    /** Whether a photo is required (every Offer and Need carries at least one photo). */
    photoRequired?: boolean;
    credits: string;
    title: string;
    description: string;
}

/**
 * What a post on the map's form needs first, from the node's Beans switch (@beanpool/core postRulesFor, as the node
 * decides it): every Offer and Need carries at least one photo. Where Beans are off (the global node) a Need waits for no Offer, and
 * no post waits for a profile photo. A node that says nothing yet: the local rules.
 */
export function postFormRules(
    features: NodeFeatures | null | undefined, postType: 'offer' | 'need', blockedFromTrading: boolean,
): { needBlocked: boolean; photoRequired: boolean; profilePhoto: boolean } {
    const rules = postRulesFor(beansOn(features));
    return {
        needBlocked: rules.offerFirst && blockedFromTrading && postType === 'need',
        photoRequired: postType !== 'need' || rules.needPhoto,
        profilePhoto: rules.profilePhoto,
    };
}

/**
 * Whether opening the map's post form waits for a profile photo (postFormRules().profilePhoto): from the screen's copy of
 * the node's profile when it has one, else from this phone's saved copy (`readCached`), read before deciding. A
 * `?newPost=` link from another tab mounts the map and opens the form at once, before the screen's copy arrives; without
 * the saved copy a member on the global node would be asked for a photo it doesn't need (review #1936 N1). No copy, or
 * one that can't be read: the local rule.
 */
export async function composerNeedsProfilePhoto(
    features: NodeFeatures | null | undefined, readCached: () => Promise<NodeProfile | null>,
): Promise<boolean> {
    const known = features ?? (await Promise.resolve().then(readCached).catch(() => null))?.features;
    return postFormRules(known, 'offer', false).profilePhoto;
}

/** The submit button's words, in the member's language: the next thing missing, or Post Offer / Post Need. */
export function postFormSubmitLabel(s: PostFormState, features: NodeFeatures | null | undefined): string {
    return s.posting ? t('Posting...')
        : s.needBlocked ? t('🟢 List an Offer first to post Needs')
        : (!s.category) ? t('📂 Select a category')
        : (!s.hasLocation) ? t('📍 Set a location')
        : (s.photoRequired !== false && s.photoCount < 1) ? t('📷 Add a photo')
        : postFormPriceMissing(s.credits, features) ? t('💰 Set a price')
        : (!s.title.trim() || !s.description.trim()) ? t('✏️ Fill required fields')
        : s.postType === 'offer' ? t('Post Offer') : t('Post Need');
}

/** Whether this node orders its listings from where the member is. */
export function sortsByDistance(profile: NodeProfile | null | undefined): boolean {
    return profile?.features.distanceSearch === true;
}

export interface Point { lat: number; lng: number }

/**
 * The Market search's distance parameters (G4, routes/distance-query.ts): a point and `sort=distance`, or none. The
 * point is the phone's last GPS fix, sent to two decimals (under a kilometre): the read has no radius, the phone orders
 * what comes back itself (nearestFirst) and shows its own distances, so only which listings come back can move
 * (scratch/fable-redo/verdict-privacy.md §6, N5).
 */
export function marketSearchDistanceParams(profile: NodeProfile | null | undefined, point: Point | null): string {
    if (!sortsByDistance(profile) || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return '';
    return `&lat=${point.lat.toFixed(2)}&lng=${point.lng.toFixed(2)}&sort=distance`;
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

/**
 * The worldwide community's circle (Market order, DESIGN-market-order-fable.md §2.5): on a node that gives each phone the
 * listings near the member's area (`features.nearbyListings`), the Market is the same newest-listed order, cut to that radius
 * of the member's area. No such feature, or no area, is no circle: the order alone.
 */
export interface NearbyCircle { area: Point; radiusKm: number }

export function nearbyCircle(profile: NodeProfile | null | undefined, area: Point | null | undefined): NearbyCircle | null {
    const n = profile?.features.nearbyListings;
    if (!n || !area || !Number.isFinite(area.lat) || !Number.isFinite(area.lng)) return null;
    return { area: { lat: area.lat, lng: area.lng }, radiusKm: n.radiusKm };
}

/** The one line above the list inside the circle: "Newest within 250 km of your area." A word() key, shown through t(). */
export const NEWEST_WITHIN_LINE = word('Newest within {distance} of your area.');

export function newestWithinLine(circle: NearbyCircle): string {
    return t(NEWEST_WITHIN_LINE, { distance: formatDistance(circle.radiusKm) ?? '' });
}

/** Each placed post's distance from the member's area in km, by post id. A post with no place has none. */
export function distancesFrom(posts: readonly Record<string, any>[], from: Point): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of posts) {
        const at = placeOf(p);
        if (at && p.id != null) out.set(String(p.id), km(from, at));
    }
    return out;
}

/**
 * Drop what lies beyond the circle. A post with no place (a poll, an online event) stays, and so does the member's own, as the
 * node's area read keeps the member's own beside the circle.
 */
export function cutToCircle<T extends Record<string, any>>(posts: readonly T[], circle: NearbyCircle, ownKey?: string | null): T[] {
    return posts.filter(p => {
        if (ownKey && (p.author_pubkey === ownKey || p.authorPublicKey === ownKey)) return true;
        const at = placeOf(p);
        return !at || km(circle.area, at) <= circle.radiusKm;
    });
}

export interface MarketStreamOptions {
    /** The Events pill: soonest first, a date list wants date order. */
    eventsOnly?: boolean;
    /** A search or a tag filter: the node's ranking for the words stands, so the posts keep the order they came in. */
    narrowedBySearch?: boolean;
    /** Set on the worldwide community with an area, and not under a Distance: the same order, cut to the circle. */
    circle?: NearbyCircle | null;
    /** The member, whose own posts are never cut. */
    ownKey?: string | null;
}

function eventStartMs(p: Record<string, any>): number {
    const ms = Date.parse(p.event_start_at ?? p.eventStartAt ?? '');
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The Market's stream for the screen (one order on both apps, core market-order): newest listed first, the two-a-day bound,
 * the node's own Daily Pulse first. Under Events, soonest first; under a search, the node's order stands. On the worldwide
 * community the circle is cut first.
 */
export function marketStream<T extends Record<string, any>>(posts: readonly T[], nowMs: number, o: MarketStreamOptions = {}): T[] {
    const pulseFirst = (list: T[]): T[] => [...list.filter(isNodePulsePost), ...list.filter(p => !isNodePulsePost(p))];
    if (o.eventsOnly) {
        return pulseFirst([...posts].sort((a, b) => eventStartMs(a) - eventStartMs(b)));
    }
    if (o.narrowedBySearch) return pulseFirst([...posts]);
    const cut = o.circle ? cutToCircle(posts, o.circle, o.ownKey) : [...posts];
    return pulseFirst(marketOrder(cut, nowMs));
}

/**
 * The list view's sections: the day headings over the stream, by the local day each post was listed. `point` is the member's
 * area (not their GPS fix): on a node that gives phones the listings near an area, the circle is cut first. The headings
 * Upcoming events, Polls and Nearest first are gone.
 */
export function marketFeedSections<T extends Record<string, any>>(
    posts: T[], profile: NodeProfile | null | undefined, point: Point | null, nowMs: number = Date.now(), ownKey?: string | null,
): FeedSection<T>[] {
    return sectionsOfOrdered(marketStream(posts, nowMs, { circle: nearbyCircle(profile, point), ownKey }), nowMs);
}
