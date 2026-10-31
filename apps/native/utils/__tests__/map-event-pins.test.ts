// @vitest-environment jsdom
/**
 * Events on the phone's map wear the listings' pin and cluster with them. Marty, 31 Oct: "introduce the event as part of
 * what we already have and that it clusters with the offer/needs and adds to the calculations".
 *
 * UnifiedMapPin's variant list holds the one event pin (EVENT_PIN): the same teardrop as an Offer's or a Need's, in the
 * event violet, with a calendar drawn from Views where a listing has its emoji (never the 📅 emoji, which Android prints
 * a date on: events round 2, B7). app/(tabs)/map.tsx draws an event through the same marker as a listing: the captured
 * image, and no `cluster={false}`, so react-native-map-clustering folds it into the bubbles and counts it.
 *
 * map.tsx, UnifiedMapPin.tsx and the clustering are the real thing: the screen is drawn by react-dom in jsdom, with React
 * Native's host components as plain tags that keep their refs and report a layout, so the off-screen capture runs, and the
 * map is react-native-map-clustering's own ClusteredMapView as patches/ leaves it, with its own supercluster. The capture
 * itself (react-native-view-shot), react-native-maps under the library and the SVG are stand-ins. What a phone's Google
 * Maps does with the image is the device test this PR waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { act, createElement, forwardRef, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error -- supercluster (react-native-map-clustering's own clusterer) ships no type declarations.
import Supercluster from 'supercluster';
import ts from 'typescript';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const os = vi.hoisted(() => ({ now: 'ios' as 'ios' | 'android' }));
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
/** The stand-in under the library: every marker drawn, the fits asked of it, and the way to tell the library the map moved. */
const maps = vi.hoisted(() => ({
    markers: [] as Array<Record<string, any>>,
    fits: [] as Array<Array<{ latitude: number; longitude: number }>>,
    regionChanged: (_region: Record<string, number>) => {},
}));
/** The map's own `sync_data_updated` listener. */
const sync = vi.hoisted(() => ({ fire: () => {} }));
/** Every off-screen capture: the slot's own element, and the file it "wrote". */
const shots = vi.hoisted(() => ({ taken: [] as Array<{ el: Element; uri: string }> }));
const posts = vi.hoisted(() => ({ now: [] as unknown[] }));

