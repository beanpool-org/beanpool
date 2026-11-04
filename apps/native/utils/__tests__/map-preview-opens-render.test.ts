// @vitest-environment jsdom
/**
 * A tap anywhere on a small card opens the ITEM, never the owner's profile (Marty, 4 Nov 2026: "in the listings and on the map
 * cards and pretty much any small card - if you click on the card in the wrong place you go to the owner of the listing's
 * profile ... from small cards you should be able to click anywhere on the card and have the card come up and then be able to
 * click on the profile pic from there").
 *
 * The map's pin cards (app/(tabs)/map.tsx, drawn for real; the map and its pins are the stand-ins map-words-render uses): a
 * listing's, an event's and a copy's. The card is ONE button named for the item; a press on the owner's name, or anywhere else
 * on it, sends the app to the item and to no profile; the ✕ opens nothing. In this harness a press stops at the innermost
 * button, as on a phone, so a name that was a button of its own would swallow the card's press.
 *
 * Marty's go for the protected map files (4 Nov) covers the tap target of these cards only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) })); // the real one needs the keyboard library's native side
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    // The top pill sits in a sideways scroller: recorded, so the 320 dp check can see it scrolls rather than clips.
    const ScrollView = (props: Record<string, any>) => createElement('div', {
        'data-horizontal': props.horizontal ? 'true' : 'false', ...(props.accessibilityLabel ? { 'aria-label': props.accessibilityLabel } : {}),
    }, createElement(native.View as any, { style: props.contentContainerStyle }, props.children));
    return { ...native, ScrollView };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
// `stack`: a case that needs what is LEFT in the stack sets a stack-sim.ts stack, and the router acts on it as well as recording.
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], stack: null as null | ReturnType<typeof import('./stack-sim').createStack> }));
// A screen drawn alone (no stack): the one route it is, focused, with no copy under it.
const SOLO_ROUTE = vi.hoisted(() => ({ key: 'solo-route', name: 'new-listing' }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useContext } = await import('react');
    const { RouteCtx } = await import('./stack-sim');
    const solo = {
        addListener: () => () => {}, isFocused: () => true, goBack: () => { nav.pushed.push('goBack'); },
        dispatch: () => { nav.pushed.push('goBack'); },
        getState: () => ({ key: 'solo', index: 0, routes: [SOLO_ROUTE] }),
    };
    return {
        router: {
            push: (to: unknown) => { nav.pushed.push(to); nav.stack?.push(to); }, navigate() {}, setParams() {},
            back: () => { nav.pushed.push('back'); nav.stack?.back(); },
            canGoBack: () => nav.stack?.canGoBack() ?? true, canDismiss: () => nav.stack?.canDismiss() ?? false,
            dismissAll() { nav.stack?.dismissAll(); }, replace(to: unknown) { nav.stack?.replace(to); },
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => useContext(RouteCtx)?.navigation ?? solo,
        useLocalSearchParams: () => (useContext(RouteCtx) ? (useContext(RouteCtx)!.route.params ?? {}) : params.now),
    };
});
vi.mock('@react-navigation/native', async () => {
    const { useContext } = await import('react');
    const { RouteCtx } = await import('./stack-sim');
    const { StackActions } = await import('@react-navigation/routers');
    return { StackActions, useRoute: () => useContext(RouteCtx)?.route ?? SOLO_ROUTE };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
/** Where the map's tap lands: a pin dropped there. */
const TAP = { latitude: -28.6543, longitude: 153.6123 };
vi.mock('../../components/Map', async () => {
    const MapView = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates() {} }));
        return createElement('div', { 'data-testid': 'map', onClick: () => props.onPress?.({ nativeEvent: { coordinate: TAP } }) }, props.children);
    });
    const Marker = ({ coordinate, onPress, children }: Record<string, any>) => createElement('button', {
        'data-marker': `${coordinate.latitude},${coordinate.longitude}`,
        onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress?.({ stopPropagation() {} }); },
    }, children);
    return { default: MapView, Marker, Circle: () => null, Callout: () => null, PROVIDER_DEFAULT: 'default' };
});
// The listing form's own pin map: the same stand-in, a box that drops a pin where it is tapped.
vi.mock('react-native-maps', async () => {
    const MapView = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ animateToRegion() {}, fitToCoordinates() {} }));
        return createElement('div', { 'data-testid': 'map', onClick: () => props.onPress?.({ nativeEvent: { coordinate: TAP } }) }, props.children);
    });
    const Marker = ({ coordinate, children }: Record<string, any>) => createElement('button', { 'data-marker': `${coordinate.latitude},${coordinate.longitude}` }, children);
    return { default: MapView, Marker, Circle: () => null, PROVIDER_DEFAULT: 'default' };
});
vi.mock('../../components/UnifiedMapPin', () => ({
    PinVisual: () => null, MapMarkerManager: () => null, ClusterCaptureManager: () => null,
    getCachedMarkerImage: () => null, getCachedClusterImage: () => null, buildVariantList: () => [], pinCacheKey: () => '',
    PIN_ANCHOR: { x: 0.5, y: 1 }, PIN_RENDER_W: 40, PIN_RENDER_H: 50, CLUSTER_ANCHOR: { x: 0.5, y: 0.5 },
    EVENT_PIN: { key: 'calendar|#7c3aed|0', emoji: '', bgColor: '#7c3aed', isElder: false, glyph: 'calendar' },
}));
const mapsKey = vi.hoisted(() => ({ on: true }));
vi.mock('../maps', () => ({ get HAS_MAPS_KEY() { return mapsKey.on; } }));
const loc = vi.hoisted(() => ({ granted: false }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => (loc.granted ? { status: 'granted', canAskAgain: true } : { status: 'denied', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: loc.granted ? 'granted' : 'denied' }),
    getCurrentPositionAsync: async () => { throw new Error('no fix'); },
    getLastKnownPositionAsync: async () => null,
}));
// The Gallery closes with nothing picked, unless a case has it give a photo: every Offer and Need needs one.
const roll = vi.hoisted(() => ({ gives: false }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => ({ granted: false }),
    launchCameraAsync: async () => ({ canceled: true, assets: [] }),
    launchImageLibraryAsync: async () => (roll.gives ? { canceled: false, assets: [{ uri: 'file:///roll/ladder.jpg' }] } : { canceled: true, assets: [] }),
}));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({ base64: '/9j/4AAQSkZJRg' }), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@react-native-picker/picker', () => ({ Picker: Object.assign(() => null, { Item: () => null }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
// Their own screens and sweeps (the poll and event composers, the pricing guide), closed until opened; none is opened here.
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
// The event form says only whether it is open: the listing screen opens it for `?newPost=event`.
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: ({ visible }: { visible: boolean }) => (visible ? createElement('div', { 'data-testid': 'event-form' }) : null) }));
vi.mock('../../components/info-content/PricingInfoModal', () => ({ PricingInfoModal: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import MapScreen from '../../app/(tabs)/map';

const NODE = 'https://mullum.example';
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

/** A small community on the map: an Elder's offer with no photo, a need, an event the host has changed. */
const POSTS = [
    {
        id: 'p-eggs', type: 'offer', status: 'active', title: 'Fresh duck eggs', description: 'A dozen a week', category: 'food',
        author_pubkey: 'kofi-key', author_callsign: 'Kofi', author_energy_cycled: 12000, credits: 5, price_type: 'fixed',
        photos: [], lat: -28.65, lng: 153.6, created_at: iso(now - 60_000),
    },
    {
        id: 'p-ladder', type: 'need', status: 'active', title: 'Borrow a long ladder', description: 'For the gutters', category: 'tools',
        author_pubkey: 'mia-key', author_callsign: 'Mia', author_energy_cycled: 700, credits: 3, price_type: 'daily',
        photos: [], lat: -28.66, lng: 153.61, created_at: iso(now - DAY),
    },
    {
        id: 'p-event', type: 'event', status: 'active', title: 'Repair café', event_place_name: 'Scout hall', event_state: 'updated',
        event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 2 * 60 * 60 * 1000),
        author_pubkey: 'mia-key', author_callsign: 'Mia', goingCount: 2, lat: -28.67, lng: 153.62, created_at: iso(now - 3 * DAY),
    },
];
/** Two partner communities: one with a name, one known only by its id. */
const PEERS = [{ peerId: 'peer-byron-0001', callsign: 'Byron Bay' }, { peerId: 'peer-0000000099999999', callsign: null }];
/** Everything members and communities wrote: shown as written, in every language. */
const COPY = {
    id: 'p-copy', type: 'offer', status: 'active', title: 'Quince paste', description: 'A jar', category: 'food', author_pubkey: 'hidden',
    credits: 0, price_type: 'fixed', photos: [], lat: -28.68, lng: 153.63, created_at: iso(now - DAY),
    shown_from: JSON.stringify({ host: 'byron.beanpool.org', name: 'Mullumbimby', url: 'https://byron.beanpool.org', door: 'ask', price: { amount: 20, unit: 'fixed' } }),
};
POSTS.push(COPY as any);

type Answers = Record<string, unknown>;
function community(over: Answers = {}): (name: string, args: unknown[]) => Promise<unknown> | undefined {
    const answers: Answers = {
        getPosts: POSTS, getBalance: { isBlockedFromTrading: true }, getMemberProfile: { avatar_url: 'https://mullum.example/a.jpg' },
        getReachablePeers: PEERS, ...over,
    };
    return (name) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
}
const LOCAL = { beans: true, escrow: true, showcase: false, exampleListings: true };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.answer = community();
    params.now = {};
    nav.pushed.length = 0;
    nav.stack = null;
    alerts.said.length = 0;
    alerts.buttons = [];
    mapsKey.on = true;
    loc.granted = false;
    roll.gives = false;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: LOCAL, checkedAt: new Date().toISOString() } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { vi.useRealTimers(); act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: unknown = createElement(MapScreen)) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, screen as any) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const byLabel = (shown: string) => host.querySelector(`[aria-label="${shown.replace(/"/g, '\\"')}"]`);
