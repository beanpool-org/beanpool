// @vitest-environment jsdom
/**
 * Tests for banner-after-start:
 * 1. start an enterprise → lands on its page (/treasury-detail)
 * 2. a keeper sees the button with no banner ("Add a banner photo" + "Not now")
 * 3. not with a banner
 * 4. not as a non-keeper
 * 5. the button opens the crop step and saving sets the banner
 * 6. Not now hides it and stays hidden after a reload
 * 7. starting a project still lands where it did (Alert -> router.back)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('@react-native-community/datetimepicker', () => ({
    default: () => null,
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardController: { dismiss: vi.fn(async () => {}) },
    KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useKeyboardState: (fn: (s: { isVisible: boolean }) => boolean) => fn({ isVisible: false }),
}));

const alerts = vi.hoisted(() => ({
    said: [] as string[],
    last: [] as Array<{ text?: string; onPress?: () => void }>,
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', checkbox: 'checkbox', alert: 'alert', tab: 'tab' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter(Boolean));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, placeholder, onLayout, value, onChangeText, disabled, numberOfLines, editable } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (editable === false) attrs.readOnly = true;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (numberOfLines !== undefined) attrs['data-lines'] = String(numberOfLines);
        if (placeholder) attrs.placeholder = placeholder;
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        KeyboardAvoidingView: el('div'),
        PanResponder: { create: () => ({ panHandlers: {} }) },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                alerts.last = buttons ?? [];
                if (buttons && buttons[0]?.onPress) {
                    buttons[0].onPress();
                }
            },
        },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
const nav = vi.hoisted(() => ({
    pushes: [] as unknown[],
    replaces: [] as unknown[],
    backs: 0,
}));

vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: {
            push(to: unknown) { nav.pushes.push(to); },
            replace(to: unknown) { nav.replaces.push(to); },
            navigate() {},
            back() { nav.backs++; },
            setParams() {},
            canGoBack: () => true,
        },
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

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('expo-image', () => ({
    Image: ({ source, accessibilityLabel }: { source?: { uri?: string }; accessibilityLabel?: string }) =>
        createElement('img', { src: source?.uri, 'aria-label': accessibilityLabel }),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors(), patternEnabled: false }),
    };
});

const ME = '1'.repeat(64);
const OTHER = '2'.repeat(64);
const ENT = '7'.repeat(64);
const me = vi.hoisted(() => ({ identity: { publicKey: '1'.repeat(64), callsign: 'Ana' } as Record<string, string> | null }));
vi.mock('../identity', () => ({ loadIdentity: async () => me.identity }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ size }: { size?: number }) => createElement('span', { 'data-avatar': String(size ?? '') }) }));
vi.mock('../node-post', () => ({ signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}), anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null }));

const net = vi.hoisted(() => ({
    createEnterpriseApi: vi.fn(async (_data: any) => ({ success: true, publicKey: ENT })),
    changeEnterpriseShop: vi.fn(async (_treasury: string, _changes: any) => ({ success: true, shop: { photoUrl: 'data:image/jpeg;base64,CROPPED_BANNER' } })),
    getTreasuryDetail: vi.fn(),
    getBalance: vi.fn(async () => ({ balance: 10, keeperOf: [ENT] })),
    getEnterpriseThread: vi.fn(async () => ({ conversation: null, messages: [], readOnly: false })),
    getEnterpriseLedger: vi.fn(async () => null),
    getEnterpriseDecisions: vi.fn(async () => null),
    signedGet: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

vi.mock('../db', () => ({
    createEnterpriseApi: net.createEnterpriseApi,
    changeEnterpriseShop: net.changeEnterpriseShop,
    getTreasuryDetail: net.getTreasuryDetail,
    getBalance: net.getBalance,
    getEnterpriseThread: net.getEnterpriseThread,
    getEnterpriseLedger: net.getEnterpriseLedger,
    getEnterpriseDecisions: net.getEnterpriseDecisions,
    signedGet: net.signedGet,
}));

vi.mock('../blocklist', () => ({ blockUser: async () => true, isUserBlocked: async () => false }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ features: { beans: true, enterprises: true } }) }));
vi.mock('../node-profile', () => ({
    getCachedNodeProfile: vi.fn(async () => ({ features: { beans: true, enterprises: true } })),
    showcaseMode: () => false,
}));
vi.mock('../use-reader-features', () => ({ useReaderFeatures: () => ({ known: true, features: { beans: true, enterprises: true } }) }));
vi.mock('../../components/useModalKeyboardLift', () => ({ useModalKeyboardLift: () => ({ maxHeight: 600, lift: 0 }) }));
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: () => createElement('span', null, 'Beans') }));
vi.mock('../../components/Sentence', () => ({ Sentence: ({ text }: { text: string }) => createElement('span', null, text) }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (w: string) => w }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: () => null,
    LocalCommunitySheet: () => null,
    ExampleHeader: () => null,
}));

const bannerCropMock = vi.hoisted(() => ({
    nextCrop: 'data:image/jpeg;base64,CROPPED_BANNER' as string | null,
}));

vi.mock('../banner-photo', () => ({
    pickBannerPhoto: vi.fn(async (_crop: any) => bannerCropMock.nextCrop),
}));

import ProposeProjectScreen from '../../app/propose-project';
import TreasuryDetailScreen from '../../app/treasury-detail';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.pushes.length = 0;
    nav.replaces.length = 0;
    nav.backs = 0;
    alerts.said.length = 0;
    alerts.last.length = 0;
    params.now = {};
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    me.identity = { publicKey: ME, callsign: 'Ana' };
    vi.clearAllMocks();
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function mount(element: any) {
    await act(async () => { root!.render(element); });
    for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
}

const typeInput = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

function sampleEnterprise(over: Record<string, any> = {}) {
    return {
        publicKey: ENT,
        name: 'Community Bakery',
        purpose: 'Fresh bread for the community.',
        lifecycle: 'ongoing',
        status: 'active',
        paused: false,
        balance: 50,
        creditLine: 50,
        liveOffers: 1,
        keepers: [{ publicKey: ME, callsign: 'Ana', role: 'lead' }],
        shop: {
            id: 'shop-1',
            name: 'Community Bakery',
            ownerPublicKey: ENT,
            photoUrl: null, // no banner
            category: 'food',
        },
        posts: [],
        ...over,
    };
}

describe('banner-after-start (Native)', () => {
    it('1. start an enterprise → lands on its page (/treasury-detail)', async () => {
        params.now = { kind: 'ongoing' };
        net.createEnterpriseApi.mockResolvedValueOnce({
            success: true,
            publicKey: 'new-ent-456',
            name: 'New Bakery',
            purpose: 'Fresh daily bread',
            lifecycle: 'ongoing',
        } as any);

        await mount(createElement(ProposeProjectScreen));

        await typeInput(host!.querySelector('input[aria-label="Enterprise name or project title"]'), 'New Bakery');
        await typeInput(host!.querySelector('input[aria-label="Purpose statement"]'), 'Fresh daily bread');

        const submitBtn = Array.from(host!.querySelectorAll('button')).find(b =>
            /start initiative|start the enterprise/i.test(b.getAttribute('aria-label') || b.textContent || '')
        );
        expect(submitBtn).toBeDefined();

        await act(async () => { submitBtn!.click(); });

        expect(net.createEnterpriseApi).toHaveBeenCalledWith(expect.objectContaining({
            lifecycle: 'ongoing',
            name: 'New Bakery',
            purpose: 'Fresh daily bread',
        }));

        // Lands on its page (/treasury-detail with publicKey)
        expect(nav.replaces).toContainEqual(expect.objectContaining({
            pathname: '/treasury-detail',
            params: expect.objectContaining({ publicKey: 'new-ent-456' }),
        }));
    });

    it('7. starting a project still lands where it did (Alert -> router.back)', async () => {
        params.now = { kind: 'bounded' };
        net.createEnterpriseApi.mockResolvedValueOnce({
            success: true,
            publicKey: 'new-proj-789',
            name: 'Solar Panel Project',
            purpose: 'Solar on the hall roof',
            lifecycle: 'bounded',
        } as any);

        await mount(createElement(ProposeProjectScreen));

        await typeInput(host!.querySelector('input[aria-label="Enterprise name or project title"]'), 'Solar Panel Project');
        await typeInput(host!.querySelector('input[aria-label="Purpose statement"]'), 'Solar on the hall roof');
        await typeInput(host!.querySelector('input[aria-label="Funding goal amount"]'), '1000');

        const submitBtn = Array.from(host!.querySelectorAll('button')).find(b =>
            /start initiative|start project/i.test(b.getAttribute('aria-label') || b.textContent || '')
        );
        expect(submitBtn).toBeDefined();

        await act(async () => { submitBtn!.click(); });

        expect(net.createEnterpriseApi).toHaveBeenCalledWith(expect.objectContaining({
            lifecycle: 'bounded',
            name: 'Solar Panel Project',
        }));

        // Alerts "Project started 🌱" and navigates back (not to /treasury-detail)
        expect(alerts.said).toContain('Project started 🌱');
        expect(nav.backs).toBeGreaterThanOrEqual(1);
        expect(nav.replaces).toHaveLength(0);
    });

    it('2. a keeper sees the button with no banner', async () => {
        params.now = { publicKey: ENT, name: 'Community Bakery' };
        net.getTreasuryDetail.mockResolvedValue(sampleEnterprise({ shop: { photoUrl: null } }));
        net.getBalance.mockResolvedValue({ balance: 10, keeperOf: [ENT] });

        await mount(createElement(TreasuryDetailScreen));

        const addBannerBtn = Array.from(host!.querySelectorAll('button, span, div')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtn).toBeDefined();

        const notNowBtn = Array.from(host!.querySelectorAll('button, span, div')).find(el =>
            /Not now/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(notNowBtn).toBeDefined();
    });

    it('3. not with a banner', async () => {
        params.now = { publicKey: ENT, name: 'Community Bakery' };
        net.getTreasuryDetail.mockResolvedValue(sampleEnterprise({
            shop: { photoUrl: 'https://mullum.example/api/banner.jpg' },
        }));
        net.getBalance.mockResolvedValue({ balance: 10, keeperOf: [ENT] });

        await mount(createElement(TreasuryDetailScreen));

        const addBannerBtn = Array.from(host!.querySelectorAll('button, span, div')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtn).toBeUndefined();
    });

    it('4. not as a non-keeper', async () => {
        params.now = { publicKey: ENT, name: 'Community Bakery' };
        // Viewer is OTHER, not in keepers and not in keeperOf
        me.identity = { publicKey: OTHER, callsign: 'Bob' };
        net.getTreasuryDetail.mockResolvedValue(sampleEnterprise({
            keepers: [{ publicKey: ME, callsign: 'Ana', role: 'lead' }],
            shop: { photoUrl: null },
        }));
        net.getBalance.mockResolvedValue({ balance: 10, keeperOf: [] });

        await mount(createElement(TreasuryDetailScreen));

        const addBannerBtn = Array.from(host!.querySelectorAll('button, span, div')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtn).toBeUndefined();
    });

    it('5. the button opens the crop step and saving sets the banner', async () => {
        params.now = { publicKey: ENT, name: 'Community Bakery' };
        const entData = sampleEnterprise({ shop: { photoUrl: null } });
        net.getTreasuryDetail.mockResolvedValue(entData);
        net.getBalance.mockResolvedValue({ balance: 10, keeperOf: [ENT] });

        await mount(createElement(TreasuryDetailScreen));

        const addBannerBtn = Array.from(host!.querySelectorAll('button')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtn).toBeDefined();

        await act(async () => { addBannerBtn!.click(); });

        expect(net.changeEnterpriseShop).toHaveBeenCalledWith(ENT, {
            photo: 'data:image/jpeg;base64,CROPPED_BANNER',
        });

        // After saving, button goes
        const addBannerBtnAfter = Array.from(host!.querySelectorAll('button')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtnAfter).toBeUndefined();
    });

    it('6. Not now hides it and stays hidden after a reload', async () => {
        params.now = { publicKey: ENT, name: 'Community Bakery' };
        net.getTreasuryDetail.mockResolvedValue(sampleEnterprise({ shop: { photoUrl: null } }));
        net.getBalance.mockResolvedValue({ balance: 10, keeperOf: [ENT] });

        await mount(createElement(TreasuryDetailScreen));

        const notNowBtn = Array.from(host!.querySelectorAll('button')).find(el =>
            /Not now/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(notNowBtn).toBeDefined();

        await act(async () => { notNowBtn!.click(); });

        // Hidden immediately
        const addBannerBtnAfter = Array.from(host!.querySelectorAll('button')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtnAfter).toBeUndefined();

        // Stays hidden after remount/reload
        act(() => root?.unmount());
        host?.remove();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);

        await mount(createElement(TreasuryDetailScreen));

        const addBannerBtnReload = Array.from(host!.querySelectorAll('button')).find(el =>
            /Add a banner photo/i.test(el.textContent || el.getAttribute('aria-label') || '')
        );
        expect(addBannerBtnReload).toBeUndefined();
    });
});
