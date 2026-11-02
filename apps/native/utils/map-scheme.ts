/**
 * The phone map's light and dark (Marty, 2 Nov, on 1.2.87: "the darker version is too dark and the light map is not light").
 *
 * On Android, react-native-maps reads `userInterfaceStyle` once, into GoogleMapOptions.mapColorScheme, when the map is
 * created, and its setter does nothing (com/rnmaps/fabric/MapViewManager.java). `customMapStyle` still applies live, on
 * top of that frozen base. So a map created dark stayed dark under the light style: teal land and white labels with the
 * moon showing, which is Google's own dark map, not a light one. The cure is a new map when the scheme changes, which is
 * what a new `key` does; the library blocks view recycling for this map, so the new one reads its options afresh.
 *
 * iOS uses Apple's map, which takes `userInterfaceStyle` live (RNMapsMapView.mm) and ignores `customMapStyle`, so a
 * remount there would only cost a blink.
 */
import type { ResolvedTheme } from './theme-preference';

/** What the pill picked, and under which app theme: a later change of theme wins again. */
export type MapSchemePick = { theme: ResolvedTheme; dark: boolean };

/** Dark or light: the app's theme, until the pill picks the other. Worked out in the render, so it never lags the theme. */
export function mapIsDark(theme: ResolvedTheme, pick: MapSchemePick | null): boolean {
    return pick?.theme === theme ? pick.dark : theme === 'dark';
}

/** The map's `key`: a new one makes a new map, on Android only. */
export function mapSchemeKey(platform: string, isDark: boolean): string {
    if (platform !== 'android') return 'map';
    return isDark ? 'map-dark' : 'map-light';
}

/** Google's POI markers and transit icons off: the pins are the map's content. */
export const hidePoisStyle = [
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];

/**
 * These go to Google's map style, not to our own screens, so they are not colour tokens. Land is lifted well off black,
 * water is darker than it and plainly blue, roads are lighter than it, highways warm, and every label is near-white on a
 * dark outline. utils/__tests__/map-scheme.test.ts holds each of those apart by contrast.
 */
export const DARK_MAP = {
    land: '#414e61',
    water: '#0f2f4d',
    road: '#8792a2',
    roadEdge: '#2c3644',
    highway: '#c9a66b',
    highwayEdge: '#5c4a2a',
    label: '#f3f5f8',
    roadLabel: '#e2e6ec',
    labelOutline: '#1b2330',
} as const;

export const darkMapStyle = [
    ...hidePoisStyle,
    { elementType: 'geometry', stylers: [{ color: DARK_MAP.land }] },
    { elementType: 'labels.text.fill', stylers: [{ color: DARK_MAP.label }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: DARK_MAP.labelOutline }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: DARK_MAP.road }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: DARK_MAP.roadEdge }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: DARK_MAP.roadLabel }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: DARK_MAP.highway }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: DARK_MAP.highwayEdge }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: DARK_MAP.road }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: DARK_MAP.water }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: DARK_MAP.label }] },
    { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: DARK_MAP.water }] },
];
