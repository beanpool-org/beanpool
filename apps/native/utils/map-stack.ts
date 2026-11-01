/**
 * What a tap on a phone map's bubble does (core's map-stack.ts holds the rule the web shares; Marty, 2 Nov), in the units
 * of react-native-map-clustering as patches/ leaves it. No React Native imports, so vitest can hold it to the design.
 *
 * The library's clustering zoom is not the map's. Patched, it measures a box four times the region's span, which reads two
 * zooms shallower than the map, and floors the answer. So a map at zoom 17.x clusters at 15, and the cap is 15 here. At 15
 * the library's radius (map.tsx's 15, on a 512 extent) is 15 / (512 × 2^15) of the world: 35.8 m at the equator, 31.4 m at
 * Bangalow, 23.5 m at 49° N, which on the screen is 30 dp at zoom 17.0. A pin's head is 36 dp across, inside a 56 dp
 * image, so two pins closer than that overlap and could not be told apart or tapped one at a time anyway.
 */
import { MAP_TAP_CAP_ZOOM, bubbleLandingZoom, bubbleTap, orderStack, t } from '@beanpool/core';
import { eventPinCard } from './events';
import { marketCardPicture } from './market-card-picture';

/** How far the patched library's clustering zoom sits under the map's zoom. */
const CLUSTER_ZOOM_BEHIND_MAP = 2;
/** The cap in the library's units. */
export const CLUSTER_CAP_ZOOM = MAP_TAP_CAP_ZOOM - CLUSTER_ZOOM_BEHIND_MAP;
/**
 * A landing aims this far past a whole zoom. The library floors, and a map that settles at 16.99 clusters a whole zoom
 * shallower, which would leave the same bubble under the member's finger.
 */
export const LANDING_MARGIN_ZOOM = 0.1;
/** The room a zoom leaves around the pins it fits, as a share of the view: about 50 dp a side on a 320 dp phone. */
const FIT_ROOM = 1.45;

export interface MapRegion { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number }
export interface WindowSize { width: number; height: number }
export interface MapPoint { latitude: number; longitude: number }

const TILE = 256;
const mercatorY = (lat: number) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
};

/**
 * The library's clustering zoom for a region, before it floors it (its helpers.js: the box of calculateBBox, fitted to the
 * window by geo-viewport). Takes the window the library took: read once, when the app loaded.
 */
export function clusterZoomOf(region: MapRegion, win: WindowSize): number {
    const boxWidthAtZoom0 = (TILE * 4 * region.longitudeDelta) / 360;
    const north = region.latitude + 2 * region.latitudeDelta;
    const south = region.latitude - 2 * region.latitudeDelta;
    const boxHeightAtZoom0 = (TILE * (mercatorY(north) - mercatorY(south))) / (2 * Math.PI);
    return Math.min(Math.log2(win.width / boxWidthAtZoom0), Math.log2(win.height / boxHeightAtZoom0));
}

/** The clustering zoom at which these pins just fit the view the region shows. Infinity for pins all on one spot. */
function fitZoomOf(points: readonly MapPoint[], region: MapRegion, win: WindowSize): number {
    const lats = points.map((p) => p.latitude);
    const lngs = points.map((p) => p.longitude);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    const lngSpan = Math.max(...lngs) - Math.min(...lngs);
    const shrink = Math.max(latSpan / region.latitudeDelta, lngSpan / region.longitudeDelta) * FIT_ROOM;
    return shrink > 0 ? clusterZoomOf(region, win) - Math.log2(shrink) : Infinity;
}

export type BubblePlan = { kind: 'list' } | { kind: 'zoom'; region: MapRegion };

/**
 * One tap on a bubble. `splitsAt` is supercluster's getClusterExpansionZoom for it. A zoom keeps the map's own shape, so the
 * map fits the region exactly and lands where it was aimed.
 */
export function planBubbleTap(splitsAt: number, points: readonly MapPoint[], current: MapRegion, win: WindowSize): BubblePlan {
    if (bubbleTap(splitsAt, CLUSTER_CAP_ZOOM) === 'list' || points.length === 0) return { kind: 'list' };
    const landing = bubbleLandingZoom(fitZoomOf(points, current, win), splitsAt, CLUSTER_CAP_ZOOM) + LANDING_MARGIN_ZOOM;
    const shrink = 2 ** (clusterZoomOf(current, win) - landing);
    const lats = points.map((p) => p.latitude);
    const lngs = points.map((p) => p.longitude);
    return {
        kind: 'zoom',
        region: {
            latitude: (Math.max(...lats) + Math.min(...lats)) / 2,
            longitude: (Math.max(...lngs) + Math.min(...lngs)) / 2,
            latitudeDelta: current.latitudeDelta * shrink,
            longitudeDelta: current.longitudeDelta * shrink,
        },
    };
}

/**
 * The list's pins: only those the map shows now, so a filter, a sync or the clock can take a row away while it is open, and
 * an ended or cancelled event never lists. Soonest events first, then Offers and Needs, newest first.
 */
export function stackPosts<T extends { id: string }>(ids: readonly string[], visible: readonly T[]): T[] {
    const wanted = new Set(ids);
    return orderStack(visible.filter((p) => wanted.has(p.id)), (p: any) => ({
        eventStartMs: (p.type || '').toLowerCase() === 'event' ? Date.parse(p.event_start_at ?? p.eventStartAt ?? '') : null,
        createdMs: Date.parse(p.created_at ?? p.createdAt ?? ''),
    }));
}

export interface StackRow {
    id: string;
    title: string;
    /** The word for what it is: Offer, Need, Event, or Poll for the one that pins on the global community. */
    type: string;
    /** An event's date line, else null. */
    when: string | null;
    cover: string | null;
    picture: string | null;
    category: string | null;
    isEvent: boolean;
    /** What a screen reader says for the row. */
    label: string;
}

/** A row reads the same card data as the pin's own card: eventPinCard for an event, marketCardPicture for the picture. */
export function stackRow(post: any): StackRow {
    const type = (post.type || '').toLowerCase();
    const isEvent = type === 'event';
    const card = isEvent ? eventPinCard(post) : null;
    const typeWord = isEvent ? t('Event') : type === 'offer' ? t('Offer') : type === 'poll' ? t('Poll') : t('Need');
    const title = card?.title ?? post.title ?? '';
    const when = card?.when || null;
    const { cover, picture } = marketCardPicture(post);
    return {
        id: post.id, title, type: typeWord, when, cover, picture, category: post.category ?? null, isEvent,
        label: [title, typeWord, when].filter(Boolean).join(', '),
    };
}
