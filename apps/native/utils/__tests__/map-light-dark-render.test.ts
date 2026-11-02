// @vitest-environment jsdom
/**
 * The phone map's light and dark: app/(tabs)/map.tsx and the radius picker rendered for real, on a stand-in map that
 * behaves as Android's does. It reads what it was CREATED with (`made`) as react-native-maps reads `userInterfaceStyle`
 * and `initialRegion`, and a later change of those props does nothing to it. So a test here can only pass if a change of
 * scheme gets a new map, which is the fault Marty photographed on 1.2.87: teal land and white labels with the moon showing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type StandIn = { made: Record<string, any>; now: Record<string, any>; moves: unknown[]; gone: boolean };
const maps = vi.hoisted(() => ({
    all: [] as StandIn[],
    standIn({ createElement, forwardRef, useEffect, useImperativeHandle, useRef }: typeof import('react')) {
        return forwardRef((props: Record<string, any>, ref) => {
            const self = useRef<StandIn | null>(null);
            if (!self.current) { self.current = { made: props, now: props, moves: [], gone: false }; maps.all.push(self.current); }
            self.current.now = props;
            useImperativeHandle(ref, () => ({
                animateToRegion: (r: unknown) => { self.current!.moves.push(r); },
                fitToCoordinates() {},
            }));
            useEffect(() => () => { self.current!.gone = true; }, []);
            return createElement('div', { 'data-testid': 'map' }, props.children);
        });
    },
}));
const liveMaps = () => maps.all.filter((m) => !m.gone);
const theMap = () => {
    expect(liveMaps(), 'one map on the screen').toHaveLength(1);
    return liveMaps()[0];
};
vi.mock('../../components/Map', async () => ({
    default: maps.standIn(await import('react')),
    Marker: ({ coordinate, onPress }: Record<string, any>) => createElement('button', {
        'data-marker': `${coordinate.latitude},${coordinate.longitude}`, onClick: () => onPress?.({ stopPropagation() {} }),
    }),
    Circle: () => null, Callout: () => null, PROVIDER_DEFAULT: 'default',
}));
vi.mock('react-native-maps', async () => ({
    default: maps.standIn(await import('react')), Marker: () => null, Circle: () => null, PROVIDER_DEFAULT: 'default',
}));

const scheme = vi.hoisted(() => ({ theme: 'light', themeLoading: false, listeners: new Set<() => void>() }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const useTheme = () => {
        const [, redraw] = useReducer((n: number) => n + 1, 0);
        useEffect(() => { scheme.listeners.add(redraw); return () => { scheme.listeners.delete(redraw); }; }, []);
        return { theme: scheme.theme, themeLoading: scheme.themeLoading, colors: scheme.theme === 'dark' ? darkColors : lightColors };
    };
    return {
        useTheme,
        useStyles: (make: (t: unknown) => unknown) => make(useTheme()),
    };
});

vi.mock('react-native', async () => {
    const alerts = { said: [], buttons: [] };
    return (await import('./profile-events-words-harness')).nativeMock(alerts);
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => ({}),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('expo-location', () => ({}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n), randomUUID: () => 'a-uuid' }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me-key', callsign: 'Ana' } }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@react-native-community/slider', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../../components/UnifiedMapPin', () => ({
    PinVisual: () => null, MapMarkerManager: () => null, ClusterCaptureManager: () => null,
    getCachedMarkerImage: () => null, getCachedClusterImage: () => null, buildVariantList: () => [], pinCacheKey: () => '',
    PIN_ANCHOR: { x: 0.5, y: 1 }, PIN_RENDER_W: 40, PIN_RENDER_H: 50, CLUSTER_ANCHOR: { x: 0.5, y: 0.5 },
    EVENT_PIN: { key: 'calendar|#7c3aed|0', emoji: '', bgColor: '#7c3aed', isElder: false, glyph: 'calendar' },
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: () => null, useCurrencyString: () => (n: number) => `${n}` }));
vi.mock('../../components/MapStackList', () => ({
    MapStackList: ({ posts }: { posts: unknown[] }) => createElement('div', { 'data-testid': 'stack-list' }, `${posts.length} rows`),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ features: { beans: true } }) }));
const POSTS = vi.hoisted(() => [
    { id: 'p-eggs', type: 'offer', status: 'active', title: 'Fresh duck eggs', category: 'food', author_pubkey: 'k', credits: 5, photos: [], lat: -28.65, lng: 153.6 },
    { id: 'p-tools', type: 'need', status: 'active', title: 'Borrow a ladder', category: 'tools', author_pubkey: 'm', credits: 3, photos: [], lat: -28.66, lng: 153.61 },
]);
vi.mock('../db', () => ({ getPosts: async () => POSTS }));

import { Platform } from 'react-native';
import MapScreen from '../../app/(tabs)/map';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { darkMapStyle, hidePoisStyle } from '../map-scheme';

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async (element: unknown = createElement(MapScreen)) => {
    await act(async () => { root.render(element as any); });
    await settle();
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const flip = async () => {
    await act(async () => { byLabel('Toggle dark mode')!.click(); });
    await settle();
};
const setTheme = async (next: Partial<Pick<typeof scheme, 'theme' | 'themeLoading'>>) => {
    Object.assign(scheme, next);
    await act(async () => { scheme.listeners.forEach((f) => f()); });
    await settle();
};
const pillShows = () => (host.textContent?.includes('🌙') ? 'moon' : host.textContent?.includes('☀️') ? 'sun' : 'neither');

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    maps.all.length = 0;
    scheme.theme = 'light';
    scheme.themeLoading = false;
    (Platform as { OS: string }).OS = 'android';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('Android: the map\'s light and dark are the real thing', () => {
    it('a map created dark, flipped with the pill, is a real light map, and back', async () => {
        scheme.theme = 'dark';
        await open();
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(pillShows()).toBe('sun');

        await flip();
        expect(theMap().made.userInterfaceStyle).toBe('light');
        expect(theMap().made.customMapStyle).toEqual(hidePoisStyle);
        expect(pillShows()).toBe('moon');

        await flip();
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(theMap().made.customMapStyle).toEqual(darkMapStyle);
        expect(pillShows()).toBe('sun');
    });

    it('a map created light goes really dark, every time, in either direction', async () => {
        await open();
        expect(theMap().made.userInterfaceStyle).toBe('light');
        for (const want of ['dark', 'light', 'dark', 'light', 'dark']) {
            await flip();
            expect(theMap().made.userInterfaceStyle).toBe(want);
        }
        expect(maps.all).toHaveLength(6);
    });

    it('the new map opens where the old one was', async () => {
        await open();
        const there = { latitude: -28.64, longitude: 153.49, latitudeDelta: 0.03, longitudeDelta: 0.02 };
        await act(async () => { theMap().now.onRegionChangeComplete(there); });
        await flip();
        expect(theMap().made.initialRegion).toEqual(there);
    });

    it('the buttons drive the new map, not the one that went', async () => {
        await open();
        const first = theMap();
        await flip();
        const second = theMap();
        await act(async () => { byLabel('Zoom in')!.click(); });
        expect(second.moves).toHaveLength(1);
        expect(first.moves).toEqual([]);
    });

    it('a change of the app\'s theme is a new map too, and gives up the pill\'s pick', async () => {
        await open();
        await flip(); // dark by the pill, in a light app
        await setTheme({ theme: 'dark' });
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        await flip(); // light by the pill, in a dark app
        expect(theMap().made.userInterfaceStyle).toBe('light');
        await setTheme({ theme: 'light' });
        expect(theMap().made.userInterfaceStyle).toBe('light');
        await setTheme({ theme: 'dark' });
        expect(theMap().made.userInterfaceStyle).toBe('dark');
    });

    it('an open preview stays open through the swap, and its pin with it', async () => {
        await open();
        const pin = host.querySelector(`[data-marker="${POSTS[0].lat},${POSTS[0].lng}"]`) as HTMLElement;
        await act(async () => { pin.click(); });
        await settle();
        expect(host.textContent).toContain(POSTS[0].title);

        await setTheme({ theme: 'dark' });
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(host.textContent).toContain(POSTS[0].title);
        expect(host.querySelector(`[data-marker="${POSTS[1].lat},${POSTS[1].lng}"]`)).not.toBeNull();
    });

    it('an open list stays open through the swap', async () => {
        await open();
        const leaves = POSTS.map((p) => ({ geometry: { coordinates: [p.lng, p.lat] }, properties: { post: p } }));
        await act(async () => {
            theMap().now.superClusterRef.current = { getClusterExpansionZoom: () => 40 }; // cannot split
            theMap().now.onClusterPress({ id: 7 }, leaves);
        });
        await settle();
        expect(host.querySelector('[data-testid="stack-list"]')?.textContent).toBe('2 rows');

        await setTheme({ theme: 'dark' });
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(host.querySelector('[data-testid="stack-list"]')?.textContent).toBe('2 rows');
    });

    it('the first map waits for the stored theme, so a dark member never sees a light one first', async () => {
        scheme.themeLoading = true; // the provider starts on 'light' while it reads the stored choice
        await open();
        expect(maps.all).toEqual([]);

        await setTheme({ theme: 'dark', themeLoading: false });
        expect(maps.all).toHaveLength(1);
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(theMap().made.customMapStyle).toEqual(darkMapStyle);
    });
});

describe('iOS: Apple\'s map takes the scheme live', () => {
    it('the pill changes the one map, with no remount', async () => {
        (Platform as { OS: string }).OS = 'ios';
        await open();
        const only = theMap();
        expect(only.now.userInterfaceStyle).toBe('light');
        await flip();
        expect(theMap()).toBe(only);
        expect(only.now.userInterfaceStyle).toBe('dark');
        await flip();
        expect(theMap()).toBe(only);
        expect(only.now.userInterfaceStyle).toBe('light');
        expect(maps.all).toHaveLength(1);
    });
});

describe('the radius picker follows the app, not the phone', () => {
    const picker = () => createElement(RadiusPickerModal as any, {
        visible: true, initialRadius: 5, onApply() {}, onCancel() {}, onReset() {},
    });

    it('light in a light app, whatever the phone', async () => {
        await open(picker());
        expect(theMap().made.userInterfaceStyle).toBe('light');
        expect(theMap().made.customMapStyle).not.toEqual(darkMapStyle);
    });

    it('dark in a dark app, and a new map if the theme changes while it is open', async () => {
        scheme.theme = 'dark';
        await open(picker());
        expect(theMap().made.userInterfaceStyle).toBe('dark');
        expect(theMap().made.customMapStyle).toEqual(darkMapStyle);
        await setTheme({ theme: 'light' });
        expect(theMap().made.userInterfaceStyle).toBe('light');
    });
});