const byText = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === shown) ?? null;
const marker = (p: { lat: number; lng: number }) => host.querySelector(`[data-marker="${p.lat},${p.lng}"]`);

const pushed = () => nav.pushed;
const openCard = () => host.querySelector('[data-testid="map-preview-open"]') as HTMLElement | null;
const textOf = (el: Element, shown: string) => Array.from(el.querySelectorAll('span, div')).find((e) => e.children.length === 0 && e.textContent?.includes(shown)) ?? null;

describe('the Map: a pin card opens its item from anywhere on it, and never the owner\'s profile', () => {
    it('a listing: one button named for it; a press on the owner\'s name opens the listing', async () => {
        await renderIn('en');
        await click(marker(POSTS[0] as any), 'the eggs pin');
        const card = openCard();
        expect(card, 'the card').toBeTruthy();
        expect(card!.getAttribute('aria-label')).toBe('Open listing: Fresh duck eggs');
        expect(card!.getAttribute('aria-label')).not.toContain('Kofi');
        // The owner is shown inside it, as a name and not as a button.
        expect(card!.textContent).toContain('Kofi');
        expect(host.querySelector('[data-testid="map-preview-author"]')?.tagName).not.toBe('BUTTON');
        await click(textOf(card!, 'Kofi'), 'the owner\'s name');
        expect(pushed()).toEqual(['/post/p-eggs']);
    });

    it('a listing: a press on its title, and on View Details, open it too (once each)', async () => {
        await renderIn('en');
        await click(marker(POSTS[0] as any), 'the eggs pin');
        await click(textOf(openCard()!, 'Fresh duck eggs'), 'the title');
        expect(pushed()).toEqual(['/post/p-eggs']);
        nav.pushed.length = 0;
        await click(marker(POSTS[0] as any), 'the eggs pin again');
        await click(byText('View Details'), 'View Details');
        expect(pushed()).toEqual(['/post/p-eggs']);
    });

    it('a listing: the ✕ closes the card and opens nothing', async () => {
        await renderIn('en');
        await click(marker(POSTS[0] as any), 'the eggs pin');
        await click(byLabel('Close'), 'the ✕');
        expect(openCard()).toBeNull();
        expect(pushed()).toEqual([]);
    });

    it('an event: one button named for it; a press on its title opens the event', async () => {
        await renderIn('en');
        await click(marker(POSTS[2] as any), 'the event pin');
        const card = openCard();
        expect(card!.getAttribute('aria-label')).toBe('Open event: Repair café');
        await click(textOf(card!, 'Repair café'), 'the title');
        expect(pushed()).toEqual(['/post/p-event']);
    });

    it('a member\'s copy (no owner shown): a press on its community line opens the listing', async () => {
        await renderIn('en');
        await click(marker(COPY as any), 'the copy pin');
        await click(host.querySelector('[data-testid="map-preview-copy-line"]'), 'the community line');
        expect(pushed()).toEqual(['/post/p-copy']);
    });
});
