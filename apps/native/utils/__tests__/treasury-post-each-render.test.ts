// @vitest-environment jsdom
/**
 * An enterprise's own goods priced for each one, from its own form on the phone (scratch/fable-design/DESIGN-stall-consignment-
 * fable.md §6 slice 5; Marty, 26 Nov 2026): app/treasury-post.tsx rendered for real. On an Offer, where the node says it takes
 * them up (`perItem`), the unit button cycles core's list (Total, Each, per hour …), and Each shows the member's own boxes
 * (components/PerItemFields: how many, and an optional price for all of them) with core's rules (per-item-form), drops
 * Recurring (the count takes its place), and sends what the member's own create form sends: `priceType: 'each'`, the price for
 * one, `unitsLeft` and `lot` (utils/db.ts treasuryPostOffer -> POST /api/treasury/:treasury/offer, which passes them through).
 * The web's enterprise form sends the same body for the same boxes (apps/pwa TreasuryDetailPage.each.test.tsx, the parity).
 * A Need never offers Each, and nor does a node that doesn't say `perItem`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { perItemRefusalText } from '@beanpool/core';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Every alert's title and buttons, and the last alert's buttons (to press one). */
const alerts = vi.hoisted(() => ({ said: [] as string[], last: [] as Array<{ text?: string; onPress?: () => unknown }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox' };
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled, source } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (source?.uri) attrs['data-src'] = source.uri;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
                alerts.last = buttons ?? [];
            },
        },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
        ErrorBoundary: () => null,
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardStickyView: pass, KeyboardController: { dismiss: async () => {} } };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    getMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: async () => ({ canceled: true, assets: [] }),
    launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///jam.jpg', width: 3000, height: 4000 }] }),
}));
vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri: string) => ({ uri: `${uri}.small.jpg`, width: 800, height: 600, base64: 'SkFN' }),
}));
// What the node says it does: the phone's copy of its features answer (utils/use-node-profile.ts), set per test.
const node = vi.hoisted(() => ({ features: null as Record<string, unknown> | null }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => (node.features ? { profile: 'local', features: node.features } : null) }));
const net = vi.hoisted(() => ({ calls: [] as string[], args: new Map<string, unknown[]>() }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => {
    net.args.set(name, args);
    if (name === 'treasuryPostOffer' || name === 'treasuryPostNeed') return Promise.resolve({ success: true, post: { id: 'p-new' } });
    return undefined;
}));

import { LanguageProvider } from '../../components/LanguageProvider';
import TreasuryPostScreen from '../../app/treasury-post';

const ENT = '9'.repeat(64);
const PICKED = 'data:image/jpeg;base64,SkFN';
const PER_ITEM_NODE = { beans: true, escrow: true, enterprises: true, perItem: true };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.last = [];
    net.calls.length = 0;
    net.args.clear();
    store.map.clear();
    node.features = PER_ITEM_NODE;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(mode: 'offer' | 'need') {
    params.now = { treasury: ENT, mode, name: 'Riverside stall', category: 'food' };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(TreasuryPostScreen)) as any); });
    await settle();
}
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(el: Element | null, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
}
async function typeInto(input: HTMLElement | null, value: string, what: string) {
    expect(input, what).toBeTruthy();
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;
/** The unit button, found by what a screen reader says of it. */
const unitButton = () => host.querySelector('[aria-label^="Price type: "]') as HTMLElement | null;
/** The units the button goes through from Total, one tap at a time, back to Total. */
async function unitsCycled(): Promise<string[]> {
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
        seen.push(unitButton()!.textContent!.trim());
        await click(unitButton(), 'the unit button');
        if (unitButton()!.textContent!.trim() === seen[0]) break;
    }
    return seen;
}
async function addPhoto() {
    await click(byLabel('Add photo'), 'Add photo');
    const gallery = alerts.last.find((x) => x.text === 'Gallery');
    expect(gallery, 'Gallery').toBeTruthy();
    await act(async () => { await gallery!.onPress?.(); });
    await settle();
}
const recurringShown = () => host.textContent?.includes('Recurring — stays live after each deal') ?? false;

