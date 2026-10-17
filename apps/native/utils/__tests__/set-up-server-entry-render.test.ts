// @vitest-environment jsdom
/**
 * "Set up a new community server" (components/SetUpServerRow.tsx): the way to the claim screen and its Scan the code for
 * someone who opens BeanPool first, on the screens where they look for one. Before it, the bean's Add a community went
 * to Settings → Advanced with no scanner, and only Settings → Link a device or the phone's camera read a server's claim
 * QR (Marty's claim of a test server, 17 Oct). The bean and Settings belong to another open PR (#2098); this one puts the
 * row on Find a community and Start a community.
 *
 * Rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host
 * components as plain tags, as home-screen-render.test.ts does; the screens' network and storage are stubbed at their
 * modules. What the claim screen does once opened is claim-screen-render.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, value, onChangeText, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn(async () => undefined) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
const nav = vi.hoisted(() => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: true })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: look.theme, colors: look.theme === 'dark' ? darkColors : lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
// Someone who has just made their BeanPool account and belongs to no community yet: one object, as the provider keeps it
// (Find a community's effects run again whenever it changes).
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'marty' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
// Find a community's network and storage: an empty list, no watches, no knocks, no typed town.
vi.mock('../community-directory', () => ({
    fetchCommunities: vi.fn(async () => ({ ok: true, value: { communities: [], fetchedAt: Date.now() } })),
    fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
    watchPlace: vi.fn(), unwatchPlace: vi.fn(),
    communityLabel: (c: { name: string }) => c.name, communityFacts: () => '',
}));
vi.mock('../knock', () => ({
    sendKnock: vi.fn(), readKnockStatus: vi.fn(), rememberedKnocks: vi.fn(async () => []), rememberKnock: vi.fn(), forgetKnock: vi.fn(),
    knockCardState: vi.fn(() => ({ kind: 'ask' })), knockFormProblem: vi.fn(() => null), KNOCK_MESSAGE_CHARS: 280, KNOCK_CALLSIGN_CHARS: 20,
}));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => null), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import { SetUpServerRow } from '../../components/SetUpServerRow';
import FindCommunityScreen from '../../app/find-community';
import StartCommunityScreen from '../../app/start-community';
import { CLAIM_NEW_SERVER_ROUTE } from '../claim-link';
import { lightColors, darkColors } from '../../constants/colors';

async function render(component: (props: any) => unknown): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(component as any) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}

const row = (host: HTMLElement) => host.querySelector('[data-testid="set-up-server"]') as HTMLElement | null;
const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

beforeEach(() => {
    document.body.innerHTML = '';
    look.theme = 'light';
    nav.router.push.mockClear();
});

describe('Set up a new community server', () => {
    it('is one button, in plain words, that opens the claim screen with no server yet', async () => {
        const host = await render(SetUpServerRow);
        const r = row(host)!;
        expect(r.getAttribute('data-role')).toBe('button');
        expect(r.textContent).toBe('Set up a new community server' + 'Installed BeanPool on a server? Scan the code it shows to become its owner.');
        expect(r.querySelector('[data-icon="server-plus"]')).not.toBeNull();
        await act(async () => { r.click(); });
        expect(nav.router.push).toHaveBeenCalledTimes(1);
        expect(nav.router.push).toHaveBeenCalledWith('/claim-community');
        expect(CLAIM_NEW_SERVER_ROUTE).toBe('/claim-community');
    });

    it('wraps at 320 dp and 1.3x: nothing cut to a line count or a fixed width, a 48 dp target', async () => {
        const host = await render(SetUpServerRow);
        const r = row(host)!;
        expect(r.querySelectorAll('[data-lines]')).toHaveLength(0);
        for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) expect(style(el)).not.toHaveProperty('width');
        expect(Number(style(r).minHeight)).toBeGreaterThanOrEqual(48);
    });

    it.each([['light', lightColors], ['dark', darkColors]] as const)('takes its colours from the tokens in %s', async (theme, colors) => {
        look.theme = theme;
        const host = await render(SetUpServerRow);
        const [title, sub] = Array.from(row(host)!.querySelectorAll('span'));
        expect(style(title).color).toBe(colors.text.heading);
        expect(style(sub).color).toBe(colors.text.secondary);
    });

    it('is on Find a community, under Start a community', async () => {
        const host = await render(FindCommunityScreen);
        const r = row(host);
        expect(r).not.toBeNull();
        const start = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('Start a community'))!;
        expect(start).toBeDefined();
        expect(start.nextElementSibling).toBe(r);
        expect(style(r).borderTopWidth).toBe(1);
        await act(async () => { r!.click(); });
        expect(nav.router.push).toHaveBeenCalledWith('/claim-community');
    });

    it('is on Start a community, once the server is running', async () => {
        const host = await render(StartCommunityScreen);
        const r = row(host);
        expect(r).not.toBeNull();
        const labels = Array.from(host.querySelectorAll('span')).map(s => s.textContent);
        expect(labels).toContain("ONCE IT'S RUNNING");
        expect(host.textContent!.indexOf("ONCE IT'S RUNNING")).toBeLessThan(host.textContent!.indexOf('Set up a new community server'));
        await act(async () => { r!.click(); });
        expect(nav.router.push).toHaveBeenCalledWith('/claim-community');
    });
});
