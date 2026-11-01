// @vitest-environment jsdom
/**
 * A tap on a web map's bubble, on the real leaflet.markercluster: MapPage's own suite mocks Leaflet, and clusterSplitZoom
 * reads fields the library keeps private, so this is what would fail if an upgrade moved them. The numbers: at Bangalow's
 * latitude the 40 px bubble radius is 42 m at zoom 17 and 21 m at 18.
 */
import { afterEach, describe, expect, it } from 'vitest';
import L from 'leaflet';
import 'leaflet.markercluster';
import { MAP_TAP_CAP_ZOOM } from '@beanpool/core';
import { bubblesOnMap, clusterSplitZoom, planBubbleTap, stackPins, type StackPin } from './map-stack';

const AT: [number, number] = [-28.69, 153.56];
const north = (m: number): [number, number] => [AT[0] + m / 111_000, AT[1]];

let cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup) f(); cleanup = []; });

/** MapPage's cluster group, with these pins, on a 320 × 640 map at this zoom. */
function mapWith(spots: Array<[number, number]>, zoom: number) {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 320 });
    Object.defineProperty(el, 'clientHeight', { value: 640 });
    document.body.appendChild(el);
    const map = L.map(el, { center: AT, zoom, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    L.tileLayer('data:,{z}{x}{y}', { maxZoom: 19 }).addTo(map);
    const group = L.markerClusterGroup({ maxClusterRadius: 40, zoomToBoundsOnClick: false, spiderfyOnMaxZoom: false, animate: false }).addTo(map);
    const markers = spots.map((s) => L.marker(s));
    markers.forEach((m) => m.addTo(group));
    cleanup.push(() => { map.remove(); el.remove(); });
    return { map, group, markers };
}
/** MapPage's fit: this map's zoom for these bounds, with 50 px a side. */
const fit = (map: L.Map) => (bounds: L.LatLngBounds) => map.getBoundsZoom(bounds, false, L.point(50, 50));
/** The bubble a pin sits in at a zoom. */
function bubbleOf(marker: L.Marker, zoom: number): any {
    let c = (marker as any).__parent;
    while (c && c._zoom > zoom) c = c.__parent;
    return c;
}

describe('the bubbles on the map when it stops, on the real library', () => {
    const read = (zoom: number, spots: Array<[number, number]>) => {
        const { map, group, markers } = mapWith(spots, zoom);
        const keys = new Map(markers.map((m, i) => [m, `pin-${i}`]));
        return bubblesOnMap(keys, (pin) => group.getVisibleParent(pin), (at: L.LatLng) => map.latLngToContainerPoint(at));
    };

    it('finds a stack that cannot part, with its pins, at its point on the view', () => {
        const [stack, ...others] = read(MAP_TAP_CAP_ZOOM, [AT, AT, AT]);
        expect(others).toEqual([]);
        expect(stack.keys).toEqual(['pin-0', 'pin-1', 'pin-2']);
        expect(stack.x).toBeCloseTo(160, 0);
        expect(stack.y).toBeCloseTo(320, 0);
    });

    it('reads a pin that shows as no bubble', () => {
        expect(read(MAP_TAP_CAP_ZOOM, [AT, north(120)])).toEqual([]);
    });
});

describe('clusterSplitZoom on the real library', () => {
    it('reads pins on one spot as never parting: one past the deepest zoom, past the cap', () => {
        const { markers } = mapWith([AT, AT, AT], 13);
        expect(clusterSplitZoom(bubbleOf(markers[0], 13))).toBe(20);
    });

    it('finds the first zoom a bubble parts, through the levels where it stays one bubble', () => {
        // 300 m apart: 40 px is 335 m at zoom 14 and 168 m at 15.
        const { markers } = mapWith([AT, north(300)], 10);
        const bubble = bubbleOf(markers[0], 10);
        expect(bubble.getAllChildMarkers()).toHaveLength(2);
        expect(clusterSplitZoom(bubble)).toBe(15);
    });

    it('parts a mixed bubble at the zoom its first pin leaves, not at the stack inside it', () => {
        const { markers } = mapWith([AT, AT, AT, north(300)], 10);
        expect(clusterSplitZoom(bubbleOf(markers[0], 10))).toBe(15);
        expect(clusterSplitZoom(bubbleOf(markers[0], 15))).toBe(20);
    });

    it('leaves a tap to the app: the library neither zooms nor spirals by itself', () => {
        const { map, group, markers } = mapWith([AT, AT, AT], 19);
        group.fire('clusterclick', { layer: bubbleOf(markers[0], 19) });
        expect(map.getZoom()).toBe(19);
        expect((group as any)._spiderfied).toBeFalsy();
    });
});

describe('planBubbleTap on the real library', () => {
    it('opens the list for pins on one spot, in one tap from far out', () => {
        const { map, markers } = mapWith([AT, AT, AT], 13);
        expect(planBubbleTap<L.LatLng, L.LatLngBounds>(bubbleOf(markers[0], 13), fit(map))).toEqual({ kind: 'list' });
    });

    it('opens the list for pins that are apart but still one bubble at the cap', () => {
        // 30 m: inside 42 m at zoom 17, outside 21 m at 18.
        const { map, markers } = mapWith([AT, north(30)], 13);
        const bubble = bubbleOf(markers[0], 13);
        expect(clusterSplitZoom(bubble)).toBe(18);
        expect(planBubbleTap<L.LatLng, L.LatLngBounds>(bubble, fit(map))).toEqual({ kind: 'list' });
    });

    it('zooms a spread bubble, stopping at the cap though a fit would go deeper', () => {
        // 100 m: parts at 16, and a 320 px map could show it deeper than 17.
        const { map, markers } = mapWith([AT, north(100)], 13);
        const bubble = bubbleOf(markers[0], 13);
        expect(fit(map)(bubble.getBounds())).toBeGreaterThan(MAP_TAP_CAP_ZOOM);
        const plan = planBubbleTap<L.LatLng, L.LatLngBounds>(bubble, fit(map));
        expect(plan).toMatchObject({ kind: 'zoom', zoom: MAP_TAP_CAP_ZOOM });
    });

    it('fits a wide bubble short of the cap', () => {
        const { map, markers } = mapWith([AT, north(900)], 12);
        const plan = planBubbleTap<L.LatLng, L.LatLngBounds>(bubbleOf(markers[0], 12), fit(map));
        expect(plan.kind).toBe('zoom');
        expect((plan as { zoom: number }).zoom).toBeLessThan(MAP_TAP_CAP_ZOOM);
    });

    it('lands deep enough to part the bubble when the pins would fit shallower', () => {
        const { markers } = mapWith([AT, north(100)], 13);
        const shallow = () => 14;
        expect(planBubbleTap<L.LatLng, L.LatLngBounds>(bubbleOf(markers[0], 13), shallow)).toMatchObject({ kind: 'zoom', zoom: 16 });
    });

    it('is never a dead end: after the zoom, the stack left at the cap opens the list', () => {
        const { map, markers } = mapWith([AT, AT, AT, north(300)], 10);
        const first = planBubbleTap<L.LatLng, L.LatLngBounds>(bubbleOf(markers[0], 10), fit(map));
        expect(first.kind).toBe('zoom');
        const landed = (first as { zoom: number }).zoom;
        expect(planBubbleTap<L.LatLng, L.LatLngBounds>(bubbleOf(markers[0], landed), fit(map))).toEqual({ kind: 'list' });
    });
});

describe('stackPins', () => {
    const pin = (key: string, eventStartMs: number | null, createdMs: number): StackPin => ({
        key, title: key, type: '', when: null, photo: null, emoji: '', eventStartMs, createdMs, open() {},
    });
    const onMap = new Map([
        pin('old-offer', null, 100), pin('later', 900, 1), pin('new-need', null, 300), pin('soon', 500, 1), pin('enterprise', null, 0),
    ].map((p) => [p.key, p]));

    it('puts the soonest events first, then the listings, newest first', () => {
        expect(stackPins([...onMap.keys()], onMap).map((p) => p.key)).toEqual(['soon', 'later', 'new-need', 'old-offer', 'enterprise']);
    });

    it('lists only pins on the map now', () => {
        expect(stackPins(['soon', 'gone'], onMap).map((p) => p.key)).toEqual(['soon']);
    });
});
