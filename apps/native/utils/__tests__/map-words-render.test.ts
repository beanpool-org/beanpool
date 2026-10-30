// @vitest-environment jsdom
/**
 * The Map in the member's language (words slice S3, sweep B12): app/(tabs)/map.tsx rendered for real inside the real
 * LanguageProvider. Marty's go for this protected file covers its words only (20 Oct, a screenshot in Portuguese: the
 * top pill and ADD POST were English), so what is checked is that every sentence it draws, says to a screen reader,
 * shows as a placeholder or puts in an alert came through t(): the top pill, the category and date rows, the left
 * pill, the event and listing previews, ADD POST and its chooser, the New Post form (every field, the price and fee,
 * the toggles, the reach chooser), dropping a pin, and the alerts.
 *
 * The New Post form and its chooser are a screen of their own since MAP-FORM (app/new-listing.tsx): the map's + and its
 * `?newPost=` link open it, and the form's cases render it, inside the same provider, with the same stand-ins.
 *
 * The map itself and its pins (components/Map, UnifiedMapPin) draw no words: they are stand-ins here, a box that hears
 * a tap and a button per pin. The form's own pin map (react-native-maps) is the same stand-in. Google's map labels and what members wrote (titles, names, places) are shown as written.
 * React Native's host components are profile-events-words-harness.ts's plain tags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: {
            push: (to: unknown) => { nav.pushed.push(to); }, navigate() {}, setParams() {}, back() {},
            canGoBack: () => true, canDismiss: () => false, dismissAll() {}, replace() {},
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
    };
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
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/info-content/PricingInfoModal', () => ({ PricingInfoModal: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import { pseudoLocalise, setLanguage, upperCase, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { bracketed, bypassing as bypassingIn, unfit, widthOf, SCALE } from './profile-events-words-harness';
import { categoryEmoji } from '../../constants/categories';
import MapScreen from '../../app/(tabs)/map';
import NewListingScreen from '../../app/new-listing';

const NODE = 'https://mullum.example';
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();
const xx = (s: string) => pseudoLocalise(s);

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
const WRITTEN = [...POSTS.flatMap((p: any) => [p.title, p.description, p.author_callsign, p.event_place_name]), 'Byron Bay', ME.callsign]
    .filter((s): s is string => typeof s === 'string');

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
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el as HTMLInputElement, text);
        (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const pressAlert = async (shown: string) => {
    const b = alerts.buttons.find((x) => x.text === shown);
    expect(b, shown).toBeTruthy();
    await act(async () => { await b!.onPress?.(); });
    await settle();
};
const byLabel = (shown: string) => host.querySelector(`[aria-label="${shown.replace(/"/g, '\\"')}"]`);
const byText = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === shown) ?? null;
const buttonHolding = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(shown)) ?? null;
const marker = (p: { lat: number; lng: number }) => host.querySelector(`[data-marker="${p.lat},${p.lng}"]`);
const bypassing = () => bypassingIn(host, WRITTEN, alerts.said);
const said = () => alerts.said;
/** The New Post form, opened the way the Market's Offer row opens it (`/new-listing?newPost=offer`). */
const listing = () => createElement(NewListingScreen);
async function openForm(lang: UiLang) {
    params.now = { newPost: 'offer' };
    await renderIn(lang, listing());
    expect(host.querySelector('input[placeholder]'), 'the form').not.toBeNull();
}

