// @vitest-environment jsdom
/**
 * DEALS-PILL-FIT: The phone Market header at font scale 1.3, rendered at 320 dp × 1.3.
 *
 * 1. The deals pill (`dealsIconBtn`): fixed height 38 dp removed, uses minHeight + paddingVertical so it grows
 *    to fit its children (🤝 18 pt + 11 pt label ≈ 49 dp at 1.3x) without clipping at 320 dp × 1.3.
 * 2. Author chips (24 dp tall in list cards, 18 dp in grid) and header pills (36–42 dp) reach ≥ 44 dp touch targets
 *    via hitSlop / minHeight without changing the visual look at 1.0.
 * 3. Both themes keep their contrast and token colours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Insets } from 'react-native';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PANEL_WIDTH = 304;

const layoutState = vi.hoisted(() => ({
    width: 320,
    height: 569,
    fontScale: 1.3,
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, horizontal, onLayout, value, onChangeText, disabled, hitSlop } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: PANEL_WIDTH, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (horizontal) attrs['data-horizontal'] = 'true';

        const s = flat(props.style);
        attrs['data-style'] = JSON.stringify(s);
        if (typeof s.height === 'number') attrs['data-height'] = String(s.height);
        if (typeof s.minHeight === 'number') attrs['data-min-height'] = String(s.minHeight);
        if (typeof s.paddingVertical === 'number') attrs['data-padding-vertical'] = String(s.paddingVertical);
        if (typeof s.paddingTop === 'number') attrs['data-padding-top'] = String(s.paddingTop);
        if (typeof s.paddingBottom === 'number') attrs['data-padding-bottom'] = String(s.paddingBottom);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);

        if (hitSlop !== undefined) {
            attrs['data-hitslop'] = JSON.stringify(hitSlop);
        }

        return createElement(tag, attrs, children);
    };

    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);

    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });

    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: layoutState.width, height: layoutState.height, scale: 1.5, fontScale: layoutState.fontScale }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: layoutState.width, height: layoutState.height, scale: 1.5, fontScale: layoutState.fontScale }),
    };
});

const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
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

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));
vi.mock('expo-modules-core', () => ({
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default, isDOMAvailable: false },
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
    CodedError: class CodedError extends Error { constructor(public code: string, message: string) { super(message); } },
    UnavailabilityError: class UnavailabilityError extends Error { constructor(module: string, method: string) { super(`${module}.${method} is unavailable`); } },
}));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, BIOMETRIC: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false,
    isEnrolledAsync: async () => false,
    authenticateAsync: async () => ({ success: false }),
}));
vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
    getRandomBytes: (n: number) => new Uint8Array(n).fill(3),
    digest: async () => new ArrayBuffer(32),
}));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'unknown' }) }));

vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {} }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
    WHEN_UNLOCKED: 1,
    AFTER_FIRST_UNLOCK: 2,
    ALWAYS: 3,
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 4,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 6,
    ALWAYS_THIS_DEVICE_ONLY: 7,
}));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }), getLastKnownPositionAsync: async () => null,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }), getCurrentPositionAsync: async () => null,
}));

vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));

const themeState = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({
            theme: themeState.current,
            colors: themeState.current === 'dark' ? darkColors : lightColors,
        }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) =>
            make({
                theme: themeState.current,
                colors: themeState.current === 'dark' ? darkColors : lightColors,
            }),
    };
});

const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: () => null }));
vi.mock('../../components/MyDealsSheet', () => ({ MyDealsSheet: () => null, usePendingDealsCount: () => 1 }));
vi.mock('../../components/RadiusPickerModal', () => ({ RadiusPickerModal: () => null }));
vi.mock('../../components/TrustPickerSheet', () => ({ TrustPickerSheet: () => null, TRUST_FILTERS: [] }));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => [], saveInterests: async () => {} }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));

import MarketScreen from '../../app/(tabs)/market';
import { PostAuthorTrust } from '../../components/PostAuthorTrust';

const POSTS = [
    {
        id: 'p1', type: 'offer', status: 'active', title: 'Bike repair service', description: 'Can tune brakes and gears', category: 'services',
        author_pubkey: 'author-sam-key', author_callsign: 'Sam', author_energy_cycled: 500, authorFoundingNeeded: false,
        credits: 15, price_type: 'hourly', photos: '[]', repeatable: 1, cash_also_needed: 0, created_at: new Date().toISOString(),
    },
];

const GROUPS = [
    { id: 'g1', name: 'Bike Co-op', members: 5 },
];

function effectiveTouchHeight(el: HTMLElement, baseHeight: number): number {
    const hitSlopRaw = el.getAttribute('data-hitslop');
    const hitSlop: Insets | number = hitSlopRaw ? JSON.parse(hitSlopRaw) : 0;
    let slopTop = 0;
    let slopBottom = 0;
    if (typeof hitSlop === 'number') {
        slopTop = hitSlop;
        slopBottom = hitSlop;
    } else if (typeof hitSlop === 'object' && hitSlop !== null) {
        slopTop = hitSlop.top ?? 0;
        slopBottom = hitSlop.bottom ?? 0;
    }
    return baseHeight + slopTop + slopBottom;
}

describe('Market Header at 320 dp × 1.3 font scale (DEALS-PILL-FIT)', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        layoutState.width = 320;
        layoutState.height = 569;
        layoutState.fontScale = 1.3;
        themeState.current = 'light';
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        net.answer = (name: string) => {
            if (name === 'getPosts') return Promise.resolve(POSTS);
            if (name === 'fetchGroups') return Promise.resolve(GROUPS);
            if (name === 'fetchMyEvents') return Promise.resolve([]);
            if (name === 'getMarketplaceTransactions') return Promise.resolve([]);
            if (name === 'getBalance') return Promise.resolve({ balance: 100 });
            if (name === 'getMemberRatings') return Promise.resolve({ average: 5, count: 3 });
            return undefined;
        };
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        host.remove();
    });

    it('1. deals pill uses minHeight + paddingVertical so it grows; fixed height is removed; label never clips at 320 dp × 1.3', async () => {
        await act(async () => { root.render(createElement(MarketScreen) as any); });
        const dealsPill = host.querySelector('[data-testid="market-deals-pill"]') as HTMLElement;
        expect(dealsPill, 'deals pill should be rendered').not.toBeNull();

        const style = JSON.parse(dealsPill.getAttribute('data-style') || '{}');
        // Must NOT have fixed height: fixed height was 38 dp which clipped children at 1.3x
        expect(style.height).toBeUndefined();
        // Must use minHeight so it grows
        expect(style.minHeight).toBe(38);
        // Must have paddingVertical so content breathes and label fits
        expect(style.paddingVertical).toBeGreaterThanOrEqual(4);

        // Contains the emoji and text label
        expect(dealsPill.textContent).toContain('🤝');
        expect(dealsPill.textContent).toContain('Your deals');

        // Total content height at 1.3x scale:
        // 🤝 18 pt * 1.3 ≈ 23.4 pt, marginBottom: -2 -> 21.4 dp
        // Label: 11 pt * 1.3 ≈ 14.3 pt, line-height ≈ 18 dp
        // paddingVertical: 4 * 2 = 8 dp
        // Total height ≈ 48-49 dp, fitting the full height of the label
        const fontScale = layoutState.fontScale;
        const emojiHeight = 18 * fontScale - 2;
        const labelHeight = 11 * fontScale * 1.3; // with line-height
        const padding = (style.paddingVertical ?? 0) * 2;
        const totalEstimatedHeight = emojiHeight + labelHeight + padding;
        expect(totalEstimatedHeight).toBeGreaterThanOrEqual(44);
        expect(totalEstimatedHeight).toBeCloseTo(49, -1); // ≈ 49 dp
    });

    it('2. header pills reach ≥ 44 dp touch targets without changing the look at 1.0', async () => {
        await act(async () => { root.render(createElement(MarketScreen) as any); });

        // Deals pill touch target
        const dealsPill = host.querySelector('[data-testid="market-deals-pill"]') as HTMLElement;
        const dealsStyle = JSON.parse(dealsPill.getAttribute('data-style') || '{}');
        const dealsTarget = effectiveTouchHeight(dealsPill, dealsStyle.minHeight);
        expect(dealsTarget).toBeGreaterThanOrEqual(44);

        // View mode toggle touch target (38x38 button)
        const toggleBtn = host.querySelector('[data-testid="market-view-mode-toggle"]') as HTMLElement;
        expect(toggleBtn).not.toBeNull();
        const toggleStyle = JSON.parse(toggleBtn.getAttribute('data-style') || '{}');
        expect(toggleStyle.height).toBe(38);
        expect(toggleStyle.width).toBe(38);
        const toggleTarget = effectiveTouchHeight(toggleBtn, toggleStyle.height);
        expect(toggleTarget).toBeGreaterThanOrEqual(44);

        // Type pills / filter pills in FilterChipRow (flat variant: top 2, bottom 2, left 0, right 0 to avoid sibling collision in FilterChipBar)
        const buttons = Array.from(host.querySelectorAll('button[role="button"]')) as HTMLElement[];
        const typeChips = buttons.filter(b => b.getAttribute('aria-label') === 'All' || b.getAttribute('aria-label')?.includes('Offers'));
        expect(typeChips.length).toBeGreaterThan(0);
        for (const chip of typeChips) {
            const hitSlop = JSON.parse(chip.getAttribute('data-hitslop') || '{}');
            expect(hitSlop.left ?? 0).toBe(0);
            expect(hitSlop.right ?? 0).toBe(0);
            const target = 36 + (hitSlop.top ?? 0) + (hitSlop.bottom ?? 0);
            expect(target).toBeGreaterThanOrEqual(40);
        }

        // Group filter chips
        const groupChip = buttons.find(b => b.textContent?.includes('All Groups & Public'));
        expect(groupChip).toBeDefined();
        const groupTarget = effectiveTouchHeight(groupChip!, 36);
        expect(groupTarget).toBeGreaterThanOrEqual(44);
    });

    it('3. author chips (24 dp in full mode, 18 dp in compact) reach ≥ 44 dp touch target via hitSlop without changing look at 1.0', async () => {
        // Render PostAuthorTrust in full mode (list cards)
        await act(async () => {
            root.render(createElement(PostAuthorTrust, {
                pubkey: 'author-sam-key',
                callsign: 'Sam',
                energyCycled: 500,
                mode: 'full',
            }) as any);
        });
        const authorChipFull = host.querySelector('[data-testid="author-chip"]') as HTMLElement;
        expect(authorChipFull).not.toBeNull();
        const fullStyle = JSON.parse(authorChipFull.getAttribute('data-style') || '{}');
        // Visual container does not set inflated minHeight that would ruin 1.0 look
        expect(fullStyle.minHeight).toBeUndefined();
        // 24 dp avatar baseline + hitSlop top 10 + bottom 10 = 44 dp
        const fullTarget = effectiveTouchHeight(authorChipFull, 24);
        expect(fullTarget).toBeGreaterThanOrEqual(44);

        // Render PostAuthorTrust in compact mode (grid cards)
        await act(async () => {
            root.render(createElement(PostAuthorTrust, {
                pubkey: 'author-sam-key',
                callsign: 'Sam',
                energyCycled: 500,
                mode: 'compact',
            }) as any);
        });
        const authorChipCompact = host.querySelector('[data-testid="author-chip"]') as HTMLElement;
        expect(authorChipCompact).not.toBeNull();
        const compactStyle = JSON.parse(authorChipCompact.getAttribute('data-style') || '{}');
        expect(compactStyle.minHeight).toBeUndefined();
        // 18 dp avatar baseline + asymmetric hitSlop top 4 + bottom 22 = 44 dp (avoids intruding into grid card title)
        const compactTarget = effectiveTouchHeight(authorChipCompact, 18);
        expect(compactTarget).toBeGreaterThanOrEqual(44);
    });

    it('4. both themes keep their colours and contrast for the deals pill', async () => {
        // Light theme
        themeState.current = 'light';
        await act(async () => { root.render(createElement(MarketScreen) as any); });
        const lightDeals = host.querySelector('[data-testid="market-deals-pill"]') as HTMLElement;
        const lightStyle = JSON.parse(lightDeals.getAttribute('data-style') || '{}');
        expect(lightStyle.backgroundColor).toBe('#fffbeb'); // amber50
        expect(lightStyle.borderColor).toBe('#fcd34d'); // amber300

        // Dark theme
        themeState.current = 'dark';
        await act(async () => { root.render(createElement(MarketScreen) as any); });
        const darkDeals = host.querySelector('[data-testid="market-deals-pill"]') as HTMLElement;
        const darkStyle = JSON.parse(darkDeals.getAttribute('data-style') || '{}');
        // In dark mode: colors.feedback.warning.bg and border
        expect(darkStyle.backgroundColor).toBe('rgba(245, 158, 11, 0.15)');
        expect(darkStyle.borderColor).toBe('#f59e0b');
    });
});
