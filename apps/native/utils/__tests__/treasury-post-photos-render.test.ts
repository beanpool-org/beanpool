// @vitest-environment jsdom
/**
 * Photos while posting an enterprise's Offer or Need (Damo, 26 Oct: "there is no option for that inside enterprises so you
 * have to post the offer first then go back in to add the photo"): app/treasury-post.tsx rendered for real, with the
 * member composer's photo step (components/PostPhotoRow.tsx, utils/post-photo.ts).
 *
 * The phone is asked for nothing until a photo is wanted (Marty, 26 Oct, the standing rule): opening the screen and tapping
 * the + ask for no permission; Gallery is the system photo picker and asks for none; only Camera asks, at its tap. A picked
 * photo is sent 800 px wide as a JPEG, and the Offer and the Need both carry it to the node (utils/db.ts treasuryPostOffer,
 * treasuryPostNeed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
const nav = vi.hoisted(() => ({ backs: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() { nav.backs++; }, setParams() {}, canGoBack: () => true },
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
// The device: every permission and picker call is recorded, so a test can say exactly what the phone was asked.
const device = vi.hoisted(() => ({ asked: [] as string[], cameraGranted: true }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => { device.asked.push('camera permission'); return { granted: device.cameraGranted }; },
    requestMediaLibraryPermissionsAsync: async () => { device.asked.push('library permission'); return { granted: true }; },
    getMediaLibraryPermissionsAsync: async () => { device.asked.push('library permission read'); return { granted: true }; },
    launchCameraAsync: async () => { device.asked.push('camera'); return { canceled: false, assets: [{ uri: 'file:///camera.jpg', width: 4000, height: 3000 }] }; },
    launchImageLibraryAsync: async () => { device.asked.push('picker'); return { canceled: false, assets: [{ uri: 'file:///picked.jpg', width: 3000, height: 4000 }] }; },
}));
const resized = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri: string, actions: unknown, save: unknown) => {
        resized.calls.push({ uri, actions, save });
        return { uri: `${uri}.small.jpg`, width: 800, height: 600, base64: uri.includes('camera') ? 'Q0FNRVJB' : 'UElDS0VE' };
    },
}));
const net = vi.hoisted(() => ({ calls: [] as string[], args: new Map<string, unknown[]>() }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => {
    net.args.set(name, args);
    if (name === 'treasuryPostOffer' || name === 'treasuryPostNeed') return Promise.resolve({ success: true, post: { id: 'p-new' } });
    return undefined;
}));

import { LanguageProvider } from '../../components/LanguageProvider';
import TreasuryPostScreen from '../../app/treasury-post';

const ENT = '9'.repeat(64);
const PICKED = 'data:image/jpeg;base64,UElDS0VE';
const TAKEN = 'data:image/jpeg;base64,Q0FNRVJB';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.last = [];
    device.asked.length = 0;
    device.cameraGranted = true;
    resized.calls.length = 0;
    net.calls.length = 0;
    net.args.clear();
    nav.backs = 0;
    store.map.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(mode: 'offer' | 'need') {
    params.now = { treasury: ENT, mode, name: 'Mullum Eggs', ...(mode === 'offer' ? { category: 'food' } : {}) };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(TreasuryPostScreen)) as any); });
    await settle();
}
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
async function click(el: Element | null, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
}
async function type(label: string, value: string) {
    const input = byLabel(label) as HTMLInputElement | null;
    expect(input, label).toBeTruthy();
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
/** Presses a button of the last alert, and waits for what it does (a picker, a resize). */
async function choose(text: string) {
    const b = alerts.last.find((x) => x.text === text);
    expect(b, text).toBeTruthy();
    await act(async () => { await b!.onPress?.(); });
    await settle();
}
const photosShown = () => Array.from(host.querySelectorAll('img[aria-label="Post photo"]')).map((i) => i.getAttribute('data-src'));
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;