describe('the Map in the pseudo-locale: every word on it came through t() (words S3m)', () => {
    it('the map: the top pill, the category chip, the left pill and ADD POST', async () => {
        await renderIn('xx');
        for (const pill of ['All', 'Offers', 'Needs', 'Events']) expect(byText(xx(pill)), pill).not.toBeNull();
        expect(buttonHolding(xx('ADD POST'))).not.toBeNull();
        for (const label of ['Filter by category', 'Toggle dark mode', 'Recenter map', 'Zoom in', 'Zoom out']) expect(byLabel(xx(label)), label).not.toBeNull();
        expect(bracketed(host)).toBeGreaterThan(5);
        expect(bypassing()).toEqual([]);
    });

    it('the filters: Offers with Clear filters, the category tiles, Events with its date chips', async () => {
        await renderIn('xx');
        await click(byText(xx('Offers')), 'Offers');
        expect(byLabel(xx('Clear filters'))).not.toBeNull();
        await click(byLabel(xx('Filter by category')), 'the category chip');
        expect(host.textContent).toContain(xx('Education'));
        expect(bypassing(), 'tiles').toEqual([]);
        await click(host.querySelector('[data-testid="map"]'), 'a tap on the map closes the panel');
        await click(byText(xx('Events')), 'Events');
        expect(byLabel(xx('Filter events by date'))).not.toBeNull();
        expect(bypassing(), 'events').toEqual([]);
    });

    it('a listing\'s preview: its category in capitals, the Elder\'s name line, View Details, Close', async () => {
        await renderIn('xx');
        await click(marker(POSTS[0] as any), 'the eggs pin');
        expect(host.textContent).toContain('Fresh duck eggs');
        expect(host.textContent).toContain(upperCase(xx('Food'), 'xx'));
        expect(host.textContent).toContain(xx('{name} ✨ Elder').replace('{name}', 'Kofi'));
        expect(byText(xx('View Details'))).not.toBeNull();
        expect(byLabel(xx('Close preview'))).not.toBeNull();
        expect(byLabel(xx('Close'))).not.toBeNull();
        expect(bypassing()).toEqual([]);
    });

    it('an event\'s preview: its date, UPDATED, how many are going, View event', async () => {
        await renderIn('xx');
        await click(marker(POSTS[2] as any), 'the event pin');
        expect(host.textContent).toContain('Repair café');
        expect(host.textContent).toContain(xx('UPDATED'));
        expect(host.textContent).toContain(xx('{n} going').replace('{n}', '2'));
        expect(byText(xx('View event'))).not.toBeNull();
        expect(bypassing()).toEqual([]);
    });

    it('ADD POST opens the chooser; with no community it says so', async () => {
        await renderIn('xx');
        await click(buttonHolding(xx('ADD POST')), 'ADD POST');
        // The chooser is on the listing screen: the + opens it with the link the Market's rows used.
        expect(nav.pushed).toEqual([{ pathname: '/new-listing', params: { newPost: 'true' } }]);
        root.unmount();
        root = createRoot(host);
        params.now = { newPost: 'true' };
        await renderIn('xx', listing());
        expect(host.textContent).toContain(xx('Create New Post'));
        expect(bypassing(), 'the chooser').toEqual([]);
        root.unmount();
        root = createRoot(host);
        store.map.delete('beanpool_anchor_url');
        await renderIn('xx');
        await click(buttonHolding(xx('ADD POST')), 'ADD POST, no community');
        expect(said()).toEqual([xx('Not Connected'), xx('You need to connect to a BeanPool community before posting. Go to Settings → Advanced to add a node.'), xx('Cancel'), xx('Connect')]);
        expect(bypassing()).toEqual([]);
    });

    it('the New Post form: every field, the price and fee, the toggles, the reach chooser and the submit button', async () => {
        await openForm('xx');
        expect(host.textContent).toContain(xx('New Post'));
        for (const label of ['Title', 'Category', 'Description', 'Location', 'Price']) expect(host.textContent, label).toContain(upperCase(xx(label), 'xx'));
        expect(host.querySelector(`input[placeholder="${xx('What do you need/offer?')}"]`)).not.toBeNull();
        expect(host.querySelector(`input[placeholder="${xx('Describe what you need/offer...')}"]`)).not.toBeNull();
        expect(host.textContent).toContain(upperCase(xx('{n}/5 photos').replace('{n}', '0'), 'xx'));
        expect(host.textContent).toContain(xx('1.5% transaction fee funds community projects & solvency.'));
        expect(byText(xx('📂 Select a category'))).not.toBeNull();
        expect(bypassing(), 'the form').toEqual([]);

        // The price: a figure gives the fee line with the amount in it; the unit button steps through its words.
        await type(byLabel(xx('Price')), '10');
        expect(host.textContent).toContain(xx('1.5% fee: You will receive {amount} B.').replace('{amount}', '9.85'));
        await click(byText(xx('Total')), 'the unit button');
        expect(byText(xx('/ Hr'))).not.toBeNull();
        // Cash too, and the reach chooser's partners.
        await click(buttonHolding(xx('💸 Cash also needed — for fuel or materials')), 'Cash also needed');
        expect(host.textContent).toContain(xx('Cash is for fuel and consumables you paid for — not your time, not your tools. At cost, no markup. Agree the details in chat; the app never handles the money.'));
        await click(byText(xx('🤝 Chosen')), 'Chosen');
        expect(byLabel(xx('Community {name}').replace('{name}', 'Byron Bay'))).not.toBeNull();
        expect(byLabel(xx('Community {name}').replace('{name}', xx('Peer {id}').replace('{id}', '99999999')))).not.toBeNull();
        expect(host.textContent).toContain(xx('Tap a community to include it'));
        // A Need while the member must list an Offer first: the note and the button say so.
        await click(byText(xx('🟠 Need')), 'Need');
        expect(host.textContent).toContain(xx('💡 Contributions First'));
        expect(byText(xx('🟢 List an Offer first to post Needs'))).not.toBeNull();
        expect(host.textContent).toContain(xx('1.5% fee: Fulfiller receives {amount} B.').replace('{amount}', '9.85'));
        expect(bypassing(), 'the form, filled').toEqual([]);
        // The category sheet.
        await click(buttonHolding(xx('Select a category...')), 'the category field');
        expect(host.textContent).toContain(xx('Select Category'));
        expect(host.textContent).toContain(xx('Education'));
        expect(bypassing(), 'the category sheet').toEqual([]);
    });

    it('the form\'s own moments where Beans are off: the note for the price, a missing field, dropping a pin, a photo, the location, a post that fails', async () => {
        // A community with Beans off (the global one): no price, the note in the price's place. A Need asks for a photo here
        // too, as every Offer and Need does (core postRulesFor: needPhoto everywhere).
        store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: { ...LOCAL, beans: false, escrow: false }, checkedAt: new Date().toISOString() } }));
        net.answer = community({ getBalance: { isBlockedFromTrading: false }, createPost: new Error('') });
        await openForm('xx');
        expect(host.textContent).toContain(xx('No price here: say in the description what you would like in return, or that it is free.'));
        expect(byLabel(xx('Price'))).toBeNull();
        expect(bypassing(), 'the form without Beans').toEqual([]);
        // Sent with nothing filled in. The line hides itself 3 s later on a bare timer in the form, run here on a fake clock so it
        // never outlives the test: left running, it fired after the file's jsdom was gone ("window is not defined", CI 23 Oct).
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const submit = byText(xx('📂 Select a category'));
        expect(submit, 'submit').toBeTruthy();
        await act(async () => { (submit as HTMLElement).click(); });
        expect(host.textContent).toContain(xx('⚠️ Please complete all required fields'));
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        vi.useRealTimers();
        expect(host.textContent).not.toContain(xx('⚠️ Please complete all required fields'));
        // Adding a photo: the shared sheet (utils/post-photo), with Browse files on Android and closed by Back. Then the camera refused.
        await click(byLabel(xx('Add photo')), 'Add photo');
        expect(said()).toEqual([xx('Add Photo'), xx('Choose a source'), xx('Camera'), xx('Gallery'), xx('Browse files')]);
        await pressAlert(xx('Camera'));
        expect(said().at(-1)).toBe(xx('Permission needed'));
        // My location, refused, then a phone that can't find itself.
        alerts.said.length = 0;
        await click(buttonHolding(xx('My location')), 'My location');
        expect(said()).toEqual([xx('Permission Denied'), xx('Location permission was denied. Please enable it in your device settings to use your current location.'), xx('Cancel'), xx('Open Settings')]);
        alerts.said.length = 0;
        loc.granted = true;
        await click(buttonHolding(xx('My location')), 'My location, no fix');
        expect(said()).toEqual([xx('Error'), xx("Could not get your location. Try 'Drop a pin' instead.")]);
        // Dropping a pin: the banner, Cancel and Confirm Pin, then ✓ once it is down.
        await click(buttonHolding(xx('Drop a pin')), 'Drop a pin');
        expect(host.textContent).toContain(xx('📌 Tap the map to place your pin'));
        expect(byText(xx('Cancel'))).not.toBeNull();
        expect(byText(xx('Confirm Pin'))).not.toBeNull();
        expect(bypassing(), 'dropping a pin').toEqual([]);
        await click(host.querySelector('[data-testid="map"]'), 'the map, where the pin goes');
        await click(byText(xx('Confirm Pin ✓')), 'Confirm Pin ✓');
        expect(host.textContent).toContain(xx('✓ Set'));
        // A Need with every field filled, which the node refuses without a reason.
        await click(byText(xx('🟠 Need')), 'Need');
        await type(host.querySelector(`input[placeholder="${xx('What do you need/offer?')}"]`), 'A ladder');
        await type(host.querySelector(`input[placeholder="${xx('Describe what you need/offer...')}"]`), 'Two days');
        await click(buttonHolding(xx('Select a category...')), 'the category field');
        // The row itself, the innermost button holding the name (the sheet's backdrop holds every row).
        await click(Array.from(host.querySelectorAll('[data-modal] button')).filter((b) => b.textContent?.includes(xx('Tools'))).pop(), 'Tools');
        expect(host.textContent).toContain(xx('{emoji} {label}').replace('{emoji}', categoryEmoji('tools')).replace('{label}', xx('Tools')));
        // Every field filled but the photo: the button asks for one, and is not Post Need until it is there.
        expect(byText(xx('📷 Add a photo')), 'the button, asking for a photo').not.toBeNull();
        expect(byText(xx('Post Need'))).toBeNull();
        roll.gives = true;
        await click(byLabel(xx('Add photo')), 'Add photo');
        await pressAlert(xx('Gallery'));
        expect(host.textContent).toContain(upperCase(xx('{n}/5 photos').replace('{n}', '1'), 'xx'));
        alerts.said.length = 0;
        await click(byText(xx('Post Need')), 'Post Need');
        expect(said()).toEqual([xx('Error'), xx('Could not publish post.')]);
        expect(bypassing(), 'the form at the end').toEqual([]);
    });

    it('the alerts before the form: Recenter map refused, a profile to finish, an unfinished post', async () => {
        await renderIn('xx');
        await click(byLabel(xx('Recenter map')), 'Recenter map');
        expect(said()).toEqual([xx('Permission Denied'), xx('Location permission was denied. Please enable it in your device settings to center the map.'), xx('Cancel'), xx('Open Settings')]);
        root.unmount();
        root = createRoot(host);

        // The map's `?newPost=` link is passed on to the listing screen as it came, and the map opens nothing itself.
        alerts.said.length = 0;
        nav.pushed.length = 0;
        params.now = { newPost: 'offer' };
        await renderIn('xx');
        expect(nav.pushed).toEqual([{ pathname: '/new-listing', params: { newPost: 'offer' } }]);
        expect(said()).toEqual([]);
        root.unmount();
        root = createRoot(host);

        alerts.said.length = 0;
        net.answer = community({ getMemberProfile: {} });
        params.now = { newPost: 'offer' };
        await renderIn('xx', listing());
        expect(said()).toEqual([xx('Finish your profile first'), xx("Your community likes to know who they're dealing with, so you need a photo before you can post. It only takes a moment."), xx('Not now'), xx('Set up profile')]);
        root.unmount();
        root = createRoot(host);

        alerts.said.length = 0;
        net.answer = community();
        store.map.set('beanpool_offer_draft', JSON.stringify({ anchorUrl: NODE, postType: 'offer', postTitle: 'Half-written', postPhotos: [] }));
        await renderIn('xx', listing());
        expect(said()).toEqual([xx('Unfinished post'), xx('You started a post earlier. Continue it, or start fresh?'), xx('Start fresh'), xx('Continue')]);
        await pressAlert(xx('Continue'));
        expect(bypassing()).toEqual([]);
    });

    it('a build with no maps key says so in the member\'s language', async () => {
        mapsKey.on = false;
        await renderIn('xx');
        expect(host.textContent).toContain(xx('Google Maps is not configured'));
        expect(host.textContent).toContain(xx('API key is missing in build config.'));
        expect(bypassing()).toEqual([]);
    });
});

