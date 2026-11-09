// @vitest-environment jsdom
/**
 * The BeanPool sheet's "Set up a new community server" row (app/beanpool.tsx, components/SetUpServerRow.tsx;
 * DESIGN-new-operator-path-fable.md S1, decision 2): directly under Add a community, on every phone, always, and its tap
 * opens the claim screen with no server yet. Before it, a member on a LOCAL community had no way in the app to the claim
 * screen but the camera: Find/Start a community are reached from the global community's Home, and the sheet's Add a
 * community saved an owner-less server as a community to visit (Marty's claim of apollobay, 9 Nov: four tries).
 *
 * Also the card a typed owner-less server shows (components/NoOwnerCard.tsx, Settings' Add a community by address and Find
 * a community): its words, its tap, and its colours from the tokens in light and dark.
 *
 * Rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components
 * as plain tags carrying their flattened style; the sheet's hooks for the communities and the global door are stood in for
 * (beanpool-global-row-render.test.ts drives those for real). Nothing is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => children, KeyboardAvoidingView: ({ children }: any) => children, KeyboardStickyView: ({ children }: any) => children })); // the real one needs the keyboard library's native side
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screen doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, value, onChangeText, disabled, color } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (color) attrs['data-color'] = String(color);
        attrs['data-style'] = JSON.stringify(flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style));
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Linking: { openURL: async () => {} },
        Alert: { alert() {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    const router = { push: (to: unknown) => { nav.pushed.push(to); }, navigate() {}, back() {}, replace() {}, canGoBack: () => true, canDismiss: () => false, dismissAll() {} };
    return { router, useRouter: () => router, useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]), ErrorBoundary: () => null };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name, color }: { name: string; color?: string }) => createElement('i', { 'data-icon': name, 'data-color': color }) }));
const look = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const now = () => ({ theme: look.dark ? 'dark' : 'light', colors: look.dark ? darkColors : lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make(now()) };
});
vi.mock('../use-guide', async () => {
    const { getBundledGuide } = await import('../guide');
    return { useGuide: () => ({ guide: getBundledGuide(), source: 'bundled' }) };
});
vi.mock('../beanpool-links', () => ({ openBeanPoolWebsite: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: 'unknown', nodeUrl: null, recheck: async () => 'unknown' }) }));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.trim().replace(/\/+$/, '').toLowerCase() === 'https://global.beanpool.org',
}));
vi.mock('../use-global-door-open', () => ({ useGlobalDoor: () => ({ state: 'open', wordsDoor: true, retry() {} }) }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));
vi.mock('../use-global-guest-visit', () => ({ useGlobalGuestVisit: () => ({ visit: async () => ({ kind: 'guest' }), visiting: false }) }));
const list = vi.hoisted(() => ({
    rows: [] as { url: string; name: string; status: 'checking' | 'online' | 'guest' | 'offline' }[],
    active: null as string | null | undefined,
}));
vi.mock('../use-communities', () => ({
    useCommunities: () => ({
        active: list.active,
        current: list.rows.find((r) => r.url === list.active) ?? null,
        rows: list.rows,
        lastSync: null,
        switching: false,
        switchTo: async () => {},
        remove: () => {},
    }),
}));

import BeanPoolSheet from '../../app/beanpool';
import { NoOwnerCard } from '../../components/NoOwnerCard';
import { CLAIM_NEW_SERVER_ROUTE } from '../claim-link';
import { darkColors, lightColors } from '../../constants/colors';

const RIVERSIDE = 'https://riverside.example';
const GLOBAL = 'https://global.beanpool.org';
const KEY = { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), callsign: 'Damo' };

/** The phones the row must be on: "on every phone, always" (decision 2). */
const PHONES = {
    'on a local community': () => { who.identity = KEY; list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'online' }]; list.active = RIVERSIDE; },
    'on the global community': () => { who.identity = KEY; list.rows = [{ url: GLOBAL, name: 'Global community', status: 'online' }]; list.active = GLOBAL; },
    'a guest of an owner-less server': () => { who.identity = KEY; list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'guest' }]; list.active = RIVERSIDE; },
    'in no community yet': () => { who.identity = KEY; list.rows = []; list.active = null; },
    'with no account': () => { who.identity = null; list.rows = []; list.active = null; },
} as const;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    look.dark = false;
    nav.pushed.length = 0;
    PHONES['on a local community']();
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(el: ReturnType<typeof createElement>) {
    await act(async () => { root.render(el as any); });
    await settle();
}
const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const setUpRow = () => host.querySelector('[data-testid="set-up-server"]') as HTMLElement | null;
const addRow = () => host.querySelector('[aria-label="Add a community"]') as HTMLElement | null;

