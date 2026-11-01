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
    /** The regions a tap asked the map to move to. */
    moves: [] as Array<Record<string, number>>,
    regionChanged: (_region: Record<string, number>) => {},
    /** A tap on the bare map, past any marker. */
    bareTap: (() => {}) as () => void,
}));
/** The map's own `sync_data_updated` listener. */
const sync = vi.hoisted(() => ({ fire: () => {} }));
/** Every off-screen capture: the slot's own element, and the file it "wrote". */
const shots = vi.hoisted(() => ({ taken: [] as Array<{ el: Element; uri: string }> }));
const posts = vi.hoisted(() => ({ now: [] as unknown[] }));
const pushes = vi.hoisted(() => ({ to: [] as unknown[] }));
/** The screen's focus effects, and the community address the map's re-centring reads. */
const focus = vi.hoisted(() => ({ effects: [] as Array<{ cb: () => void | (() => void); cleanup: void | (() => void) }>, anchor: null as string | null }));

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
        useImperativeHandle(ref, () => ({ animateToRegion(region: Record<string, number>) { maps.moves.push(region); }, fitToCoordinates(coords: typeof maps.fits[number]) { maps.fits.push(coords); } }));
        maps.regionChanged = props.onRegionChangeComplete;
        maps.bareTap = props.onPress;
        return createElement('div', { 'data-testid': 'map' }, props.children);
    });
    const Marker = (props: Record<string, any>) => {
        maps.markers.push(props);
        return createElement('button', {
            'data-marker': `${props.coordinate.latitude},${props.coordinate.longitude}`,
            'data-image': props.image?.uri ?? '',
            'data-opacity': String(props.opacity ?? 1),
            // As on iOS: a marker's press bubbles to the map's onPress unless the marker stops it.
            onClick: (e: { stopPropagation(): void }) => {
                e.stopPropagation();
                let stopped = false;
                props.onPress?.({ stopPropagation() { stopped = true; } });
                if (!stopped && os.now === 'ios') maps.bareTap();
            },
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
    return { default: load('ClusteredMapView').default, Marker, Circle: () => null, Callout: () => null, PROVIDER_DEFAULT: 'default', libraryHelpers: load('helpers') };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect, useRef } = await import('react');
    return {
        router: { push(to: unknown) { pushes.to.push(to); }, setParams() {}, navigate() {}, back() {} },
        // Each focus effect is kept, so a test can leave the screen and come back to it.
        useFocusEffect: (cb: () => void | (() => void)) => {
            const slot = useRef<{ cb: () => void | (() => void); cleanup: void | (() => void) } | null>(null);
            effect(() => {
                slot.current = { cb, cleanup: cb() };
                focus.effects.push(slot.current);
                return () => { slot.current?.cleanup?.(); };
            }, [cb]);
        },
        useLocalSearchParams: () => ({}),
    };
});
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    getCurrentPositionAsync: async () => { throw new Error('no fix'); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => focus.anchor, setItem: async () => {}, removeItem: async () => {} } }));
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
vi.mock('expo-image', () => ({ Image: (props: { source?: { uri?: string } }) => createElement('img', { 'data-uri': props.source?.uri ?? '' }) }));
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => {} }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: () => null, useCurrencyString: () => 'Beans' }));
vi.mock('../../components/FilterChipRow', () => ({
    FilterChipRow: (props: { chips: Array<{ id: string }>; onSelect: (id: string) => void }) =>
        createElement('div', null, props.chips.map((c) => createElement('button', { key: c.id, 'data-chip': c.id, onClick: () => props.onSelect(c.id) }))),
}));
vi.mock('../../components/FilterChipPicker', () => ({
    FilterChipPicker: (props: { chips: Array<{ id: string }>; onSelect: (id: string) => void }) =>
        createElement('div', null, props.chips.map((c) => createElement('button', { key: c.id, 'data-chip': c.id, onClick: () => props.onSelect(c.id) }))),
}));
vi.mock('../maps', () => ({ HAS_MAPS_KEY: true }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../market-global', () => ({ marketShowsBeans: () => true }));
vi.mock('../db', () => ({ getPosts: async () => posts.now }));

import MapScreen from '../../app/(tabs)/map';
import { buildVariantList, EVENT_PIN, PIN_ANCHOR, pinCacheKey } from '../../components/UnifiedMapPin';
import { POST_CATEGORIES, categoryEmoji } from '../../constants/categories';
import { MAP_TAP_CAP_ZOOM } from '@beanpool/core';
import { CLUSTER_CAP_ZOOM, LANDING_MARGIN_ZOOM, clusterZoomOf, planBubbleTap, type MapRegion } from '../map-stack';
import { eventPinCard } from '../events';

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
const ev = (id: string, lat: number, lng: number, over: Record<string, unknown> = {}) => ({
    id, type: 'event', status: 'active', title: `Event ${id}`, category: 'community', author_energy_cycled: 0, event_state: 'scheduled',
    event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 2 * 60 * 60 * 1000), lat, lng, ...over,
});
const CAFE = ev('ev-cafe', -28.5401, 153.5001, { author_energy_cycled: 12000 });
const PARTY = ev('ev-party', -28.5402, 153.5002);
const BEE = ev('ev-bee', -28.56, 153.53);
const CALLED_OFF = ev('ev-off', -28.57, 153.54, { event_state: 'cancelled' });
const OVER = ev('ev-over', -28.58, 153.55, { event_start_at: iso(now - 2 * DAY), event_end_at: iso(now - 2 * DAY + 60 * 60 * 1000) });
const ALL = [OFFER, NEED, CAFE, PARTY, BEE, CALLED_OFF, OVER];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    maps.markers = [];
    maps.fits = [];
    maps.moves = [];
    pushes.to = [];
    focus.effects = [];
    focus.anchor = null;
    posts.now = ALL;
    os.now = 'ios';
    vi.spyOn(console, 'log').mockImplementation(() => {}); // the capture's own progress lines, a hundred a draw
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The map drawn, every pin and cluster image captured (the capture waits 200 ms after a slot's layout). */
async function drawMap(Screen: typeof MapScreen = MapScreen) {
    await act(async () => { root.render(createElement(Screen) as any); });
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

/** The list panel: its header's words, its rows (each row's button), its ✕. */
const heading = () => Array.from(host.querySelectorAll('span')).find((s) => /at this spot$/.test(s.textContent ?? ''))?.textContent ?? null;
const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-list] button'));
const closeButton = () => host.querySelector<HTMLElement>('[data-list]')!.parentElement!.querySelector<HTMLElement>('button[aria-label="Close"]')!;

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
        expect(markerAt(BEE), 'the map is drawn').not.toBeNull();
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
        await act(async () => { maps.regionChanged({ latitude: CAFE.lat, longitude: CAFE.lng, latitudeDelta: 0.0002, longitudeDelta: 0.0002 }); });
        await settle(2);
        expect(bubbles()).toEqual([]);
        for (const p of HALL) expect(opacityAt(p), p.id).toBe('1');
    });

    it('is among the pins a tap on the bubble zooms to: these four are 50 m across, which the cap can part', async () => {
        await drawMap();
        await act(async () => { bubbles()[0].el.click(); });
        await settle(2);
        expect(heading()).toBeNull();
        const landing = maps.moves.at(-1)!;
        for (const p of HALL) {
            expect(Math.abs(p.lat - landing.latitude), p.id).toBeLessThan(landing.latitudeDelta / 2);
            expect(Math.abs(p.lng - landing.longitude), p.id).toBeLessThan(landing.longitudeDelta / 2);
        }
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

describe('a tap on a bubble (utils/map-stack.ts, core map-stack.ts)', () => {
    const HOUR = 60 * 60 * 1000;
    const AT = { lat: -28.54, lng: 153.5 };
    /** About 111 km to a degree of latitude. */
    const metresNorth = (m: number) => Number((AT.lat + m / 111_000).toFixed(6));
    const listing = (id: string, type: 'offer' | 'need', daysOld: number, over: Record<string, unknown> = {}) => ({
        id, type, status: 'active', title: `Listing ${id}`, category: 'food', author_energy_cycled: 0,
        created_at: iso(now - daysOld * DAY), lat: AT.lat, lng: AT.lng, ...over,
    });
    const eventIn = (id: string, hours: number, over: Record<string, unknown> = {}) => ev(id, AT.lat, AT.lng, {
        event_start_at: iso(now + hours * HOUR), event_end_at: iso(now + (hours + 2) * HOUR), ...over,
    });
    const openBubble = async (index = 0) => { await act(async () => { bubbles()[index].el.click(); }); await settle(2); };
    const closeList = async () => { await act(async () => { closeButton().click(); }); await settle(2); };
    const land = async (region: Record<string, number>) => { await act(async () => { maps.regionChanged(region); }); await settle(2); };
    const tapPill = async (name: string) => {
        await act(async () => { Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name)!.click(); });
        await settle(2);
    };
    const titles = () => rows().map((r) => r.getAttribute('aria-label')!.split(',')[0]);
    const window320 = { width: 320, height: 569 };

    it('reads the same clustering zoom as the library, whatever the region', async () => {
        const { libraryHelpers } = await import('../../components/Map') as any;
        for (const lngDelta of [0.0421, 0.01, 0.0031, 0.00084, 0.0002]) {
            for (const aspect of [1.2, 1.78, 2.19]) {
                const region = { latitude: AT.lat, longitude: AT.lng, longitudeDelta: lngDelta, latitudeDelta: lngDelta * aspect };
                expect(Math.floor(clusterZoomOf(region, window320)), `${lngDelta} × ${aspect}`)
                    .toBe(libraryHelpers.returnMapZoom(region, libraryHelpers.calculateBBox(region), 1));
            }
        }
    });

    it('opens the list in one tap for pins on one spot, and the map does not move', async () => {
        posts.now = [eventIn('a', 2), eventIn('b', 3), eventIn('c', 4)];
        await drawMap();
        expect(bubbles().map((b) => b.count)).toEqual([3]);
        await openBubble();
        expect(heading()).toBe('3 at this spot');
        expect(rows()).toHaveLength(3);
        expect(maps.moves).toEqual([]);
        expect(maps.fits).toEqual([]);
    });

    it('zooms a spread bubble, stops at the cap, and the bubble has parted when it lands', async () => {
        // 400 m apart: one bubble at the first view, and a fit would go past the cap.
        const north = ev('north', metresNorth(400), AT.lng);
        posts.now = [ev('south', AT.lat, AT.lng), north];
        await drawMap();
        expect(bubbles().map((b) => b.count)).toEqual([2]);
        await openBubble();
        expect(heading(), 'no list for pins a zoom can part').toBeNull();
        expect(maps.moves).toHaveLength(1);
        const landing = maps.moves[0] as unknown as MapRegion;
        expect(clusterZoomOf(landing, window320)).toBeCloseTo(CLUSTER_CAP_ZOOM + LANDING_MARGIN_ZOOM, 3);
        expect(CLUSTER_CAP_ZOOM + 2).toBe(MAP_TAP_CAP_ZOOM);
        // Halfway between the two, so both are in view.
        expect(landing.latitude).toBeCloseTo((AT.lat + north.lat) / 2, 6);
        await land(maps.moves[0]);
        expect(bubbles()).toEqual([]);
    });

    it('fits a wide bubble short of the cap, with all of its pins inside the region', async () => {
        const north = ev('north', metresNorth(900), AT.lng);
        posts.now = [ev('south', AT.lat, AT.lng), north];
        await drawMap();
        await openBubble();
        const landing = maps.moves[0] as unknown as MapRegion;
        expect(Math.floor(clusterZoomOf(landing, window320))).toBeLessThan(CLUSTER_CAP_ZOOM);
        expect(landing.latitudeDelta).toBeGreaterThan(Math.abs(north.lat - AT.lat));
        await land(maps.moves[0]);
        expect(bubbles()).toEqual([]);
    });

    it('lands deep enough to part the bubble even when the pins would fit shallower', () => {
        const region = { latitude: AT.lat, longitude: AT.lng, latitudeDelta: 0.04, longitudeDelta: 0.02 };
        const points = [{ latitude: AT.lat, longitude: AT.lng }, { latitude: AT.lat + 0.03, longitude: AT.lng }];
        const plan = planBubbleTap(14, points, region, window320);
        expect(plan.kind).toBe('zoom');
        expect(Math.floor(clusterZoomOf((plan as { region: MapRegion }).region, window320))).toBe(14);
    });

    it('opens the list for a bubble that would still be a bubble at the cap, though its pins are apart', async () => {
        // 20 m apart: inside the radius at the cap (31 m here) and outside it one zoom deeper, so the pins are not on one spot.
        posts.now = [ev('here', AT.lat, AT.lng), ev('there', metresNorth(20), AT.lng)];
        await drawMap();
        await openBubble();
        expect(heading()).toBe('2 at this spot');
        expect(maps.moves).toEqual([]);
    });

    it('is never a dead end: a far bubble zooms, and what is left at the cap opens the list', async () => {
        // Three on one spot and one 300 m off. The first tap parts them; the three are then a bubble the cap cannot part.
        posts.now = [eventIn('a', 2), eventIn('b', 3), eventIn('c', 4), ev('off', metresNorth(300), AT.lng)];
        await drawMap();
        expect(bubbles().map((b) => b.count)).toEqual([4]);
        await openBubble();
        expect(heading()).toBeNull();
        await land(maps.moves[0]);
        expect(bubbles().map((b) => b.count)).toEqual([3]);
        await openBubble();
        expect(heading()).toBe('3 at this spot');
        expect(maps.moves).toHaveLength(1);
    });

    it('has no spiral: a stack stays a bubble however deep the map goes, and a tap there still lists it', async () => {
        posts.now = [eventIn('a', 2), eventIn('b', 3), eventIn('c', 4)];
        await drawMap();
        await openBubble();
        await closeList();
        await land({ latitude: AT.lat, longitude: AT.lng, latitudeDelta: 0.0002, longitudeDelta: 0.0002 });
        expect(bubbles().map((b) => b.count)).toEqual([3]);
        await openBubble();
        expect(heading()).toBe('3 at this spot');
    });

    it('orders the soonest events first, then Offers and Needs together, newest first', async () => {
        posts.now = [
            listing('old-offer', 'offer', 9), eventIn('later', 48), listing('new-need', 'need', 1), eventIn('soon', 2),
            listing('mid-offer', 'offer', 4),
        ];
        await drawMap();
        await openBubble();
        expect(titles()).toEqual(['Event soon', 'Event later', 'Listing new-need', 'Listing mid-offer', 'Listing old-offer']);
    });

    it('shows a row\'s title, what it is, and for an event its date, and a screen reader reads all three', async () => {
        posts.now = [eventIn('soon', 2), listing('eggs', 'offer', 1)];
        await drawMap();
        await openBubble();
        const [event, offer] = rows();
        const when = eventPinCard(posts.now[0]).when;
        expect(when).toBeTruthy();
        expect(event.textContent).toContain('Event soon');
        expect(event.textContent).toContain(when);
        expect(event.getAttribute('aria-label')).toBe(`Event soon, Event, ${when}`);
        expect(offer.getAttribute('aria-label')).toBe('Listing eggs, Offer');
    });

    it('never lists an ended or a cancelled event', async () => {
        posts.now = [eventIn('on', 2), listing('eggs', 'offer', 1), eventIn('off', 3, { event_state: 'cancelled' }), eventIn('over', -48)];
        await drawMap();
        await openBubble();
        expect(heading()).toBe('2 at this spot');
        expect(titles()).toEqual(['Event on', 'Listing eggs']);
    });

    it('lists only what the pills and the category chip show', async () => {
        posts.now = [eventIn('a', 2), eventIn('b', 3), listing('eggs', 'offer', 1), listing('jam', 'offer', 2), listing('ladder', 'need', 3, { category: 'tools' })];
        await drawMap();
        await tapPill('Offers');
        await openBubble();
        expect(heading()).toBe('2 at this spot');
        expect(titles()).toEqual(['Listing eggs', 'Listing jam']);
        await closeList();
        await tapPill('All');
        await act(async () => { host.querySelector<HTMLElement>('[data-chip="food"]')!.click(); });
        await settle(2);
        await openBubble();
        expect(titles()).toEqual(['Listing eggs', 'Listing jam']);
    });

    it('lists only what the date chips show', async () => {
        // Soon is within the next seven days; far is not.
        posts.now = [eventIn('soon', 2), eventIn('soon2', 3), eventIn('far', 24 * 30)];
        await drawMap();
        await tapPill('Events');
        await act(async () => { host.querySelector<HTMLElement>('[data-chip="week"]')!.click(); });
        await settle(2);
        await openBubble();
        expect(titles()).toEqual(['Event soon', 'Event soon2']);
    });

    it('drops a row when the post goes while the list is open, and closes when none are left', async () => {
        const [a, b] = [eventIn('a', 2), eventIn('b', 3)];
        posts.now = [a, b];
        await drawMap();
        await openBubble();
        expect(rows()).toHaveLength(2);
        posts.now = [a, { ...b, event_state: 'cancelled' }];
        await act(async () => { sync.fire(); });
        await settle();
        expect(heading()).toBe('1 at this spot');
        posts.now = [{ ...a, status: 'cancelled' }];
        await act(async () => { sync.fire(); });
        await settle();
        expect(heading()).toBeNull();
        // The list has gone: those pins coming back draw a bubble, not the list again.
        posts.now = [a, b];
        await act(async () => { sync.fire(); });
        await settle();
        expect(heading()).toBeNull();
        expect(bubbles().map((x) => x.count)).toEqual([2]);
    });

    it('opens a post from its row, and coming back finds the list open and the map where it was', async () => {
        focus.anchor = 'https://node.example';
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ serviceRadius: { lat: -28.1, lng: 153.1, radiusKm: 5 } }) })));
        posts.now = [eventIn('a', 2), eventIn('b', 3)];
        await drawMap();
        await settle();
        maps.moves = []; // the first centring on the community
        await openBubble();
        await act(async () => { rows()[0].click(); });
        expect(pushes.to).toEqual(['/post/a']);
        // Away to the post and back: the focus effects close, then run again.
        await act(async () => { for (const f of focus.effects) f.cleanup?.(); });
        await act(async () => { for (const f of focus.effects) f.cleanup = f.cb(); });
        await settle();
        expect(heading()).toBe('2 at this spot');
        expect(maps.moves).toEqual([]);
        vi.unstubAllGlobals();
    });

    it('closes on ✕ or a tap on the map, and the map has not moved', async () => {
        posts.now = [eventIn('a', 2), eventIn('b', 3)];
        await drawMap();
        await openBubble();
        await closeList();
        expect(heading()).toBeNull();
        await openBubble();
        await act(async () => { maps.bareTap(); });
        await settle(2);
        expect(heading()).toBeNull();
        expect(maps.moves).toEqual([]);
    });

    it('gives way to a pin\'s card, and hides the filters and buttons as the card does', async () => {
        posts.now = [eventIn('a', 2), eventIn('b', 3), BEE];
        await drawMap();
        await openBubble();
        expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Events')).toBe(false);
        await act(async () => { markerAt(BEE)!.click(); });
        await settle(2);
        expect(heading()).toBeNull();
        expect(host.textContent).toContain('View event');
    });

    it('holds a hundred rows on one spot', async () => {
        posts.now = Array.from({ length: 100 }, (_, i) => listing(`n${i}`, 'offer', i));
        await drawMap();
        // A bubble of a hundred wears the 99+ image, which bubbles() does not read as a number.
        const bubble = Array.from(host.querySelectorAll<HTMLElement>('[data-marker]')).find((el) => shots.taken.find((s) => s.uri === imageOn(el))?.el.textContent === '99+')!;
        await act(async () => { bubble.click(); });
        await settle(2);
        expect(heading()).toBe('100 at this spot');
        expect(rows()).toHaveLength(100);
    });
});