describe('the Map in English: the words are as they were', () => {
    it('the pill, ADD POST, the previews: nothing bracketed', async () => {
        await renderIn('en');
        expect(bracketed(host)).toBe(0);
        for (const pill of ['All', 'Offers', 'Needs', 'Events']) expect(byText(pill), pill).not.toBeNull();
        expect(buttonHolding('ADD POST')!.textContent).toBe('+ADD POST');
        await click(marker(POSTS[0] as any), 'the eggs pin');
        expect(host.textContent).toContain('FOOD');
        expect(host.textContent).toContain('Kofi ✨ Elder');
        expect(byText('View Details')).not.toBeNull();
        await click(byLabel('Close'), 'Close');
        await click(marker(POSTS[2] as any), 'the event pin');
        expect(host.textContent).toContain('UPDATED');
        expect(host.textContent).toContain('👥 2 going');
        expect(byText('View event')).not.toBeNull();
    });

    it('the form: the labels in capitals as the style drew them, the fee line whole, Confirm Pin', async () => {
        await openForm('en');
        expect(bracketed(host)).toBe(0);
        for (const label of ['TITLE *', 'CATEGORY *', 'DESCRIPTION *', 'LOCATION *', 'PRICE *', 'PHOTOS * (min 1)']) {
            expect(Array.from(host.querySelectorAll('span')).some((s) => s.textContent === label), label).toBe(true);
        }
        expect(host.textContent).toContain('0/5 PHOTOS');
        expect(host.textContent).toContain('🔁 Repeatable — keep listing active for ongoing bookings');
        const fee = () => Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.startsWith('1.5% '))!.textContent;
        expect(fee()).toBe('1.5% transaction fee funds community projects & solvency. Learn more ⓘ (100% community owned)');
        await type(byLabel('Price'), '10');
        expect(fee()).toBe('1.5% fee: You will receive 9.85 B. Learn more ⓘ (100% community owned)');
        expect(byText('Total')).not.toBeNull();
        expect(byText('FREE')).not.toBeNull();
        await click(byText('🤝 Chosen'), 'Chosen');
        expect(byLabel('Community Byron Bay')).not.toBeNull();
        expect(byLabel('Community Peer 99999999')).not.toBeNull();
        await click(buttonHolding('Drop a pin'), 'Drop a pin');
        expect(byText('Confirm Pin')).not.toBeNull();
        await click(host.querySelector('[data-testid="map"]'), 'the map');
        expect(byText('Confirm Pin ✓')).not.toBeNull();
    });
});

