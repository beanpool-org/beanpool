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
import { MAP_TAP_CAP_ZOOM, bubbleLandingZoom, bubbleTap, orderStack, stackLift, t, type MapFrame, type MapRest, type StackBubble } from '@beanpool/core';
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
 * Which marker takes a tap. Google Maps hands a tap to the highest marker under the finger, then the nearest, then cycles
 * through the rest on repeat taps, and a marker at opacity 0 counts: the patch keeps every pin mounted, so without this a pin
 * hidden under a bubble took the bubble's tap and opened its card, one card a tap (1.2.88, Marty: "one card at a time"). The
 * bubble goes first; a visible pin goes before a hidden one, or a hidden pin beside it would take its tap.
 */
export const MARKER_Z = { hiddenPin: 0, pin: 1, bubble: 2 } as const;

/** The parts of the library's supercluster read here. */
export interface ClusterIndex {
    getClusters(bbox: [number, number, number, number], zoom: number): ClusterFeature[];
    getLeaves(clusterId: number, limit: number): LeafFeature[];
}
export interface ClusterFeature {
    id?: number;
    geometry: { coordinates: number[] };
    properties: { cluster?: boolean; cluster_id?: number };
}
export interface LeafFeature {
    geometry: { coordinates: number[] };
    properties: { post: { id: string } };
}
export interface MapBubble { cluster: ClusterFeature; leaves: LeafFeature[] }

/** The bubbles the library is drawing for this region, from its own index: the same box, at the same zoom. */
function bubblesOf(index: ClusterIndex, region: MapRegion, win: WindowSize): MapBubble[] {
    const lngSpan = region.longitudeDelta < 0 ? region.longitudeDelta + 360 : region.longitudeDelta;
    const bbox: [number, number, number, number] = [
        region.longitude - lngSpan * 2, region.latitude - region.latitudeDelta * 2,
        region.longitude + lngSpan * 2, region.latitude + region.latitudeDelta * 2,
    ];
    return index.getClusters(bbox, clusterZoomAt(region, win))
        .filter((feature) => feature.properties.cluster)
        .map((cluster) => ({ cluster, leaves: index.getLeaves(cluster.properties.cluster_id!, Infinity) }));
}

/** The clustering zoom the library settles on for a region: its minZoom past 40° across, else clusterZoomOf, floored. */
export function clusterZoomAt(region: MapRegion, win: WindowSize): number {
    return region.longitudeDelta >= 40 ? 1 : Math.max(0, Math.min(20, Math.floor(clusterZoomOf(region, win))));
}

/** The bubble a hidden pin is folded into, so a tap that reached the pin can act on it. Null if none holds it. */
export function bubbleHolding(index: ClusterIndex, postId: string, region: MapRegion, win: WindowSize): MapBubble | null {
    return bubblesOf(index, region, win).find((b) => b.leaves.some((leaf) => leaf.properties.post.id === postId)) ?? null;
}

/** Where a point sits in a view showing this region, in px from its top left. */
function pointIn(region: MapRegion, frame: MapFrame, longitude: number, latitude: number) {
    return {
        x: ((longitude - region.longitude) / region.longitudeDelta + 0.5) * frame.width,
        y: ((region.latitude - latitude) / region.latitudeDelta + 0.5) * frame.height,
    };
}

/** What core's settleStackList needs to know about a map that has stopped. */
export function mapRestOf(index: ClusterIndex, region: MapRegion, win: WindowSize, frame: MapFrame, blocked: boolean): MapRest {
    const bubbles = bubblesOf(index, region, win).map(({ cluster, leaves }): StackBubble => ({
        keys: leaves.map((leaf) => leaf.properties.post.id),
        ...pointIn(region, frame, cluster.geometry.coordinates[0], cluster.geometry.coordinates[1]),
    }));
    return { view: frame, bubbles, atCap: clusterZoomAt(region, win) >= CLUSTER_CAP_ZOOM, blocked };
}

/** The region that lifts a tapped bubble clear of the list; null when it is already in view above it. */
export function regionClearOfList(region: MapRegion, frame: MapFrame, stack: MapPoint): MapRegion | null {
    const lift = stackLift(pointIn(region, frame, stack.longitude, stack.latitude).y, frame);
    return lift > 0 ? { ...region, latitude: region.latitude - (lift / frame.height) * region.latitudeDelta } : null;
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