describe('The BeanPool sheet: Set up a new community server, under Add a community', () => {
    it.each(Object.keys(PHONES) as (keyof typeof PHONES)[])('%s: the row sits right after Add a community, and opens the claim screen', async (phone) => {
        PHONES[phone]();
        await render(createElement(BeanPoolSheet));
        const add = addRow();
        const row = setUpRow();
        expect(add, 'Add a community').not.toBeNull();
        expect(row, 'Set up a new community server').not.toBeNull();
        // Directly under it, in the same list.
        expect(add!.nextElementSibling).toBe(row);
        expect(row!.getAttribute('data-role')).toBe('button');
        expect(row!.textContent).toBe('Set up a new community server' + 'Installed BeanPool on a server? Scan the code it shows to become its owner.');
        await act(async () => { row!.click(); });
        expect(nav.pushed).toEqual([CLAIM_NEW_SERVER_ROUTE]);
        expect(CLAIM_NEW_SERVER_ROUTE).toBe('/claim-community');
    });

    it('is one of the list\'s rows: its divider, side padding and height', async () => {
        await render(createElement(BeanPoolSheet));
        const add = style(addRow());
        const row = style(setUpRow());
        expect(row.borderTopWidth).toBe(1);
        expect(row.borderTopColor).toBe(lightColors.border.default);
        expect(row.paddingHorizontal).toBe(add.paddingHorizontal);
        expect(row.paddingVertical).toBe(add.paddingVertical);
        expect(Number(row.minHeight)).toBeGreaterThanOrEqual(48);
    });

    it('wraps at 320 dp and 1.3x: nothing cut to a line count or a fixed width', async () => {
        await render(createElement(BeanPoolSheet));
        const row = setUpRow()!;
        expect(row.querySelectorAll('[data-lines]')).toHaveLength(0);
        for (const el of [row, ...Array.from(row.querySelectorAll('*'))]) expect(style(el)).not.toHaveProperty('width');
        const text = row.querySelector('div')!;
        expect(style(text).flex).toBe(1);
        expect(style(text).minWidth).toBe(0);
    });

    it.each([['light', lightColors], ['dark', darkColors]] as const)('takes its colours from the tokens in %s', async (theme, colors) => {
        look.dark = theme === 'dark';
        await render(createElement(BeanPoolSheet));
        const row = setUpRow()!;
        const [title, sub] = Array.from(row.querySelectorAll('span'));
        expect(style(title).color).toBe(colors.text.heading);
        expect(style(sub).color).toBe(colors.text.secondary);
        expect(style(row).borderTopColor).toBe(colors.border.default);
        expect(row.querySelector('[data-icon="server-plus"]')!.getAttribute('data-color')).toBe(colors.brand.primary);
    });
});

describe('The no-owner card (Settings\' Add a community by address, Find a community)', () => {
    const SERVER = { origin: 'https://apollobay.example.org', name: 'Apollo Bay', codeId: '0a1b2c3d' };

    it('says whose it is, the real address, how to claim it; Claim opens the claim screen on that server with the code\'s id', async () => {
        await render(createElement(NoOwnerCard, { server: SERVER, testID: 'no-owner' }));
        const card = host.querySelector('[data-testid="no-owner"]')!;
        const lines = Array.from(card.querySelectorAll('span')).map((s) => s.textContent);
        expect(lines).toEqual([
            'Apollo Bay has no owner yet',
            'https://apollobay.example.org',
            'If you installed it, claim it with the one-time code on the server.',
            'Claim Apollo Bay',
        ]);
        const claim = card.querySelector('button')!;
        expect(claim.getAttribute('data-role')).toBe('button');
        await act(async () => { claim.click(); });
        expect(nav.pushed).toEqual([`/claim-community?node=${encodeURIComponent(SERVER.origin)}&id=0a1b2c3d`]);
    });

    it('wraps at 320 dp and 1.3x: no line count, no fixed width, a 48 dp button that wraps', async () => {
        await render(createElement(NoOwnerCard, { server: { ...SERVER, name: 'The Apollo Bay and Otway Ranges Community Garden Commons' }, testID: 'no-owner' }));
        const card = host.querySelector('[data-testid="no-owner"]')!;
        expect(card.querySelectorAll('[data-lines]')).toHaveLength(0);
        for (const el of [card, ...Array.from(card.querySelectorAll('*'))]) expect(style(el)).not.toHaveProperty('width');
        expect(Number(style(card.querySelector('button')).minHeight)).toBeGreaterThanOrEqual(48);
        expect(style(card.querySelector('button')!.parentElement).flexWrap).toBe('wrap');
    });

    it.each([['light', lightColors], ['dark', darkColors]] as const)('takes its colours from the tokens in %s', async (theme, colors) => {
        look.dark = theme === 'dark';
        await render(createElement(NoOwnerCard, { server: SERVER, testID: 'no-owner' }));
        const card = host.querySelector('[data-testid="no-owner"]')!;
        expect(style(card).backgroundColor).toBe(colors.surface.card);
        expect(style(card).borderColor).toBe(colors.border.default);
        const [name, address, note, claimWords] = Array.from(card.querySelectorAll('span'));
        expect(style(name).color).toBe(colors.text.heading);
        expect(style(address).color).toBe(colors.text.secondary);
        expect(style(note).color).toBe(colors.text.body);
        expect(style(card.querySelector('button')).backgroundColor).toBe(colors.brand.fill);
        expect(style(claimWords).color).toBe(colors.text.onBrand);
    });
});
