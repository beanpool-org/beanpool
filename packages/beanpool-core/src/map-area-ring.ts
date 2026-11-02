/**
 * A community's area on a map: a thin dashed line round its edge and nothing inside it, the same in every app. Marty, 2 Nov:
 * "please remove the yellow fill. Make it a dashed circumfrence line instead - no fill as it makes the map look yellow when
 * you zoom in - both on dark and light map view", and "make sure its visible - but not overly visible on dark map also".
 * The colour is BRAND_COLOURS.map.ring, which picks the two themes apart.
 */
import { BRAND_COLOURS } from './brand-colours.js';

/** Thin: 1.5 dp on the phone, 1.5 px on the web. */
export const AREA_RING_WIDTH = 1.5;
/** Dash and gap, in the same units as the width. */
export const AREA_RING_DASH: readonly number[] = [8, 5];
/** How many points a ring drawn as a line has. At 360 each corner turns one degree, whatever the zoom or the radius. */
export const AREA_RING_POINTS = 360;

/** The earth's mean radius. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface RingPoint { latitude: number; longitude: number }

/** Which colour, by the map under the line and not by the app's theme: the phone's pill can darken a map in a light app. */
export function areaRingColour(darkMap: boolean): string {
    return BRAND_COLOURS.map.ring[darkMap ? 'dark' : 'light'];
}

/** The dash for a phone's line. Google's dashes are in pixels, though its width is scaled for us; Apple's are in points. */
export function areaRingDash(platform: string, pixelRatio: number): number[] {
    return AREA_RING_DASH.map((length) => (platform === 'android' ? length * pixelRatio : length));
}

/**
 * The ring as a closed line: each point the radius away from the centre on a sphere, because on a map a circle in degrees is
 * an oval, and the last point the first. Longitudes run on past 180 rather than jump, so a community on that meridian keeps
 * neighbouring points neighbours.
 */
export function areaRingPoints(centre: RingPoint, radiusKm: number): RingPoint[] {
    const rad = Math.PI / 180;
    const angle = (radiusKm * 1000) / EARTH_RADIUS_M;
    const lat = centre.latitude * rad;
    const points = Array.from({ length: AREA_RING_POINTS }, (_, i) => {
        const bearing = (2 * Math.PI * i) / AREA_RING_POINTS;
        const sinTo = Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(bearing);
        const across = Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat), Math.cos(angle) - Math.sin(lat) * sinTo);
        return { latitude: Math.asin(sinTo) / rad, longitude: centre.longitude + across / rad };
    });
    return [...points, points[0]];
}

/** The ring as Leaflet draws it, on the web app's and the manager's maps. Both show OSM's light tiles in either app theme. */
export function areaRingLeafletStyle() {
    return { color: areaRingColour(false), weight: AREA_RING_WIDTH, dashArray: AREA_RING_DASH.join(' '), fill: false };
}
