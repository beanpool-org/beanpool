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
 * map.tsx and UnifiedMapPin.tsx are drawn for real (react-dom in jsdom; React Native's host components as plain tags that
 * keep their refs and report a layout, so the off-screen capture runs). The capture itself (react-native-view-shot), the
 * map (components/Map) and the SVG are stand-ins, and the clustering is supercluster fed the way the library feeds it.
 * What a phone's Google Maps does with the image is the device test this PR waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, Children, createElement, forwardRef, isValidElement, useEffect, useImperativeHandle, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error -- supercluster (react-native-map-clustering's own clusterer) ships no type declarations.
import Supercluster from 'supercluster';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const os = vi.hoisted(() => ({ now: 'ios' as 'ios' | 'android' }));
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
/** What the stand-in map was handed and drew. */
const seen = vi.hoisted(() => ({ children: [] as unknown[], markers: [] as Array<Record<string, any>> }));
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
vi.mock('../../components/Map', async () => {
    const MapView = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates() {} }));
        seen.children = Children.toArray(props.children);
        return createElement('div', { 'data-testid': 'map' }, props.children);
    });
    const Marker = (props: Record<string, any>) => {
        seen.markers.push(props);
        return createElement('button', {
            'data-marker': `${props.coordinate.latitude},${props.coordinate.longitude}`,
            'data-image': props.image?.uri ?? '',
            onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); props.onPress?.({ stopPropagation() {} }); },
        }, props.children);
    };
    return { default: MapView, Marker, Circle: () => null, Callout: () => null, PROVIDER_DEFAULT: 'default' };
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

/** An Elder's Offer and a Need near the hall, two upcoming events (one hosted by the Elder), one cancelled, one over. */
const OFFER = { id: 'p-eggs', type: 'offer', status: 'active', title: 'Duck eggs', category: 'food', author_energy_cycled: 12000, lat: -28.65, lng: 153.6 };
const NEED = { id: 'p-ladder', type: 'need', status: 'active', title: 'A ladder', category: 'tools', author_energy_cycled: 0, lat: -28.6503, lng: 153.6004 };
const ev = (id: string, over: Record<string, unknown> = {}) => ({
    id, type: 'event', status: 'active', title: `Event ${id}`, category: 'community', author_energy_cycled: 0, event_state: 'scheduled',
    event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 2 * 60 * 60 * 1000), lat: -28.6501, lng: 153.6001, ...over,
});
const CAFE = ev('ev-cafe', { author_energy_cycled: 12000 });
const BEE = ev('ev-bee', { lat: -28.70, lng: 153.65 });
const CALLED_OFF = ev('ev-off', { event_state: 'cancelled', lat: -28.71, lng: 153.66 });
const OVER = ev('ev-over', { event_start_at: iso(now - 2 * DAY), event_end_at: iso(now - 2 * DAY + 60 * 60 * 1000), lat: -28.72, lng: 153.67 });
const ALL = [OFFER, NEED, CAFE, BEE, CALLED_OFF, OVER];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    seen.children = [];
    seen.markers = [];
    posts.now = ALL;
    os.now = 'ios';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The map drawn, every pin and cluster image captured (the capture waits 200 ms after a slot's layout). */
async function drawMap() {
    await act(async () => { root.render(createElement(MapScreen)); });
    await settle();
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    await settle();
}
/** The capture that holds the event pin: the slot drawn with the calendar, not an emoji. */
const eventShot = () => shots.taken.find((s) => s.el.querySelector('svg path')?.getAttribute('data-fill') === EVENT_PIN.bgColor);
const childFor = (id: string) => (seen.children as ReactElement<any>[]).find((c) => isValidElement(c) && (c.props as any).post?.id === id);
const lastMarkerAt = (p: { lat: number; lng: number }) => [...seen.markers].reverse().find((m) => m.coordinate.latitude === p.lat && m.coordinate.longitude === p.lng);

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

    it('has no event pin to capture where there are no events', () => {
        expect(buildVariantList([OFFER, NEED], POST_CATEGORIES).some((v) => v.glyph !== undefined)).toBe(false);
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
        expect(listingShots.map((s) => s.el.textContent).sort()).toEqual([categoryEmoji('food'), categoryEmoji('tools')].sort());
    });

    it('is drawn by the listings\' marker with no cluster={false}, so the clustering counts it', async () => {
        await drawMap();
        const offer = childFor(OFFER.id);
        const cafe = childFor(CAFE.id);
        expect(offer && cafe, 'both pins are children of the map').toBeTruthy();
        expect(cafe!.type).toBe(offer!.type);
        // react-native-map-clustering clusters a child that has a coordinate and no cluster={false}: its rule, below.
        const helpers = readFileSync(join(NATIVE, '..', '..', 'node_modules', 'react-native-map-clustering', 'lib', 'helpers.js'), 'utf8');
        expect(helpers).toMatch(/child\.props\.coordinate &&\s*child\.props\.cluster !== false/);
        const clustered = (seen.children as ReactElement<any>[]).filter((c) => isValidElement(c) && (c.props as any).coordinate && (c.props as any).cluster !== false);
        expect(clustered.map((c) => (c.props as any).post.id).sort()).toEqual([OFFER.id, NEED.id, CAFE.id, BEE.id].sort());
        // Fed to supercluster as the library feeds it (map.tsx's radius 15, the library's defaults): the café, the eggs
        // and the ladder share a bubble of 3; the working bee, away from them, stands alone.
        const index = new Supercluster({ radius: 15, maxZoom: 20, minZoom: 1, minPoints: 2, extent: 512, nodeSize: 64 });
        index.load(clustered.map((c, i) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [(c.props as any).coordinate.longitude, (c.props as any).coordinate.latitude] },
            properties: { point_count: 0, index: i, id: (c.props as any).post.id },
        })));
        const atTown = index.getClusters([153.4, -28.9, 153.9, -28.4], 13);
        const bubble = atTown.find((f: any) => f.properties.cluster);
        expect(bubble?.properties.point_count).toBe(3);
        expect(index.getLeaves(bubble!.properties.cluster_id as number, Infinity).map((l: any) => l.properties.id).sort()).toEqual([OFFER.id, NEED.id, CAFE.id].sort());
        expect(atTown.filter((f: any) => !f.properties.cluster).map((f: any) => f.properties.id)).toEqual([BEE.id]);
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
        const uri = eventShot()!.uri;
        const marker = host.querySelector(`[data-marker="${CAFE.lat},${CAFE.lng}"]`)!;
        expect(marker.querySelector('img')?.getAttribute('data-uri')).toBe(uri);
        expect(lastMarkerAt(CAFE)!.anchor).toEqual(PIN_ANCHOR);
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
        await act(async () => { (host.querySelector(`[data-marker="${CAFE.lat},${CAFE.lng}"]`) as HTMLElement).click(); });
        await settle();
        expect(host.textContent).toContain('View event');
        expect(host.textContent).toContain(CAFE.title);
    });
});