describe("an enterprise's Offer priced for each one, on the phone", () => {
    it('the unit button offers Each right after Total on an Offer, and Each shows the count and the price for all, with no Recurring', async () => {
        await open('offer');
        // Red if the screen keeps its own five units instead of core's list (priceUnitsOffered).
        expect(await unitsCycled()).toEqual(['Total', 'Each', '/hr', '/day', '/wk', '/mo']);
        expect(byTestId('per-item-fields')).toBeNull();
        expect(recurringShown()).toBe(true);

        await click(unitButton(), 'to Each');
        expect(unitButton()!.textContent).toBe('Each');
        expect(unitButton()!.getAttribute('aria-label')).toBe('Price type: Each. Tap to change.');
        expect(host.textContent).toContain('PRICE FOR ONE');
        expect(byTestId('per-item-count')).not.toBeNull();
        expect(byTestId('per-item-lot')).not.toBeNull();
        expect(host.textContent).toContain('HOW MANY DO YOU HAVE?');
        expect(host.textContent).toContain('Leave this empty to sell them one by one only.');
        // Each has no Recurring: the count takes its place (DESIGN-per-item-price-fable.md D4).
        expect(recurringShown()).toBe(false);
    });

    it('6.50 each, 12 of them, all 12 for 70: sent as the member\'s own create form sends it, never Recurring', async () => {
        await open('offer');
        await addPhoto();
        await typeInto(byLabel('Title'), 'Plum jam', 'Title');
        await click(unitButton(), 'to Each');
        await typeInto(byLabel('Price in Beans'), '6.50', 'the price for one');
        await typeInto(byTestId('per-item-count'), '12', 'how many');
        await typeInto(byTestId('per-item-lot'), '70', 'the price for all');
        expect(byTestId('per-item-hint')?.textContent).toBe('All 12 for 70 Beans. One by one they come to 78.');
        await click(button('POST OFFER'), 'POST OFFER');
        // The same body the web's enterprise form sends for the same boxes (TreasuryDetailPage.each.test.tsx).
        expect(net.args.get('treasuryPostOffer')).toEqual([ENT, {
            category: 'food', title: 'Plum jam', description: '', price_c: 650, priceType: 'each', repeatable: false,
            unitsLeft: 12, lot: { price_c: 7000 }, photos: [PICKED],
        }]);
        expect(alerts.said).toContain('Offer posted');
    });

    it('Total -> Each carries the figure typed as the Total into the price for all, and a count alone sends no price for all', async () => {
        await open('offer');
        await addPhoto();
        await typeInto(byLabel('Title'), 'Quince paste', 'Title');
        await typeInto(byLabel('Price in Beans'), '70', 'the Total');
        await click(unitButton(), 'to Each');
        expect((byLabel('Price in Beans') as HTMLInputElement).value).toBe('');
        expect((byTestId('per-item-lot') as HTMLInputElement).value).toBe('70');
        await typeInto(byTestId('per-item-lot'), '', 'the price for all, emptied');
        await typeInto(byLabel('Price in Beans'), '4', 'the price for one');
        await typeInto(byTestId('per-item-count'), '30', 'how many');
        await click(button('POST OFFER'), 'POST OFFER');
        expect(net.args.get('treasuryPostOffer')).toEqual([ENT, {
            category: 'food', title: 'Quince paste', description: '', price_c: 400, priceType: 'each', repeatable: false, unitsLeft: 30, photos: [PICKED],
        }]);
    });

    it('a count the node would refuse stops the post, with the node\'s own sentence under the box', async () => {
        await open('offer');
        await addPhoto();
        await typeInto(byLabel('Title'), 'Plum jam', 'Title');
        await click(unitButton(), 'to Each');
        await typeInto(byLabel('Price in Beans'), '6.50', 'the price for one');
        for (const bad of ['', '0', '2.5', '10000']) {
            await typeInto(byTestId('per-item-count'), bad, `count ${bad}`);
            await click(button('POST OFFER'), 'POST OFFER');
            expect(byTestId('per-item-refusal')?.textContent, `count "${bad}"`).toBe(perItemRefusalText({ code: 'units_refused' }));
        }
        await typeInto(byTestId('per-item-count'), '12', 'how many');
        await typeInto(byTestId('per-item-lot'), '78.01', 'a price for all above one by one');
        await click(button('POST OFFER'), 'POST OFFER');
        expect(byTestId('per-item-refusal')?.textContent).toBe(perItemRefusalText({ code: 'lot_not_less', count: 12, total_c: 7800 }));
        expect(net.calls).not.toContain('db.treasuryPostOffer');
    });

    it('a Total Offer is sent exactly as before, Recurring and all', async () => {
        await open('offer');
        await addPhoto();
        await typeInto(byLabel('Title'), 'Dozen eggs', 'Title');
        await typeInto(byLabel('Price in Beans'), '6', 'the Total');
        await click(button('POST OFFER'), 'POST OFFER');
        expect(net.args.get('treasuryPostOffer')).toEqual([ENT, {
            category: 'food', title: 'Dozen eggs', description: '', price_c: 600, priceType: 'fixed', repeatable: true, photos: [PICKED],
        }]);
    });

    it('a Need never offers Each, and nor does a node that does not say perItem', async () => {
        await open('need');
        expect(await unitsCycled()).toEqual(['Total', '/hr', '/day', '/wk', '/mo']);
        act(() => root.unmount());
        root = createRoot(host);
        for (const features of [{ beans: true, escrow: true }, { beans: true, perItem: false }, null]) {
            node.features = features;
            await open('offer');
            expect(await unitsCycled(), JSON.stringify(features)).toEqual(['Total', '/hr', '/day', '/wk', '/mo']);
            expect(byTestId('per-item-fields')).toBeNull();
            act(() => root.unmount());
            root = createRoot(host);
        }
    });
});