describe('words in capitals, the language\'s way (never the English rule on a translation)', () => {
    const catalog = (lang: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words', `${lang}.json`), 'utf8')) as Record<string, string>;

    it('Turkish: the form\'s CATEGORY label keeps its dotted capital "İ"; ADD POST is the catalog\'s own capitals', async () => {
        const tr = catalog('tr');
        expect(tr['Category']).toMatch(/i/);
        await openForm('tr');
        expect(host.textContent).toContain(`${tr['Category'].toLocaleUpperCase('tr')} *`);
        expect(host.textContent).not.toContain(tr['Category'].toUpperCase());
        root.unmount();
        root = createRoot(host);
        params.now = {};
        await renderIn('tr');
        expect(buttonHolding(tr['ADD POST'])).not.toBeNull();
    });
});

describe('the Map follows a language picked in Settings', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words', 'fr.json'), 'utf8')) as Record<string, string>;
    const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

    it('a pick redraws the top pill and ADD POST in French, with nothing by hand (Marty\'s screenshot, 20 Oct)', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(LanguageRow as any, { styles: MENU }), createElement(MapScreen))) as any);
        });
        await settle();
        expect(byText('Offers')).not.toBeNull();
        expect(buttonHolding('ADD POST')).not.toBeNull();
        await click(host.querySelector('[data-testid="settings-language"]'), 'Settings → Language');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        for (const pill of ['All', 'Offers', 'Needs', 'Events']) {
            expect(fr[pill], pill).toBeTruthy();
            expect(byText(fr[pill]), pill).not.toBeNull();
        }
        expect(byText('Offers')).toBeNull();
        expect(buttonHolding(fr['ADD POST'])).not.toBeNull();
        expect(buttonHolding('ADD POST')).toBeNull();
    });
});

