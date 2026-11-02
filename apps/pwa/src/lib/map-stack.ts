/**
 * What a tap on a web map's bubble does (core's map-stack.ts holds the rule the phone shares; Marty, 2 Nov), in the terms
 * of leaflet.markercluster. Here the map's zoom is the clustering zoom, so the cap is 17 as it stands. The bubble radius is
 * MapPage's maxClusterRadius, 40 px: at 17 that is 47.8 m at the equator, 42 m at Bangalow. A 40 px pin is that wide, so
 * pins closer than that sit on top of each other however they are tapped.
 */
import { MAP_TAP_CAP_ZOOM, bubbleLandingZoom, bubbleTap, orderStack, type StackBubble } from '@beanpool/core';

/**
 * The parts of a markercluster bubble this reads. The library has no public way to ask when a bubble parts, and its own
 * click handler walks these same fields; lib/map-stack.cluster.test.ts holds them to the real library.
 */
export interface ClusterTree {
    _zoom: number;
    _markers: unknown[];
    _childClusters: ClusterTree[];
}

/**
 * The first zoom at which this bubble is no longer one bubble. A bubble at zoom z holds what is separate at z + 1, so a
 * bubble with a single child bubble and no pins of its own is the same bubble one zoom on. Pins that never part end at the
 * map's deepest zoom, where this reads one past it.
 */
export function clusterSplitZoom(cluster: ClusterTree): number {
    let bubble = cluster;
    while (bubble._markers.length === 0 && bubble._childClusters.length === 1) bubble = bubble._childClusters[0];
    return bubble._zoom + 1;
}

export interface BubbleCluster<LatLng, Bounds extends { getCenter(): LatLng }> extends ClusterTree {
    getBounds(): Bounds;
}

export type BubblePlan<LatLng> = { kind: 'list' } | { kind: 'zoom'; center: LatLng; zoom: number };

/**
 * One tap on a bubble: the list when the cap could not part it, else the zoom that does, no deeper than the cap. `fitZoom`
 * is the zoom that shows these bounds on this map.
 */
export function planBubbleTap<LatLng, Bounds extends { getCenter(): LatLng }>(
    cluster: BubbleCluster<LatLng, Bounds>,
    fitZoom: (bounds: Bounds) => number,
): BubblePlan<LatLng> {
    const splitsAt = clusterSplitZoom(cluster);
    if (bubbleTap(splitsAt, MAP_TAP_CAP_ZOOM) === 'list') return { kind: 'list' };
    const bounds = cluster.getBounds();
    return { kind: 'zoom', center: bounds.getCenter(), zoom: bubbleLandingZoom(fitZoom(bounds), splitsAt, MAP_TAP_CAP_ZOOM) };
}

/**
 * The bubbles on the map now, for core's settleStackList. `visibleParent` is the library's getVisibleParent: the pin itself
 * when it shows, the bubble it is folded into when not, null when it is off the map. `point` is the map's latLngToContainerPoint.
 */
export function bubblesOnMap<Pin, LatLng>(
    pins: ReadonlyMap<Pin, string>,
    visibleParent: (pin: Pin) => unknown,
    point: (at: LatLng) => { x: number; y: number },
): StackBubble[] {
    const held = new Map<{ getLatLng(): LatLng }, string[]>();
    for (const [pin, key] of pins) {
        const parent = visibleParent(pin) as { getLatLng(): LatLng } | null;
        if (!parent || (parent as unknown) === pin) continue;
        held.set(parent, [...(held.get(parent) ?? []), key]);
    }
    return [...held].map(([bubble, keys]) => ({ keys, ...point(bubble.getLatLng()) }));
}

/** One row of the list: a pin on the map, an Offer, a Need, an event or an enterprise. */
export interface StackPin {
    key: string;
    title: string;
    /** The word for what it is. */
    type: string;
    /** An event's date line. */
    when: string | null;
    photo: string | null;
    emoji: string;
    /** An event's start in ms, else null. */
    eventStartMs: number | null;
    createdMs: number;
    open: () => void;
}

/**
 * The list's pins: only those on the map now, so a date chip or a sync can take a row away while it is open, and an ended
 * or cancelled event, which never pins, never lists. Soonest events first, then Offers and Needs, newest first.
 */
export function stackPins(keys: readonly string[], onMap: ReadonlyMap<string, StackPin>): StackPin[] {
    const pins = keys.flatMap((key) => {
        const pin = onMap.get(key);
        return pin ? [pin] : [];
    });
    return orderStack(pins, (pin) => ({ eventStartMs: pin.eventStartMs, createdMs: pin.createdMs }));
}
