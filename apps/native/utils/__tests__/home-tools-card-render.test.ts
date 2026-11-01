// @vitest-environment jsdom
/**
 * Render test for "Your tools" card on Home (home-tools-card):
 * - The card is offered in Add a card sheet
 * - Add puts it on Home
 * - A tool can be added and removed
 * - A tap opens that tool (real openTool through router.push)
 * - An unknown tool id is skipped without crashing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, value, onValueChange, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onValueChange) attrs.onClick = () => onValueChange(!value);
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        ScrollView: el('div'),
        Switch: el('button'),
        TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        RefreshControl: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        Animated: { View: el('div'), Value: class Value { constructor(public v: number) {} setValue(v: number) { this.v = v; } interpolate() { return 0; } }, timing: () => ({ start: (cb?: () => void) => cb?.() }) },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        AccessibilityInfo: { isReduceMotionEnabled: vi.fn(async () => true), announceForAccessibility: vi.fn(), sendAccessibilityEvent: vi.fn() },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

const nav = vi.hoisted(() => ({
    params: {} as Record<string, string>,
    router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), setParams: vi.fn() },
}));

vi.mock('expo-router', () => ({
    router: nav.router,
    useLocalSearchParams: () => nav.params,
    useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
    useFocusEffect: (cb: () => void | (() => void)) => {
        useEffect(() => {
            const leave = cb();
            return typeof leave === 'function' ? leave : undefined;
        }, [cb]);
    },
}));

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: (pick: (s: any) => unknown) => pick({ height: 0, isVisible: false }) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(k => mem.store.delete(k)); }),
    },
}));

vi.mock('../../utils/pulse-token-store', () => ({ forgetAllPulseTokens: vi.fn(async () => undefined) }));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});
vi.mock('../../components/PageTitle', () => ({
    PageTitle: ({ title }: { title: string }) => createElement('h1', null, title),
    useTabRetapScrollTop: () => {},
}));
vi.mock('../../components/OneWayBackCard', () => ({ OneWayBackCard: () => null }));
vi.mock('../../components/KeyMovedCard', () => ({ KeyMovedCard: () => null }));
vi.mock('../../components/NewPostTypeSheet', () => ({ NewPostTypeSheet: () => null }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/NeedsYouIcons', () => ({ goToNeedsTarget: vi.fn() }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: vi.fn(), dialog: null }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../../utils/db', () => ({
    getMarketplaceTransactions: vi.fn(async () => []),
    getUnreadByConversation: vi.fn(async () => []),
    getDb: vi.fn(async () => ({
        getFirstAsync: vi.fn(async () => null),
        getAllAsync: vi.fn(async () => []),
        runAsync: vi.fn(async () => ({})),
    })),
}));
vi.mock('../../utils/pulse', () => ({ resolvePulseThumbnailUrl: () => null }));
vi.mock('expo-local-authentication', () => ({}));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
}));

import HomeScreen from '../../app/(tabs)/index';
import { draftIdentity } from '../identity';
import { announceAccountOnPhone } from '../account-on-phone';
import { resetHomeStoreForTests } from '../home-store';
import { resetHomeAccountForTests } from '../home-account';
import type { HomeAnswer } from '../home-cards';
import * as nodePost from '../node-post';

const NODE = 'https://mullum.beanpool.org';
const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };

function makeAnswer(cards: any[] = []): HomeAnswer {
    const now = Date.now();
    return {
        generatedAt: new Date(now).toISOString(),
        profile: 'local',
        features: { beans: true, escrow: true, invites: true, decisions: true },
        me: {
            joinedAt: new Date(now - 86400000).toISOString(),
            isKeeper: false,
            probation: null,
            interests: [],
            area: null,
            firstOffer: false,
            standing: 'member',
            tour: TOUR_ENDED,
        },
        layout: {
            v: 2,
            cards: cards.length > 0 ? cards : [{ id: 'needs', type: 'needs' }, { id: 'community', type: 'community' }],
            dismissed: {},
            updatedAt: '2026-10-01T00:00:00.000Z',
        },
        cards: {
            needs: { items: [] },
            community: { name: 'Mullumbimby', members: 10, tradesThisMonth: 0 },
        },
    };
}

describe('Home: Your tools card on phone (home-tools-card)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let activeAnswer: HomeAnswer;

    beforeEach(async () => {
        mem.store.clear();
        mem.store.set('beanpool_anchor_url', NODE);
        resetHomeAccountForTests();
        resetHomeStoreForTests();
        who.identity = await draftIdentity();
        announceAccountOnPhone(who.identity.publicKey);
        activeAnswer = makeAnswer();
        globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
            const url = String(input);
            const u = new URL(url);
            if (u.pathname === '/api/home') {
                const body = JSON.stringify(activeAnswer);
                return new Response(body, { status: 200, headers: { ETag: '"test-etag"' } });
            }
            if (u.pathname === '/api/node-admin/me') {
                return new Response(JSON.stringify({ role: null, communityName: 'Mullumbimby' }), { status: 200 });
            }
            if (u.pathname === '/api/members/preferences') {
                const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
                if (body.preferences?.['home.layout']) {
                    activeAnswer = { ...activeAnswer, layout: body.preferences['home.layout'] };
                }
                return new Response(JSON.stringify({ success: true, ...body.preferences }), { status: 200 });
            }
            return new Response('{}', { status: 200 });
        }) as any;
        nav.router.push.mockReset();
        nav.router.navigate.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.clearAllMocks();
    });

    async function settle(rounds = 10) {
        for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }

    it('the card is offered, Add puts it on Home, a tool can be added and removed, a tap opens that tool, and an unknown tool id is skipped', async () => {
        await act(async () => {
            root.render(createElement(HomeScreen) as any);
        });
        await settle();

        // 1. The card is offered in Add a card sheet.
        const addCardButton = container.querySelector('[data-testid="home-add-card"]') as HTMLButtonElement;
        expect(addCardButton).not.toBeNull();
        await act(async () => {
            addCardButton.click();
        });
        await settle();

        // Offered with name and line
        const toolsRow = container.querySelector('[data-testid="add-card-tools"]');
        expect(toolsRow).not.toBeNull();
        expect(toolsRow?.textContent).toContain('Your tools');
        expect(toolsRow?.textContent).toContain('A card you fill with the tools you use.');

        // 2. Add puts it on Home.
        const addToolsBtn = container.querySelector('[data-testid="add-card-tools-add"]') as HTMLButtonElement;
        expect(addToolsBtn).not.toBeNull();
        await act(async () => {
            addToolsBtn.click();
        });
        await settle();

        // "Your tools" card is on Home
        const card = container.querySelector('[data-testid="home-card-tools"]');
        expect(card).not.toBeNull();

        // Empty state: invites member to add one
        const empty = container.querySelector('[data-testid="home-tools-empty"]');
        expect(empty).not.toBeNull();
        expect(empty?.textContent).toContain('Add a tool to keep it here.');

        // "Add a tool" row lists tools not yet on the card
        const addRow = container.querySelector('[data-testid="home-tools-add-row"]');
        expect(addRow).not.toBeNull();
        const addThings = container.querySelector('[data-testid="home-tools-add-things"]') as HTMLButtonElement;
        const addGarden = container.querySelector('[data-testid="home-tools-add-garden"]') as HTMLButtonElement;
        expect(addThings).not.toBeNull();
        expect(addGarden).not.toBeNull();

        // 3. A tool can be added and removed.
        // Add "Tool shed"
        await act(async () => {
            addThings.click();
        });
        await settle();

        // "Tool shed" row is rendered on the card
        const toolRow = container.querySelector('[data-testid="home-tool-row-things"]');
        expect(toolRow).not.toBeNull();
        expect(toolRow?.textContent).toContain('Tool shed');

        // 4. A tap opens that tool (real openTool through router.push).
        const openThings = container.querySelector('[data-testid="home-tool-open-things"]') as HTMLButtonElement;
        expect(openThings).not.toBeNull();
        await act(async () => {
            openThings.click();
        });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/tool/[id]', params: { id: 'things' } });

        // Remove "Tool shed"
        const removeThings = container.querySelector('[data-testid="home-tool-remove-things"]') as HTMLButtonElement;
        expect(removeThings).not.toBeNull();
        await act(async () => {
            removeThings.click();
        });
        await settle();

        // Removed from card, back to empty
        expect(container.querySelector('[data-testid="home-tool-row-things"]')).toBeNull();
        expect(container.querySelector('[data-testid="home-tools-empty"]')).not.toBeNull();
    }, 10000);

    it('an unknown tool id in card settings is skipped without crashing', async () => {
        const layoutWithUnknown = [
            { id: 'needs', type: 'needs' },
            { id: 'tools', type: 'tools', settings: { tools: ['mystery-tool-unknown-999', 'garden'] } },
            { id: 'community', type: 'community' },
        ];
        activeAnswer = makeAnswer(layoutWithUnknown);

        await act(async () => {
            root.render(createElement(HomeScreen) as any);
        });
        await settle();

        // Card is on Home
        const card = container.querySelector('[data-testid="home-card-tools"]');
        expect(card).not.toBeNull();

        // Unknown tool ID is skipped
        expect(container.querySelector('[data-testid="home-tool-row-mystery-tool-unknown-999"]')).toBeNull();

        // Valid tool 'garden' is rendered
        const gardenRow = container.querySelector('[data-testid="home-tool-row-garden"]');
        expect(gardenRow).not.toBeNull();
        expect(gardenRow?.textContent).toContain('Your garden');
    });
});