describe("an enterprise's Offer or Need, with photos while posting it", () => {
    it('an Offer: a photo from the gallery, asked for nothing, sent with the Offer', async () => {
        await open('offer');
        expect(host.textContent).toContain('PHOTOS (0/5)');
        expect(device.asked).toEqual([]);

        await click(byLabel('Add photo'), 'Add photo');
        expect(alerts.said.slice(-5)).toEqual(['Add Photo', 'Choose a source', 'Camera', 'Gallery', 'Browse files']); // Android: Cancel is Back or a tap outside
        // Tapping + asks the phone for nothing: the member chooses first.
        expect(device.asked).toEqual([]);

        await choose('Gallery');
        // The system's photo picker, with no permission asked for, before or after.
        expect(device.asked).toEqual(['picker']);
        expect(resized.calls).toEqual([{ uri: 'file:///picked.jpg', actions: [{ resize: { width: 800 } }], save: { compress: 0.7, format: 'jpeg', base64: true } }]);
        expect(photosShown()).toEqual([PICKED]);
        expect(host.textContent).toContain('PHOTOS (1/5)');

        await type('Title', 'Dozen eggs');
        await type('Price in Beans', '6');
        await click(button('POST OFFER'), 'POST OFFER');
        expect(net.calls).toContain('db.treasuryPostOffer');
        expect(net.args.get('treasuryPostOffer')).toEqual([ENT, {
            category: 'food', title: 'Dozen eggs', description: '', credits: 6, priceType: 'fixed', repeatable: true, photos: [PICKED],
        }]);
        expect(alerts.said).toContain('Offer posted');
    });

    it('a Need: a photo from the camera, its permission asked at the Camera tap only, sent with the Need; ✕ takes one off', async () => {
        await open('need');
        await click(byLabel('Add photo'), 'Add photo');
        expect(device.asked).toEqual([]);
        await choose('Camera');
        expect(device.asked).toEqual(['camera permission', 'camera']);
        expect(photosShown()).toEqual([TAKEN]);

        await click(byLabel('Add photo'), 'Add photo');
        await choose('Browse files');
        expect(photosShown()).toEqual([TAKEN, PICKED]);
        await click(host.querySelectorAll('[aria-label="Remove photo"]')[0], 'Remove photo');
        expect(photosShown()).toEqual([PICKED]);

        await type('Title', 'Tend the flock');
        await click(byLabel('Choose a category'), 'Choose a category');
        await click(byLabel('Food'), 'Food');
        await type('Price in Beans', '10');
        await click(button('POST NEED'), 'POST NEED');
        expect(net.args.get('treasuryPostNeed')).toEqual([ENT, {
            category: 'food', title: 'Tend the flock', description: '', credits: 10, priceType: 'fixed', repeatable: false, photos: [PICKED],
        }]);
        expect(device.asked.filter((a) => a.includes('library'))).toEqual([]);
    });

    it('the camera refused: no photo, and nothing else asked; posted without one, no photos are sent', async () => {
        device.cameraGranted = false;
        await open('offer');
        await click(byLabel('Add photo'), 'Add photo');
        await choose('Camera');
        expect(device.asked).toEqual(['camera permission']);
        expect(alerts.said).toContain('Permission needed');
        expect(photosShown()).toEqual([]);

        await type('Title', 'Dozen eggs');
        await type('Price in Beans', '6');
        await click(button('POST OFFER'), 'POST OFFER');
        expect(net.args.get('treasuryPostOffer')?.[1]).not.toHaveProperty('photos');
    });

    it('five at most: the + goes once five are on', async () => {
        await open('offer');
        for (let i = 0; i < 5; i++) {
            await click(byLabel('Add photo'), 'Add photo');
            await choose('Gallery');
        }
        expect(photosShown()).toHaveLength(5);
        expect(host.textContent).toContain('PHOTOS (5/5)');
        expect(byLabel('Add photo')).toBeNull();
    });
});