const flat = vi.hoisted(() => (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object')));

vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    // A View that keeps its ref (the capture reads it) and its style (the calendar's colour is checked), and reports a layout.
    const View = (props: Record<string, any>) => {
        useEffect(() => { props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 640 } } }); }, []);
        const attrs: Record<string, unknown> = { ref: props.ref, 'data-style': JSON.stringify(flat(props.style)) };
        if (props.onPress) attrs.onClick = () => props.onPress({ stopPropagation() {} });
        return createElement('div', attrs, props.children);
    };
    const Image = (props: Record<string, any>) => createElement('img', { 'data-uri': props.source?.uri ?? '' });
    return {
        ...native, View, Image,
        Platform: { get OS() { return os.now; }, select: (o: Record<string, unknown>) => o[os.now] ?? o.default },
        LayoutAnimation: { Presets: { spring: {} } }, // read by the library's default props
        DeviceEventEmitter: { addListener: (name: string, listener: () => void) => { if (name === 'sync_data_updated') sync.fire = listener; return { remove() {} }; }, emit() {} },
    };
});
vi.mock('react-native-svg', () => {
    const tag = (name: string) => (props: Record<string, any>) => createElement(name, { 'data-fill': props.fill ?? '' }, props.children);
    return { default: tag('svg'), Path: tag('path'), Circle: tag('circle') };
});
vi.mock('react-native-view-shot', () => ({
    captureRef: async (el: Element) => {
        const uri = `file:///pins/${shots.taken.length}.png`;
        shots.taken.push({ el, uri });
        return uri;
    },
}));
// The library as patches/react-native-map-clustering@4.0.0.patch leaves it, over a stand-in for react-native-maps. Its files
// are JSX in plain .js, which vitest does not transform under node_modules, so they are transpiled here.
vi.mock('../../components/Map', async () => {
    const NativeMap = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates(coords: typeof maps.fits[number]) { maps.fits.push(coords); } }));
        maps.regionChanged = props.onRegionChangeComplete;
        return createElement('div', { 'data-testid': 'map' }, props.children);
    });
    const Marker = (props: Record<string, any>) => {
        maps.markers.push(props);
        return createElement('button', {
            'data-marker': `${props.coordinate.latitude},${props.coordinate.longitude}`,
            'data-image': props.image?.uri ?? '',
            'data-opacity': String(props.opacity ?? 1),
            onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); props.onPress?.({ stopPropagation() {} }); },
        }, props.children);
    };
    const nodeRequire = createRequire(__filename);
    const modules: Record<string, unknown> = {
        react: nodeRequire('react'),
        'react-native': await import('react-native'),
        'react-native-maps': { __esModule: true, default: NativeMap, Marker, Polyline: () => null },
        supercluster: Supercluster,
        '@mapbox/geo-viewport': nodeRequire('@mapbox/geo-viewport'),
    };
    const lib = join(__dirname, '..', '..', '..', '..', 'node_modules', 'react-native-map-clustering', 'lib');
    const load = (file: string): Record<string, any> => {
        const { outputText } = ts.transpileModule(readFileSync(join(lib, `${file}.js`), 'utf8'), {
            fileName: `${file}.jsx`,
            compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        });
        const mod = { exports: {} };
        new Function('require', 'module', 'exports', outputText)((id: string) => modules[id] ?? load(id.replace('./', '')), mod, mod.exports);
        return mod.exports;
    };
    return { default: load('ClusteredMapView').default, Marker, Circle: () => null, Callout: () => null, PROVIDER_DEFAULT: 'default' };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, setParams() {}, navigate() {}, back() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
    };
});
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    getCurrentPositionAsync: async () => { throw new Error('no fix'); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (f: any) => f({ theme: 'light', colors: lightColors }) };
});
// The event card's colour, from its own source (below): the card itself is not drawn here.
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#7c3aed' }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: () => null, useCurrencyString: () => 'Beans' }));
vi.mock('../../components/FilterChipRow', () => ({ FilterChipRow: () => null }));
vi.mock('../../components/FilterChipPicker', () => ({ FilterChipPicker: () => null }));
vi.mock('../maps', () => ({ HAS_MAPS_KEY: true }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../market-global', () => ({ marketShowsBeans: () => true }));
vi.mock('../db', () => ({ getPosts: async () => posts.now }));

import MapScreen from '../../app/(tabs)/map';
import { buildVariantList, EVENT_PIN, PIN_ANCHOR, pinCacheKey } from '../../components/UnifiedMapPin';
import { POST_CATEGORIES, categoryEmoji } from '../../constants/categories';

const NATIVE = join(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

/**
 * Inside the map's first region: an Elder's Offer, a Need and two upcoming events (one hosted by the Elder) metres apart at
 * the hall; a third event away from them; one cancelled and one over.
 */
const OFFER = { id: 'p-eggs', type: 'offer', status: 'active', title: 'Duck eggs', category: 'food', author_energy_cycled: 12000, lat: -28.54, lng: 153.5 };
const NEED = { id: 'p-ladder', type: 'need', status: 'active', title: 'A ladder', category: 'tools', author_energy_cycled: 0, lat: -28.5403, lng: 153.5004 };
const ev = (id: string, over: Record<string, unknown> = {}) => ({
    id, type: 'event', status: 'active', title: `Event ${id}`, category: 'community', author_energy_cycled: 0, event_state: 'scheduled',
    event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 2 * 60 * 60 * 1000), ...over,
});
const CAFE = ev('ev-cafe', { author_energy_cycled: 12000, lat: -28.5401, lng: 153.5001 });
const PARTY = ev('ev-party', { lat: -28.5402, lng: 153.5002 });
const BEE = ev('ev-bee', { lat: -28.56, lng: 153.53 });
const CALLED_OFF = ev('ev-off', { event_state: 'cancelled', lat: -28.57, lng: 153.54 });
const OVER = ev('ev-over', { event_start_at: iso(now - 2 * DAY), event_end_at: iso(now - 2 * DAY + 60 * 60 * 1000), lat: -28.58, lng: 153.55 });
const ALL = [OFFER, NEED, CAFE, PARTY, BEE, CALLED_OFF, OVER];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    maps.markers = [];
    maps.fits = [];
    posts.now = ALL;
    os.now = 'ios';
    vi.spyOn(console, 'log').mockImplementation(() => {}); // the capture's own progress lines, a hundred a draw
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The map drawn, every pin and cluster image captured (the capture waits 200 ms after a slot's layout). */
async function drawMap(Screen: typeof MapScreen = MapScreen) {
    await act(async () => { root.render(createElement(Screen)); });
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    await settle();
}
/** The capture that holds the event pin: the slot drawn with the calendar, not an emoji. */
const eventShot = () => [...shots.taken].reverse().find((s) => s.el.querySelector('svg path')?.getAttribute('data-fill') === EVENT_PIN.bgColor);
const lastMarkerAt = (p: { lat: number; lng: number }) => [...maps.markers].reverse().find((m) => m.coordinate.latitude === p.lat && m.coordinate.longitude === p.lng);
/** The marker on the map now, at a post's spot. */
const markerAt = (p: { lat: number; lng: number }) => host.querySelector<HTMLElement>(`[data-marker="${p.lat},${p.lng}"]`);
const opacityAt = (p: { lat: number; lng: number }) => markerAt(p)?.getAttribute('data-opacity');
/** The image a marker wears: the `image` prop on iOS, the Image inside it on Android. */
const imageOn = (marker: Element) => marker.getAttribute('data-image') || marker.querySelector('img')?.getAttribute('data-uri') || '';
/** The bubbles on the map, each with the number on the image it wears, read from that image's own capture. */
const bubbles = () => Array.from(host.querySelectorAll<HTMLElement>('[data-marker]')).flatMap((el) => {
    const label = shots.taken.find((s) => s.uri === imageOn(el))?.el.textContent ?? '';
    return /^\d+$/.test(label) ? [{ el, count: Number(label) }] : [];
});

describe('the event pin in the variant list (UnifiedMapPin)', () => {
    it('holds exactly one event pin, whatever the events: violet, a calendar, no emoji, no elder ring, a key of its own', () => {
        const variants = buildVariantList(ALL, POST_CATEGORIES);
        const eventPins = variants.filter((v) => v.glyph !== undefined);
        expect(eventPins).toEqual([EVENT_PIN]);
        // The events' violet is the one the event card uses, read from the card's source.
        const card = readFileSync(join(NATIVE, 'components', 'EventCard.tsx'), 'utf8');
        expect(card).toContain(`export const EVENT_ACCENT = '${EVENT_PIN.bgColor}';`);
        expect(EVENT_PIN).toMatchObject({ glyph: 'calendar', emoji: '', isElder: false });
        expect(EVENT_PIN.emoji).not.toContain('📅');
        // Its own key: no listing's pin, Elder or not, in any category, can be served the event's image or take its slot.
        expect(new Set(variants.map((v) => v.key)).size).toBe(variants.length);
        for (const c of POST_CATEGORIES) {
            for (const colour of ['#10b981', '#ea580c']) {
                for (const elder of [false, true]) expect(pinCacheKey(c.emoji, colour, elder)).not.toBe(EVENT_PIN.key);
            }
        }
        // The listings' pins are what they were: one per emoji, colour and Elder ring, keyed as before (emoji|colour|elder).
        expect(variants.filter((v) => v.glyph === undefined)).toEqual([
            { key: `${categoryEmoji('food')}|#10b981|1`, emoji: categoryEmoji('food'), bgColor: '#10b981', isElder: true },
            { key: `${categoryEmoji('tools')}|#ea580c|0`, emoji: categoryEmoji('tools'), bgColor: '#ea580c', isElder: false },
        ]);
    });

    it('holds it before any event has come, first in the list, and an empty map captures nothing', () => {
        // First, so a new category's pin joining the list never moves its slot (a slot that moves is laid out and counted again).
        expect(buildVariantList([OFFER, NEED], POST_CATEGORIES)[0]).toEqual(EVENT_PIN);
        expect(buildVariantList([CAFE], POST_CATEGORIES)).toEqual([EVENT_PIN]);
        expect(buildVariantList([], POST_CATEGORIES)).toEqual([]);
    });
});

describe('an event on the map (app/(tabs)/map.tsx)', () => {
    it('captures the event pin with the listings\' pins: the violet teardrop and a calendar drawn in it, no emoji', async () => {
        await drawMap();
        const shot = eventShot();
        expect(shot, 'the event pin was captured').toBeTruthy();
        // The same teardrop and white disc as a listing's pin; the disc holds Views, not words or an emoji.
        expect(shot!.el.querySelectorAll('svg path')).toHaveLength(1);
        expect(shot!.el.textContent).toBe('');
        const strokes = Array.from(shot!.el.querySelectorAll('div[data-style]')).map((d) => JSON.parse(d.getAttribute('data-style')!));
        expect(strokes.some((s) => s.borderColor === EVENT_PIN.bgColor)).toBe(true);
        expect(strokes.filter((s) => s.backgroundColor === EVENT_PIN.bgColor).length).toBeGreaterThanOrEqual(3);
        // Each listing pin was captured too, with its emoji.
        const listingShots = shots.taken.filter((s) => ['#10b981', '#ea580c'].includes(s.el.querySelector('svg path')?.getAttribute('data-fill') ?? ''));
        expect(new Set(listingShots.map((s) => s.el.textContent))).toEqual(new Set([categoryEmoji('food'), categoryEmoji('tools')]));
    });

    it('wears its captured image on iOS, at the listings\' anchor, and its own image, not a listing\'s', async () => {
        await drawMap();
        const uri = eventShot()!.uri;
        const cafe = lastMarkerAt(CAFE)!;
        expect(cafe.image).toEqual({ uri });
        expect(cafe.anchor).toEqual(PIN_ANCHOR);
        expect(cafe.tracksViewChanges).toBe(false);
        expect(lastMarkerAt(BEE)!.image).toEqual({ uri });
        expect(lastMarkerAt(OFFER)!.image?.uri).toBeTruthy();
        expect(lastMarkerAt(OFFER)!.image.uri).not.toBe(uri);
        expect(lastMarkerAt(OFFER)!.anchor).toEqual(cafe.anchor);
    });

    it('wears its captured image on Android, in the image the listings use there', async () => {
        os.now = 'android';
        await drawMap();
        expect(markerAt(CAFE)!.querySelector('img')?.getAttribute('data-uri')).toBe(eventShot()!.uri);
        expect(lastMarkerAt(CAFE)!.anchor).toEqual(PIN_ANCHOR);
        expect(lastMarkerAt(CAFE)!.tracksViewChanges).toBe(lastMarkerAt(OFFER)!.tracksViewChanges);
    });

    it('wears its pin at once when a community\'s first event reaches a map already open', async () => {
        // A fresh pin cache, so this event pin can only be one captured here. Captured only once the event had come, it
        // would stay on the fallback (on Android, the undersized snapshot the capture exists to avoid) until the map next
        // moved: nothing redraws a marker for a pin captured after the map is ready.
        vi.resetModules();
        const fresh = await import('../../app/(tabs)/map');
        const pins = await import('../../components/UnifiedMapPin');
        const eventImage = () => pins.getCachedMarkerImage(EVENT_PIN.emoji, EVENT_PIN.bgColor, EVENT_PIN.isElder, EVENT_PIN.glyph);
        expect(eventImage()).toBeNull();

        posts.now = [OFFER, NEED];
        await drawMap(fresh.default);
        posts.now = ALL;
        await act(async () => { sync.fire(); });
        await settle();
        await act(async () => { await new Promise((r) => setTimeout(r, 260)); }); // past any capture the event started
        await settle();

        expect(eventImage()).toBeTruthy();
        expect(markerAt(BEE)?.getAttribute('data-image')).toBe(eventImage());
        // And from its first frame: never the fallback.
        const frames = maps.markers.filter((m) => m.coordinate.latitude === BEE.lat);
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((m) => m.image?.uri === eventImage())).toBe(true);
    });

    it('never pins a cancelled or an ended event', async () => {
        await drawMap();
        expect(childFor(CALLED_OFF.id)).toBeUndefined();
        expect(childFor(OVER.id)).toBeUndefined();
        expect(lastMarkerAt(CALLED_OFF)).toBeUndefined();
        expect(lastMarkerAt(OVER)).toBeUndefined();
    });

    it('opens the event\'s own card when tapped, as before', async () => {
        await drawMap();
        await act(async () => { markerAt(BEE)!.click(); });
        await settle();
        expect(host.textContent).toContain('View event');
        expect(host.textContent).toContain(BEE.title);
    });
});

describe('an event in the bubbles (react-native-map-clustering, as patched)', () => {
    /** The hall's four pins: two listings and two events. */
    const HALL = [OFFER, NEED, CAFE, PARTY];

    it('leaves no cluster={false} on the map: nothing is held out of the bubbles', () => {
        expect(readFileSync(join(NATIVE, 'app', '(tabs)', 'map.tsx'), 'utf8')).not.toContain('cluster={false}');
    });

    it.each(['ios', 'android'] as const)('%s: folds into a bubble with the listings beside it, counted, and stays mounted behind it', async (platform) => {
        os.now = platform;
        await drawMap();
        // The bubble wears the image captured for 4: the eggs, the ladder and both events.
        expect(bubbles().map((b) => b.count)).toEqual([4]);
        // Every leaf stays mounted and is hidden by its opacity (the patch's way, which keeps iOS pins from vanishing).
        for (const p of HALL) expect(opacityAt(p), p.id).toBe('0');
        // The working bee, away from them, stands alone.
        expect(opacityAt(BEE)).toBe('1');
    });

    it('comes out as its own pin when the map zooms in, and the bubble goes', async () => {
        await drawMap();
        await act(async () => { maps.regionChanged({ latitude: CAFE.lat, longitude: CAFE.lng, latitudeDelta: 0.001, longitudeDelta: 0.001 }); });
        await settle(2);
        expect(bubbles()).toEqual([]);
        for (const p of HALL) expect(opacityAt(p), p.id).toBe('1');
    });

    it('is among the pins a tap on the bubble fits to', async () => {
        await drawMap();
        await act(async () => { bubbles()[0].el.click(); });
        expect(maps.fits.at(-1)).toEqual(expect.arrayContaining(HALL.map((p) => ({ latitude: p.lat, longitude: p.lng }))));
        expect(maps.fits.at(-1)).toHaveLength(HALL.length);
    });

    it('under the Events pill the bubble counts the events alone: the listings have left the map', async () => {
        await drawMap();
        const events = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Events')!;
        await act(async () => { events.click(); });
        await settle();
        expect(bubbles().map((b) => b.count)).toEqual([2]);
        expect(markerAt(OFFER)).toBeNull();
        expect(markerAt(NEED)).toBeNull();
        expect(opacityAt(CAFE)).toBe('0');
        expect(opacityAt(BEE)).toBe('1');
    });
});