// ── 320 dp with text at 1.3× ──────────────────────────────────────────────────────────────────────────────────────
describe('the Map at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the top pill scrolls sideways rather than clipping a longer language', async () => {
        await renderIn('xx');
        const pill = byText(xx('Offers'))!;
        expect(pill.closest('[data-horizontal]')?.getAttribute('data-horizontal')).toBe('true');
    });

    it('the form: no word wider than the sheet; what sits in a row that cannot wrap is named here', async () => {
        await openForm('xx');
        await click(byText(xx('🤝 Chosen')), 'Chosen');
        // The sheet: 320 dp less its 14 dp padding a side.
        const found = unfit(host, 320 - 2 * 14, WRITTEN);
        // The form moved as it was (MAP-FORM), its layout with it (map.tsx's go was words only, Marty, 20 Oct). These rows hold translated words
        // beside each other without wrapping; measured in xx and listed in the PR for Marty's call. Anything new fails.
        const KNOWN = [`stuck in a row: ${xx('My location')}`, `stuck in a row: ${xx('Drop a pin')}`, `stuck in a row: ${xx('New Post')}`];
        expect(found.filter((line) => !KNOWN.includes(line))).toEqual([]);
        // The sheet's title shares its row (space-between) with the 32 dp ✕ only, and fits beside it (18 dp, 0.5 letter-spacing).
        const title = xx('New Post');
        expect(widthOf(title, 18 * SCALE) + Array.from(title).length * 0.5 * SCALE + 32).toBeLessThanOrEqual(320 - 2 * 14);
    });

    it('ADD POST in xx clears the left pill on a 320 dp phone', async () => {
        await renderIn('xx');
        // The button: right 24, 20 dp padding a side, the + (20 dp text) and a 6 dp gap; the left pill: 16 + 48 dp.
        const words = widthOf(xx('ADD POST'), 13 * SCALE);
        const plus = widthOf('+', 20 * SCALE);
        expect(24 + 20 + plus + 6 + words + 20).toBeLessThanOrEqual(320 - 16 - 48 - 8);
    });
});
